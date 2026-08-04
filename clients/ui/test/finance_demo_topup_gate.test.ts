// B-P0-4 (owner directive 2026-07-30: "решить поведение недоступных финансовых функций —
// полноценная активация").
//
// Measured on the production deployment before this existed: /v1/wallet advertised exactly one asset
// (GUSD), every rail was off (no chain configured, on-ramp off, cards off) and every user held 0.
// "Отправить", "Обменять" and the exchange therefore had nothing to move, and "Пополнить" opened a
// deposit sheet with no chain to deposit on — a whole half of the app visible and unusable.
//
// The activation that invents no money rail: `kind='demo'` assets plus the server faucet, switched on
// by an explicit deployment flag (GC_FINANCE_DEMO=1) and advertised as `features.demo_finance`.
// This test pins the three directions that keep it honest:
//   1. no flag  -> no entry point at all (a live-rails deployment never offers test money);
//   2. flag but no demo asset -> still no entry point (the sheet would have nothing to credit);
//   3. flag + demo asset -> the entry point exists and POSTs /v1/wallet/faucet.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import type { FaucetResult, MoneyApi, WalletResult } from "../src/screens/money_api.ts";
import { openDemoTopUp, type WalletOpsDeps } from "../src/screens/wallet_ops.ts";
import { readServerFeatures } from "../src/screens/server_features.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const asset = (id: string, kind: string) => ({
  id,
  name: `${id} asset`,
  kind,
  scale: 9,
  chain: null,
  chain_decimals: null,
  enabled: true,
  min_amount: "0",
  max_amount: "0",
  withdraw_fee: "0",
  balance: "0",
  hold: "0",
  available: "0",
  usd_rate: null,
  usd_value: null,
});

const wallet = (assets: unknown[]) => ({
  total_usd: "0",
  approx_fiat: null,
  assets,
  payment_settings: {
    has_pin: false,
    two_factor_enabled: false,
    security_hold_until: 0,
    flags: [],
    pin_required_usd: "20",
  },
});

class Api implements ApiLike {
  readonly posts: string[] = [];
  private readonly demo: boolean;
  private readonly assets: unknown[];
  constructor(demo: boolean, assets: unknown[]) {
    this.demo = demo;
    this.assets = assets;
  }
  get<T>(path: string): Promise<T> {
    if (path === "/v1/config")
      return Promise.resolve({
        features: { payments: true, cards: false, demo_finance: this.demo },
      } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(wallet(this.assets) as unknown as T);
    if (path === "/v1/wallet/history?limit=8")
      return Promise.resolve({ items: [], next_before_id: null } as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    this.posts.push(path);
    if (path === "/v1/wallet/faucet")
      return Promise.resolve({ tx_id: 1, asset: "tUSDT", amount: "100" } as unknown as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
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

async function render(api: ApiLike): Promise<StubNode> {
  const screen = createFinanceScreen({
    api,
    i18n,
    view: "wallet",
    onNavigate() {},
    onBack() {},
  });
  await settle();
  return screen.root as unknown as StubNode;
}

const topUpButton = (root: StubNode): StubNode | undefined =>
  root.findAll(
    (node) => node.hasClass("gc-finance-action") && node.attrs["aria-label"] === "Test funds",
  )[0];

const visibleTopUp = (root: StubNode): boolean => {
  const button = topUpButton(root) as (StubNode & { hidden?: boolean }) | undefined;
  return Boolean(button) && button!.hidden !== true;
};

test("an unknown /v1/config body reads as 'demo contour off'", () => {
  assert.equal(readServerFeatures(undefined).demoFinance, false);
  assert.equal(readServerFeatures({ features: { payments: true } }).demoFinance, false);
  assert.equal(readServerFeatures({ features: { demo_finance: "yes" } }).demoFinance, false);
  assert.equal(readServerFeatures({ features: { demo_finance: true } }).demoFinance, true);
});

test("no demo contour: the wallet never offers test money", async () => {
  const root = await render(new Api(false, [asset("GUSD", "stable"), asset("tUSDT", "demo")]));
  assert.equal(visibleTopUp(root), false);
});

test("demo contour but no demo asset: still no entry point", async () => {
  const root = await render(new Api(true, [asset("GUSD", "stable")]));
  assert.equal(visibleTopUp(root), false);
});

test("demo contour + demo asset: the wallet reveals the test top-up entry point", async () => {
  const root = await render(new Api(true, [asset("GUSD", "stable"), asset("tUSDT", "demo")]));
  assert.equal(visibleTopUp(root), true, "the demo top-up entry point is missing");
});

// The sheet itself is driven directly: it mounts through the hub's `openSheet` callback and the DOM
// stub has no document.body (same reason as wallet_ops_screen.test.ts).
function sheetHarness(faucet: (body: { asset: string; amount: string }) => Promise<FaucetResult>) {
  let panel: StubNode | null = null;
  const changes: string[] = [];
  const deps = {
    money: { faucet } as unknown as MoneyApi,
    i18n,
    openSheet: (node: HTMLElement) => {
      panel = node as unknown as StubNode;
    },
    closeSheet: () => {},
    onChanged: (message: string) => changes.push(message),
  } as unknown as WalletOpsDeps;
  return { deps, panel: () => panel as unknown as StubNode, changes };
}

const demoWallet = (assets: unknown[]) => wallet(assets) as unknown as WalletResult;

test("the top-up sheet says in words that this is test money and calls the faucet", async () => {
  const calls: Array<{ asset: string; amount: string }> = [];
  const h = sheetHarness((body) => {
    calls.push(body);
    return Promise.resolve({ tx_id: 7, asset: body.asset, amount: body.amount });
  });
  openDemoTopUp(h.deps, demoWallet([asset("GUSD", "stable"), asset("tUSDT", "demo")]));
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes("Test funds"), `the sheet is not labelled as test money: ${text}`);
  assert.ok(
    text.includes("cannot be withdrawn"),
    `the sheet does not warn that the money cannot leave: ${text}`,
  );
  // Only the demo asset may be credited: a real asset in the same wallet must not be selectable.
  const options = h.panel().findAll((node) => node.tag === "option");
  assert.deepEqual(
    options.map((node) => node.attrs.value),
    ["tUSDT"],
  );

  const form = h.panel().findAll((node) => node.hasClass("gc-finance-form"))[0];
  assert.ok(form, "no top-up form rendered");
  form!.dispatch("submit");
  await settle();
  // The wire amount is the ledger integer, not the typed text. /v1/wallet/faucet runs the same
  // parseAmount as transfers, so a literal "100" means 100 nano units (1e-7 of a token) and the
  // server refuses it with AMOUNT_TOO_SMALL against the asset's 1000-unit floor — measured against
  // the ephemeral demo deployment on port 39715 before this conversion existed.
  assert.deepEqual(calls, [{ asset: "tUSDT", amount: "100000000000" }]);
  // ...and the confirmation is read by a person, so it must be the human amount again, not the
  // integer that was just sent.
  assert.ok(
    h.changes[0]?.includes("100") && !h.changes[0]?.includes("100000000000"),
    `the hub was not told what was credited in human terms: ${h.changes[0]}`,
  );
});

test("a wallet with no demo asset renders an explanation instead of a doomed form", async () => {
  const h = sheetHarness(() => Promise.reject(new Error("the faucet must not be called")));
  openDemoTopUp(h.deps, demoWallet([asset("GUSD", "stable")]));
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes("no demo assets"), `expected an explanation, got: ${text}`);
  assert.equal(h.panel().findAll((node) => node.tag === "option").length, 0);
});
