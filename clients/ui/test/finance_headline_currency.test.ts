// Regression for a defect observed on the signed superapp APK (versionCode 1000013) on 2026-07-31:
// the wallet headline printed «24.91 USD ≈ 24.92 USD» — the same balance twice, in the same
// currency, disagreeing with itself by a cent.
//
// Why it happened: `total_usd` is the sum of the per-asset USD values, while `approx_fiat` is one
// converted total, and the server returns currency:"USD" both for a USD display currency and for
// the G-004 rate fallback. Two rounding paths, one currency, two numbers on screen.
//
// The rule this test pins: an approximation in the SAME currency as the headline never repeats the
// amount. It may still carry the freshness note, because that is information the headline cannot
// express. A DIFFERENT currency must keep working exactly as before — that is the whole point of
// the "≈" line and is asserted here too, so the fix cannot be "delete the line".
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

// 24.91 USD on the wire (nano units, PAYMENTS §21) — the exact balance from the device screenshot.
const TOTAL_USD = "24910000000";

interface ApproxLike {
  currency: string;
  amount: string;
  rate_asof: number | null;
  stale: boolean;
}

function wallet(approx: ApproxLike | null): Record<string, unknown> {
  return {
    total_usd: TOTAL_USD,
    ...(approx ? { approx_fiat: approx } : {}),
    assets: [
      {
        id: "tUSDT",
        name: "Test USDT",
        kind: "demo",
        enabled: true,
        balance: "15000000000",
        hold: "0",
        available: "15000000000",
        usd_value: "15000000000",
        usd_rate: "1000000000",
      },
    ],
    payment_settings: {
      has_pin: false,
      two_factor_enabled: false,
      security_hold_until: 0,
      flags: [],
      pin_required_usd: "20",
    },
  };
}

class WalletApi implements ApiLike {
  // A plain field, not a constructor parameter property: node --experimental-strip-types removes
  // types without emitting code, so the shorthand would never assign anything.
  readonly body: Record<string, unknown>;
  constructor(body: Record<string, unknown>) {
    this.body = body;
  }
  get<T>(path: string): Promise<T> {
    if (path === "/v1/config")
      return Promise.resolve({ features: { payments: true, cards: false } } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(this.body as unknown as T);
    if (path === "/v1/wallet/history?limit=8")
      return Promise.resolve({ items: [], next_before_id: null } as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected POST"));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

// The assertions are scoped to the summary card, not to the whole screen: an asset row legitimately
// says «15 ≈ 15 USD» because 15 tUSDT and 15 USD are different units. Only the headline block is
// forbidden from printing the same money twice.
async function renderSummary(approx: ApproxLike | null): Promise<StubNode> {
  const screen = createFinanceScreen({
    api: new WalletApi(wallet(approx)),
    i18n,
    view: "wallet",
    onNavigate() {},
    onBack() {},
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  const summary = root.querySelector(".gc-finance-summary");
  assert.ok(summary, "the wallet summary card did not render at all");
  return summary as StubNode;
}

test("a same-currency approximation never repeats the headline balance", async () => {
  const summary = await renderSummary({ currency: "USD", amount: "24.92", rate_asof: 1_785_500_000, stale: false });
  const text = summary.textContent;
  assert.ok(text.includes("24.91"), `the headline balance disappeared: ${text}`);
  // The exact shape of the defect: a second USD amount under the headline.
  assert.ok(!text.includes("24.92"), `the balance was printed twice with two roundings: ${text}`);
  assert.ok(!text.includes("≈"), `a bare same-currency approximation survived: ${text}`);
  // No empty element either — a blank line under the balance reads as a value that failed to load.
  assert.equal(summary.querySelector(".gc-finance-approx"), null, "an empty approximation row was left behind");
});

test("a same-currency approximation still reports a stale rate", async () => {
  const summary = await renderSummary({ currency: "USD", amount: "24.92", rate_asof: 1_700_000_000, stale: true });
  const text = summary.textContent;
  assert.ok(text.includes(ru["finance.rateStale"]), `the freshness note was dropped: ${text}`);
  assert.ok(!text.includes("24.92"), `the duplicate amount came back with the note: ${text}`);
});

test("a different display currency keeps the full approximation line", async () => {
  const summary = await renderSummary({ currency: "EUR", amount: "22.80", rate_asof: 1_785_500_000, stale: false });
  const text = summary.textContent;
  assert.ok(text.includes("24.91"), `the headline balance disappeared: ${text}`);
  assert.ok(text.includes("22.8"), `the cross-currency approximation was suppressed: ${text}`);
  assert.ok(text.includes("≈"), `the approximation lost its marker: ${text}`);
});

test("a missing approximation still explains itself", async () => {
  const summary = await renderSummary(null);
  assert.ok(summary.textContent.includes(ru["finance.fiatUnavailable"]),
    `the unavailable notice vanished: ${summary.textContent}`);
});
