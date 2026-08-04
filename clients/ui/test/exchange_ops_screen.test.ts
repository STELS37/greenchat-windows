// T010–T013 at the level a trader actually sees: the four exchange surfaces, plus the wiring that
// was the whole point of the campaign.
//
// The measured defect this file guards is not a formatting slip — it is a dead end. The markets view
// rendered prices and then stopped: `finance_screen.ts` imported nothing from the trading module, so
// a market row was an inert <article>, and the server's central limit order book (CLOB) was
// unreachable from the application. The first test therefore drives the REAL screen through a stub
// transport and clicks a market row, because only that proves the row leads somewhere.
//
// The rest drive exchange_ops.ts directly, the same way wallet_ops_screen.test.ts does: the sheets
// mount through the hub's `openSheet` callback, and injecting that mount keeps every assertion on
// what the sheet renders and what it sends — which is exactly where a money bug would live.
//
// Every fixture amount is a canonical nano string, the way the server emits it (PAYMENTS §21).
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import type { ExMyTradeRow, ExOrderRow, ExPairRow, SwapQuoteRow } from "../src/screens/finance_model.ts";
import type { MoneyApi, WalletResult } from "../src/screens/money_api.ts";
import { changeText, openActivity, openPair, openSwap, previewProblemText, type ExchangeOpsDeps } from "../src/screens/exchange_ops.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
// The hub mounts its sheets into document.body. The stub has no body of its own, so the test owns
// one: without it the click path under test would throw instead of rendering.
const documentStub = globalThis.document as unknown as { body: StubNode; createElement(tag: string): StubNode };
documentStub.body = documentStub.createElement("body");

const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const NOW = 1_800_000_000;

/**
 * tBTC/GUSD with real tick/step/notional and non-zero fees.
 * `kind` is "crypto"/"stable" on purpose: a demo asset zeroes exchange fees server-side
 * (pairHasDemoAsset), and a zero fee would hide the very number T011 is about.
 */
const PAIR: ExPairRow = {
  id: "tBTC/GUSD",
  base_asset: "tBTC",
  quote_asset: "GUSD",
  price_tick: "1000000000", // 1 GUSD
  lot_step: "1000000", // 0.001 tBTC
  min_notional: "1000000000", // 1 GUSD
  maker_fee_bp: "10", // 0.10 %
  taker_fee_bp: "20", // 0.20 %
  enabled: true,
  mode: "active",
};

const WALLET: WalletResult = {
  total_usd: "100000000000",
  assets: [
    {
      id: "GUSD", name: "Green USD", kind: "stable", scale: 9, chain: null, chain_decimals: null,
      enabled: true, min_amount: "1000000000", max_amount: "1000000000000", withdraw_fee: "0",
      balance: "100000000000", hold: "0", available: "100000000000",
      usd_rate: "1000000000", usd_value: "100000000000",
    },
    {
      id: "tBTC", name: "Test BTC", kind: "crypto", scale: 9, chain: "mock", chain_decimals: 8,
      enabled: true, min_amount: "1000000", max_amount: "1000000000000", withdraw_fee: "1000000",
      balance: "2000000000", hold: "0", available: "2000000000",
      usd_rate: "100000000000", usd_value: "200000000000",
    },
  ],
  payment_settings: { has_pin: true, two_factor_enabled: false, pin_required_usd: "20", security_hold_until: 0 },
};

const TICKER = {
  pair: PAIR.id, last: "101500000000", mid: "101450000000", high_24h: "102000000000", low_24h: "99000000000",
  vol_base_24h: "3500000000", vol_quote_24h: "355250000000",
};

const DEPTH = {
  pair: PAIR.id,
  bids: [{ price: "100000000000", qty: "250000000" }],
  asks: [{ price: "101000000000", qty: "500000000" }],
};

const TRADES = [{
  id: 1, pair: PAIR.id, maker_order_id: 4, taker_order_id: 5,
  price: "100500000000", qty: "125000000", notional: "12562500000",
  maker_fee: "125000", taker_fee: "250000", created_at: NOW - 30,
}];

const CANDLES = [
  { ts: NOW - 7200, o: "99000000000", h: "100000000000", l: "98000000000", c: "99500000000", vol_base: "1000000000", vol_quote: "99500000000" },
  { ts: NOW - 3600, o: "99500000000", h: "102000000000", l: "99500000000", c: "101500000000", vol_base: "2000000000", vol_quote: "203000000000" },
];

const OPEN_ORDER: ExOrderRow = {
  id: 77, pair: PAIR.id, side: "buy", type: "limit", price: "100000000000", qty: "500000000",
  filled_qty: "100000000", hold_amount: "50000000000", hold_remaining: "40000000000",
  slippage_cap: null, status: "open", tif: "GTC", post_only: false, trigger_price: null,
  oco_group_id: null, created_at: NOW - 600, updated_at: NOW - 60,
};

const FILLED_ORDER: ExOrderRow = { ...OPEN_ORDER, id: 78, status: "filled", filled_qty: "500000000" };

const MY_TRADE: ExMyTradeRow = {
  id: 9, pair: PAIR.id, order_id: 77, role: "maker", side: "buy",
  price: "100000000000", qty: "100000000", notional: "10000000000",
  fee: "100000", fee_asset: "tBTC", created_at: NOW - 60,
};

/** A MoneyApi where every method fails loudly unless the test opted into it. */
function stubMoney(overrides: Partial<MoneyApi>): MoneyApi {
  const trap = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const base = {
    wallet: trap("wallet"), walletHistory: trap("walletHistory"), depositAddress: trap("depositAddress"),
    deposits: trap("deposits"), withdrawals: trap("withdrawals"), createWithdrawal: trap("createWithdrawal"),
    cancelWithdrawal: trap("cancelWithdrawal"), whitelist: trap("whitelist"), addWhitelist: trap("addWhitelist"),
    deleteWhitelist: trap("deleteWhitelist"), setWalletPin: trap("setWalletPin"), pairs: trap("pairs"),
    tickers: trap("tickers"), ticker: trap("ticker"), depth: trap("depth"), trades: trap("trades"),
    candles: trap("candles"), orders: trap("orders"), placeOrder: trap("placeOrder"),
    cancelOrder: trap("cancelOrder"), myTrades: trap("myTrades"), swapQuote: trap("swapQuote"), swap: trap("swap"),
  } as unknown as MoneyApi;
  return { ...base, ...overrides };
}

/** The market-data half every pair sheet needs, so each test only states what it is really about. */
const marketData: Partial<MoneyApi> = {
  ticker: () => Promise.resolve({ ticker: TICKER }),
  depth: () => Promise.resolve(DEPTH),
  trades: () => Promise.resolve({ trades: TRADES }),
  candles: () => Promise.resolve({ pair: PAIR.id, tf: "1h", candles: CANDLES }),
  orders: () => Promise.resolve({ orders: [] }),
};

interface Harness {
  deps: ExchangeOpsDeps;
  panel(): StubNode;
  changes: string[];
  closed(): number;
  /** Fire every pending injected interval tick once. */
  tick(): void;
  now: { value: number };
}

function harness(money: MoneyApi): Harness {
  let panel: StubNode | null = null;
  let closed = 0;
  const changes: string[] = [];
  const ticks: Array<() => void> = [];
  const now = { value: NOW };
  const deps: ExchangeOpsDeps = {
    money, i18n,
    openSheet: (node) => { panel = node as unknown as StubNode; },
    closeSheet: () => { closed += 1; },
    onChanged: (message) => changes.push(message),
    now: () => now.value,
    interval: (fn) => {
      ticks.push(fn);
      return () => {
        const index = ticks.indexOf(fn);
        if (index >= 0) ticks.splice(index, 1);
      };
    },
  };
  return {
    deps,
    panel: () => {
      assert.ok(panel, "no sheet was mounted");
      return panel as unknown as StubNode;
    },
    changes,
    closed: () => closed,
    tick: () => { for (const fn of [...ticks]) fn(); },
    now,
  };
}

const buttonWith = (root: StubNode, needle: string): StubNode => {
  const match = root.findAll((node) => node.tag === "button" && node.textContent.includes(needle))[0];
  assert.ok(match, `no button containing "${needle}" in: ${root.textContent}`);
  return match as StubNode;
};

const previewOf = (panel: StubNode): StubNode =>
  panel.find((node) => node.hasClass("gc-finance-preview")) as StubNode;

// ── the wiring itself: a market row must lead into the trading sheet ─────────────────────────────

/** The exchange view of the hub, served by a stub transport that records every path it is asked. */
class ExchangeApi implements ApiLike {
  readonly seen: string[] = [];
  get<T>(path: string): Promise<T> {
    this.seen.push(path);
    // The screen asks the server whether the money contour exists at all before it fetches anything
    // from it (finance_screen.ts, contourOff). This stub serves a deployment with GC_PAYMENTS=1,
    // which is the only deployment where the assertions below are meaningful.
    if (path === "/v1/config") return Promise.resolve({ features: { payments: true, cards: false } } as unknown as T);
    if (path === "/v1/ex/pairs") return Promise.resolve({ pairs: [PAIR] } as unknown as T);
    if (path === "/v1/ex/tickers") return Promise.resolve({ tickers: [TICKER] } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(WALLET as unknown as T);
    if (path.startsWith("/v1/ex/ticker/")) return Promise.resolve({ ticker: TICKER } as unknown as T);
    if (path.startsWith("/v1/ex/depth/")) return Promise.resolve(DEPTH as unknown as T);
    if (path.startsWith("/v1/ex/trades/")) return Promise.resolve({ trades: TRADES } as unknown as T);
    if (path.startsWith("/v1/ex/candles/")) return Promise.resolve({ pair: PAIR.id, tf: "1h", candles: CANDLES } as unknown as T);
    if (path.startsWith("/v1/ex/orders")) return Promise.resolve({ orders: [OPEN_ORDER] } as unknown as T);
    if (path === "/v1/ex/my_trades") return Promise.resolve({ trades: [MY_TRADE] } as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function renderExchange(): Promise<{ root: StubNode; api: ExchangeApi }> {
  documentStub.body.children = [];
  const api = new ExchangeApi();
  const screen = createFinanceScreen({ api, i18n, view: "exchange", onNavigate() {}, onBack() {} });
  await settle();
  return { root: screen.root as unknown as StubNode, api };
}

const mounted = (): StubNode => {
  const layer = documentStub.body.children[0];
  assert.ok(layer, "the hub mounted no sheet: the market surface is still a dead end");
  return layer as StubNode;
};

test("a market row opens the pair sheet — the row is an action, not a label", async () => {
  const { root, api } = await renderExchange();
  const row = root.findAll((node) => node.tag === "button" && node.hasClass("gc-market-row"))[0];
  assert.ok(row, `no market row rendered as a button: ${root.textContent}`);
  // 101.5, not 101 500 000 000: the row shares the hub's nano formatter.
  assert.ok(root.textContent.includes("101.5"), `ticker price missing from the row: ${root.textContent}`);
  row.dispatch("click");
  await settle();
  const sheet = mounted();
  assert.ok(sheet.textContent.includes(PAIR.id), `the sheet is not the pair sheet: ${sheet.textContent}`);
  assert.ok(sheet.textContent.includes(i18n.t("finance.placeOrder")), "the order ticket is missing from the pair sheet");
  assert.ok(sheet.textContent.includes(i18n.t("finance.orderBook")), "the order book is missing from the pair sheet");
  // The four market-data reads of T010 all happened against the real transport.
  for (const prefix of ["/v1/ex/ticker/", "/v1/ex/depth/", "/v1/ex/trades/", "/v1/ex/candles/"]) {
    assert.ok(api.seen.some((path) => path.startsWith(prefix)), `${prefix} was never requested: ${api.seen.join(", ")}`);
  }
  // The pair travels as ONE segment; "/v1/ex/ticker/tBTC/GUSD" would be five segments and 404.
  assert.ok(api.seen.includes("/v1/ex/ticker/tBTC%2FGUSD"), `pair encoding broken: ${api.seen.join(", ")}`);
});

test("the exchange hero opens the account-wide activity and swap sheets", async () => {
  const { root } = await renderExchange();
  buttonWith(root, i18n.t("finance.openOrders")).dispatch("click");
  await settle();
  assert.ok(mounted().textContent.includes(i18n.t("finance.myTrades")), "the activity sheet did not open");
  documentStub.body.children = [];
  buttonWith(root, i18n.t("finance.swap")).dispatch("click");
  await settle();
  assert.ok(mounted().textContent.includes(i18n.t("finance.getQuote")), "the swap sheet did not open");
});

// ── T010 market data ────────────────────────────────────────────────────────────────────────────

test("the pair sheet renders ticker, depth, tape and chart in units, never in nano", async () => {
  const h = harness(stubMoney(marketData));
  openPair(h.deps, PAIR, WALLET);
  await settle();
  const panel = h.panel();
  const text = panel.textContent;
  assert.ok(text.includes("101.5"), `last price missing: ${text}`);
  assert.ok(text.includes("99"), `24h low missing: ${text}`);
  // Best bid 100 / best ask 101 → a spread of exactly 1.
  assert.ok(text.includes(`${i18n.t("finance.spread")}: 1`), `spread not computed from the book: ${text}`);
  assert.ok(text.includes("0.25"), `bid size missing from the ladder: ${text}`);
  assert.ok(text.includes("100.5"), `trade tape missing: ${text}`);
  assert.ok(panel.find((node) => node.tag === "polyline"), "the candle sparkline was not drawn");
  // The exact shape of the T020 defect, in the surface added after it.
  assert.ok(!/101[\s  ]?500[\s  ]?000[\s  ]?000/.test(text), `nano string leaked into the pair sheet: ${text}`);
});

test("changeText turns basis points into a signed percent and refuses to invent one", () => {
  assert.equal(changeText(null), "—");
  assert.equal(changeText(0), "0.00%");
  assert.equal(changeText(202), "+2.02%");
  assert.equal(changeText(-125), "-1.25%");
});

// ── T011 the order ticket ───────────────────────────────────────────────────────────────────────

function fillTicket(panel: StubNode, qty: string, price: string): void {
  const inputs = panel.findAll((node) => node.tag === "input" && node.attrs.inputmode === "decimal");
  const qtyInput = inputs[0] as StubNode;
  const priceInput = inputs[1] as StubNode;
  qtyInput.value = qty;
  priceInput.value = price;
  qtyInput.dispatch("input");
}

test("hold, both fees and the worst-case receipt are shown BEFORE the order is sent", async () => {
  const h = harness(stubMoney(marketData));
  openPair(h.deps, PAIR, WALLET);
  await settle();
  const panel = h.panel();
  fillTicket(panel, "0.5", "100"); // buy 0.5 tBTC at 100 GUSD
  const preview = previewOf(panel).textContent;
  // hold = 0.5 × 100 = 50 GUSD; maker 10 bp and taker 20 bp of the RECEIVED leg (0.5 tBTC);
  // worst case = 0.5 − 0.001 = 0.499 tBTC.
  assert.ok(preview.includes("50"), `hold amount missing: ${preview}`);
  assert.ok(preview.includes("GUSD"), `the hold asset must be named: ${preview}`);
  assert.ok(preview.includes("0.0005"), `maker fee missing: ${preview}`);
  assert.ok(preview.includes("0.001"), `taker fee missing: ${preview}`);
  assert.ok(preview.includes("0.499"), `worst-case receipt missing: ${preview}`);
  assert.ok(preview.includes("GTC"), `time in force missing: ${preview}`);
  // placeOrder is a trap in this harness: a preview that submitted would reject and fail here.
  assert.deepEqual(h.changes, []);
});

test("a submitted order carries the nano qty, the nano price and an idempotency key", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const h = harness(stubMoney({
    ...marketData,
    placeOrder: (body) => {
      sent.push(body as unknown as Record<string, unknown>);
      return Promise.resolve({ order: { ...OPEN_ORDER, status: "open" }, trades: [] });
    },
  }));
  openPair(h.deps, PAIR, WALLET);
  await settle();
  const panel = h.panel();
  fillTicket(panel, "0.5", "100");
  (panel.find((node) => node.tag === "form") as StubNode).dispatch("submit");
  await settle();
  assert.equal(sent.length, 1, "the order was not sent");
  const body = sent[0]!;
  assert.equal(body.pair, PAIR.id);
  assert.equal(body.side, "buy");
  assert.equal(body.type, "limit");
  assert.equal(body.qty, "500000000");
  assert.equal(body.price, "100000000000");
  assert.equal(body.tif, "GTC");
  assert.ok(typeof body.client_order_id === "string" && body.client_order_id.length > 0,
    "an order without a client_order_id cannot be deduplicated by the server");
  assert.deepEqual(h.changes, [i18n.t("finance.orderPlaced")]);
});

test("an order below the pair minimum is refused client-side and never reaches the server", async () => {
  const h = harness(stubMoney(marketData));
  openPair(h.deps, PAIR, WALLET);
  await settle();
  const panel = h.panel();
  fillTicket(panel, "0.001", "100"); // notional 0.1 GUSD < min_notional 1 GUSD
  const preview = previewOf(panel);
  assert.ok(preview.textContent.includes(i18n.t("finance.minNotional", { min: "1" })),
    `expected the minimum-notional wording: ${preview.textContent}`);
  const submit = buttonWith(panel, i18n.t("finance.placeOrder"));
  assert.ok("disabled" in submit.attrs, "a rejected ticket must not offer a live submit button");
  (panel.find((node) => node.tag === "form") as StubNode).dispatch("submit");
  await settle();
  // placeOrder is a trap: reaching it would reject and fail this test.
  assert.deepEqual(h.changes, []);
});

test("a halted pair still shows its market data but refuses to collect an order", async () => {
  const h = harness(stubMoney(marketData));
  openPair(h.deps, { ...PAIR, mode: "halted" }, WALLET);
  await settle();
  const panel = h.panel();
  assert.ok(panel.textContent.includes("101.5"), "market data must stay visible on a halted pair");
  assert.equal(previewOf(panel).textContent, i18n.t("finance.marketHalted"));
  assert.ok("disabled" in buttonWith(panel, i18n.t("finance.placeOrder")).attrs,
    "the server rejects every order on a halted pair, so the button must not promise otherwise");
});

test("previewProblemText names the field at fault instead of a generic refusal", () => {
  const distinct = new Set([
    previewProblemText({ ok: false, problem: "qty_lot_step" } as never, PAIR, i18n),
    previewProblemText({ ok: false, problem: "price_tick" } as never, PAIR, i18n),
    previewProblemText({ ok: false, problem: "min_notional" } as never, PAIR, i18n),
    previewProblemText({ ok: false, problem: "insufficient" } as never, PAIR, i18n),
  ]);
  assert.equal(distinct.size, 4, "four different problems must not collapse into one message");
  assert.equal(previewProblemText({ ok: true, problem: null } as never, PAIR, i18n), "");
});

// ── T012 my orders and my trades ────────────────────────────────────────────────────────────────

test("the activity sheet lists only cancellable orders and cancels the one that was clicked", async () => {
  const cancelled: number[] = [];
  const h = harness(stubMoney({
    orders: () => Promise.resolve({ orders: [OPEN_ORDER, FILLED_ORDER] }),
    myTrades: () => Promise.resolve({ trades: [MY_TRADE] }),
    cancelOrder: (id) => {
      cancelled.push(id);
      return Promise.resolve({ order: { ...OPEN_ORDER, status: "cancelled" }, trades: [] });
    },
  }));
  openActivity(h.deps);
  await settle();
  const panel = h.panel();
  const cancels = panel.findAll((node) => node.tag === "button" && node.textContent.includes(i18n.t("finance.cancelOrder")));
  // The server answers STATE_INVALID for a filled order, so exactly one row may offer a cancel.
  assert.equal(cancels.length, 1, "a filled order must not offer a cancel the server would refuse");
  assert.ok(panel.textContent.includes(i18n.t("finance.filledOf", { filled: "0.1", qty: "0.5" })),
    `fill progress missing or unscaled: ${panel.textContent}`);
  // The fee is named with its own asset, and 0.0001 tBTC is not 100000.
  assert.ok(panel.textContent.includes("0.0001 tBTC"), `my-trade fee missing or unscaled: ${panel.textContent}`);
  cancels[0]!.dispatch("click");
  await settle();
  assert.deepEqual(cancelled, [OPEN_ORDER.id]);
  assert.deepEqual(h.changes, [i18n.t("finance.orderCancelled")]);
});

test("an exchange that is switched off degrades to an honest unavailable line", async () => {
  const off = Object.assign(new Error("off"), { name: "ApiError", code: "PAYMENTS_DISABLED" });
  const h = harness(stubMoney({ orders: () => Promise.reject(off), myTrades: () => Promise.reject(off) }));
  openActivity(h.deps);
  await settle();
  assert.ok(h.panel().textContent.includes(i18n.t("finance.unavailable")),
    `expected the unavailable wording: ${h.panel().textContent}`);
});

// ── T013 instant swap ───────────────────────────────────────────────────────────────────────────

const QUOTE: SwapQuoteRow = {
  quote_id: 4242, from: "GUSD", to: "tBTC",
  amount_from: "50000000000", amount_to: "495000000",
  rate_from: "1000000000", rate_to: "100000000000",
  spread_bp: 25, expires_at: NOW + 30, created_at: NOW,
};

function swapHarness(extra: Partial<MoneyApi> = {}): Harness {
  return harness(stubMoney({ swapQuote: () => Promise.resolve(QUOTE), ...extra }));
}

async function quoteFor(h: Harness): Promise<StubNode> {
  openSwap(h.deps, WALLET);
  const panel = h.panel();
  (panel.find((node) => node.tag === "select") as StubNode).value = "GUSD";
  (panel.findAll((node) => node.tag === "select")[1] as StubNode).value = "tBTC";
  (panel.find((node) => node.tag === "input" && node.attrs.inputmode === "decimal") as StubNode).value = "50";
  (panel.find((node) => node.tag === "form") as StubNode).dispatch("submit");
  await settle();
  return panel;
}

test("a swap quote shows what arrives, at what rate, and how long it is still valid", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const h = swapHarness({ swapQuote: (body) => { sent.push(body as unknown as Record<string, unknown>); return Promise.resolve(QUOTE); } });
  const panel = await quoteFor(h);
  assert.deepEqual(sent, [{ from: "GUSD", to: "tBTC", amount: "50000000000" }],
    "the amount must leave as a nano string, not as the typed decimal");
  const text = panel.textContent;
  assert.ok(text.includes("0.495"), `received amount missing: ${text}`);
  // 0.495 tBTC for 50 GUSD → 1 GUSD = 0.0099 tBTC.
  assert.ok(text.includes("0.0099"), `unit rate missing: ${text}`);
  assert.ok(text.includes(i18n.t("finance.quoteExpires", { sec: "30" })), `countdown missing: ${text}`);
  assert.equal(buttonWith(panel, i18n.t("finance.confirmSwap")).attrs.disabled, undefined,
    "a live quote must be confirmable");
});

test("the PIN field appears exactly when the quote crosses the account threshold", async () => {
  const h = swapHarness();
  const panel = await quoteFor(h);
  // 50 USD of notional against a 20 USD threshold: modules/swaps.ts postSwap will demand a PIN.
  const pinInput = panel.find((node) => node.tag === "input" && node.attrs.type === "password") as StubNode;
  const pinField = pinInput.parent as StubNode;
  assert.ok(!("hidden" in pinField.attrs), "the server will demand a PIN, so the field must be visible");

  const small = { ...QUOTE, amount_from: "5000000000", amount_to: "49500000" }; // 5 USD < 20 USD
  const h2 = harness(stubMoney({ swapQuote: () => Promise.resolve(small) }));
  const panel2 = await quoteFor(h2);
  const hiddenField = (panel2.find((node) => node.tag === "input" && node.attrs.type === "password") as StubNode).parent as StubNode;
  assert.ok("hidden" in hiddenField.attrs, "a below-threshold swap must not ask for a PIN the server will not check");
});

test("an expired quote stops being confirmable and is never executed", async () => {
  // `swap` here SUCCEEDS on purpose. A trap that rejects would keep this test green even if the
  // click-time expiry guard were deleted, because the rejection is caught and only painted on the
  // status line. Measured: with the guard removed and a trap, 15/15 still passed; with a succeeding
  // stub the same mutation fails on `sent`. The disabled attribute alone proves nothing either —
  // the DOM stub still delivers the click, exactly like a stale enabled button in a real browser.
  const sent: Array<Record<string, unknown>> = [];
  const h = swapHarness({
    swap: (body) => {
      sent.push(body as unknown as Record<string, unknown>);
      return Promise.resolve({
        quote_id: QUOTE.quote_id, tx_id: 92, from: QUOTE.from, to: QUOTE.to,
        amount_from: QUOTE.amount_from, amount_to: QUOTE.amount_to,
        rate_from: QUOTE.rate_from, rate_to: QUOTE.rate_to, spread_bp: QUOTE.spread_bp,
        balance_from: "0", balance_to: "0", executed_at: NOW + 31,
      });
    },
  });
  const panel = await quoteFor(h);
  const confirm = buttonWith(panel, i18n.t("finance.confirmSwap"));
  h.now.value = NOW + 31;
  h.tick(); // the injected countdown, not a real second
  assert.ok(panel.textContent.includes(i18n.t("finance.quoteExpired")), `expiry not shown: ${panel.textContent}`);
  assert.ok("disabled" in confirm.attrs, "an expired quote must not stay confirmable");
  confirm.dispatch("click");
  await settle();
  assert.deepEqual(sent, [], "an expired quote must never reach POST /v1/ex/swap");
  assert.deepEqual(h.changes, []);
  assert.equal(h.closed(), 0, "nothing happened, so the sheet must stay open");
});

test("confirming a live quote executes it by id and closes the sheet", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const h = swapHarness({
    swap: (body) => {
      sent.push(body as unknown as Record<string, unknown>);
      return Promise.resolve({
        quote_id: QUOTE.quote_id, tx_id: 91, from: QUOTE.from, to: QUOTE.to,
        amount_from: QUOTE.amount_from, amount_to: QUOTE.amount_to,
        rate_from: QUOTE.rate_from, rate_to: QUOTE.rate_to, spread_bp: QUOTE.spread_bp,
        balance_from: "50000000000", balance_to: "2495000000", executed_at: NOW + 2,
      });
    },
  });
  const panel = await quoteFor(h);
  (panel.find((node) => node.tag === "input" && node.attrs.type === "password") as StubNode).value = "1234";
  buttonWith(panel, i18n.t("finance.confirmSwap")).dispatch("click");
  await settle();
  assert.deepEqual(sent, [{ quote_id: 4242, pin: "1234" }],
    "the quote id must be echoed as the NUMBER the server sent");
  assert.equal(h.closed(), 1, "a finished swap must close its sheet");
  assert.ok(h.changes[0]?.includes("0.495"), `the hub was not told what arrived: ${h.changes.join(", ")}`);
});
