// Regression for the second half of the dead-navigation defect.
//
// Hiding «Кошелёк» and «Биржа» from the bottom bar (shell_nav_contours.test.ts) fixed the entry
// points, not the screens. A deep link — or a server that turns the contour off after the tab was
// already painted — still landed on finance_screen, which fired /v1/wallet, /v1/wallet/history,
// /v1/ex/pairs and /v1/ex/tickers before deciding to show its honest "unavailable" panel. On a stock
// deployment (GC_PAYMENTS unset, the documented default of PAYMENTS.md) every one of those answers
// 403, so the route audit recorded four failed requests plus console errors per visit
// (var/ux-audit/v41/report.json). The screen now asks the advertised contour first.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

// Every money path answers 403 the way the server does when the contour is fail-closed, so a screen
// that still asks fails this test loudly instead of quietly rendering the same panel.
class Api implements ApiLike {
  readonly paths: string[] = [];
  private readonly payments: boolean;
  // Written out rather than a parameter property: node --experimental-strip-types refuses those.
  constructor(payments: boolean) { this.payments = payments; }
  get<T>(path: string): Promise<T> {
    this.paths.push(path);
    if (path === "/v1/config") {
      return Promise.resolve({ features: { payments: this.payments, cards: false } } as unknown as T);
    }
    return Promise.reject(Object.assign(new Error("forbidden"), { name: "ApiError", code: "FORBIDDEN" }));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function render(api: ApiLike, view: "wallet" | "exchange"): Promise<StubNode> {
  const screen = createFinanceScreen({ api, i18n, view, onNavigate() {}, onBack() {} });
  await settle();
  return screen.root as unknown as StubNode;
}

const moneyPaths = (paths: string[]): string[] =>
  paths.filter((p) => p.startsWith("/v1/wallet") || p.startsWith("/v1/ex/"));

for (const view of ["wallet", "exchange"] as const) {
  test(`${view}: a payments-less server is never asked for money data`, async () => {
    const api = new Api(false);
    const root = await render(api, view);
    assert.deepEqual(moneyPaths(api.paths), [], `doomed requests were still sent: ${api.paths.join(", ")}`);
    // The contour flag has to be read, otherwise the screen is merely broken in a new way.
    assert.ok(api.paths.includes("/v1/config"), "the contour was never probed");
    // The user gets the explanation, not a spinner that never resolves.
    const body = root.find((n) => n.hasClass("gc-finance-body"));
    assert.ok(body, "the screen body is missing");
    assert.equal(body.attrs["aria-busy"], "false", "the screen stayed in its loading state");
    assert.ok(
      body.textContent.includes(i18n.t("finance.unavailable")),
      `expected the unavailable explanation, got: ${body.textContent}`,
    );
  });

  test(`${view}: a payments-enabled server is still asked, so the guard cannot become a blanket off`, async () => {
    const api = new Api(true);
    await render(api, view);
    assert.ok(
      moneyPaths(api.paths).length > 0,
      `the enabled contour was never used: ${api.paths.join(", ")}`,
    );
  });
}
