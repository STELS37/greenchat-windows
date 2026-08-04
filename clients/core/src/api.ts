// clients/core — ApiClient transport (T-402).
//
// Typed fetch wrapper over the Green Chat HTTP API. Responsibilities (CLIENTS.md §5.1):
//   - envelope: success {ok:true, result} -> result; failure {ok:false, error} -> throw ApiError.
//   - Authorization: Bearer <access token> injected from the in-memory token holder.
//   - single-flight refresh: a TOKEN_EXPIRED (or any 401 the server marks refreshable) triggers ONE
//     shared POST /v1/auth/refresh; concurrent callers await the same promise, then replay once.
//   - retries with exponential backoff + jitter ONLY for idempotent requests: GET, and sends that
//     carry a client_msg_id (server dedupes by (chat, sender, client_msg_id) — T-013), plus network
//     failures where no response was ever seen. Never retries a non-idempotent POST/PATCH/DELETE.
//   - per-request timeout via AbortController.
//   - X-GC-Client: <platform>/<semver> on every request (CLIENTS.md §9).
import { ApiError, NetworkError, type WireError } from "./errors.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

// T-512: a best-effort, PII-free record of one HTTP round-trip, handed to the optional `onRequest`
// observer (the diagnostics ring buffer). Carries NO body and NO headers — only the method, the raw
// path (the observer redacts the query/ids), the HTTP status (0 = no response), the envelope verdict,
// the server error code on failure, and the latency. A throw from the observer never breaks a request.
export interface RequestObservation {
  method: HttpMethod;
  path: string;
  status: number;
  ok: boolean;
  code: string | null;
  ms: number;
}

// The three tokens the SDK cares about. access lives in memory only (§10); refresh is persisted by
// the shell in platform-secure storage and handed in here. The holder is a live reference so a
// refresh updates it in place for every in-flight and future call.
export interface TokenStore {
  access: string | null;
  refresh: string | null;
  // A client-generated successor used to make refresh rotation retry-safe. Shells with durable
  // storage persist it BEFORE the request, so a response lost after the server commit can be
  // replayed with the same (current -> successor) pair instead of destroying the session.
  refreshNext?: string | null;
  // access token expiry (unix seconds), used only as a hint; the server verdict (TOKEN_EXPIRED) is
  // authoritative. null when unknown.
  accessExpiresAt: number | null;
}

// Cross-context refresh serialization. Core supplies the refresh task; a shell may wrap it in an
// origin/process-wide lease and synchronize its secure persisted refresh token before/after the call.
export type RefreshCoordinator = (task: () => Promise<boolean>) => Promise<boolean>;

export interface ApiClientOptions {
  // Base origin, e.g. "http://127.0.0.1:8990" (no trailing slash) or "" for same-origin web.
  baseUrl: string;
  // <platform>/<semver>, e.g. "web/0.1.0" — sent as X-GC-Client.
  clientId: string;
  tokens: TokenStore;
  // Per-request timeout in ms (default 30_000).
  timeoutMs?: number;
  // Max automatic retries for idempotent/networ-failed calls (default 3).
  maxRetries?: number;
  // Called when the session is unrecoverable (refresh failed / 4401-equivalent). The app returns to
  // login. Optional so headless tests need not supply it.
  onAuthLost?: () => void;
  // Optional shell-provided cross-context coordinator. Web serializes rotating refresh tokens across
  // tabs; native/desktop shells may use their secure-store/process lock. Omitted = in-realm single-flight only.
  refreshCoordinator?: RefreshCoordinator;
  // Injected for tests: fetch + a sleep. Default to globals.
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  // Injected deterministic jitter in [0,1) for tests; default Math.random.
  randomImpl?: () => number;
  // T-512: fired once per HTTP round-trip (success OR failure) for the diagnostics ring buffer. Never
  // sees the body or headers; any throw is swallowed so diagnostics can never break a request.
  onRequest?: (obs: RequestObservation) => void;
}

export interface RequestOptions {
  // Request body — JSON-encoded. Omit for GET.
  body?: unknown;
  // Force idempotency on/off. Default: GET is idempotent; a POST/PATCH is idempotent iff its body
  // carries a client_msg_id. Explicitly set true for other retry-safe calls.
  idempotent?: boolean;
  // Per-call timeout override (ms).
  timeoutMs?: number;
  // AbortSignal from the caller (e.g. component unmount). Composed with the internal timeout.
  signal?: AbortSignal;
  // Skip the auth header (auth-less endpoints: register/login/refresh).
  noAuth?: boolean;
  // Some authenticated handlers deliberately use 401 for a secondary credential challenge (for example,
  // DELETE /v1/account with a wrong confirmation password). Those narrowly-scoped calls skip even the
  // one-shot session probe and surface the error locally. Direct SESSION_WIPED / ACCOUNT_SUSPENDED verdicts
  // remain fatal regardless of this flag.
  preserveAuthOnUnauthorized?: boolean;
}

export interface AccountDeletionResult {
  deleted: true;
  cancellable_until?: number;
}

export type ResolvedUser =
  | {
      id: number;
      username: string;
      name: string;
      avatar_file_id: number | null;
      is_bot: boolean;
      is_system?: boolean;
      deleted?: false;
    }
  | { id: number; deleted: true };

const REFRESH_SUCCESSOR_BYTES = 48;

/** Generate the same 96-hex-character opaque credential shape as the server's randomToken(). */
export function createRefreshSuccessor(): string | null {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) return null;
  const bytes = cryptoApi.getRandomValues(new Uint8Array(REFRESH_SUCCESSOR_BYTES));
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  readonly tokens: TokenStore;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onAuthLost: (() => void) | undefined;
  private readonly refreshCoordinator: RefreshCoordinator;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly onRequest: ((obs: RequestObservation) => void) | undefined;

  // The single in-flight refresh promise (single-flight). null when no refresh is running.
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.clientId = opts.clientId;
    this.tokens = opts.tokens;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.onAuthLost = opts.onAuthLost;
    this.refreshCoordinator = opts.refreshCoordinator ?? (async (task) => task());
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.randomImpl = opts.randomImpl ?? Math.random;
    this.onRequest = opts.onRequest;
  }

  private observe(obs: RequestObservation): void {
    try { this.onRequest?.(obs); } catch { /* diagnostics must never break a request */ }
  }

  /**
   * Resolve a server-returned resource path against the API origin. Web normally uses same-origin
   * paths, while Capacitor/Tauri render from their own local origin and therefore must not ask the
   * WebView host for `/f/...`. Absolute/blob/data URLs are already complete and stay untouched.
   */
  resolveUrl(value: string): string {
    const url = value.trim();
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;
    if (!this.baseUrl) return url;
    return `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  get<T>(path: string, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, { ...opts, idempotent: opts.idempotent ?? true });
  }

  post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }

  patch<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }

  put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }

  delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  deleteAccount(password: string): Promise<AccountDeletionResult> {
    return this.delete<AccountDeletionResult>("/v1/account", {
      body: { password },
      preserveAuthOnUnauthorized: true,
    });
  }

  resolveUser(username: string): Promise<ResolvedUser> {
    const exact = username.trim().replace(/^@+/, "");
    if (!exact) return Promise.reject(new Error("username is required"));
    return this.get<ResolvedUser>(
      `/v1/users/resolve?username=${encodeURIComponent(exact)}`,
    );
  }

  // T-426: two typed shortcuts over already-existing endpoints, so a screen opens the "New chat"
  // directory without hand-building the URL/body. Pure sugar over get/post — SAME transport (auth,
  // retries, single-flight refresh); no new logic.
  // GET /v1/search/global?q= — the people/chat/message directory (this UI reads only `result.users`).
  searchGlobal<T>(q: string): Promise<T> {
    return this.get<T>(`/v1/search/global?q=${encodeURIComponent(q)}`);
  }

  // POST /v1/chats/dialog {user_id} — open (or create) the 1:1 dialog with a user; user_id === me is
  // the "Saved Messages" self-dialog. Returns the chat detail (id/kind/title/…).
  createDialog<T>(userId: number): Promise<T> {
    return this.post<T>("/v1/chats/dialog", { user_id: userId });
  }

  // T-512 — MS-2 support/feedback: typed shortcuts over the T-511 endpoints (same transport: auth,
  // single-flight refresh; no new logic). The create carries a client_ref so the server is idempotent
  // (S-001) — a replay from the offline queue folds onto the SAME ticket. It is deliberately NOT
  // auto-idempotent at the transport layer: a transient failure surfaces to the caller (which enqueues
  // it, S-003) instead of the backoff loop hammering a 429/LIMIT_EXCEEDED.
  createSupportTicket<T>(body: unknown): Promise<T> {
    return this.post<T>("/v1/support/tickets", body);
  }

  // GET /v1/support/tickets?limit=&before_id= — the caller's own tickets, newest-first (keyset).
  listSupportTickets<T>(limit = 50, beforeId?: number): Promise<T> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (typeof beforeId === "number") q.set("before_id", String(beforeId));
    return this.get<T>(`/v1/support/tickets?${q.toString()}`);
  }

  // GET /v1/support/tickets/:ref — one ticket with its public event timeline (status lines, §3.3).
  getSupportTicket<T>(ref: string): Promise<T> {
    return this.get<T>(`/v1/support/tickets/${encodeURIComponent(ref)}`);
  }

  // T-514 — MS-4 / T-113: file an abuse report over the EXISTING endpoint (POST /v1/report). A report is
  // NOT a support ticket (SUPPORT.md §12): it feeds a separate moderation flow with its own `reports`
  // table. The support overlay's "Пожаловаться на пользователя или контент" link hands off here. Same
  // transport (auth); the server is idempotent per open (reporter, kind, target), so a double-submit folds
  // onto the existing open report instead of flooding the queue.
  reportContent<T>(body: unknown): Promise<T> {
    return this.post<T>("/v1/report", body);
  }

  // T-503 — user currency (BANKING §4): typed shortcuts over the T-502 endpoints (same transport:
  // auth, single-flight refresh; no new logic). The server stays the source of truth for the display
  // currency — the client only reads it back from GET /v1/users/me (display_currency) after a write.
  //
  // PUT /v1/me/currency {currency} — set the caller's display currency (ISO-4217). The server trims/
  // upcases the code, validates it against Intl.supportedValuesOf("currency") (VALIDATION_FAILED on an
  // unknown code), self-responds 204 (no body -> null here) and emits a user.update. NOT auto-retried
  // by transport idempotency rules (a PUT without client_msg_id), which is fine: the write is a plain
  // last-writer-wins set with no double-write hazard.
  putMyCurrency(code: string): Promise<null> {
    return this.put<null>("/v1/me/currency", { currency: code });
  }

  // GET /v1/fx/rates[?currency=CUR] — the fiat reference rates (USD base), read-only, used to render
  // the "≈" approximations and the stale/unavailable badges. An optional `currency` filters to one
  // quote. Generic `<T>` to match the other shortcuts; callers pass FxRatesResult from ./types.ts.
  getFxRates<T>(currency?: string): Promise<T> {
    const q = currency ? `?currency=${encodeURIComponent(currency)}` : "";
    return this.get<T>(`/v1/fx/rates${q}`);
  }

  // Re-consent program (legal v2, client half) — typed shortcuts over the T-124 legal endpoints
  // (same transport: auth, single-flight refresh; no new logic).
  //
  // GET /v1/legal/status — the caller's exact consent position: {accepted_version, current_version,
  // reconsent_required}. Read after login/restore so the client discovers a version gap proactively
  // instead of learning it from its first refused write (403 LEGAL_RECONSENT).
  getLegalStatus<T>(): Promise<T> {
    return this.get<T>("/v1/legal/status");
  }

  // POST /v1/legal/accept {legal_accepted:true, version} — records consent to EXACTLY the edition the
  // client displayed (the status/document `version` it rendered, never a hardcode). The server refuses
  // a stale version with 403 LEGAL_RECONSENT + {version} and writes NOTHING — that closes the legacy
  // race where an operator bump between display and click stamped consent to unseen text. Deliberately
  // NOT auto-idempotent at the transport layer: consent is a deliberate act; a transient failure
  // surfaces to the screen (which keeps the button re-tappable) instead of a background replay loop.
  acceptLegal<T>(version: number): Promise<T> {
    return this.post<T>("/v1/legal/accept", { legal_accepted: true, version });
  }

  // A request is idempotent (safe to auto-retry on a server 5xx / network drop) when it is a GET,
  // when the caller forced idempotent:true, or when it is a mutation carrying a client_msg_id (the
  // server dedupes on it, so a replay cannot double-write).
  private isIdempotent(method: HttpMethod, opts: RequestOptions): boolean {
    if (opts.idempotent !== undefined) return opts.idempotent;
    if (method === "GET") return true;
    const b = opts.body;
    return (
      typeof b === "object" &&
      b !== null &&
      typeof (b as Record<string, unknown>).client_msg_id === "string"
    );
  }

  // Core request path: attempt -> (refresh on expiry) -> retry idempotent on transient failures.
  async request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const idempotent = this.isIdempotent(method, opts);
    let attempt = 0;
    let refreshedOnce = false;

    for (;;) {
      try {
        return await this.attempt<T>(method, path, opts);
      } catch (err) {

        // A caller abort is an explicit lifecycle decision (component unmount, app LOCKED, remote wipe),
        // not a transient network failure. Never refresh/retry/back off after the caller revoked the
        // request: retries would keep the data plane alive after the security boundary closed.
        if (opts.signal?.aborted) throw err;
        // TOKEN_EXPIRED is unambiguous: refresh once and replay the request. Generic UNAUTHORIZED is
        // ambiguous because protected handlers also use it for a wrong old password/TOTP. Probe the
        // durable session once, but replay only an idempotent request; a mutation must be retried by the
        // user so an uncertain response can never duplicate a write. If refresh is rejected, the session
        // really is dead and the ordinary auth-loss wipe runs.
        const genericUnauthorized = err instanceof ApiError && err.code === "UNAUTHORIZED";
        const shouldProbeSession =
          err instanceof ApiError &&
          !opts.noAuth &&
          !refreshedOnce &&
          (err.isTokenExpired || (genericUnauthorized && !opts.preserveAuthOnUnauthorized));
        if (shouldProbeSession) {
          const replayAfterRefresh = err.isTokenExpired || idempotent;
          refreshedOnce = true;
          let refreshed: boolean;
          try {
            refreshed = await this.refreshTokens();
          } catch (refreshErr) {
            // Transient refresh failure (offline / 5xx): the session is preserved (T-422), so we must
            // NEVER onAuthLost here. Retry an idempotent call under the normal backoff policy (the
            // replay re-attempts the refresh); surface the failure to a non-idempotent caller as-is.
            if (idempotent && attempt < this.maxRetries) {
              await this.sleepImpl(this.backoff(attempt));
              attempt++;
              refreshedOnce = false;
              continue;
            }
            throw refreshErr;
          }
          if (refreshed) {
            if (replayAfterRefresh) continue;
            throw err;
          }
          this.onAuthLost?.();
          throw err;
        }
        if (err instanceof ApiError && err.isAuthFatal && !opts.noAuth) {
          this.onAuthLost?.();
          throw err;
        }

        // Retry policy: only idempotent calls, only transient failures (network with no response,
        // or a server 5xx / 429), and only while retries remain.
        const transient =
          err instanceof NetworkError ||
          (err instanceof ApiError && (err.httpStatus >= 500 || err.httpStatus === 429));
        if (idempotent && transient && attempt < this.maxRetries) {
          await this.sleepImpl(this.backoff(attempt));
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  // One HTTP round-trip: build headers, enforce timeout, decode the envelope.
  private async attempt<T>(method: HttpMethod, path: string, opts: RequestOptions): Promise<T> {
    const started = Date.now();
    const headers: Record<string, string> = { "x-gc-client": this.clientId };
    let body: string | undefined;
    if (opts.body !== undefined && method !== "GET") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (!opts.noAuth && this.tokens.access) {
      headers["authorization"] = `Bearer ${this.tokens.access}`;
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
    const onExternalAbort = () => ac.abort((opts.signal as AbortSignal).reason);
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: ac.signal,
      });
    } catch (err) {
      // Distinguish our own timeout from a real network drop; both mean "no HTTP response".
      const timedOut = ac.signal.aborted && (ac.signal.reason as { name?: string })?.name === "TimeoutError";
      this.observe({ method, path, status: 0, ok: false, code: timedOut ? "TIMEOUT" : "NETWORK", ms: Date.now() - started });
      throw new NetworkError(timedOut ? "request timed out" : "network request failed", err, timedOut);
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    }

    // 204 No Content carries no envelope to decode: some mutations self-respond bodyless (e.g.
    // PUT /v1/me/currency — T-503). Treat it as a success returning null, instead of falling into the
    // "empty body -> JSON.parse('') guarded to {} -> neither ok nor error -> BAD_RESPONSE" trap below.
    if (res.status === 204) {
      this.observe({ method, path, status: 204, ok: true, code: null, ms: Date.now() - started });
      return null as T;
    }

    const text = await res.text();
    let parsed: { ok?: boolean; result?: T; error?: WireError };
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body from a proxy/gateway (e.g. 502 HTML) — treat by status.
      this.observe({ method, path, status: res.status, ok: false, code: "BAD_RESPONSE", ms: Date.now() - started });
      throw new ApiError("BAD_RESPONSE", `non-JSON response (HTTP ${res.status})`, res.status);
    }

    if (parsed.ok === true) {
      this.observe({ method, path, status: res.status, ok: true, code: null, ms: Date.now() - started });
      return (parsed.result === undefined ? (null as T) : parsed.result) as T;
    }
    if (parsed.error) {
      this.observe({ method, path, status: res.status, ok: false, code: parsed.error.code ?? "ERROR", ms: Date.now() - started });
      throw ApiError.fromWire(parsed.error, res.status);
    }
    // Well-formed HTTP error without our envelope (shouldn't happen against our server).
    this.observe({ method, path, status: res.status, ok: false, code: "BAD_RESPONSE", ms: Date.now() - started });
    throw new ApiError("BAD_RESPONSE", `unexpected response (HTTP ${res.status})`, res.status);
  }

  // Single-flight refresh: the first caller starts the refresh; everyone else awaits the same
  // promise (this coalesces the HTTP path with the WS 4401 path — T-421). Resolves true on success
  // (tokens updated in place); resolves false only on an explicit terminal auth/session verdict after
  // clearing the dead tokens; REJECTS on transient or ambiguous failures WITHOUT touching credentials, so the
  // caller retries later instead of destroying a valid session while offline (T-422).
  refreshTokens(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = this.refreshCoordinator(() => this.doRefresh()).finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = p;
    return p;
  }

  private async doRefresh(): Promise<boolean> {
    const refresh = this.tokens.refresh;
    if (!refresh) return false;

    // The successor is chosen by the client and reused until the rotation is acknowledged. A shell
    // coordinator may already have generated + durably persisted it; headless/native callers still
    // get in-process retry safety from this fallback.
    const generated = this.tokens.refreshNext ?? createRefreshSuccessor();
    if (generated && generated !== refresh) this.tokens.refreshNext = generated;
    else if (generated === refresh) this.tokens.refreshNext = null;
    const successor = this.tokens.refreshNext ?? null;

    try {
      const r = await this.attempt<{
        session_id: number;
        access_token: string;
        access_expires_at: number;
        refresh_token: string;
      }>("POST", "/v1/auth/refresh", {
        body: {
          refresh_token: refresh,
          ...(successor ? { next_refresh_token: successor } : {}),
        },
        noAuth: true,
      });
      this.tokens.access = r.access_token;
      this.tokens.refresh = r.refresh_token;
      this.tokens.refreshNext = null;
      this.tokens.accessExpiresAt = r.access_expires_at;
      return true;
    } catch (err) {
      // REFRESH_SUPERSEDED is a benign cross-context race: another tab/process already advanced the
      // credential. The coordinator reloads durable state (or the ordinary retry path tries later).
      // Likewise, rate limits, malformed proxy responses and other non-definitive 4xx responses must
      // never erase a valid account. Only explicit account/session verdicts are terminal.
      if (err instanceof ApiError && err.code === "REFRESH_SUPERSEDED") throw err;
      if (
        err instanceof ApiError &&
        (err.code === "UNAUTHORIZED" || err.code === "ACCOUNT_SUSPENDED" || err.code === "SESSION_WIPED")
      ) {
        this.tokens.access = null;
        this.tokens.refresh = null;
        this.tokens.refreshNext = null;
        this.tokens.accessExpiresAt = null;
        return false;
      }
      throw err;
    }
  }

  // Full-jitter exponential backoff: random in [0, min(cap, base*2^attempt)].
  private backoff(attempt: number): number {
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    return Math.floor(this.randomImpl() * ceiling);
  }
}
