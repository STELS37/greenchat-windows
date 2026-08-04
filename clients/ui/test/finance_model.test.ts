// T016 — the money/market model. Every law here is copied from a server file, not invented:
//   PAYMENTS §21   amounts on the wire are canonical integer strings of nano units (scale 9)
//   PAYMENTS §13   notional floors toward the credit, fee ceils toward the house
//   core/exchange  hold = qty for a sell, notional for a buy; a demo leg zeroes both fee rates
// The numbers below are taken from server/test/integration/wallet.test.ts and from the server's
// own arithmetic, so a divergence in either direction fails here before it reaches a user.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASIS_POINTS,
  NANO_ONE,
  bookTop,
  checkWithdrawAmount,
  clientOpId,
  depositProgress,
  depthLadder,
  feeCeil,
  formatDecimal,
  formatNano,
  formatNanoWire,
  humanToNano,
  nanoToDecimal,
  notionalFloor,
  orderRequestBody,
  pairHasDemoAsset,
  parseBp,
  parseHumanAmount,
  parseNano,
  previewOrder,
  quoteRemainingSec,
  quoteUnitRate,
  summarizeCandles,
  whitelistState,
  withdrawalCost,
} from "../src/screens/finance_model.ts";
import type {
  ExPairRow,
  OrderPreviewInput,
  WalletAssetRow,
  WithdrawalRow,
} from "../src/screens/finance_model.ts";

// ── The wire contract ─────────────────────────────────────────────────────────────────────────

test("only canonical integer strings are accepted as money", () => {
  assert.equal(parseNano("12500000000"), 12500000000n);
  assert.equal(parseNano("0"), 0n);
  assert.equal(parseNano("-5"), -5n);
  // Everything a sloppy producer might send is refused rather than silently coerced.
  for (const bad of ["", " 1", "1 ", "01", "-0", "1.5", "1e9", "+1", "0x10", "abc", "１２"]) {
    assert.equal(parseNano(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(parseNano(null), null);
  assert.equal(parseNano(undefined), null);
  // Beyond 2^53 the value must survive intact — the whole reason amounts are strings.
  assert.equal(parseNano("9007199254740993000000000"), 9007199254740993000000000n);
});

test("nano converts to a decimal without losing or inventing a digit", () => {
  assert.equal(nanoToDecimal(12500000000n), "12.5");
  assert.equal(nanoToDecimal(1n), "0.000000001");
  assert.equal(nanoToDecimal(0n), "0");
  assert.equal(nanoToDecimal(NANO_ONE), "1");
  assert.equal(nanoToDecimal(-12500000000n), "-12.5");
  assert.equal(nanoToDecimal(999999999n), "0.999999999");
});

test("the wire form of a BigInt is the server's formatAmount", () => {
  assert.equal(formatNanoWire(0n), "0");
  assert.equal(formatNanoWire(-7n), "-7");
  assert.equal(formatNanoWire(12500000000n), "12500000000");
});

// ── The defect this module exists to kill (T020) ──────────────────────────────────────────────

test("a wallet balance renders as 12.5, never as 12 500 000 000", () => {
  // server/test/integration/wallet.test.ts:58 — 12.5 tUSDT arrives on the wire as "12500000000".
  assert.equal(formatNano("12500000000", { maxFraction: 2 }), "12.5");
  assert.equal(formatNano("2500000000", { maxFraction: 2 }), "2.5");
  assert.equal(formatNano("10000000000", { maxFraction: 2 }), "10");
  // The old finance_screen.ts money() split on "." in a string that has none and printed the raw
  // integer with spaces. Pin the honest output so that regression cannot come back unnoticed.
  assert.notEqual(formatNano("12500000000"), "12 500 000 000");
});

test("display truncates and never rounds a balance up", () => {
  assert.equal(formatNano("1999999999", { maxFraction: 2 }), "1.99");
  assert.equal(formatNano("999999999", { maxFraction: 2 }), "0.99");
  assert.equal(formatNano("1999999999", { maxFraction: 0 }), "1");
});

test("grouping, the typographic minus and the placeholder", () => {
  assert.equal(formatNano("1234567890000000000"), "1 234 567 890");
  assert.equal(formatNano("1234567890000000000", { group: false }), "1234567890");
  assert.equal(formatNano("-12500000000"), "−12.5");
  assert.equal(formatNano(null), "—");
  assert.equal(formatNano("1.5"), "—", "a decimal string is not a wire amount");
  assert.equal(formatNano(null, { placeholder: "n/a" }), "n/a");
});

test("formatDecimal reads already-human strings and refuses nothing else", () => {
  assert.equal(formatDecimal("1234.5678"), "1 234.56");
  assert.equal(formatDecimal("0012.5"), "12.5");
  assert.equal(formatDecimal("-3.10"), "−3.1");
  assert.equal(formatDecimal("abc"), "—");
  assert.equal(formatDecimal(null), "—");
});

// ── What a person types ───────────────────────────────────────────────────────────────────────

test("typed amounts parse with the reasons a screen can localize", () => {
  assert.deepEqual(parseHumanAmount("12.5"), { ok: true, nano: 12500000000n });
  assert.deepEqual(parseHumanAmount("12,5"), { ok: true, nano: 12500000000n }, "russian keyboard");
  assert.deepEqual(parseHumanAmount("1 234.5"), { ok: true, nano: 1234500000000n }, "grouped input");
  assert.deepEqual(parseHumanAmount("1 234"), { ok: true, nano: 1234000000000n }, "nbsp");
  assert.deepEqual(parseHumanAmount(".5"), { ok: true, nano: 500000000n });
  assert.deepEqual(parseHumanAmount("0"), { ok: true, nano: 0n });
  assert.deepEqual(parseHumanAmount("-0"), { ok: true, nano: 0n }, "a signed zero is still zero");

  assert.deepEqual(parseHumanAmount(""), { ok: false, reason: "empty" });
  assert.deepEqual(parseHumanAmount("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseHumanAmount("abc"), { ok: false, reason: "format" });
  assert.deepEqual(parseHumanAmount("1.2.3"), { ok: false, reason: "format" });
  assert.deepEqual(parseHumanAmount("."), { ok: false, reason: "format" });
  // Ten decimals cannot be represented; truncating would send a DIFFERENT amount than shown.
  assert.deepEqual(parseHumanAmount("0.1234567891"), { ok: false, reason: "precision" });
  assert.deepEqual(parseHumanAmount("-1"), { ok: false, reason: "negative" });

  assert.equal(humanToNano("12.5"), 12500000000n);
  assert.equal(humanToNano("nope"), null);
});

test("typing then displaying returns the same number", () => {
  for (const text of ["0", "1", "12.5", "0.000000001", "999999999.999999999", "1000000"]) {
    const parsed = parseHumanAmount(text);
    assert.ok(parsed.ok, text);
    assert.equal(formatNano(formatNanoWire(parsed.nano), { group: false }), nanoToDecimal(parsed.nano));
  }
});

// ── The arithmetic laws (PAYMENTS §13) ────────────────────────────────────────────────────────

test("notional floors toward the credit", () => {
  assert.equal(notionalFloor(NANO_ONE, NANO_ONE), NANO_ONE);
  assert.equal(notionalFloor(3n, 3n), 0n, "sub-nano products vanish, they do not round up");
  assert.equal(notionalFloor(1500000000n, 2000000000n), 3000000000n);
  assert.equal(notionalFloor(0n, NANO_ONE), 0n);
});

test("fee ceils toward the house and is zero only when it must be", () => {
  assert.equal(feeCeil(10000n, 10n), 10n);
  assert.equal(feeCeil(1n, 1n), 1n, "a non-zero fee never rounds down to nothing");
  assert.equal(feeCeil(10001n, 10n), 11n);
  assert.equal(feeCeil(1000n, 0n), 0n, "zero rate, zero fee");
  assert.equal(feeCeil(0n, 25n), 0n, "zero amount, zero fee");
  assert.equal(BASIS_POINTS, 10000n);
});

test("basis points are clamped to the range the schema allows", () => {
  assert.equal(parseBp("25"), 25n);
  assert.equal(parseBp("0"), 0n);
  assert.equal(parseBp("99999"), 9999n, "a corrupt rate can never charge over 99.99%");
  assert.equal(parseBp("-5"), 0n);
  assert.equal(parseBp("abc"), 0n);
  assert.equal(parseBp(null), 0n);
});

// ── Order preview: what the user is told BEFORE the trade (EXCHANGE §0.5) ─────────────────────

const PAIR: ExPairRow = {
  id: "BTC/GUSD",
  base_asset: "BTC",
  quote_asset: "GUSD",
  price_tick: "1000000",       // 0.001
  lot_step: "1000000",         // 0.001
  min_notional: "1000000000",  // 1.0
  maker_fee_bp: "10",
  taker_fee_bp: "25",
  enabled: true,
  mode: "active",
};

function input(patch: Partial<OrderPreviewInput> = {}): OrderPreviewInput {
  return { pair: PAIR, side: "buy", type: "limit", qty: "", price: "", slippageCap: "", ...patch };
}

test("a buy holds quote and pays its fee in base", () => {
  const preview = previewOrder(input({ side: "buy", qty: "2", price: "100" }));
  assert.equal(preview.ok, true);
  assert.equal(preview.problem, null);
  assert.equal(preview.qty, 2000000000n);
  assert.equal(preview.notional, 200000000000n, "2 × 100");
  assert.equal(preview.holdAsset, "GUSD");
  assert.equal(preview.holdAmount, 200000000000n, "hold is exactly the notional, fee is not added");
  assert.equal(preview.feeAsset, "BTC", "the fee comes out of what the buyer receives");
  assert.equal(preview.makerFee, feeCeil(2000000000n, 10n));
  assert.equal(preview.takerFee, feeCeil(2000000000n, 25n));
  assert.equal(preview.receiveWorstCase, 2000000000n - preview.takerFee!, "worst case is the taker fee");
  assert.equal(preview.receiveAsset, "BTC");
  assert.equal(preview.tif, "GTC");
});

test("a sell holds base and pays its fee in quote", () => {
  const preview = previewOrder(input({ side: "sell", qty: "2", price: "100" }));
  assert.equal(preview.ok, true);
  assert.equal(preview.holdAsset, "BTC");
  assert.equal(preview.holdAmount, 2000000000n, "a sell holds the quantity itself");
  assert.equal(preview.feeAsset, "GUSD");
  assert.equal(preview.makerFee, feeCeil(200000000000n, 10n));
  assert.equal(preview.takerFee, feeCeil(200000000000n, 25n));
  assert.equal(preview.receiveAsset, "GUSD");
});

test("a demo leg means no fee at all", () => {
  const preview = previewOrder(input({ side: "buy", qty: "2", price: "100", demoFees: true }));
  assert.equal(preview.makerFee, 0n);
  assert.equal(preview.takerFee, 0n);
  assert.equal(preview.receiveWorstCase, preview.qty, "the whole quantity lands");
});

test("every rejection the server would make is named before sending", () => {
  const cases: Array<[Partial<OrderPreviewInput>, string]> = [
    [{ qty: "", price: "100" }, "qty_empty"],
    [{ qty: "abc", price: "100" }, "qty_format"],
    [{ qty: "0.1234567891", price: "100" }, "qty_precision"],
    [{ qty: "0", price: "100" }, "qty_positive"],
    [{ qty: "0.0015", price: "100" }, "qty_lot_step"],
    [{ qty: "2", price: "" }, "price_empty"],
    [{ qty: "2", price: "abc" }, "price_format"],
    [{ qty: "2", price: "0" }, "price_positive"],
    [{ qty: "2", price: "100.0005" }, "price_tick"],
    [{ qty: "0.001", price: "100" }, "min_notional"],
  ];
  for (const [patch, problem] of cases) {
    const preview = previewOrder(input(patch));
    assert.equal(preview.problem, problem, JSON.stringify(patch));
    assert.equal(preview.ok, false);
    assert.equal(preview.holdAmount, null, "a rejected preview quotes no number at all");
  }
});

test("min_notional is measured on the floored value, exactly like the server", () => {
  // 0.01 × 100 = 1.0 exactly — the boundary is inclusive on the server, so it must pass here.
  assert.equal(previewOrder(input({ qty: "0.01", price: "100" })).problem, null);
  assert.equal(previewOrder(input({ qty: "0.009", price: "100" })).problem, "min_notional");
});

test("a market order names its cap and is IOC-only", () => {
  const market = input({ type: "market", side: "buy", qty: "2", slippageCap: "110" });
  const preview = previewOrder(market);
  assert.equal(preview.ok, true);
  assert.equal(preview.tif, "IOC", "core/exchange validateInput allows nothing else");
  assert.equal(preview.price, 110000000000n, "the cap is the price the hold is taken at");
  assert.equal(previewOrder({ ...market, slippageCap: "" }).problem, "cap_empty");
  assert.equal(previewOrder({ ...market, slippageCap: "0" }).problem, "cap_positive");
  assert.equal(previewOrder({ ...market, slippageCap: "110.0005" }).problem, "cap_tick");
});

test("an insufficient balance is caught before the request, not after", () => {
  const enough = previewOrder(input({ qty: "2", price: "100", available: "200000000000" }));
  assert.equal(enough.ok, true, "exactly the hold is enough");
  const short = previewOrder(input({ qty: "2", price: "100", available: "199999999999" }));
  assert.equal(short.ok, false);
  assert.equal(short.problem, "insufficient");
  const unknown = previewOrder(input({ qty: "2", price: "100", available: null }));
  assert.equal(unknown.ok, true, "an unknown balance is not a fabricated refusal");
});

test("the request body carries strings and the previewed numbers", () => {
  const limit = input({ side: "sell", qty: "2", price: "100" });
  assert.deepEqual(orderRequestBody(limit, previewOrder(limit), "op-1"), {
    pair: "BTC/GUSD",
    side: "sell",
    type: "limit",
    qty: "2000000000",
    client_order_id: "op-1",
    tif: "GTC",
    price: "100000000000",
  });
  const market = input({ type: "market", side: "buy", qty: "2", slippageCap: "110" });
  assert.deepEqual(orderRequestBody(market, previewOrder(market), "op-2"), {
    pair: "BTC/GUSD",
    side: "buy",
    type: "market",
    qty: "2000000000",
    client_order_id: "op-2",
    tif: "IOC",
    slippage_cap: "110000000000",
  });
});

// ── Book, candles ─────────────────────────────────────────────────────────────────────────────

test("the depth ladder accumulates and scales without touching money as a float", () => {
  const rows = depthLadder([
    { price: "100000000000", qty: "1000000000" },
    { price: "99000000000", qty: "3000000000" },
    { price: "bad", qty: "1000000000" },
    { price: "98000000000", qty: "0" },
  ]);
  assert.equal(rows.length, 2, "unparsable and empty levels are dropped, not guessed");
  assert.equal(rows[0]!.total, 1000000000n);
  assert.equal(rows[1]!.total, 4000000000n);
  assert.equal(rows[1]!.ratio, 1);
  assert.equal(rows[0]!.ratio, 0.25);
  assert.equal(depthLadder([], 12).length, 0);
  assert.equal(depthLadder(undefined).length, 0);
  const many = Array.from({ length: 40 }, () => ({ price: "1000000000", qty: "1000000000" }));
  assert.equal(depthLadder(many, 12).length, 12, "the limit is respected");
});

test("the book top reports the spread only when both sides exist", () => {
  const both = bookTop({
    pair: "BTC/GUSD",
    bids: [{ price: "99000000000", qty: "1" }],
    asks: [{ price: "100000000000", qty: "1" }],
  });
  assert.equal(both.spread, 1000000000n);
  assert.equal(bookTop({ pair: "P", bids: [], asks: [] }).spread, null);
  assert.equal(bookTop(null).bid, null);
});

test("a candle window summarizes into a sparkline without dividing by zero", () => {
  const candle = (c: string, l: string, h: string) => ({ ts: 0, o: c, h, l, c, vol_base: "0", vol_quote: "0" });
  const summary = summarizeCandles([
    candle("100000000000", "100000000000", "100000000000"),
    candle("110000000000", "105000000000", "115000000000"),
  ]);
  assert.ok(summary);
  assert.equal(summary!.first, 100000000000n);
  assert.equal(summary!.last, 110000000000n);
  assert.equal(summary!.low, 100000000000n);
  assert.equal(summary!.high, 115000000000n);
  assert.equal(summary!.changeBp, 1000, "+10% is 1000 basis points");
  assert.equal(summary!.points.length, 2);
  const flat = summarizeCandles([candle("5", "5", "5"), candle("5", "5", "5")], 100, 32);
  assert.equal(flat!.points[0]!.y, 16, "a flat series sits in the middle, not at NaN");
  assert.equal(summarizeCandles([]), null);
  assert.equal(summarizeCandles(undefined), null);
});

// ── Deposits, withdrawals, whitelist ──────────────────────────────────────────────────────────

test("deposit progress is honest about confirmations", () => {
  const base = { id: 1, chain: "evm:eth", asset: "ETH", txid: "0x", vout: 0, amount: "1", status: "confirming", credited_tx_id: null, created_at: 0, updated_at: 0 };
  assert.deepEqual(depositProgress({ ...base, confirmations: 3, need_confirmations: 12 }), { confirmations: 3, need: 12, ratio: 0.25, credited: false });
  const credited = depositProgress({ ...base, confirmations: 12, need_confirmations: 12, status: "credited" });
  assert.equal(credited.credited, true);
  assert.equal(credited.ratio, 1);
  const zeroNeed = depositProgress({ ...base, confirmations: 0, need_confirmations: 0 });
  assert.equal(zeroNeed.ratio, 0, "no division by zero");
});

test("the 24-hour whitelist cooling period is shown, not hidden", () => {
  const row = { id: 1, chain: "evm:eth", address: "0xabc", label: null, active_after: 1000 + 86400, created_at: 1000 };
  assert.deepEqual(whitelistState(row, 1000), { active: false, waitSec: 86400 });
  assert.deepEqual(whitelistState(row, 1000 + 86400), { active: true, waitSec: 0 });
  assert.deepEqual(whitelistState(row, 1000 + 90000), { active: true, waitSec: 0 });
});

const WITHDRAWAL: WithdrawalRow = {
  id: 1, chain: "evm:eth", asset: "ETH", to_address: "0xabc",
  amount: "1000000000", fee: "10000000",
  network_fee_asset: "ETH", network_fee_amount: "5000000", network_fee_actual: null,
  network_fee_state: "estimated_ceiling", status: "pending", txid: null, error: null,
  client_op_id: "op", created_at: 0, updated_at: 0,
};

test("a withdrawal states its real cost and never dresses an estimate as a fact", () => {
  const cost = withdrawalCost(WITHDRAWAL);
  assert.equal(cost.net, 990000000n);
  assert.equal(cost.networkFee, 5000000n);
  assert.equal(cost.networkFeeState, "estimated_ceiling");
  const settled = withdrawalCost({ ...WITHDRAWAL, network_fee_actual: "4000000", network_fee_state: "actual" });
  assert.equal(settled.networkFee, 4000000n, "the actual fee wins over the estimate");
  const unknown = withdrawalCost({ ...WITHDRAWAL, network_fee_amount: null, network_fee_actual: null, network_fee_state: null });
  assert.equal(unknown.networkFee, null, "unknown stays null, it does not become zero");
});

const ASSET: WalletAssetRow = {
  id: "ETH", name: "Ether", kind: "crypto", scale: 9, chain: "evm:eth", chain_decimals: 18,
  enabled: true, min_amount: "100000000", max_amount: "10000000000", withdraw_fee: "10000000",
  balance: "5000000000", hold: "0", available: "5000000000", usd_rate: null, usd_value: null,
};

test("the withdrawal form enforces the server's own limits", () => {
  assert.equal(checkWithdrawAmount("1", ASSET).ok, true);
  assert.equal(checkWithdrawAmount("1", ASSET).net, 990000000n);
  assert.equal(checkWithdrawAmount("", ASSET).problem, "empty");
  assert.equal(checkWithdrawAmount("abc", ASSET).problem, "format");
  assert.equal(checkWithdrawAmount("0.1234567891", ASSET).problem, "precision");
  assert.equal(checkWithdrawAmount("0", ASSET).problem, "positive");
  assert.equal(checkWithdrawAmount("0.05", ASSET).problem, "below_min");
  assert.equal(checkWithdrawAmount("11", ASSET).problem, "above_max");
  assert.equal(checkWithdrawAmount("6", ASSET).problem, "insufficient");
  const feeEater: WalletAssetRow = { ...ASSET, min_amount: "0", withdraw_fee: "1000000000" };
  assert.equal(checkWithdrawAmount("1", feeEater).problem, "fee_exceeds", "net must stay positive");
});

// ── Swap ──────────────────────────────────────────────────────────────────────────────────────

const QUOTE = {
  quote_id: 1, from: "ETH", to: "GUSD",
  amount_from: "1000000000", amount_to: "3000000000000",
  rate_from: "1", rate_to: "3000", spread_bp: 30,
  expires_at: 1030, created_at: 1000,
};

test("an expired quote is dead before the button is pressed", () => {
  assert.equal(quoteRemainingSec(QUOTE, 1000), 30);
  assert.equal(quoteRemainingSec(QUOTE, 1030), 0);
  assert.equal(quoteRemainingSec(QUOTE, 9999), 0, "never negative");
  assert.equal(quoteRemainingSec(null, 1000), 0);
});

test("the quote's implied unit rate", () => {
  assert.equal(quoteUnitRate(QUOTE), 3000000000000n, "1 ETH = 3000 GUSD");
  assert.equal(quoteUnitRate({ ...QUOTE, amount_from: "0" }), null, "no division by zero");
  assert.equal(quoteUnitRate({ ...QUOTE, amount_to: "bad" }), null);
});

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────

test("idempotency keys are unique, prefixed and within the server's length", () => {
  const a = clientOpId("ord");
  const b = clientOpId("ord");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("ord-"));
  assert.ok(a.length <= 64);
});

test("a demo leg is detected from the wallet, not assumed", () => {
  const demo: WalletAssetRow = { ...ASSET, id: "GUSD", kind: "demo" };
  assert.equal(pairHasDemoAsset(PAIR, [ASSET, demo]), true);
  assert.equal(pairHasDemoAsset(PAIR, [ASSET]), false);
  assert.equal(pairHasDemoAsset(PAIR, []), false);
  assert.equal(pairHasDemoAsset(PAIR, [{ ...demo, id: "OTHER" }]), false, "a demo asset off the pair does not count");
});
