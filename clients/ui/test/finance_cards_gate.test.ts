// Regression for a dead entry point in the main navigation.
//
// The card contour is fail-closed on the server: pay/cards/routes.ts registers no route unless
// GC_CARDS=1 AND GC_PAYMENTS=1. On every default deployment the finance screen still offered a "Cards"
// tab and a "Cards" shortcut in the wallet hero, both of which could only ever produce a 404 plus an
// "unavailable" panel. The route-wide UX audit saw it as `errors=2` on /cards in both colour schemes.
//
// The fix reads the contour from public /v1/config, so this test pins all three directions:
// the flag parser, the hidden-by-default entry points, and the absence of the doomed request.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import { readServerFeatures } from "../src/screens/server_features.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const WALLET = {
  total_usd: "0",
  approx_fiat: null,
  assets: [],
  payment_settings: { has_pin: false, two_factor_enabled: false, security_hold_until: 0, flags: [], pin_required_usd: "20" },
};

class Api implements ApiLike {
  readonly paths: string[] = [];
  private readonly cards: boolean | undefined;
  constructor(cards: boolean | undefined) { this.cards = cards; }
  get<T>(path: string): Promise<T> {
    this.paths.push(path);
    if (path === "/v1/config") {
      const features = this.cards === undefined ? { payments: true } : { payments: true, cards: this.cards };
      return Promise.resolve({ features } as unknown as T);
    }
    if (path === "/v1/wallet") return Promise.resolve(WALLET as unknown as T);
    if (path === "/v1/wallet/history?limit=8") return Promise.resolve({ items: [], next_before_id: null } as unknown as T);
    // The whole point: on a server without the contour this must never be reached.
    if (path === "/v1/cards") return Promise.reject(Object.assign(new Error("not found"), { name: "ApiError", code: "NOT_FOUND" }));
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function render(api: ApiLike, view: "wallet" | "cards"): Promise<StubNode> {
  const screen = createFinanceScreen({ api, i18n, view, onNavigate() {}, onBack() {} });
  await settle();
  return screen.root as unknown as StubNode;
}

const tabLabels = (root: StubNode): string[] =>
  root.findAll((n) => n.hasClass("gc-finance-tab")).map((n) => n.textContent.trim());

test("an unknown /v1/config body reads as 'optional contours off'", () => {
  assert.equal(readServerFeatures(undefined).cards, false);
  assert.equal(readServerFeatures({}).cards, false);
  // A server predating the flag omits it entirely — "unknown" must not mean "available".
  assert.equal(readServerFeatures({ features: { payments: true } }).cards, false);
  assert.equal(readServerFeatures({ features: { cards: "yes" } }).cards, false);
  assert.equal(readServerFeatures({ features: { cards: true } }).cards, true);
});

test("a server without the card contour offers no Cards tab", async () => {
  const api = new Api(false);
  const root = await render(api, "wallet");
  assert.deepEqual(tabLabels(root), ["Wallet", "Exchange"]);
});

test("a server with the card contour does offer the Cards tab", async () => {
  const api = new Api(true);
  const root = await render(api, "wallet");
  assert.deepEqual(tabLabels(root), ["Wallet", "Exchange", "Cards"]);
});

test("the cards view never issues the request that is known to 404", async () => {
  const api = new Api(false);
  const root = await render(api, "cards");
  assert.ok(!api.paths.includes("/v1/cards"), `a doomed request was still sent: ${api.paths.join(", ")}`);
  // The user still gets an explanation rather than a blank screen.
  assert.ok(root.textContent.includes("Cards"), `expected an explanatory panel, got: ${root.textContent}`);
  // Deep-linking to #/cards keeps the tab, otherwise the current screen would be missing from its own
  // tab bar.
  assert.deepEqual(tabLabels(root), ["Wallet", "Exchange", "Cards"]);
});
