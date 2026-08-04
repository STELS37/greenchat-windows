// T006–T009 at the level a person actually sees: the four on-chain sheets.
//
// These tests drive wallet_ops.ts directly rather than through createFinanceScreen, for a measured
// reason: the sheets mount through the hub's `openSheet` callback, and the DOM stub has no
// document.body. Injecting the mount keeps the assertions on what the sheet renders and what it
// sends, which is exactly where a money bug would live.
//
// Every fixture number is a canonical nano string, the way the server emits it (PAYMENTS §21).
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { MoneyApi, WalletResult } from "../src/screens/money_api.ts";
import { depositChains, heldTotal, openDeposit, openPin, openWhitelist, openWithdraw, type WalletOpsDeps } from "../src/screens/wallet_ops.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const NOW = 1_800_000_000;

const WALLET: WalletResult = {
  total_usd: "12500000000",
  assets: [
    {
      id: "tUSDT", name: "Test USDT", kind: "demo", scale: 9, chain: "mock", chain_decimals: 6,
      enabled: true, min_amount: "1000000000", max_amount: "1000000000000",
      withdraw_fee: "500000000", balance: "12500000000", hold: "2000000000",
      available: "10500000000", usd_rate: "1000000000", usd_value: "12500000000",
    },
  ],
  payment_settings: { has_pin: true, two_factor_enabled: false, pin_required_usd: "20", security_hold_until: 0 },
};

/** A MoneyApi where every method fails loudly unless the test opted into it. */
function stubMoney(overrides: Partial<MoneyApi>): MoneyApi {
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
  return { ...base, ...overrides };
}

interface Harness {
  deps: WalletOpsDeps;
  panel(): StubNode;
  changes: string[];
  closed(): number;
}

function harness(money: MoneyApi): Harness {
  let panel: StubNode | null = null;
  let closed = 0;
  const changes: string[] = [];
  const deps: WalletOpsDeps = {
    money, i18n,
    openSheet: (node) => { panel = node as unknown as StubNode; },
    closeSheet: () => { closed += 1; },
    onChanged: (message) => changes.push(message),
    now: () => NOW,
  };
  return {
    deps,
    panel: () => {
      assert.ok(panel, "no sheet was mounted");
      return panel as unknown as StubNode;
    },
    changes,
    closed: () => closed,
  };
}

const buttonWith = (root: StubNode, needle: string): StubNode => {
  const match = root.findAll((node) => node.tag === "button" && node.textContent.includes(needle))[0];
  assert.ok(match, `no button containing "${needle}" in: ${root.textContent}`);
  return match as StubNode;
};

// ── T006 deposit ────────────────────────────────────────────────────────────────────────────────

test("the deposit sheet shows the server address and the confirmation progress", async () => {
  const asked: string[] = [];
  const h = harness(stubMoney({
    depositAddress: (chain: string) => { asked.push(chain); return Promise.resolve({ chain, address: "mock1qexampleaddress", derivation_index: 3 }); },
    deposits: () => Promise.resolve({ items: [
      { id: 1, chain: "mock", asset: "tUSDT", txid: "0xaa", vout: 0, amount: "2500000000", confirmations: 1,
        need_confirmations: 3, status: "seen", credited_tx_id: null, created_at: NOW - 60, updated_at: NOW },
    ] }),
  }));
  openDeposit(h.deps, WALLET);
  await settle();
  const text = h.panel().textContent;
  assert.deepEqual(asked, ["mock"], "the sheet must ask for the wallet's own chain");
  assert.ok(text.includes("mock1qexampleaddress"), `address missing: ${text}`);
  // 2.5 tUSDT, not 2 500 000 000.
  assert.ok(text.includes("2.5"), `deposit amount not scaled: ${text}`);
  assert.ok(!/2[\s  ]?500[\s  ]?000[\s  ]?000/.test(text), `nano leaked: ${text}`);
  assert.ok(text.includes("Confirmations: 1 of 3"), `confirmation progress missing: ${text}`);
});

test("a chain the server refuses degrades to an honest unavailable line, not a fake address", async () => {
  const err = Object.assign(new Error("chain off"), { name: "ApiError", code: "CHAIN_UNAVAILABLE" });
  const h = harness(stubMoney({
    depositAddress: () => Promise.reject(err),
    deposits: () => Promise.resolve({ items: [] }),
  }));
  openDeposit(h.deps, WALLET);
  await settle();
  const text = h.panel().textContent;
  // The line used to be the contour-wide "not enabled for this account or environment", which is a
  // different fact: the contour IS on, one network is down and will come back. Now the sheet says
  // exactly that — still no invented address, and still not the nameless "Something went wrong".
  assert.ok(text.includes(i18n.error("CHAIN_UNAVAILABLE")), `expected the network-down wording: ${text}`);
  assert.ok(!text.includes(i18n.t("errors.unknown")), `the refusal must not degrade to the generic line: ${text}`);
  assert.ok(!text.includes("mock1q"), "no address may be invented when the chain is off");
});

test("depositChains lists only enabled on-chain assets, once each", () => {
  const chains = depositChains([
    ...WALLET.assets,
    { ...WALLET.assets[0]!, id: "tBTC", chain: "mock" },
    { ...WALLET.assets[0]!, id: "OFF", chain: "evm", enabled: false },
    { ...WALLET.assets[0]!, id: "GUSD", chain: null },
  ]);
  assert.deepEqual(chains, ["mock"]);
});

// ── the phantom network (measured 2026-08-04, state/outbox/2026-08-04-wallet-phantom-chain) ─────
//
// On the LIVE database the only enabled chain-carrying asset is GUSD with `chain='sol'`, and `sol`
// has no adapter in server/src/modules/onchain.ts in any configuration — the probe got 404 NOT_FOUND
// for it in all three runs, while the control run with GC_CHAIN_MOCK=1 got 200 for `mock`. So the
// route is sound and the network was imaginary. An asset's `chain` is a denomination LABEL; only
// GET /v1/wallet/chains states which rails this deployment can actually serve.
const PHANTOM_WALLET: WalletResult = {
  ...WALLET,
  assets: [
    // Exactly the production row: enabled, carries a chain, and that chain has no adapter anywhere.
    {
      id: "GUSD", name: "GreenChat USD", kind: "stable", scale: 9, chain: "sol", chain_decimals: 9,
      enabled: true, min_amount: "0", max_amount: "0", withdraw_fee: "0",
      balance: "0", hold: "0", available: "0", usd_rate: "1000000000", usd_value: "0",
    },
    ...WALLET.assets,
  ],
} as unknown as WalletResult;

test("depositChains drops a network the server did not say it can serve", () => {
  // Absent argument = "the client has not asked yet", which must NOT be read as "serves nothing":
  // the two are different states and collapsing them would empty a picker that has live rails.
  assert.deepEqual(depositChains(PHANTOM_WALLET.assets).sort(), ["mock", "sol"]);
  assert.deepEqual(depositChains(PHANTOM_WALLET.assets, ["mock"]), ["mock"], "sol has no rail here");
  assert.deepEqual(depositChains(PHANTOM_WALLET.assets, []), [], "a deployment with no rail offers none");
  // A chain the server serves but no asset is denominated in is not offerable either: a deposit needs
  // both halves, and the intersection is what makes that true in one place.
  assert.deepEqual(depositChains(PHANTOM_WALLET.assets, ["ton"]), []);
});

test("the deposit sheet never offers a network the server cannot serve", async () => {
  const asked: string[] = [];
  const h = harness(stubMoney({
    walletChains: () => Promise.resolve({
      chains: [{ chain: "mock", deposits: true, withdrawals: true }],
      frozen: false,
    }),
    depositAddress: (chain: string) => { asked.push(chain); return Promise.resolve({ chain, address: "mock1qexampleaddress", derivation_index: 3 }); },
    deposits: () => Promise.resolve({ items: [] }),
  }));
  openDeposit(h.deps, PHANTOM_WALLET);
  await settle();
  const panel = h.panel();
  const options = panel.findAll((n) => n.tag === "option").map((n) => n.attrs.value);
  assert.deepEqual(options, ["mock"], "SOL was offered on the live shape and answered 404 every time");
  assert.deepEqual(asked, ["mock"], "the sheet must ask only for a chain the server named");
  assert.ok(panel.textContent.includes("mock1qexampleaddress"));
});

test("a deployment with no rail at all shows the reason and asks for no address", async () => {
  let addressCalls = 0;
  const h = harness(stubMoney({
    walletChains: () => Promise.resolve({ chains: [], frozen: false }),
    depositAddress: () => { addressCalls += 1; return Promise.reject(new Error("must not be called")); },
    deposits: () => Promise.resolve({ items: [] }),
  }));
  openDeposit(h.deps, PHANTOM_WALLET);
  await settle();
  const panel = h.panel();
  assert.equal(addressCalls, 0, "asking for an address on a rail that does not exist is the defect");
  assert.equal(panel.findAll((n) => n.tag === "select").length, 0, "no picker, not an empty picker");
  assert.ok(panel.textContent.includes(i18n.t("finance.noChains")), `the sheet must say why: ${panel.textContent}`);
});

test("a server too old to answer /v1/wallet/chains keeps the previous behaviour", async () => {
  // The degradation that matters: an unknown answer must not empty the picker, because a deployment
  // WITH live rails would then look dead. It falls back to the label-derived list and any bad chain
  // fails loudly on its own address request, exactly as it did before the filter existed.
  const asked: string[] = [];
  const h = harness(stubMoney({
    walletChains: () => Promise.reject(Object.assign(new Error("no such route"), { name: "ApiError", code: "NOT_FOUND" })),
    depositAddress: (chain: string) => { asked.push(chain); return Promise.resolve({ chain, address: "mock1qexampleaddress", derivation_index: 3 }); },
    deposits: () => Promise.resolve({ items: [] }),
  }));
  openDeposit(h.deps, WALLET);
  await settle();
  assert.deepEqual(asked, ["mock"]);
  assert.ok(h.panel().textContent.includes("mock1qexampleaddress"));
});

// ── T007 withdrawal ─────────────────────────────────────────────────────────────────────────────

function withdrawHarness(extra: Partial<MoneyApi> = {}): Harness {
  return harness(stubMoney({
    whitelist: () => Promise.resolve({ items: [
      { id: 5, chain: "mock", address: "mock1qready", label: "Cold", active_after: NOW - 10, created_at: NOW - 90_000 },
      { id: 6, chain: "mock", address: "mock1qfresh", label: "New", active_after: NOW + 3600, created_at: NOW },
    ] }),
    withdrawals: () => Promise.resolve({ items: [] }),
    ...extra,
  }));
}

test("the withdrawal fee and the net amount are shown BEFORE the request", async () => {
  const h = withdrawHarness();
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  const amount = panel.findAll((n) => n.tag === "input" && n.attrs.inputmode === "decimal")[0] as StubNode;
  amount.value = "3";
  amount.dispatch("input");
  const preview = panel.find((n) => n.hasClass("gc-finance-preview")) as StubNode;
  // withdraw_fee 0.5 → the address receives 2.5 of the 3 sent.
  assert.ok(preview.textContent.includes("0.5"), `fee missing: ${preview.textContent}`);
  assert.ok(preview.textContent.includes("2.5"), `net amount missing: ${preview.textContent}`);
});

test("an amount below the asset minimum is refused client-side and never sent", async () => {
  const h = withdrawHarness();
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  const amount = panel.findAll((n) => n.tag === "input" && n.attrs.inputmode === "decimal")[0] as StubNode;
  amount.value = "0.4";
  amount.dispatch("input");
  const preview = panel.find((n) => n.hasClass("gc-finance-preview")) as StubNode;
  assert.equal(preview.textContent, i18n.t("finance.amountBelowMin"));
  const form = panel.find((n) => n.tag === "form") as StubNode;
  form.dispatch("submit");
  await settle();
  // createWithdrawal is a trap in this harness: reaching it would reject and fail the test.
  assert.deepEqual(h.changes, []);
});

test("only a whitelisted address that has finished its 24h wait is selectable", async () => {
  const h = withdrawHarness();
  openWithdraw(h.deps, WALLET);
  await settle();
  const options = h.panel().findAll((n) => n.tag === "option" && String(n.attrs.value).startsWith("mock|"));
  assert.equal(options.length, 2);
  const ready = options.find((o) => o.attrs.value === "mock|mock1qready") as StubNode;
  const fresh = options.find((o) => o.attrs.value === "mock|mock1qfresh") as StubNode;
  assert.equal(ready.attrs.disabled, undefined, "an active address must be selectable");
  assert.ok("disabled" in fresh.attrs, "an address still cooling down must be disabled");
  assert.ok(fresh.textContent.includes("Active in"), `remaining wait missing: ${fresh.textContent}`);
});

test("a submitted withdrawal sends the full nano amount, the PIN and an idempotency key", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const h = withdrawHarness({
    createWithdrawal: (body) => { sent.push(body as unknown as Record<string, unknown>); return Promise.resolve({ withdrawal: { id: 9 } as never, tx_id: 11 }); },
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  (panel.findAll((n) => n.tag === "input" && n.attrs.inputmode === "decimal")[0] as StubNode).value = "3";
  (panel.findAll((n) => n.tag === "input" && n.attrs.type === "password")[0] as StubNode).value = "1234";
  (panel.find((n) => n.tag === "select" && n.children.some((c) => String(c.attrs.value).startsWith("mock|"))) as StubNode).value = "mock|mock1qready";
  (panel.find((n) => n.tag === "form") as StubNode).dispatch("submit");
  await settle();
  assert.equal(sent.length, 1);
  const body = sent[0] as Record<string, string>;
  assert.equal(body.amount, "3000000000", "the wire carries nano, and the FULL amount — the server subtracts the fee");
  assert.equal(body.to_address, "mock1qready");
  assert.equal(body.chain, "mock");
  assert.equal(body.pin, "1234");
  assert.ok(typeof body.client_op_id === "string" && body.client_op_id.length > 0, "a replay key is mandatory");
  assert.equal(body.code, undefined, "no second factor is sent when the field is empty");
  assert.deepEqual(h.changes, [i18n.t("finance.withdrawalCreated")]);
});

test("a network fee is labelled with the state the server gave it", async () => {
  const h = withdrawHarness({
    withdrawals: () => Promise.resolve({ items: [
      { id: 3, chain: "mock", asset: "tUSDT", to_address: "mock1qready", amount: "3000000000", fee: "500000000",
        network_fee_asset: "tUSDT", network_fee_amount: "100000000", network_fee_actual: null,
        network_fee_state: "estimated_ceiling", status: "pending_review", txid: null, error: null,
        client_op_id: "wd-1", created_at: NOW - 5, updated_at: NOW },
    ] }),
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes(i18n.t("finance.networkFeeCeiling")), `fee state missing: ${text}`);
  assert.ok(text.includes(i18n.t("finance.withdrawStatus.pending_review")), `status missing: ${text}`);
  assert.ok(text.includes(i18n.t("finance.cancelWithdrawal")), "a pending withdrawal must offer cancel");
});

test("cancelling a pending withdrawal calls the server and reports it", async () => {
  const cancelled: number[] = [];
  const h = withdrawHarness({
    withdrawals: () => Promise.resolve({ items: [
      { id: 42, chain: "mock", asset: "tUSDT", to_address: "mock1qready", amount: "3000000000", fee: "500000000",
        network_fee_asset: null, network_fee_amount: null, network_fee_actual: null, network_fee_state: null,
        status: "pending_review", txid: null, error: null, client_op_id: "wd-2", created_at: NOW, updated_at: NOW },
    ] }),
    cancelWithdrawal: (id: number) => { cancelled.push(id); return Promise.resolve({ withdrawal: { id } as never, tx_id: null }); },
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  buttonWith(h.panel(), i18n.t("finance.cancelWithdrawal")).dispatch("click");
  await settle();
  assert.deepEqual(cancelled, [42]);
  assert.deepEqual(h.changes, [i18n.t("finance.withdrawalCancelled")]);
});

// The mirror of the test above, and the reason it exists: an APPROVED withdrawal is already
// released for signing, and core/chain.ts cancelWithdrawalInTx answers STATE_INVALID 409 for every
// status except pending_review (asserted in server/test/unit/chain.test.ts). A cancel button there
// is a promise the server always breaks, so the sheet must not draw one.
test("an approved withdrawal offers no cancel, because the server always refuses it", async () => {
  const h = withdrawHarness({
    withdrawals: () => Promise.resolve({ items: [
      { id: 43, chain: "mock", asset: "tUSDT", to_address: "mock1qready", amount: "3000000000", fee: "500000000",
        network_fee_asset: null, network_fee_amount: null, network_fee_actual: null, network_fee_state: null,
        status: "approved", txid: null, error: null, client_op_id: "wd-3", created_at: NOW, updated_at: NOW },
    ] }),
  });
  openWithdraw(h.deps, WALLET);
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes(i18n.t("finance.withdrawStatus.approved")), `status must still be shown: ${text}`);
  assert.equal(
    h.panel().findAll((n) => n.tag === "button" && n.textContent.includes(i18n.t("finance.cancelWithdrawal"))).length,
    0,
    "an approved withdrawal must not offer a cancel the server refuses with STATE_INVALID",
  );
});

// ── T008 whitelist ──────────────────────────────────────────────────────────────────────────────

test("the whitelist shows the 24h wait and adds an address with its chain", async () => {
  const added: Array<Record<string, unknown>> = [];
  const h = harness(stubMoney({
    whitelist: () => Promise.resolve({ items: [
      { id: 6, chain: "mock", address: "mock1qfresh", label: null, active_after: NOW + 7200, created_at: NOW },
    ] }),
    addWhitelist: (body) => { added.push(body as unknown as Record<string, unknown>); return Promise.resolve({ id: 7 } as never); },
  }));
  openWhitelist(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  assert.ok(panel.textContent.includes("Active in 2 h 0 min"), `wait text missing: ${panel.textContent}`);
  (panel.findAll((n) => n.tag === "input" && n.attrs.type === "text")[0] as StubNode).value = "mock1qnew";
  (panel.find((n) => n.tag === "form") as StubNode).dispatch("submit");
  await settle();
  assert.deepEqual(added, [{ chain: "mock", address: "mock1qnew", label: null }]);
  const status = panel.find((n) => n.hasClass("gc-sheet-status")) as StubNode;
  assert.equal(status.textContent, i18n.t("finance.whitelistAdded"));
});

// ── T009 payment PIN ────────────────────────────────────────────────────────────────────────────

test("changing an existing PIN warns about the security hold and closes the sheet", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const h = harness(stubMoney({
    setWalletPin: (body) => { sent.push(body as unknown as Record<string, unknown>); return Promise.resolve({ has_pin: true as const }); },
  }));
  openPin(h.deps, WALLET);
  await settle();
  const panel = h.panel();
  const passwords = panel.findAll((n) => n.tag === "input" && n.attrs.type === "password");
  (passwords[0] as StubNode).value = "correct horse";
  (passwords[1] as StubNode).value = "4821";
  (panel.find((n) => n.tag === "form") as StubNode).dispatch("submit");
  await settle();
  assert.deepEqual(sent, [{ password: "correct horse", pin: "4821" }]);
  assert.deepEqual(h.changes, [i18n.t("finance.pinChangedHold")], "a PIN change holds withdrawals — say so");
  assert.equal(h.closed(), 1);
});

test("the second-factor field appears only when the account has one", async () => {
  const h = harness(stubMoney({ setWalletPin: () => Promise.resolve({ has_pin: true as const }) }));
  openPin(h.deps, WALLET);
  await settle();
  assert.ok(!h.panel().textContent.includes(i18n.t("finance.twoFactorCode")));

  const h2 = harness(stubMoney({ setWalletPin: () => Promise.resolve({ has_pin: true as const }) }));
  openPin(h2.deps, { ...WALLET, payment_settings: { ...WALLET.payment_settings, two_factor_enabled: true } });
  await settle();
  assert.ok(h2.panel().textContent.includes(i18n.t("finance.twoFactorCode")));
});

test("heldTotal sums the nano hold across assets", () => {
  assert.equal(heldTotal(WALLET.assets), 2_000_000_000n);
  assert.equal(heldTotal([]), 0n);
});
