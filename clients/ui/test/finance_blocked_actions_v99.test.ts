// clients/ui/test/finance_blocked_actions_v99.test.ts — V99: an action that cannot be taken must say
// so, and must not look available.
//
// Measured on the signed superapp APK (versionCode 1000013) on a 393x873 dp device, 2026-07-31, on a
// deployment whose real rails are off (config: payments=true, demo_finance=true, cards=false):
//
//  1. «Вывод средств» opened with the whole form and a bright green «Вывести» at the bottom. The
//     button WAS `disabled=true` — and measured `opacity: 1`, `cursor: pointer`, full accent
//     gradient, because the stylesheet carried no `:disabled` rule anywhere. Tapping it did nothing
//     and said nothing. The only clue was the string «Адресов пока нет» inside a collapsed <select>
//     that a touch user never opens.
//  2. «Пополнение» promised what it could not deliver: the hint «Отправляйте только указанный актив
//     в указанной сети», a network picker set to SOL, the heading «Адрес пополнения» with an EMPTY
//     box under it, and a paragraph telling the user to scan a QR code that was never drawn. The
//     refusal itself sat below all of it as one faint status line. A screen that explains how to
//     send money to an address it does not have invites a real, unrecoverable transfer.
//
// Both are the same product rule, from the owner's P0-4 item ("decide the behaviour of unavailable
// financial functions"): the app must never dress a blocked action as a working one. This file pins
// the three parts of that rule which regress silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { MoneyApi, WalletResult } from "../src/screens/money_api.ts";
import { openDeposit, openWithdraw, type WalletOpsDeps } from "../src/screens/wallet_ops.ts";
import { sheetError } from "../src/screens/finance_sheet.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const NOW = 1_800_000_000;

const WALLET: WalletResult = {
  total_usd: "0",
  assets: [{
    id: "tUSDT", name: "Test USDT", kind: "demo", scale: 9, chain: "mock", chain_decimals: 6,
    enabled: true, min_amount: "1000000000", max_amount: "1000000000000",
    withdraw_fee: "500000000", balance: "12500000000", hold: "0",
    available: "12500000000", usd_rate: "1000000000", usd_value: "12500000000",
  }],
  payment_settings: { has_pin: true, two_factor_enabled: false, pin_required_usd: "20", security_hold_until: 0 },
};

function mount(money: Partial<MoneyApi>): { deps: WalletOpsDeps; panel: () => StubNode } {
  const trap = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const base = {
    wallet: trap("wallet"), walletHistory: trap("walletHistory"), depositAddress: trap("depositAddress"),
    deposits: trap("deposits"), withdrawals: trap("withdrawals"), createWithdrawal: trap("createWithdrawal"),
    cancelWithdrawal: trap("cancelWithdrawal"), whitelist: trap("whitelist"), addWhitelist: trap("addWhitelist"),
    deleteWhitelist: trap("deleteWhitelist"), setWalletPin: trap("setWalletPin"), pairs: trap("pairs"),
    tickers: trap("tickers"), ticker: trap("ticker"), depth: trap("depth"), trades: trap("trades"),
    candles: trap("candles"), orders: trap("orders"), placeOrder: trap("placeOrder"),
    cancelOrder: trap("cancelOrder"), myTrades: trap("myTrades"), swapQuote: trap("swapQuote"), swap: trap("swap"),
    walletChains: trap("walletChains"),
  } as unknown as MoneyApi;
  let panel: StubNode | null = null;
  const deps: WalletOpsDeps = {
    money: { ...base, ...money }, i18n,
    openSheet: (node) => { panel = node as unknown as StubNode; },
    closeSheet: () => {},
    onChanged: () => {},
    now: () => NOW,
  };
  return { deps, panel: () => { assert.ok(panel, "no sheet mounted"); return panel as unknown as StubNode; } };
}

const submitButton = (panel: StubNode): StubNode => {
  const b = panel.findAll((n) => n.tag === "button" && n.attrs.type === "submit")[0];
  assert.ok(b, "the sheet has no submit button");
  return b as StubNode;
};
const gate = (panel: StubNode): StubNode | null => panel.find((n) => n.hasClass("gc-withdraw-gate"));

// ── 1. the withdraw sheet says WHY it is blocked ─────────────────────────────────────────────────

test("V99: an empty whitelist blocks withdrawal with a visible reason, not with silence", async () => {
  const h = mount({
    whitelist: () => Promise.resolve({ items: [] }),
    withdrawals: () => Promise.resolve({ items: [] }),
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  const line = gate(panel);
  assert.ok(line, "no reason line is rendered at all");
  assert.equal(line!.hidden, false, "the reason is hidden while the action is blocked");
  assert.equal(line!.textContent, i18n.t("finance.withdrawNeedsAddress"));
  assert.equal(submitButton(panel).attrs.disabled, "true", "the button must stay blocked");
  // The reason must be announced, since a disabled control is skipped by screen readers (WCAG 3.3.2).
  assert.equal(line!.attrs.role, "status");
});

test("V99: a valid amount does not unlock the button while no address can receive it", async () => {
  const h = mount({
    whitelist: () => Promise.resolve({ items: [] }),
    withdrawals: () => Promise.resolve({ items: [] }),
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  const amount = panel.findAll((n) => n.tag === "input" && n.attrs.inputmode === "decimal")[0] as StubNode;
  amount.value = "3";
  amount.dispatch("input");
  assert.equal(submitButton(panel).attrs.disabled, "true", "a parsable number must not fake availability");
});

test("V99: an address still inside its 24-hour hold says WAIT, not ADD ANOTHER", async () => {
  const h = mount({
    whitelist: () => Promise.resolve({ items: [
      { id: 7, chain: "mock", address: "mock1qfresh", label: "New", active_after: NOW + 3600, created_at: NOW },
    ] }),
    withdrawals: () => Promise.resolve({ items: [] }),
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  const line = gate(panel);
  assert.ok(line && line.hidden === false, "a cooling-down whitelist must still explain itself");
  assert.notEqual(line!.textContent, i18n.t("finance.withdrawNeedsAddress"),
    "telling the user to add an address they already added makes them add a useless second one");
  assert.match(line!.textContent, /1 ч|1 h/, "the remaining time must be named");
  assert.equal(submitButton(panel).attrs.disabled, "true");
});

test("V99: a usable address clears the reason line and releases the button", async () => {
  const h = mount({
    whitelist: () => Promise.resolve({ items: [
      { id: 5, chain: "mock", address: "mock1qready", label: "Cold", active_after: NOW - 10, created_at: NOW - 90_000 },
    ] }),
    withdrawals: () => Promise.resolve({ items: [] }),
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  assert.equal(gate(panel)!.hidden, true, "the reason must disappear once it stops being true");
  const amount = panel.findAll((n) => n.tag === "input" && n.attrs.inputmode === "decimal")[0] as StubNode;
  amount.value = "3";
  amount.dispatch("input");
  assert.equal(submitButton(panel).attrs.disabled, undefined, "a satisfied precondition must unlock the action");
});

// ── 2. the deposit sheet never promises an address it does not have ──────────────────────────────

// Both deposit cases below are about a rail that EXISTS: the deployment serves `mock` (the wallet
// fixture's only chain), and the question is only whether the address request behind it succeeds.
// So `/v1/wallet/chains` is stubbed to name that rail. The other two shapes of this answer — a
// deployment that names no rail at all, and a server too old to answer the route — are pinned in
// finance_unavailable_rails_v159.test.ts; mixing them in here would test the picker, not the promise.
const servesMock = () =>
  Promise.resolve({ chains: [{ chain: "mock", deposits: true, withdrawals: true }], frozen: false });

const addressGroup = (panel: StubNode): StubNode => {
  const g = panel.find((n) => n.hasClass("gc-deposit-address-group"));
  assert.ok(g, "the deposit sheet has no address block");
  return g as StubNode;
};
const subtitle = (panel: StubNode): StubNode => {
  const s = panel.find((n) => n.hasClass("gc-sheet-subtitle"));
  assert.ok(s, "the sheet has no subtitle node");
  return s as StubNode;
};

test("V99: a refused chain takes the address heading, the QR promise and the subtitle with it", async () => {
  const err = Object.assign(new Error("off"), { name: "ApiError", code: "PAYMENTS_DISABLED" });
  const h = mount({
    depositAddress: () => Promise.reject(err),
    deposits: () => Promise.resolve({ items: [] }),
    walletChains: servesMock,
  });
  openDeposit(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  assert.equal(addressGroup(panel).hidden, true, "no address heading without an address");
  assert.equal(subtitle(panel).hidden, true, "no «send only this asset on this network» without a network address");
  const line = panel.find((n) => n.hasClass("gc-deposit-unavailable"));
  assert.ok(line && line.hidden === false, "the refusal must be stated where the address was");
  // The exact wording is finance_error_text.test.ts's business (the contour line differs from the raw
  // error catalogue); what V99 pins is that the named reason, not the generic fallback, lands here.
  assert.equal(line!.textContent, sheetError(err, i18n));
  assert.notEqual(line!.textContent, i18n.t("errors.unknown"));
  // The network picker survives: a user whose one chain failed can switch to another.
  assert.ok(panel.find((n) => n.tag === "select"), "the sheet must not lock the user out of other chains");
});

test("V99: a working chain shows the address block and its promise", async () => {
  const h = mount({
    depositAddress: (chain: string) => Promise.resolve({ chain, address: "mock1qexampleaddress", derivation_index: 1 }),
    deposits: () => Promise.resolve({ items: [] }),
    walletChains: servesMock,
  });
  openDeposit(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  assert.equal(addressGroup(panel).hidden, false);
  assert.equal(subtitle(panel).hidden, false);
  assert.ok(panel.textContent.includes("mock1qexampleaddress"));
});

// ── 3. the stylesheet makes "blocked" visible at all ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("V99: a disabled button is styled as disabled, product-wide", () => {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let body = "";
  while ((m = re.exec(css))) {
    const sel = m[1]!.replace(/\s+/g, " ").trim();
    if (/\.gc-btn:disabled(?![-\w(])/.test(sel) && !/:hover/.test(sel.split(",")[0]!)) body = m[2]!;
  }
  assert.notEqual(body, "", "the stylesheet has no rule for a disabled button — every gated action looks live");
  assert.match(body, /opacity\s*:\s*0?\.[0-9]+/, "a blocked control must be visibly muted");
  assert.match(body, /cursor\s*:\s*not-allowed/, "the pointer must not promise a tap that does nothing");
  assert.match(body, /box-shadow\s*:\s*none/, "the accent glow must not survive into the disabled state");
});
