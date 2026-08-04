// clients/ui/src/screens/finance_model.ts — the pure money/market brain of the finance hub.
//
// Everything here is DOM-free and i18n-free (same contract as approx_fiat_model.ts) so the laws
// below are unit-tested in isolation and the screen stays a thin painter.
//
// ── THE WIRE LAW (PAYMENTS §13/§21, measured against server/src/core/money.ts) ──────────────────
// A ledger amount on the wire is a CANONICAL INTEGER STRING of nano units (scale 9). The server's
// `formatAmount()` is literally `bigint.toString()` and its `parseAmount()` accepts
// /^-?(0|[1-9]\d*)$/ and NOTHING else — no ".", no exponent, no leading "+".
// Proven by the server's own integration tests: a wallet holding 12.5 tUSDT answers
//   total_usd: "12500000000",  balance: "12500000000"
// (server/test/integration/wallet.test.ts:58,62). Hence:
//   * display — nano string → human decimal via nanoToDecimal(); NEVER a raw split on ".";
//   * entry   — human text → nano string via parseHumanAmount(); NEVER the user's text verbatim;
//   * math    — BigInt only. A float never touches a money value.
//
// The one exception, and the reason both formatters exist side by side: `approx_fiat.amount` and
// `payment_settings.pin_required_usd` are ALREADY human decimal strings produced by
// formatMinorUnits()/String(Number(...)) on the server. Those go to formatDecimal()/Intl, not here.
//
// ── THE FEE LAW (PAYMENTS §13, server/src/core/{money,exchange}.ts) ─────────────────────────────
//   notional(qty, price) = floor(qty * price / 1e9)      — value is floored toward the credit
//   fee(amount, bp)      = ceil(amount * bp / 10_000)    — the fee is ceiled toward the house
// A buy pays its fee in the BASE asset (out of what it receives), a sell pays in the QUOTE asset.
// The hold the server takes is `qty` (base) for a sell and `notional(qty, price)` (quote) for a buy;
// the fee is never held on top, because it is deducted from the incoming leg.
//
// Reproducing that arithmetic here is deliberate: EXCHANGE §0.5 requires the fee to be visible
// BEFORE the order is sent, and the only honest preview is one that uses the server's own rounding.
// Any divergence is a bug in this file, not a "close enough" rendering.

// ── Wire shapes ────────────────────────────────────────────────────────────────────────────────
// Mirrors of the server serializers. Restated here because the UI layer never imports server code.

/** GET /v1/wallet → assets[] (server modules/wallet.ts getWallet). */
export interface WalletAssetRow {
  id: string;
  name: string;
  kind: string; // "stable" | "crypto" | "demo" | …  — "demo" zeroes exchange fees server-side
  scale: number;
  chain: string | null;
  chain_decimals: number | null;
  enabled: boolean;
  min_amount: string;
  max_amount: string;
  withdraw_fee: string;
  balance: string;
  hold: string;
  available: string;
  usd_rate: string | null;
  usd_value: string | null;
}

/** GET /v1/wallet/deposits → items[] (server modules/onchain.ts listDeposits). */
export interface DepositRow {
  id: number;
  chain: string;
  asset: string;
  txid: string;
  vout: number;
  amount: string;
  confirmations: number;
  need_confirmations: number;
  status: string; // seen | confirming | credited | orphaned | …
  credited_tx_id: number | null;
  created_at: number;
  updated_at: number;
}

/** GET/POST /v1/wallet/withdrawals → items[] / { withdrawal } (server withdrawalOut). */
export interface WithdrawalRow {
  id: number;
  chain: string;
  asset: string;
  to_address: string;
  amount: string;
  fee: string;
  network_fee_asset: string | null;
  network_fee_amount: string | null;
  network_fee_actual: string | null;
  network_fee_state: "actual" | "signed_ceiling" | "estimated_ceiling" | null;
  status: string; // pending | signed | broadcast | confirmed | failed | cancelled
  txid: string | null;
  error: string | null;
  client_op_id: string;
  created_at: number;
  updated_at: number;
}

/** GET /v1/wallet/whitelist → items[] (server listWhitelist). */
export interface WhitelistRow {
  id: number;
  chain: string;
  address: string;
  label: string | null;
  active_after: number;
  created_at: number;
}

/** GET /v1/ex/pairs → pairs[] (server ExchangePairOut). Fee fields are BASIS POINTS, not nano. */
export interface ExPairRow {
  id: string;
  base_asset: string;
  quote_asset: string;
  price_tick: string;
  lot_step: string;
  min_notional: string;
  maker_fee_bp: string;
  taker_fee_bp: string;
  enabled: boolean;
  mode: "active" | "swap_only" | "halted" | string;
}

/** GET /v1/ex/ticker/:pair → ticker (server ExchangeTickerOut). */
export interface ExTickerRow {
  pair: string;
  last: string | null;
  high_24h: string | null;
  low_24h: string | null;
  vol_base_24h: string;
  vol_quote_24h: string;
}

export interface ExDepthLevel {
  price: string;
  qty: string;
}
export interface ExDepthRow {
  pair: string;
  bids: ExDepthLevel[];
  asks: ExDepthLevel[];
}

/** GET /v1/ex/trades/:pair → trades[] (server ExchangeTradeOut). */
export interface ExTradeRow {
  id: number;
  pair: string;
  maker_order_id: number;
  taker_order_id: number;
  price: string;
  qty: string;
  notional: string;
  maker_fee: string;
  taker_fee: string;
  created_at: number;
}

/** GET /v1/ex/my_trades → trades[] (server ExchangeMyTradeOut). */
export interface ExMyTradeRow {
  id: number;
  pair: string;
  order_id: number;
  role: "maker" | "taker";
  side: "buy" | "sell";
  price: string;
  qty: string;
  notional: string;
  fee: string;
  fee_asset: string;
  created_at: number;
}

/** GET/POST/DELETE /v1/ex/orders → order(s) (server ExchangeOrderOut). */
export interface ExOrderRow {
  id: number;
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market" | "stop_limit" | "stop_market";
  price: string | null;
  qty: string;
  filled_qty: string;
  hold_amount: string;
  hold_remaining: string;
  slippage_cap: string | null;
  status: "waiting" | "open" | "partial" | "filled" | "cancelled";
  tif: "GTC" | "IOC" | "FOK";
  post_only: boolean;
  trigger_price: string | null;
  oco_group_id: number | null;
  created_at: number;
  updated_at: number;
}

/** GET /v1/ex/candles/:pair → candles[] (server ExchangeCandleOut). */
export interface ExCandleRow {
  ts: number;
  o: string;
  h: string;
  l: string;
  c: string;
  vol_base: string;
  vol_quote: string;
}

/**
 * POST /v1/ex/swap/quote (server modules/swaps.ts quoteOut).
 * `quote_id` is a NUMBER, not a string: the serializer writes `Number(row.id)` (core/swaps.ts
 * quoteOut), and only the money amounts travel as nano strings. Declaring it a string here made the
 * echo back to POST /v1/ex/swap a lie about the wire.
 */
export interface SwapQuoteRow {
  quote_id: number;
  from: string;
  to: string;
  amount_from: string;
  amount_to: string;
  rate_from: string;
  rate_to: string;
  spread_bp: number;
  expires_at: number;
  created_at: number;
}

/**
 * POST /v1/ex/swap (server core/swaps.ts SwapResult). It is NOT a quote plus extras: an executed
 * swap has no `expires_at` and no `created_at` — it carries `executed_at` instead. Extending the
 * quote type would have promised two fields the server never sends.
 */
export interface SwapResultRow {
  quote_id: number;
  tx_id: number;
  from: string;
  to: string;
  amount_from: string;
  amount_to: string;
  rate_from: string;
  rate_to: string;
  spread_bp: number;
  balance_from: string;
  balance_to: string;
  executed_at: number;
}

// ── Nano arithmetic ────────────────────────────────────────────────────────────────────────────

export const NANO_DIGITS = 9;
export const NANO_ONE = 1_000_000_000n;
export const BASIS_POINTS = 10_000n;

/** The server's parseAmount regexp, character for character. */
// Canonical exactly as the server emits it (core/money.ts formatAmount = BigInt.prototype.toString):
// no leading zeros, no plus, and no "-0" — a negative zero is not a value the ledger can produce, so
// accepting it would mean trusting a producer that is already lying about something.
const CANONICAL_INT = /^(0|-?[1-9]\d*)$/;

/**
 * A wire amount → BigInt, or null when the string is not a canonical integer.
 * Returning null instead of throwing is deliberate: a malformed field must degrade to "—" in one
 * cell, never blank the whole wallet with an exception during render.
 */
export function parseNano(raw: string | null | undefined): bigint | null {
  if (typeof raw !== "string" || !CANONICAL_INT.test(raw)) return null;
  return BigInt(raw);
}

/** BigInt → the exact decimal representation, trailing zeros trimmed. 12500000000n → "12.5". */
export function nanoToDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = abs.toString().padStart(NANO_DIGITS + 1, "0");
  const cut = digits.length - NANO_DIGITS;
  const fraction = digits.slice(cut).replace(/0+$/, "");
  return `${negative ? "-" : ""}${digits.slice(0, cut)}${fraction ? `.${fraction}` : ""}`;
}

/** BigInt → wire string. Identical to the server's formatAmount, kept named for intent. */
export function formatNanoWire(value: bigint): string {
  return value.toString();
}

export type AmountParseFailure = "empty" | "format" | "precision" | "negative";
export type AmountParse = { ok: true; nano: bigint } | { ok: false; reason: AmountParseFailure };

/**
 * Human text → nano BigInt. This is the ONLY entry point for anything a person typed.
 *
 * Accepted: optional sign, digits, an optional fraction of at most 9 digits, "," as the decimal
 * separator (a Russian keyboard produces it), and any spacing (plain, thin or non-breaking) which
 * grouped output may have put there. Rejected — loudly, with a reason the screen can localize:
 *   "precision" — more than 9 decimals, i.e. a value the ledger cannot represent. Silently
 *                 truncating here would send a DIFFERENT amount than the one on screen.
 *   "negative"  — every amount endpoint requires > 0; a minus must be a typo, not a reversal.
 */
export function parseHumanAmount(text: string): AmountParse {
  const cleaned = String(text ?? "")
    .replace(/[\s   ']/g, "")
    .replace(",", ".");
  if (!cleaned) return { ok: false, reason: "empty" };
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || !/\d/.test(cleaned)) return { ok: false, reason: "format" };
  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  const [whole = "", fraction = ""] = body.split(".");
  if (fraction.length > NANO_DIGITS) return { ok: false, reason: "precision" };
  const nano = BigInt((whole || "0") + fraction.padEnd(NANO_DIGITS, "0"));
  if (negative && nano !== 0n) return { ok: false, reason: "negative" };
  return { ok: true, nano };
}

/** Convenience wrapper for call sites that only care whether it parsed. */
export function humanToNano(text: string): bigint | null {
  const parsed = parseHumanAmount(text);
  return parsed.ok ? parsed.nano : null;
}

export interface FormatNanoOptions {
  /** Cap the shown decimals. Digits beyond it are TRUNCATED, never rounded up (see below). */
  maxFraction?: number;
  /** Group the integer part in threes. On by default. */
  group?: boolean;
  /** What to render for a missing/invalid value. */
  placeholder?: string;
}

/**
 * A wire nano string → what a person reads.
 *
 * Truncation, not rounding, is the rule: a displayed balance must never claim more than the ledger
 * holds. The default keeps all 9 decimals, so nothing is lost unless a caller asks for less (USD
 * aggregates ask for 2).
 */
export function formatNano(raw: string | null | undefined, options: FormatNanoOptions = {}): string {
  const placeholder = options.placeholder ?? "—";
  const value = parseNano(raw);
  if (value === null) return placeholder;
  const decimal = nanoToDecimal(value);
  const negative = decimal.startsWith("-");
  const [wholeRaw = "0", fractionRaw = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const maxFraction = options.maxFraction ?? NANO_DIGITS;
  const fraction = fractionRaw.slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  const whole = options.group === false ? wholeRaw : wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  // U+2212 MINUS SIGN reads as a minus at any font size; the ASCII hyphen does not.
  return `${negative ? "−" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * An ALREADY-human decimal string (approx_fiat.amount, pin_required_usd) → grouped display.
 * Kept separate from formatNano on purpose: feeding a nano string here is the exact bug this
 * module exists to kill, and a reader can tell the two call sites apart by name alone.
 */
export function formatDecimal(raw: string | null | undefined, maxFraction = 2, placeholder = "—"): string {
  if (typeof raw !== "string" || !/^-?\d+(\.\d+)?$/.test(raw)) return placeholder;
  const negative = raw.startsWith("-");
  const [wholeRaw = "0", fractionRaw = ""] = (negative ? raw.slice(1) : raw).split(".");
  const fraction = fractionRaw.slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "−" : ""}${whole || "0"}${fraction ? `.${fraction}` : ""}`;
}

/** floor(qty * price / 1e9) — the server's notional(), same truncation toward zero. */
export function notionalFloor(qty: bigint, price: bigint): bigint {
  return (qty * price) / NANO_ONE;
}

/** ceil(amount * bp / 10_000) — the server's fee(). Never rounds a fee down. */
export function feeCeil(amount: bigint, bp: bigint): bigint {
  if (bp <= 0n || amount <= 0n) return 0n;
  const product = amount * bp;
  return product / BASIS_POINTS + (product % BASIS_POINTS === 0n ? 0n : 1n);
}

/** A basis-point field ("10") → BigInt, clamped to the server's 0..9999 domain. */
export function parseBp(raw: string | null | undefined): bigint {
  const value = parseNano(raw);
  if (value === null || value < 0n) return 0n;
  return value > 9_999n ? 9_999n : value;
}

// ── Order preview (EXCHANGE §0.5: the fee is shown BEFORE the order is sent) ────────────────────

export type OrderPreviewProblem =
  | "qty_empty"
  | "qty_format"
  | "qty_precision"
  | "qty_positive"
  | "qty_lot_step"
  | "price_empty"
  | "price_format"
  | "price_precision"
  | "price_positive"
  | "price_tick"
  | "cap_empty"
  | "cap_format"
  | "cap_precision"
  | "cap_positive"
  | "cap_tick"
  | "min_notional"
  | "insufficient";

export interface OrderPreviewInput {
  pair: ExPairRow;
  side: "buy" | "sell";
  type: "limit" | "market";
  /** Raw text straight out of the inputs — parsing is this module's job, not the screen's. */
  qty: string;
  price: string;
  slippageCap: string;
  /** Available balance (nano string) of the asset the hold is taken from, when known. */
  available?: string | null;
  /** True when either leg of the pair is a `demo` asset: the server then forces both bp to 0. */
  demoFees?: boolean;
}

export interface OrderPreview {
  ok: boolean;
  problem: OrderPreviewProblem | null;
  qty: bigint | null;
  /** The price used for the hold: the limit price, or the slippage cap for a market order. */
  price: bigint | null;
  notional: bigint | null;
  holdAsset: string;
  holdAmount: bigint | null;
  /** Which asset the taker/maker fee is charged in: BASE for a buy, QUOTE for a sell. */
  feeAsset: string;
  makerFee: bigint | null;
  takerFee: bigint | null;
  /** What actually lands after the WORST case (taker) fee — the number a user should trust. */
  receiveWorstCase: bigint | null;
  receiveAsset: string;
  /** The TIF the server will apply: market orders are IOC-only (core/exchange validateInput). */
  tif: "GTC" | "IOC";
}

function emptyPreview(input: OrderPreviewInput, problem: OrderPreviewProblem | null): OrderPreview {
  const buy = input.side === "buy";
  return {
    ok: false,
    problem,
    qty: null,
    price: null,
    notional: null,
    holdAsset: buy ? input.pair.quote_asset : input.pair.base_asset,
    holdAmount: null,
    feeAsset: buy ? input.pair.base_asset : input.pair.quote_asset,
    makerFee: null,
    takerFee: null,
    receiveWorstCase: null,
    receiveAsset: buy ? input.pair.base_asset : input.pair.quote_asset,
    tif: input.type === "market" ? "IOC" : "GTC",
  };
}

function amountProblem(
  reason: AmountParseFailure,
  field: "qty" | "price" | "cap",
): OrderPreviewProblem {
  if (reason === "empty") return `${field}_empty` as OrderPreviewProblem;
  if (reason === "precision") return `${field}_precision` as OrderPreviewProblem;
  return `${field}_format` as OrderPreviewProblem;
}

/**
 * Mirror of the server's validateInput + holdNeed + applyFill fee split, run on what the user typed.
 *
 * It never approves anything the server would reject, and it never quotes a fee the server would
 * not charge: the same floor/ceil, the same lot/tick multiples, the same min_notional gate. When it
 * says ok, the only remaining server-side reasons to fail are liveness ones this client cannot see
 * (NO_LIQUIDITY, PAIR_HALTED, a concurrent balance change) — those surface as real API errors.
 */
export function previewOrder(input: OrderPreviewInput): OrderPreview {
  const buy = input.side === "buy";
  const lotStep = parseNano(input.pair.lot_step) ?? 0n;
  const priceTick = parseNano(input.pair.price_tick) ?? 0n;
  const minNotional = parseNano(input.pair.min_notional) ?? 0n;

  const qtyParsed = parseHumanAmount(input.qty);
  if (!qtyParsed.ok) return emptyPreview(input, amountProblem(qtyParsed.reason, "qty"));
  const qty = qtyParsed.nano;
  if (qty <= 0n) return emptyPreview(input, "qty_positive");
  if (lotStep > 0n && qty % lotStep !== 0n) return emptyPreview(input, "qty_lot_step");

  const field = input.type === "market" ? "cap" : "price";
  const source = input.type === "market" ? input.slippageCap : input.price;
  const priceParsed = parseHumanAmount(source);
  if (!priceParsed.ok) return emptyPreview(input, amountProblem(priceParsed.reason, field));
  const price = priceParsed.nano;
  if (price <= 0n) return emptyPreview(input, `${field}_positive` as OrderPreviewProblem);
  if (priceTick > 0n && price % priceTick !== 0n)
    return emptyPreview(input, `${field}_tick` as OrderPreviewProblem);

  const value = notionalFloor(qty, price);
  if (value < minNotional) return emptyPreview(input, "min_notional");

  const makerBp = input.demoFees ? 0n : parseBp(input.pair.maker_fee_bp);
  const takerBp = input.demoFees ? 0n : parseBp(input.pair.taker_fee_bp);
  // The fee is charged on the leg the trader RECEIVES: base for a buy, quote for a sell.
  const feeBasis = buy ? qty : value;
  const makerFee = feeCeil(feeBasis, makerBp);
  const takerFee = feeCeil(feeBasis, takerBp);
  const holdAmount = buy ? value : qty;
  const available = parseNano(input.available ?? null);
  const insufficient = available !== null && holdAmount > available;

  return {
    ok: !insufficient,
    problem: insufficient ? "insufficient" : null,
    qty,
    price,
    notional: value,
    holdAsset: buy ? input.pair.quote_asset : input.pair.base_asset,
    holdAmount,
    feeAsset: buy ? input.pair.base_asset : input.pair.quote_asset,
    makerFee,
    takerFee,
    receiveWorstCase: feeBasis - (makerFee > takerFee ? makerFee : takerFee),
    receiveAsset: buy ? input.pair.base_asset : input.pair.quote_asset,
    tif: input.type === "market" ? "IOC" : "GTC",
  };
}

/** The exact JSON body POST /v1/ex/orders expects — amounts as canonical strings (PAYMENTS §21). */
export function orderRequestBody(
  input: OrderPreviewInput,
  preview: OrderPreview,
  clientOrderId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    pair: input.pair.id,
    side: input.side,
    type: input.type,
    qty: formatNanoWire(preview.qty ?? 0n),
    client_order_id: clientOrderId,
    tif: preview.tif,
  };
  if (input.type === "market") body.slippage_cap = formatNanoWire(preview.price ?? 0n);
  else body.price = formatNanoWire(preview.price ?? 0n);
  return body;
}

// ── Depth ladder ───────────────────────────────────────────────────────────────────────────────

export interface DepthLadderRow {
  price: bigint;
  qty: bigint;
  /** Running sum of qty from the top of the book down to and including this level. */
  total: bigint;
  /** 0..1 share of the deepest cumulative total, for the background bar. Geometry, not money. */
  ratio: number;
}

/**
 * Aggregate one side of the book into a ladder. `ratio` is the only place a nano value is turned
 * into a JS number, and it is a BAR WIDTH — never displayed, never sent, never compared as money.
 * The conversion is done on the ratio of two BigInts scaled to 4 digits, so even a book beyond
 * 2^53 nano units produces a sane bar.
 */
export function depthLadder(levels: ExDepthLevel[] | undefined, limit = 12): DepthLadderRow[] {
  const rows: DepthLadderRow[] = [];
  let total = 0n;
  for (const level of levels ?? []) {
    if (rows.length >= limit) break;
    const price = parseNano(level.price);
    const qty = parseNano(level.qty);
    if (price === null || qty === null || qty <= 0n) continue;
    total += qty;
    rows.push({ price, qty, total, ratio: 0 });
  }
  if (total > 0n) {
    for (const row of rows) row.ratio = Number((row.total * 10_000n) / total) / 10_000;
  }
  return rows;
}

/** Best bid, best ask and the spread between them, or nulls when a side is empty. */
export function bookTop(depth: ExDepthRow | null | undefined): {
  bid: bigint | null;
  ask: bigint | null;
  spread: bigint | null;
} {
  const bid = parseNano(depth?.bids?.[0]?.price ?? null);
  const ask = parseNano(depth?.asks?.[0]?.price ?? null);
  return { bid, ask, spread: bid !== null && ask !== null ? ask - bid : null };
}

// ── Candles ────────────────────────────────────────────────────────────────────────────────────

export interface CandleSummary {
  first: bigint;
  last: bigint;
  low: bigint;
  high: bigint;
  /** Signed change in basis points of the opening price; null when the open is 0. */
  changeBp: number | null;
  /** Polyline points in a 0..width × 0..height box, newest last. Pixel geometry only. */
  points: Array<{ x: number; y: number }>;
}

/**
 * Reduce a candle window to what a sparkline needs. Money comparisons stay in BigInt; only the
 * final pixel coordinates become numbers, and a flat series is pinned to the vertical middle
 * instead of dividing by a zero range.
 */
export function summarizeCandles(
  candles: ExCandleRow[] | undefined,
  width = 100,
  height = 32,
): CandleSummary | null {
  const closes: bigint[] = [];
  let low: bigint | null = null;
  let high: bigint | null = null;
  for (const candle of candles ?? []) {
    const close = parseNano(candle.c);
    const candleLow = parseNano(candle.l);
    const candleHigh = parseNano(candle.h);
    if (close === null) continue;
    closes.push(close);
    const lo = candleLow ?? close;
    const hi = candleHigh ?? close;
    low = low === null || lo < low ? lo : low;
    high = high === null || hi > high ? hi : high;
  }
  if (closes.length === 0 || low === null || high === null) return null;
  const first = closes[0] as bigint;
  const last = closes[closes.length - 1] as bigint;
  const range = high - low;
  const points = closes.map((close, index) => ({
    x: closes.length === 1 ? width : (index * width) / (closes.length - 1),
    y:
      range === 0n
        ? height / 2
        : height - (Number(((close - low) * 10_000n) / range) / 10_000) * height,
  }));
  return {
    first,
    last,
    low,
    high,
    changeBp: first === 0n ? null : Number(((last - first) * BASIS_POINTS) / first),
    points,
  };
}

// ── Deposits, withdrawals, whitelist ───────────────────────────────────────────────────────────

export interface DepositProgress {
  confirmations: number;
  need: number;
  /** 0..1 for a progress bar; 1 once the deposit is credited. */
  ratio: number;
  credited: boolean;
}

export function depositProgress(row: DepositRow): DepositProgress {
  const need = Math.max(0, Math.trunc(row.need_confirmations));
  const seen = Math.max(0, Math.trunc(row.confirmations));
  const credited = row.status === "credited" || row.credited_tx_id !== null;
  const ratio = credited ? 1 : need === 0 ? 0 : Math.min(1, seen / need);
  return { confirmations: seen, need, ratio, credited };
}

/**
 * The 24-hour cooling period the server puts on a new withdrawal address
 * (modules/onchain.ts addWhitelist: active_after = now + 86400; createWithdrawal refuses with
 * WHITELIST_REQUIRED until it passes). Shown so nobody thinks the address was silently ignored.
 */
export function whitelistState(row: WhitelistRow, nowSec: number): { active: boolean; waitSec: number } {
  const waitSec = Math.max(0, Math.trunc(row.active_after) - Math.trunc(nowSec));
  return { active: waitSec === 0, waitSec };
}

/**
 * What a withdrawal actually costs: the platform fee the server took from the asset
 * (assets.withdraw_fee, already inside `fee`) plus whatever network fee is known so far.
 * `network_fee_state` is passed through untouched — an estimate must never be shown as a fact.
 */
export interface WithdrawalCost {
  amount: bigint | null;
  fee: bigint | null;
  /** amount − fee: what the destination address receives from the ledger's side. */
  net: bigint | null;
  networkFee: bigint | null;
  networkFeeAsset: string | null;
  networkFeeState: WithdrawalRow["network_fee_state"];
}

export function withdrawalCost(row: WithdrawalRow): WithdrawalCost {
  const amount = parseNano(row.amount);
  const fee = parseNano(row.fee);
  const networkFee = parseNano(row.network_fee_actual ?? row.network_fee_amount);
  return {
    amount,
    fee,
    net: amount === null || fee === null ? null : amount - fee,
    networkFee,
    networkFeeAsset: row.network_fee_asset,
    networkFeeState: row.network_fee_state,
  };
}

/**
 * Pre-flight for the withdrawal form, using the same asset limits the server enforces
 * (modules/onchain.ts parseWithdrawal): positive, within [min_amount, max_amount], strictly greater
 * than the fixed withdraw fee, and covered by the available balance.
 */
export type WithdrawProblem =
  | AmountParseFailure
  | "positive"
  | "below_min"
  | "above_max"
  | "fee_exceeds"
  | "insufficient";

export interface WithdrawCheck {
  ok: boolean;
  problem: WithdrawProblem | null;
  nano: bigint | null;
  fee: bigint;
  net: bigint | null;
}

export function checkWithdrawAmount(text: string, asset: WalletAssetRow): WithdrawCheck {
  const fee = parseNano(asset.withdraw_fee) ?? 0n;
  const parsed = parseHumanAmount(text);
  if (!parsed.ok) return { ok: false, problem: parsed.reason, nano: null, fee, net: null };
  const nano = parsed.nano;
  const min = parseNano(asset.min_amount) ?? 0n;
  const max = parseNano(asset.max_amount) ?? 0n;
  const available = parseNano(asset.available) ?? 0n;
  const net = nano - fee;
  const problem: WithdrawProblem | null =
    nano <= 0n
      ? "positive"
      : min > 0n && nano < min
        ? "below_min"
        : max > 0n && nano > max
          ? "above_max"
          : net <= 0n
            ? "fee_exceeds"
            : nano > available
              ? "insufficient"
              : null;
  return { ok: problem === null, problem, nano, fee, net };
}

// ── Swap ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Seconds left on a swap quote. The server rejects an expired quote_id outright, so the button is
 * disabled the moment this hits zero rather than sending a request that cannot succeed.
 */
export function quoteRemainingSec(quote: SwapQuoteRow | null | undefined, nowSec: number): number {
  if (!quote) return 0;
  return Math.max(0, Math.trunc(quote.expires_at) - Math.trunc(nowSec));
}

/** The effective rate a swap quote implies, as "1 FROM = x TO" in nano. */
export function quoteUnitRate(quote: SwapQuoteRow): bigint | null {
  const from = parseNano(quote.amount_from);
  const to = parseNano(quote.amount_to);
  if (from === null || to === null || from === 0n) return null;
  return (to * NANO_ONE) / from;
}

// ── Small shared helpers ───────────────────────────────────────────────────────────────────────

/**
 * A client-side idempotency key for POSTs the server dedupes (client_op_id, client_order_id).
 * crypto.randomUUID is used when present; the fallback stays unique per call without pretending to
 * be cryptographic — the server treats these as opaque replay keys, never as secrets.
 */
export function clientOpId(prefix: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`.slice(0, 64);
}

/** Is either leg of the pair a demo asset? Then the server charges no exchange fee at all. */
export function pairHasDemoAsset(pair: ExPairRow, assets: WalletAssetRow[]): boolean {
  return assets.some(
    (asset) => asset.kind === "demo" && (asset.id === pair.base_asset || asset.id === pair.quote_asset),
  );
}
