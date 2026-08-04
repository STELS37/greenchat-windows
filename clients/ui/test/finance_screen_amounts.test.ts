// T020 regression, at the level where the defect was actually visible: the rendered wallet.
//
// The old finance_screen.ts had a single `money()` that split the string on "." and grouped the
// integer part. Server amounts carry no dot at all — PAYMENTS §21 puts them on the wire as a
// canonical integer of nano units (scale 9) — so 12.5 tUSDT ("12500000000") was painted as
// 12 500 000 000. Every balance, total and market price was wrong by a factor of 1e9.
//
// The fix splits the two kinds of string the server really sends, so this test asserts both
// directions: a wire nano string must be scaled down, and an already-human decimal
// (approx_fiat.amount, produced by core/fx_rates.approxFiatAmount and already rounded to minor
// units) must be printed as-is. Scaling that one would be the mirror bug.
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

// Numbers taken from the server's own integration test (server/test/integration/wallet.test.ts):
// a 12.5 tUSDT balance is "12500000000" on the wire.
const WALLET = {
  total_usd: "12500000000",
  approx_fiat: { currency: "EUR", amount: "11.40", stale: false },
  assets: [
    {
      id: "tUSDT",
      name: "Test USDT",
      kind: "demo",
      enabled: true,
      balance: "12500000000",
      hold: "0",
      available: "12500000000",
      usd_value: "12500000000",
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

const HISTORY = {
  items: [
    {
      id: 7,
      tx_id: 7,
      op: "transfer",
      asset: "tUSDT",
      amount: "-1500000000",
      balance: "11000000000",
      memo: null,
      ref: null,
      created_at: 1_700_000_000,
      approx_fiat: { currency: "EUR", amount: "1.37", stale: false },
    },
  ],
  next_before_id: null,
};

class WalletApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    // Same reason as exchange_ops_screen.test.ts: the wallet is only fetched once /v1/config admits
    // the money contour is enabled, so a stub that renders balances must admit it.
    if (path === "/v1/config") return Promise.resolve({ features: { payments: true, cards: false } } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(WALLET as unknown as T);
    if (path === "/v1/wallet/history?limit=8") return Promise.resolve(HISTORY as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  // The wallet view is read-only, so every mutating verb is a wired-up trap: if a future edit makes
  // this screen write during a plain render, the test fails instead of silently passing.
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

async function renderWallet(): Promise<StubNode> {
  const screen = createFinanceScreen({
    api: new WalletApi(),
    i18n,
    view: "wallet",
    onNavigate() {},
    onBack() {},
  });
  await settle();
  return screen.root as unknown as StubNode;
}

test("a wire nano balance is scaled to units, not printed raw", async () => {
  const root = await renderWallet();
  const rendered = root.textContent;
  assert.ok(rendered.includes("12.5"), `expected a 12.5 balance, got: ${rendered}`);
  // The exact shape of the old defect. 1e9 too large must never reappear in any grouping style.
  assert.ok(!/12[\s  ]?500[\s  ]?000[\s  ]?000/.test(rendered),
    `nano string leaked into the UI: ${rendered}`);
});

test("the fiat approximation is already human and is not scaled again", async () => {
  const root = await renderWallet();
  const rendered = root.textContent;
  // 11.40 must survive as 11.4 — not become 0.0000000114.
  assert.ok(rendered.includes("11.4"), `expected the fiat approximation, got: ${rendered}`);
  assert.ok(!rendered.includes("0.0000000114"), `fiat amount was scaled as if it were nano: ${rendered}`);
});

test("a negative history amount keeps its sign and its scale", async () => {
  const root = await renderWallet();
  const rendered = root.textContent;
  // U+2212 MINUS SIGN, which is what the model emits deliberately.
  assert.ok(rendered.includes("−1.5"), `expected a signed 1.5 outflow, got: ${rendered}`);
});
