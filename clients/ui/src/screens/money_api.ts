// clients/ui/src/screens/money_api.ts — the typed transport for every money route (T005).
//
// One module owns every money PATH, every query parameter and every request BODY the finance hub
// sends. The screens never build a URL themselves, for three measured reasons:
//
//  1. Pair identifiers contain a slash ("BTC/GUSD"). The router matches route segments against the
//     RAW pathname and decodes each capture afterwards (server/src/core/http.ts:352), so a pair must
//     travel as encodeURIComponent(pair) — "/v1/ex/ticker/BTC/GUSD" is five segments and matches
//     nothing (404), while "/v1/ex/ticker/BTC%2FGUSD" is four and matches. The server's own tests
//     spell it exactly this way (server/test/integration/exchange_data.test.ts:176).
//  2. Amounts leave here as canonical nano strings only (THE WIRE LAW, finance_model.ts). The
//     request types below accept `string`, and every caller is required to have produced that string
//     through humanToNano()/formatNanoWire() — never from a float or a raw input value.
//  3. It stays testable without a DOM: a fake ApiLike records the exact path and body, so a typo in
//     a route or a field name fails a unit test instead of a user's withdrawal.
//
// The transport itself is ApiLike (clients/core ApiClient satisfies it structurally), so this layer
// adds no auth, retry or refresh behaviour of its own — it only names things correctly.
import type { ApiLike } from "./api.ts";
import type {
  DepositRow,
  ExCandleRow,
  ExDepthRow,
  ExMyTradeRow,
  ExOrderRow,
  ExPairRow,
  ExTickerRow,
  ExTradeRow,
  SwapQuoteRow,
  SwapResultRow,
  WalletAssetRow,
  WhitelistRow,
  WithdrawalRow,
} from "./finance_model.ts";
// The token page's wire shape lives with the model that reads it, so there is exactly one definition
// of what `/v1/gcn` returns and the transport cannot drift from the screen.
import type { GcnWire } from "./gcn_model.ts";

// ---- wallet wire shapes (server: modules/wallet.ts) ----

/** An "≈ 12.34 EUR" annotation. `amount` is ALREADY a human decimal string (server formatMinorUnits). */
export interface ApproxFiatRow {
  currency: string;
  amount: string;
  stale: boolean;
  unavailable?: boolean;
}

/** GET /v1/wallet → payment_settings. `pin_required_usd` is a human decimal, not nano. */
export interface PaymentSettingsRow {
  has_pin: boolean;
  two_factor_enabled: boolean;
  pin_required_usd: string;
  security_hold_until: number | null;
}

export interface WalletResult {
  total_usd: string;
  approx_fiat?: ApproxFiatRow | null;
  assets: WalletAssetRow[];
  payment_settings: PaymentSettingsRow;
}

export interface WalletHistoryRow {
  id: number;
  op: string;
  asset: string;
  amount: string;
  balance: string;
  memo: string | null;
  created_at: number;
  approx_fiat?: ApproxFiatRow | null;
}

export interface WalletHistoryResult {
  items: WalletHistoryRow[];
  next_before_id: number | null;
}

/** GET /v1/wallet/deposit_address?chain= (server: modules/onchain.ts getDepositAddress). */
export interface DepositAddressResult {
  chain: string;
  address: string;
  derivation_index: number;
}

export interface DepositListResult {
  items: DepositRow[];
}

export interface WithdrawalListResult {
  items: WithdrawalRow[];
}

/** POST /v1/wallet/withdrawals and .../:id/cancel both answer the row plus its ledger tx id. */
export interface WithdrawalResult {
  withdrawal: WithdrawalRow;
  tx_id: number | null;
}

export interface WhitelistListResult {
  items: WhitelistRow[];
}

/**
 * Body of POST /v1/wallet/withdrawals (server: parseWithdrawal).
 * `amount` is nano and INCLUDES the withdraw fee — the server credits `amount - fee` on-chain and
 * rejects `fee >= amount`. `pin` is always sent (the server reads it as a required string field);
 * `code` carries the second factor when the account has one.
 */
export interface WithdrawalRequest {
  chain: string;
  asset: string;
  to_address: string;
  amount: string;
  client_op_id: string;
  pin: string;
  code?: string;
}

/** Body of POST /v1/wallet/whitelist. A new entry activates only after 24h (server: activeAfter). */
export interface WhitelistRequest {
  chain: string;
  address: string;
  label?: string | null;
}

/** Body of POST /v1/wallet/pin: re-auth by password (+2FA), then the new 4–8 digit PIN. */
export interface WalletPinRequest {
  password: string;
  pin: string;
  code?: string;
}

export interface WalletPinResult {
  has_pin: true;
}

/**
 * POST /v1/wallet/faucet -> server modules/wallet.ts postWalletFaucet. Demo-money credit: it exists
 * only where /v1/config advertises `demo_finance`, only for `kind='demo'` assets, and the server caps
 * the rolling 24h intake per user and asset. It is the only way a user can obtain a balance on a
 * deployment with no live rails, which is what makes wallet/exchange exercisable at all.
 */
export interface FaucetResult {
  tx_id: number;
  asset: string;
  amount: string;
}

export interface WhitelistDeleted {
  deleted: true;
}

/**
 * A claimable transfer parked in an envelope (server: modules/wallet.ts, GET /v1/envelopes).
 * `role` says what this user can do with it: a `recipient` claims, a `sender` may take it back.
 */
export interface EnvelopeRow {
  id: number;
  sender_id: number;
  chat_id: number | null;
  target_user_id: number | null;
  asset: string;
  total: string;
  remaining: string;
  parts: number;
  claimed_parts: number;
  status: string;
  expires_at: number;
  created_at: number;
  role: "sender" | "recipient";
}

export interface EnvelopeInboxResult {
  envelopes: EnvelopeRow[];
}

export interface EnvelopeClaimResult {
  tx_id: number | null;
  envelope: Record<string, unknown>;
  claim: { user_id: number; amount: string; created_at: number };
}

export interface EnvelopeRefundResult {
  tx_id: number | null;
  refunded_amount: string;
  envelope: Record<string, unknown>;
}

// ---- exchange wire shapes (server: modules/exchange.ts, modules/swaps.ts) ----

export interface ExPairsResult {
  pairs: ExPairRow[];
}

export interface ExTickersResult {
  tickers: ExTickerRow[];
}

/**
 * GET /v1/ex/ticker/:pair answers `{ ticker }` — an ENVELOPE, unlike GET /v1/ex/depth/:pair which
 * returns the depth object bare (server modules/exchange.ts getTicker vs getDepth). Typing this
 * route as the bare row would have made `result.last` silently undefined at runtime.
 */
export interface ExTickerResult {
  ticker: ExTickerRow;
}

export interface ExTradesResult {
  trades: ExTradeRow[];
}

export interface ExMyTradesResult {
  trades: ExMyTradeRow[];
}

export interface ExOrdersResult {
  orders: ExOrderRow[];
}

export type ExCandleTf = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface ExCandlesResult {
  pair: string;
  tf: ExCandleTf;
  candles: ExCandleRow[];
}

export type ExOrderStatusFilter = "waiting" | "open" | "partial" | "filled" | "cancelled";

/**
 * Body of POST /v1/ex/orders (server: postOrder). `qty`/`price`/`slippage_cap` are nano strings.
 * A market order carries no price; `tif`/`post_only` are optional and defaulted server-side.
 */
export interface ExOrderRequest {
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  qty: string;
  price?: string;
  slippage_cap?: string;
  client_order_id: string;
  tif?: "GTC" | "IOC" | "FOK";
  post_only?: boolean;
}

/** POST /v1/ex/orders and DELETE /v1/ex/orders/:id both answer the order plus the trades it caused. */
export interface ExPlaceResult {
  order: ExOrderRow;
  trades: ExTradeRow[];
}

/** Body of POST /v1/ex/swap/quote. `amount` is the nano amount of `from` being sold. */
export interface SwapQuoteRequest {
  from: string;
  to: string;
  amount: string;
}

/**
 * Body of POST /v1/ex/swap: the quote to execute, plus the PIN when the notional needs one.
 * `quote_id` is the NUMBER the quote answered with (server quoteId() accepts a number or its digit
 * string); it is echoed back unchanged rather than re-typed.
 */
export interface SwapRequest {
  quote_id: number;
  pin?: string;
}

/**
 * One row of GET /v1/wallet/chains: a chain this deployment can actually serve, and whether each
 * direction is open right now. Absence from the list means "no rail here", which is a different
 * statement from `deposits: false` ("rail exists, currently frozen") and must be shown differently.
 */
export interface WalletChainRow {
  chain: string;
  deposits: boolean;
  withdrawals: boolean;
}

/** Result of GET /v1/wallet/chains. */
export interface WalletChainsResult {
  chains: WalletChainRow[];
  frozen: boolean;
}

// ---- the surface ----

/** Every money call the finance hub makes, named once. */
export interface MoneyApi {
  wallet(): Promise<WalletResult>;
  walletHistory(limit?: number, beforeId?: number): Promise<WalletHistoryResult>;
  /** Chains with a real rail on this deployment — never inferred from an asset's `chain` label. */
  walletChains(): Promise<WalletChainsResult>;
  depositAddress(chain: string): Promise<DepositAddressResult>;
  deposits(): Promise<DepositListResult>;
  withdrawals(): Promise<WithdrawalListResult>;
  createWithdrawal(body: WithdrawalRequest): Promise<WithdrawalResult>;
  cancelWithdrawal(id: number): Promise<WithdrawalResult>;
  whitelist(): Promise<WhitelistListResult>;
  addWhitelist(body: WhitelistRequest): Promise<WhitelistRow>;
  deleteWhitelist(id: number): Promise<WhitelistDeleted>;
  setWalletPin(body: WalletPinRequest): Promise<WalletPinResult>;
  faucet(body: { asset: string; amount: string }): Promise<FaucetResult>;
  envelopes(): Promise<EnvelopeInboxResult>;
  claimEnvelope(id: number): Promise<EnvelopeClaimResult>;
  refundEnvelope(id: number): Promise<EnvelopeRefundResult>;
  pairs(): Promise<ExPairsResult>;
  tickers(): Promise<ExTickersResult>;
  ticker(pair: string): Promise<ExTickerResult>;
  depth(pair: string): Promise<ExDepthRow>;
  trades(pair: string): Promise<ExTradesResult>;
  candles(pair: string, tf: ExCandleTf, from?: number, to?: number): Promise<ExCandlesResult>;
  orders(status?: ExOrderStatusFilter): Promise<ExOrdersResult>;
  placeOrder(body: ExOrderRequest): Promise<ExPlaceResult>;
  cancelOrder(id: number): Promise<ExPlaceResult>;
  myTrades(): Promise<ExMyTradesResult>;
  swapQuote(body: SwapQuoteRequest): Promise<SwapQuoteRow>;
  swap(body: SwapRequest): Promise<SwapResultRow>;
  /**
   * The Green Coin (GCN) token page: supply, deflation, the holder programme and the caller's own
   * standing in it. Read-only by construction — the server exposes no mint/burn lever over HTTP at
   * all (server/test/integration/gcn_api.test.ts), so this transport has nothing to write.
   */
  gcn(): Promise<GcnWire>;
}

/** A pair identifier as ONE path segment (see reason 1 in the header). */
export function pairSegment(pair: string): string {
  return encodeURIComponent(pair);
}

// Every method below returns a promise, so every failure must arrive through that promise. A method
// that builds a dynamic path segment is therefore `async`: without it the RangeError/URIError below
// would be thrown SYNCHRONOUSLY out of the call expression, and a caller that only attached .catch()
// — which is what every screen here does — would take an unhandled exception mid-render instead of
// showing an error. One failure channel, no exceptions.

/**
 * A positive integer path id. A non-integer would build a path the server answers with a 400
 * VALIDATION at best, so it is refused here where the caller's bug is still visible.
 */
function idSegment(id: number, what: string): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError(`invalid ${what} id`);
  return String(id);
}

function queryString(params: Array<[string, string | number | undefined]>): string {
  const search = params
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
  return search ? `?${search}` : "";
}

/** Bind the money routes to a transport. */
export function createMoneyApi(api: ApiLike): MoneyApi {
  return {
    wallet: () => api.get<WalletResult>("/v1/wallet"),
    walletHistory: (limit, beforeId) =>
      api.get<WalletHistoryResult>(
        "/v1/wallet/history" + queryString([["limit", limit], ["before_id", beforeId]]),
      ),
    walletChains: () => api.get<WalletChainsResult>("/v1/wallet/chains"),
    depositAddress: (chain) =>
      api.get<DepositAddressResult>("/v1/wallet/deposit_address" + queryString([["chain", chain]])),
    deposits: () => api.get<DepositListResult>("/v1/wallet/deposits"),
    withdrawals: () => api.get<WithdrawalListResult>("/v1/wallet/withdrawals"),
    createWithdrawal: (body) => api.post<WithdrawalResult>("/v1/wallet/withdrawals", body),
    cancelWithdrawal: async (id) =>
      api.post<WithdrawalResult>(`/v1/wallet/withdrawals/${idSegment(id, "withdrawal")}/cancel`),
    whitelist: () => api.get<WhitelistListResult>("/v1/wallet/whitelist"),
    addWhitelist: (body) => api.post<WhitelistRow>("/v1/wallet/whitelist", body),
    deleteWhitelist: async (id) =>
      api.delete<WhitelistDeleted>(`/v1/wallet/whitelist/${idSegment(id, "whitelist")}`),
    setWalletPin: (body) => api.post<WalletPinResult>("/v1/wallet/pin", body),
    faucet: (body) => api.post<FaucetResult>("/v1/wallet/faucet", body),
    envelopes: () => api.get<EnvelopeInboxResult>("/v1/envelopes"),
    claimEnvelope: async (id) =>
      api.post<EnvelopeClaimResult>(`/v1/envelopes/${idSegment(id, "envelope")}/claim`),
    refundEnvelope: async (id) =>
      api.post<EnvelopeRefundResult>(`/v1/envelopes/${idSegment(id, "envelope")}/refund`),
    pairs: () => api.get<ExPairsResult>("/v1/ex/pairs"),
    tickers: () => api.get<ExTickersResult>("/v1/ex/tickers"),
    ticker: async (pair) => api.get<ExTickerResult>(`/v1/ex/ticker/${pairSegment(pair)}`),
    depth: async (pair) => api.get<ExDepthRow>(`/v1/ex/depth/${pairSegment(pair)}`),
    trades: async (pair) => api.get<ExTradesResult>(`/v1/ex/trades/${pairSegment(pair)}`),
    candles: async (pair, tf, from, to) =>
      api.get<ExCandlesResult>(
        `/v1/ex/candles/${pairSegment(pair)}` + queryString([["tf", tf], ["from", from], ["to", to]]),
      ),
    orders: (status) => api.get<ExOrdersResult>("/v1/ex/orders" + queryString([["status", status]])),
    placeOrder: (body) => api.post<ExPlaceResult>("/v1/ex/orders", body),
    cancelOrder: async (id) => api.delete<ExPlaceResult>(`/v1/ex/orders/${idSegment(id, "order")}`),
    myTrades: () => api.get<ExMyTradesResult>("/v1/ex/my_trades"),
    swapQuote: (body) => api.post<SwapQuoteRow>("/v1/ex/swap/quote", body),
    swap: (body) => api.post<SwapResultRow>("/v1/ex/swap", body),
    gcn: () => api.get<GcnWire>("/v1/gcn"),
  };
}
