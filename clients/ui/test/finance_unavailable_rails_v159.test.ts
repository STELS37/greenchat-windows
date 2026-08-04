// clients/ui/test/finance_unavailable_rails_v159.test.ts — V159: the two withdrawal sheets on a
// deployment that has no on-chain rail at all.
//
// V99 established the product rule ("never dress a blocked action as a working one") and applied it
// to the deposit sheet and to the withdrawal button. It was never applied to the two places this
// suite covers, and the gap only becomes visible on the SHIPPED production shape, which no earlier
// fixture reproduced.
//
// Measured 2026-08-03 against a server compiled from this tree and started with GC_PAYMENTS=1,
// GC_FINANCE_DEMO=0, NODE_ENV=production and the regulatory `var/FREEZE` marker in place —
// i.e. the deployment the owner photographed. `GET /v1/wallet` answered with 25 assets, 18 of them
// `enabled`, and EVERY asset carrying a `chain` switched off:
//
//   GUSD  kind=stable  chain=sol       enabled=false
//   BTC   kind=crypto  chain=btc       enabled=false
//   ETH   kind=crypto  chain=evm:eth   enabled=false
//   TON   kind=crypto  chain=ton       enabled=false
//   TRX   kind=crypto  chain=tron      enabled=false
//
// so `depositChains()` returns [] and `assets.filter(enabled && chain)` is empty. What the sheets
// rendered on that payload, before this change:
//
//   Адреса для вывода : 3 input fields, a <select> with ZERO options, «Добавить адрес» ENABLED.
//                       Submitting posted `chain: ""` and the server answered 403 PAYMENTS_FROZEN.
//   Вывести           : 5 fields over two empty pickers, and the reason line said «сначала добавьте
//                       адрес» — advice that costs a 24-hour wait and changes nothing, because the
//                       sheet has nothing to send afterwards either.
//
// The server agrees that the rail is absent rather than merely paused — asked directly, with the
// same parameter the client sends, it answers 404 for every chain that exists in the asset table
// and 400 for the empty string the whitelist form would have posted:
//
//   GET /v1/wallet/deposit_address?chain=mock|sol|btc|ton|tron|evm:eth -> 404 NOT_FOUND
//                                                                        "chain not available"
//   GET /v1/wallet/deposit_address?chain=              -> 400 VALIDATION_FAILED "invalid chain"
//
// so the empty picker was not a client-side rendering accident: there is no chain to pick.
//
// Both sheets are now a sentence instead of a form. The LIST half of each sheet stays: reading the
// whitelist and the withdrawal history is `assertPaymentsReadable` and works, and an address added
// while a rail was live is a fact the owner is entitled to see and to delete.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { MoneyApi, WalletResult } from "../src/screens/money_api.ts";
import { depositChains, openWhitelist, openWithdraw, type WalletOpsDeps } from "../src/screens/wallet_ops.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const NOW = 1_800_000_000;

/** The measured production payload, trimmed to the two rows that decide these sheets. */
const NO_RAIL: WalletResult = {
  total_usd: "0",
  assets: [
    {
      id: "GUSD", name: "GreenChat USD", kind: "stable", scale: 9, chain: "sol", chain_decimals: 9,
      enabled: false, min_amount: "0", max_amount: "0", withdraw_fee: "0",
      balance: "0", hold: "0", available: "0", usd_rate: "1000000000", usd_value: "0",
    },
    {
      id: "gEUR", name: "GreenChat EUR", kind: "gfiat", scale: 9, chain: null, chain_decimals: null,
      enabled: true, min_amount: "0", max_amount: "0", withdraw_fee: "0",
      balance: "0", hold: "0", available: "0", usd_rate: "1080000000", usd_value: "0",
    },
  ],
  payment_settings: { has_pin: true, two_factor_enabled: false, pin_required_usd: "20", security_hold_until: 0 },
} as unknown as WalletResult;

/** The same account on a deployment whose rail IS live — every assertion below has this control. */
const WITH_RAIL: WalletResult = {
  ...NO_RAIL,
  assets: [{
    id: "tUSDT", name: "Test USDT", kind: "demo", scale: 9, chain: "mock", chain_decimals: 6,
    enabled: true, min_amount: "1000000000", max_amount: "1000000000000", withdraw_fee: "500000000",
    balance: "12500000000", hold: "0", available: "12500000000",
    usd_rate: "1000000000", usd_value: "12500000000",
  }],
} as unknown as WalletResult;

function mount(money: Partial<MoneyApi>): { deps: WalletOpsDeps; panel: () => StubNode; sent: unknown[] } {
  const trap = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const base = {
    wallet: trap("wallet"), walletHistory: trap("walletHistory"), depositAddress: trap("depositAddress"),
    // A trap here is meaningful, not lazy: refreshChainPicker() must fall back to the label-derived
    // list when /v1/wallet/chains fails, so a rejecting stub exercises that degradation path.
    walletChains: trap("walletChains"),
    deposits: trap("deposits"), withdrawals: trap("withdrawals"), createWithdrawal: trap("createWithdrawal"),
    cancelWithdrawal: trap("cancelWithdrawal"), whitelist: trap("whitelist"), addWhitelist: trap("addWhitelist"),
    deleteWhitelist: trap("deleteWhitelist"), setWalletPin: trap("setWalletPin"), pairs: trap("pairs"),
    tickers: trap("tickers"), ticker: trap("ticker"), depth: trap("depth"), trades: trap("trades"),
    candles: trap("candles"), orders: trap("orders"), placeOrder: trap("placeOrder"),
    cancelOrder: trap("cancelOrder"), myTrades: trap("myTrades"), swapQuote: trap("swapQuote"), swap: trap("swap"),
  } as unknown as MoneyApi;
  let panel: StubNode | null = null;
  const sent: unknown[] = [];
  const deps: WalletOpsDeps = {
    money: { ...base, ...money }, i18n,
    openSheet: (node) => { panel = node as unknown as StubNode; },
    closeSheet: () => {},
    onChanged: () => {},
    now: () => NOW,
  };
  return { deps, panel: () => { assert.ok(panel, "no sheet mounted"); return panel as unknown as StubNode; }, sent };
}

const forms = (p: StubNode): StubNode[] => p.findAll((n) => n.tag === "form");
const fields = (p: StubNode): number => p.findAll((n) => n.hasClass("gc-field")).length;
const liveButtons = (p: StubNode): StubNode[] =>
  p.findAll((n) => n.tag === "button" && n.attrs.type !== "button" && n.attrs.disabled === undefined);
const emptyOptionSelect = (p: StubNode): boolean =>
  p.findAll((n) => n.tag === "select").some((s) => s.findAll((o) => o.tag === "option").length === 0);
const subtitle = (p: StubNode): StubNode => {
  const s = p.find((n) => n.hasClass("gc-sheet-subtitle"));
  assert.ok(s, "the sheet has no subtitle node");
  return s as StubNode;
};

// ── the shape the whole suite depends on ────────────────────────────────────────────────────────

test("V159: an asset with a chain but switched off contributes no network", () => {
  // Both sheets read the rail through this one helper, so the payload interpretation is pinned once.
  assert.deepEqual(depositChains(NO_RAIL.assets), [], "a disabled asset must not advertise its chain");
  assert.deepEqual(depositChains(WITH_RAIL.assets), ["mock"]);
});

// ── 1. «Адреса для вывода» ───────────────────────────────────────────────────────────────────────

test("V159: with no withdrawal network the address sheet states the reason instead of a form", async () => {
  const h = mount({ whitelist: () => Promise.resolve({ items: [] }) });
  openWhitelist(h.deps, NO_RAIL);
  await settle();
  const panel = h.panel();

  assert.equal(forms(panel).length, 0, "a form nobody can complete must not be rendered");
  assert.equal(fields(panel), 0, "no input field survives the missing rail");
  assert.equal(emptyOptionSelect(panel), false, "an empty <select> is the defect, not the fallback");
  assert.deepEqual(
    liveButtons(panel).map((b) => b.textContent.trim()),
    [],
    "«Добавить адрес» must not stay enabled over a request the server answers with PAYMENTS_FROZEN",
  );
  const reason = panel.find((n) => n.hasClass("gc-whitelist-unavailable"));
  assert.ok(reason, "the sheet must say WHY, not merely go quiet");
  assert.equal(reason!.textContent, i18n.t("finance.noWhitelistChains"));
  // The reason is the withdrawal side and must not be the deposit sentence: a user reading «нет
  // сетей пополнения» on the withdrawal screen would conclude the wrong half of the wallet is off.
  assert.notEqual(reason!.textContent, i18n.t("finance.noChains"));
  assert.equal(subtitle(panel).hidden, true, "no 24-hour countdown for an address that cannot be added");
});

test("V159: the address sheet still shows and can delete addresses added while a rail was live", async () => {
  let deleted: number | null = null;
  const h = mount({
    whitelist: () => Promise.resolve({ items: [
      { id: 11, chain: "sol", address: "So1dAddr", label: "Cold", active_after: NOW - 10, created_at: NOW - 90_000 },
    ] }),
    deleteWhitelist: (id: number) => { deleted = id; return Promise.resolve({ deleted: true }); },
  });
  openWhitelist(h.deps, NO_RAIL);
  await settle();
  const panel = h.panel();
  assert.ok(panel.textContent.includes("So1dAddr"), "reading the whitelist is allowed and the owner owns these rows");
  const remove = panel.findAll((n) => n.tag === "button" && n.attrs.title === i18n.t("finance.removeAddress"))[0];
  assert.ok(remove, "an address that cannot be re-added must still be removable");
  remove!.dispatch("click");
  await settle();
  assert.equal(deleted, 11, "the delete request must still reach the server");
});

test("V159: a live rail leaves the address form exactly as it was", async () => {
  const h = mount({ whitelist: () => Promise.resolve({ items: [] }) });
  openWhitelist(h.deps, WITH_RAIL);
  await settle();
  const panel = h.panel();
  assert.equal(forms(panel).length, 1, "the working case must not be collateral damage");
  assert.equal(fields(panel), 3, "network, address and label");
  assert.equal(subtitle(panel).hidden, false, "the 24-hour rule is true again and must be stated");
  assert.equal(panel.find((n) => n.hasClass("gc-whitelist-unavailable")), null);
});

// ── 2. «Вывести» ─────────────────────────────────────────────────────────────────────────────────

test("V159: with nothing sendable the withdrawal sheet names THAT reason, not the address one", async () => {
  const h = mount({ whitelist: () => Promise.resolve({ items: [] }), withdrawals: () => Promise.resolve({ items: [] }) });
  openWithdraw(h.deps, NO_RAIL);
  await settle();
  const panel = h.panel();

  assert.equal(forms(panel).length, 0, "five dead fields over two empty pickers is the defect");
  assert.equal(emptyOptionSelect(panel), false);
  const reason = panel.find((n) => n.hasClass("gc-withdraw-unavailable"));
  assert.ok(reason, "the sheet must state the blocking reason");
  assert.equal(reason!.textContent, i18n.t("finance.withdrawNoAsset"));
  // The old text sent the user on a 24-hour errand that could not help: adding an address does not
  // create an asset. That is the regression this assertion exists to catch.
  assert.notEqual(reason!.textContent, i18n.t("finance.withdrawNeedsAddress"));
  assert.equal(subtitle(panel).hidden, true, "«только на адрес из белого списка» is a how-to for a road that is closed");
  assert.deepEqual(liveButtons(panel).map((b) => b.textContent.trim()), []);
});

test("V159: even a usable whitelisted address cannot unlock a sheet with nothing to send", async () => {
  // The dangerous ordering: the whitelist round trip lands AFTER the sheet is built, and the old
  // code let its verdict (`addressReady` → clear the gate, enable the button) overwrite everything.
  const h = mount({
    whitelist: () => Promise.resolve({ items: [
      { id: 5, chain: "sol", address: "So1dReady", label: "Cold", active_after: NOW - 10, created_at: NOW - 90_000 },
    ] }),
    withdrawals: () => Promise.resolve({ items: [] }),
  });
  openWithdraw(h.deps, NO_RAIL);
  await settle();
  assert.deepEqual(
    liveButtons(h.panel()).map((b) => b.textContent.trim()),
    [],
    "an active address must not release a submit button that has no asset to send",
  );
});

test("V159: a live rail keeps the V99 behaviour — form, gate, and the address reason", async () => {
  const h = mount({ whitelist: () => Promise.resolve({ items: [] }), withdrawals: () => Promise.resolve({ items: [] }) });
  openWithdraw(h.deps, WITH_RAIL);
  await settle();
  const panel = h.panel();
  assert.equal(forms(panel).length, 1, "the working case must keep its form");
  const gate = panel.find((n) => n.hasClass("gc-withdraw-gate"));
  assert.ok(gate && gate.hidden === false, "V99's reason line must still appear");
  assert.equal(gate!.textContent, i18n.t("finance.withdrawNeedsAddress"),
    "with an asset present, the missing address is again the true and actionable reason");
  assert.equal(subtitle(panel).hidden, false);
  assert.equal(panel.find((n) => n.hasClass("gc-withdraw-unavailable")), null);
});

// ── 3. both dictionaries carry both sentences ────────────────────────────────────────────────────

test("V159: the two new reasons exist in both locales and stay distinct", () => {
  // A missing key falls back to the OTHER locale, so the failure mode is a Russian wallet printing an
  // English sentence — silent, and exactly the kind of thing a screenshot review misses.
  for (const key of ["finance.noWhitelistChains", "finance.withdrawNoAsset"] as const) {
    for (const [name, dict] of [["en", en], ["ru", ru]] as const) {
      const value = (dict as Record<string, string>)[key];
      assert.ok(value && value.trim().length > 0, `${name} is missing ${key}`);
    }
  }
  // Distinctness is the point of having two keys: the deposit rail and the withdrawal rail are
  // configured separately, and one sentence for both would misreport whichever half is still live.
  for (const dict of [en, ru] as Array<Record<string, string>>) {
    assert.notEqual(dict["finance.noWhitelistChains"], dict["finance.noChains"]);
    assert.notEqual(dict["finance.withdrawNoAsset"], dict["finance.withdrawNeedsAddress"]);
  }
});
