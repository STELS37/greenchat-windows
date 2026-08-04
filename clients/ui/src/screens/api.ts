// clients/ui/src/screens/api.ts — the thin transport surface the screens depend on (T-405).
// The UI layer stays decoupled from clients/core: instead of importing the concrete ApiClient, screens
// take anything that structurally satisfies ApiLike (the real ApiClient does). Error helpers classify a
// thrown value WITHOUT importing ApiError/NetworkError — they read the stable `.name`/`.code` contract —
// so a screen can turn any failure into localised text via the i18n error catalogue (CLIENTS §9).
import type { I18n } from "../i18n.ts";

// The subset of clients/core ApiClient that screens call. Structural — ApiClient is assignable to it.
export interface ApiLike {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string, opts?: { body?: unknown }): Promise<T>;
  // Server media URLs are often root-relative. Native shells render on capacitor:// / tauri://, so the
  // concrete ApiClient resolves them against its configured API origin. Optional keeps old fakes valid.
  resolveUrl?(path: string): string;
  // Single-flight refresh used explicitly on cold boot (no access token yet) — see session.restore().
  refreshTokens(): Promise<boolean>;
  // T-426: directory shortcuts (people search + open/create a dialog). OPTIONAL on the structural
  // surface so fakes that predate them still satisfy ApiLike; the real ApiClient (clients/core)
  // implements both (its generic get<T>/post<T> instantiate to these concrete result types).
  searchGlobal?(q: string): Promise<GlobalSearchResult>;
  resolveUser?(username: string): Promise<ResolvedUser>;
  createDialog?(userId: number): Promise<DialogChat>;
  deleteAccount?(password: string): Promise<AccountDeletionResult>;
  // T-512: MS-2 support/feedback shortcuts (server: modules/support.ts, T-511). OPTIONAL on the
  // structural surface (fakes predate them); the real ApiClient implements all three.
  createSupportTicket?(body: SupportTicketPayload): Promise<SupportTicketCreated>;
  listSupportTickets?(limit?: number, beforeId?: number): Promise<SupportTicketList>;
  getSupportTicket?(ref: string): Promise<SupportTicketDetail>;
  // T-514 (MS-4 / T-113): file an abuse report (server: modules/reports.ts, POST /v1/report). A report is
  // NOT a ticket (SUPPORT.md §12). OPTIONAL — the real ApiClient implements it; fakes may omit it.
  reportContent?(body: ReportPayload): Promise<ReportResult>;
  // T-503 (BANKING §4): user-currency shortcuts. OPTIONAL on the structural surface (fakes predate
  // them); the real ApiClient implements both. putMyCurrency sets the display currency (PUT
  // /v1/me/currency -> 204 -> null); getFxRates reads the reference table for the "≈"/badge surface.
  putMyCurrency?(code: string): Promise<null>;
  getFxRates?(currency?: string): Promise<FxRatesResult>;
  // Legal re-consent (v2): consent-position probe + versioned accept (server: modules/legal.ts, T-124).
  // OPTIONAL on the structural surface (fakes predate them); the real ApiClient implements both.
  getLegalStatus?(): Promise<LegalStatus>;
  acceptLegal?(version: number): Promise<LegalAccepted>;
}

// ---- Legal re-consent wire shapes (server: modules/legal.ts, T-124) ----

// GET /v1/legal/status — the caller's exact consent position. `accepted_version` is the edition this
// account last accepted; it lags current_version after an operator bump (⇒ reconsent_required=true).
export interface LegalStatus {
  accepted_version: number | null;
  current_version: number;
  reconsent_required: boolean;
}

// GET /v1/legal/tos|privacy (public) — the CURRENT edition of a published document, as markdown text.
export interface LegalDoc {
  version: number;
  doc: string;
  markdown: string;
}

// POST /v1/legal/accept result — the edition that was recorded, and when.
export interface LegalAccepted {
  version: number;
  accepted_at: number;
}

export interface AccountDeletionResult {
  deleted: true;
  cancellable_until?: number;
}

// ---- T-503 (BANKING §4/§6): fiat reference-rate wire shapes (server: modules/rates.ts) ----
// Restated here (the UI never imports clients/core); mirror FxRateItem/FxRatesResult in core/types.ts.
// `price` is a scaled-integer STRING — never parsed to float on the client (§6 display law).
export interface FxRateItem {
  base: string;
  quote: string;
  price: string;
  source: string;
  fetched_at: number;
  age_sec: number;
  stale: boolean;
}

// GET /v1/fx/rates result: the USD-base table plus its freshness policy. `enabled` mirrors GC_FX; when
// false `items` is empty and wallet rows carry no approx_fiat at all.
export interface FxRatesResult {
  enabled: boolean;
  source: string;
  refresh_sec: number;
  max_age_sec: number;
  manual_max_age_sec: number;
  fetch_fail_streak: number;
  items: FxRateItem[];
}

// ---- T-514 (MS-4 / T-113): abuse-report wire shapes (server: modules/reports.ts) ----

export type ReportKind = "user" | "message" | "chat";
export type ReportReason = "spam" | "abuse" | "csam" | "other";

// Body of POST /v1/report. comment is optional (≤500 on the server); target_id is a positive integer.
export interface ReportPayload {
  kind: ReportKind;
  target_id: number;
  reason: ReportReason;
  comment?: string;
}

// POST /v1/report result (server: publicReport). Only the fields we surface are typed; the rest ride through.
export interface ReportResult {
  id: number;
  kind: string;
  target_id: number;
  reason: string;
  comment: string;
  created_at: number;
  resolved_at: number | null;
}

// ---- T-512: support/feedback wire shapes (server: modules/support.ts) ----

export type SupportCategory = "bug" | "question" | "feedback" | "account" | "payments";

// The already-redacted diagnostics snapshot the diag buffer produces (core DiagSnapshot is assignable).
// The UI never builds or inspects this — it passes it through and shows it verbatim in the preview.
export interface SupportDiagnostics {
  env: unknown;
  entries: Array<{ t: number; kind: string; data: unknown }>;
}

// Body of POST /v1/support/tickets. client_ref is a uuid (server idempotency S-001); auto-fields
// (screen/app_version/platform) ride OUTSIDE the "attach diagnostics" toggle (§3.2).
export interface SupportTicketPayload {
  category: SupportCategory;
  text: string;
  screen?: string;
  app_version?: string;
  platform?: string;
  client_ref: string;
  diagnostics?: SupportDiagnostics;
}

// POST /v1/support/tickets result: ref = "GC-" + id.padStart(6,'0').
export interface SupportTicketCreated {
  ref: string;
  status: string;
  chat_id: number | null;
}

export interface SupportTicketSummary {
  ref: string;
  category: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface SupportTicketList {
  tickets: SupportTicketSummary[];
  next_before_id: number | null;
}

// A PUBLIC ticket event (note/verdict are filtered server-side). `status` events carry {from,to}.
export interface SupportEvent {
  actor: string;
  kind: string;
  payload: unknown;
  created_at: number;
}

export interface SupportTicketDetail {
  ref: string;
  category: string;
  status: string;
  screen: string | null;
  app_version: string | null;
  platform: string | null;
  text: string;
  chat_id: number | null;
  created_at: number;
  updated_at: number;
  events: SupportEvent[];
}

// ---- T-426: the "New chat" directory wire shapes (server: publicUser / chatDetail) ----

// A person from GET /v1/search/global (server: publicUser). Only the fields the New-chat list renders
// are typed; the rest ride through untouched.
export interface SearchUser {
  id: number;
  deleted?: false;
  username: string;
  name: string;
  avatar_file_id: number | null;
  is_bot: boolean;
  // T-514 (§4): present+true marks a service account (@support). OPTIONAL — the server does not emit it
  // today, so a payload without it is a normal account (additive, no regression).
  is_system?: boolean;
}

export type ResolvedUser = SearchUser | { id: number; deleted: true };

// GET /v1/search/global?q= result. The overlay reads only `users`; chats/messages are kept (loosely
// typed) so we neither depend on nor silently drop them.
export interface GlobalSearchResult {
  users: SearchUser[];
  chats: unknown[];
  messages: unknown[];
}

// POST /v1/chats/dialog result (a chat detail) — the fields we need to open the feed and slot a list row.
export interface DialogChat {
  id: number;
  kind: string;
  title: string;
  username: string | null;
  peer_is_bot?: boolean;
  my_role: string;
  message_ttl_sec: number;
  updated_at: number;
}

// The Appendix-D error code of a server-shaped failure, or null for anything else (network/timeout/etc).
export function apiErrorCode(err: unknown): string | null {
  if (err && typeof err === "object" && (err as { name?: unknown }).name === "ApiError") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

// True for a transport failure that never saw an HTTP response (offline/timeout) — clients/core NetworkError.
export function isNetworkError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "NetworkError";
}

// Structured extras the server merged beside {code,message} (e.g. RATE_LIMITED → {retry_after}).
export function apiErrorData(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object" && (err as { name?: unknown }).name === "ApiError") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  return {};
}

// Localise any thrown value: a network drop → the offline message; a server error → its Appendix-D text.
export function describeError(err: unknown, i18n: I18n): string {
  if (isNetworkError(err)) return i18n.t("errors.network");
  return i18n.error(apiErrorCode(err));
}
