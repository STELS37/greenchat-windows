// clients/core — shared wire/event types (T-402).
//
// The server speaks two flavours of the same durable event (T-015/T-018):
//   - long-poll GET /v1/updates -> {events:[{seq, type, payload, created_at}], next_since, resync?}
//   - WebSocket /v1/ws          -> {type:"event", seq?, event_type, payload}
// SyncEngine normalises both into a single SyncEvent so the app never branches on the transport.

// A normalised durable/volatile event. `seq` is null for volatile events (typing/presence/…) that
// arrive only over WS and are never replayed.
export interface SyncEvent {
  seq: number | null;
  type: string;
  payload: unknown;
}

// WS server->client frames.
export interface HelloFrame {
  type: "hello";
  user_id: number;
  session_id: number;
  now: number;
  last_seq: number;
  resync?: boolean;
}

export interface WsEventFrame {
  type: "event";
  seq?: number;
  event_type: string;
  payload: unknown;
}

export interface PongFrame {
  type: "pong";
  now: number;
}

// long-poll shapes.
export interface LongPollEvent {
  seq: number;
  type: string;
  payload: unknown;
  created_at: number;
}

export interface UpdatesResponse {
  events: LongPollEvent[];
  next_since: number;
  resync?: boolean;
}

// The auth session payload returned by register/login (with `user`) and refresh (without).
export interface SessionResult {
  user?: { id: number; username: string; name: string };
  session_id: number;
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
}

// ── T-503 user currency (BANKING §4/§6) — wire shapes, USD-base fiat reference. ───────────────────
// All monetary amounts cross the wire as decimal STRINGS and are NEVER parsed to float on the client
// (BANKING §6 display law): the "≈" formatter feeds the raw string straight to Intl.NumberFormat, so
// full precision survives. These interfaces only describe bytes; they do no rounding themselves.

// One row of GET /v1/fx/rates.items — a USD->quote price. `price` is a scaled-integer STRING (server
// fixed-point, e.g. "923600000"); `age_sec`/`stale` are derived by the server against its max-age
// policy. Consumed read-only for the badge/approx surface.
export interface FxRateItem {
  base: string;
  quote: string;
  price: string;
  source: string;
  fetched_at: number;
  age_sec: number;
  stale: boolean;
}

// GET /v1/fx/rates — the reference-rate table plus its freshness policy. `enabled` mirrors the server
// GC_FX flag; when false `items` is empty and the wallet carries no approx_fiat at all.
export interface FxRatesResult {
  enabled: boolean;
  source: string;
  refresh_sec: number;
  max_age_sec: number;
  manual_max_age_sec: number;
  fetch_fail_streak: number;
  items: FxRateItem[];
}

// A single "≈ amount currency" approximation attached to a wallet balance / history row, computed by
// the server on read and never stored (BANKING §6). Shape rules proven by live probe (T-503):
//   - display currency == USD          -> {currency:"USD", amount, rate_asof:null, stale:false}
//   - rate unavailable (G-004 fallback) -> {currency:"USD", amount, rate_asof:null, stale:false, unavailable:true}
//   - normal cross-rate                 -> {currency, amount, rate_asof:<fetched_at>, stale:<bool>}
// The whole field is ABSENT (not null) when fx is disabled — the formatter renders nothing in that case.
export interface ApproxFiat {
  currency: string;
  amount: string;
  rate_asof: number | null;
  stale: boolean;
  unavailable?: boolean;
}
