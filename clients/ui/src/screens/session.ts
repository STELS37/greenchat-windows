// clients/ui/src/screens/session.ts — the auth session controller for every shell (T-405, CLIENTS §10).
// Owns the login/register/logout/restore lifecycle around the shared token holder. Security rules:
//   • the ACCESS token lives in memory only (the TokenHolder the ApiClient reads) — never persisted;
//   • the REFRESH token + a small user snapshot are kept in the shell's secure storage (web: localStorage)
//     so a reload restores the session by refreshing for a fresh access token BEFORE the first API call
//     (a bare GET with no access token would be a fatal 401, so we refresh explicitly on cold boot);
//   • a transient refresh failure (offline) keeps the session (T-422) instead of logging the user out.
// DOM-free and storage-injected → unit-tested with a fake ApiLike + storage.
//
// T-121: register() runs behind the core PoW gate (executeWithPow). When the server demands the
// anti-bot proof-of-work (GC_POW=1 → 400 POW_REQUIRED), the gate fetches ONE challenge from
// GET /v1/auth/pow, solves it and retries the register exactly once with {pow_salt, pow_nonce}
// (bounded retries — pow_gate.ts). The SOLVER EXECUTOR is injectable via SessionDeps.powRunner: the
// web shell passes its Web Worker runner (web/src/pow_runner.ts) so a bits=20 solve never blocks the
// UI thread; the default is the in-process solver, so these unit tests and non-worker shells need no
// DOM/Worker. This is the ONE deliberate exception to the «ui does not import core» convention
// (settings_model.ts): the gate's retry discipline is a security contract that must not be duplicated,
// and only the DOM-free pow_gate module is imported — the ApiLike transport decoupling stands.
import {
  executeWithPow,
  type PowRunner,
  type PowChallenge,
} from "../../../core/src/pow_gate.ts";
import { apiErrorCode, type AccountDeletionResult, type ApiLike } from "./api.ts";
export type { AccountDeletionResult } from "./api.ts";
import type { AuthUser, AuthSession } from "./types.ts";

// The live token reference shared with the ApiClient — a refresh updates it in place.
export interface TokenHolder {
  access: string | null;
  refresh: string | null;
  refreshNext?: string | null;
  accessExpiresAt: number | null;
}

// The persisted slice: the rotating refresh token + who it belongs to (for an instant cold-start header).
export interface PersistedSession {
  refresh: string;
  // Durable in-progress rotation. Both values are needed after a process kill: retrying the SAME
  // pair is safe whether the server committed the first request or never received it.
  pendingRefresh?: string;
  user: AuthUser;
}

export interface SessionStorage {
  load(): PersistedSession | null;
  save(value: PersistedSession): void;
  clear(): void;
  /** Native shells resolve only after Keystore/Keychain has durably applied earlier writes. */
  flush?(): Promise<void>;
}

// The local cache substrate, seen abstractly so Session can wipe it on logout / owner change without
// importing core or touching IndexedDB/CacheStorage directly (T-423, CLIENTS §10 privacy).
//   • wipe()     — delete ALL cached user data (IndexedDB store + media CacheStorage). Best-effort.
//   • getOwner() — the user id the cached data belongs to, or null (never set / already wiped).
//   • setOwner() — stamp the current owner so a later login by a DIFFERENT account is detected.
export interface LocalData {
  wipe(): Promise<void>;
  getOwner(): Promise<number | null>;
  setOwner(userId: number): Promise<void>;
}

export interface SessionDeps {
  api: ApiLike;
  tokens: TokenHolder;
  storage: SessionStorage;

  /** Browser coordinator persists a rotated refresh while its origin-wide lock is still held. */
  refreshStorageManaged?: boolean;
  // Synchronous account-boundary invalidation. Shells stop/abort every account-owned data-plane
  // operation here BEFORE tokens are cleared and before any durable wipe starts.
  onBeforeClear?: () => void;
  // Post-wipe barrier. Shells can recreate an empty durable schema and repeat bounded physical cleanup
  // after deleteDatabase/CacheStorage removal, before signed-out observers are notified.
  onAfterClear?: () => void | Promise<void>;
  // Optional: shells without a durable cache (or unit tests) simply omit it.
  localData?: LocalData;
  // T-121: solver executor for the registration PoW gate. The web shell injects its Web Worker
  // runner; omitted ⇒ the gate's default in-process solver (fine for tests/non-worker shells).
  powRunner?: PowRunner;
}

export interface RegisterFields {
  username: string;
  password: string;
  name: string;
  phone?: string;
  email?: string;
  locale?: string;
  legal_accepted: boolean;
  age_confirmed: boolean;
  invite_code?: string;
}

export interface LoginFields {
  username: string;
  password: string;
  totp_code?: string;
}


export type QrLoginStatus = "starting" | "waiting" | "offline";

export interface QrLoginReady {
  token: string;
  link: string;
  expiresAt: number;
}

export interface QrLoginOptions {
  signal?: AbortSignal;
  onReady?: (attempt: QrLoginReady) => void;
  onStatus?: (status: QrLoginStatus) => void;
  onPowProgress?: (attempts: number) => void;
  /** Tests may make the bounded poll loop immediate; production defaults to one request/second. */
  pollIntervalMs?: number;
  /** Milliseconds since epoch. */
  now?: () => number;
  /** Optional native device public key bound to the minted QR session. */
  devicePubkey?: string;
}

export type QrLoginErrorCode = "QR_DENIED" | "QR_CANCELLED" | "QR_EXPIRED" | "QR_INVALID_RESPONSE";

export class QrLoginError extends Error {
  readonly code: QrLoginErrorCode;
  constructor(code: QrLoginErrorCode, message: string) {
    super(message);
    this.name = "QrLoginError";
    this.code = code;
  }
}

interface QrStartResult {
  qr_token: string;
  expires_in: number;
}

type QrPollResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "cancelled" }
  | ({ status: "approved" } & AuthSession);

function qrAbortError(): QrLoginError {
  return new QrLoginError("QR_CANCELLED", "QR login cancelled");
}

function waitForQrPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(qrAbortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(qrAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isTransientQrPollError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return name === "NetworkError" || name === "TypeError";
}

// T-121: per-call knobs for the PoW-gated register. `signal` aborts a solve in flight (leaving the
// screen ⇒ PowAbortedError, no retry request); `onPowProgress` streams the solver's attempt counter
// so the calling screen can render "solving…" feedback next to its busy state.
export interface RegisterOptions {
  signal?: AbortSignal;
  onPowProgress?: (attempts: number) => void;
}

export class Session {
  private readonly api: ApiLike;
  private readonly tokens: TokenHolder;
  private readonly storage: SessionStorage;

  private readonly refreshStorageManaged: boolean;
  private readonly localData: LocalData | undefined;
  private readonly onBeforeClear: (() => void) | undefined;
  private readonly onAfterClear: (() => void | Promise<void>) | undefined;
  private readonly powRunner: PowRunner | undefined;
  private user: AuthUser | null = null;
  private readonly listeners = new Set<(user: AuthUser | null) => void>();
  private lifecycleSeq = 0;
  private committedTokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  private localDataChain: Promise<void> = Promise.resolve();
  private logoutInFlight: { seq: number; task: Promise<void> } | null = null;
  private wipeInFlight: { seq: number; task: Promise<void> } | null = null;
  private deleteInFlight: {
    seq: number;
    task: Promise<AccountDeletionResult>;
  } | null = null;
  private clearBoundarySeq: number | null = null;

  constructor(deps: SessionDeps) {
    this.api = deps.api;
    this.tokens = deps.tokens;
    this.storage = deps.storage;

    this.refreshStorageManaged = deps.refreshStorageManaged === true;
    this.onBeforeClear = deps.onBeforeClear;
    this.onAfterClear = deps.onAfterClear;
    this.localData = deps.localData;
    this.powRunner = deps.powRunner;
    this.committedTokens = {
      access: deps.tokens.access,
      refresh: deps.tokens.refresh,
      refreshNext: deps.tokens.refreshNext ?? null,
      accessExpiresAt: deps.tokens.accessExpiresAt,
    };
  }

  currentUser(): AuthUser | null {
    return this.user;
  }

  isAuthed(): boolean {
    return this.user !== null;
  }

  subscribe(listener: (user: AuthUser | null) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    for (const l of [...this.listeners]) l(this.user);
  }

  private beginTransition(): number {
    const seq = ++this.lifecycleSeq;
    // Older tasks continue only to finish their already-started transport/local cleanup. They no longer
    // coalesce with actions belonging to the new account lifecycle.
    this.logoutInFlight = null;
    this.wipeInFlight = null;
    this.deleteInFlight = null;
    return seq;
  }

  private isCurrent(seq: number): boolean {
    return seq === this.lifecycleSeq;
  }

  private ensureCurrent(seq: number): void {
    if (!this.isCurrent(seq)) throw new Error("Session operation superseded by a newer transition");
  }

  private beginClearBoundary(seq: number): void {
    if (this.clearBoundarySeq === seq) return;
    this.clearBoundarySeq = seq;
    try { this.onBeforeClear?.(); } catch { /* one subsystem cannot keep the session alive */ }
  }

  private async finishClearBoundary(): Promise<void> {
    try { await this.onAfterClear?.(); } catch { /* post-wipe recovery remains best-effort */ }
  }

  private commitTokenSnapshot(): void {
    this.committedTokens = {
      access: this.tokens.access,
      refresh: this.tokens.refresh,
      refreshNext: this.tokens.refreshNext ?? null,
      accessExpiresAt: this.tokens.accessExpiresAt,
    };
  }

  private restoreCommittedTokens(): void {
    this.tokens.access = this.committedTokens.access;
    this.tokens.refresh = this.committedTokens.refresh;
    this.tokens.refreshNext = this.committedTokens.refreshNext ?? null;
    this.tokens.accessExpiresAt = this.committedTokens.accessExpiresAt;
  }

  private enqueueLocalData<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.localDataChain.then(operation, operation);
    this.localDataChain = result.then(() => undefined, () => undefined);
    return result;
  }

  // Adopt a fresh AuthSession (register/login): access in memory, refresh+user persisted. Before the app
  // starts warming screens from cache, reconcile the cache owner — if the durable store belongs to a
  // DIFFERENT account (shared computer, account switch), wipe it so one user never sees another's data.
  private async adopt(s: AuthSession, seq: number): Promise<AuthUser> {
    this.ensureCurrent(seq);
    const user = s.user ?? this.user ?? { id: 0, username: "", name: "" };
    const replacingActiveSession = this.user !== null || this.committedTokens.access !== null || this.committedTokens.refresh !== null;
    if (replacingActiveSession) this.beginClearBoundary(seq);
    await this.reconcileOwner(user.id, seq);
    if (replacingActiveSession) await this.finishClearBoundary();
    this.ensureCurrent(seq);
    this.tokens.access = s.access_token;
    this.tokens.refresh = s.refresh_token;
    this.tokens.refreshNext = null;
    this.tokens.accessExpiresAt = s.access_expires_at;
    this.user = user;
    this.storage.save({ refresh: s.refresh_token, user });
    try { await this.storage.flush?.(); } catch { /* the live session remains usable; a later save retries */ }
    this.ensureCurrent(seq);
    this.commitTokenSnapshot();
    this.emit();
    return user;
  }

  // Wipe the local cache when its owner differs from `userId`, then stamp the new owner. Best-effort:
  // a storage error must never block sign-in. A null (fresh/just-wiped) owner is adopted silently.
  private async reconcileOwner(userId: number, seq: number): Promise<void> {
    if (!this.localData || userId <= 0) {
      this.ensureCurrent(seq);
      return;
    }
    await this.enqueueLocalData(async () => {
      if (!this.isCurrent(seq)) return;
      try {
        const prev = await this.localData!.getOwner();
        if (!this.isCurrent(seq)) return;
        if (prev !== null && prev !== userId) {
          await this.localData!.wipe();
          if (!this.isCurrent(seq)) return;
        }
        await this.localData!.setOwner(userId);
      } catch {
        // ignore — a cache we can't inspect/clear must not trap the user out of logging in
      }
    });
    this.ensureCurrent(seq);
  }

  async register(fields: RegisterFields, opts: RegisterOptions = {}): Promise<AuthUser> {
    const seq = this.beginTransition();
    const body: Record<string, unknown> = {
      username: fields.username,
      password: fields.password,
      name: fields.name,
    };
    if (fields.phone) body.phone = fields.phone;
    if (fields.email) body.email = fields.email;
    if (fields.locale) body.locale = fields.locale;
    body.legal_accepted = fields.legal_accepted;
    body.age_confirmed = fields.age_confirmed;
    if (fields.invite_code) body.invite_code = fields.invite_code;
    // T-121: the PoW gate. When GC_POW=0 the gate makes one register request; when required it
    // solves through the injected worker runner and retries with the proof. The transition generation
    // remains authoritative across the entire solve/request sequence.
    const s = await executeWithPow(
      (pow) => this.api.post<AuthSession>("/v1/auth/register", pow ? { ...body, ...pow } : body),
      {
        fetchChallenge: () => this.api.get<PowChallenge>("/v1/auth/pow"),
        ...(this.powRunner ? { runner: this.powRunner } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onPowProgress ? { onProgress: opts.onPowProgress } : {}),
      },
    );
    this.ensureCurrent(seq);
    return this.adopt(s, seq);
  }

  async login(fields: LoginFields): Promise<AuthUser> {
    const seq = this.beginTransition();
    const body: Record<string, unknown> = {
      username: fields.username,
      password: fields.password,
    };
    if (fields.totp_code) body.totp_code = fields.totp_code;
    const s = await this.api.post<AuthSession>("/v1/auth/login", body);
    this.ensureCurrent(seq);
    return this.adopt(s, seq);
  }


  /**
   * Passwordless desktop sign-in approved from an already authenticated GreenChat device.
   *
   * The QR contains only a high-entropy, short-lived token. Starting the attempt is behind the same
   * PoW gate as registration; the desktop polls at a bounded cadence; denial/cancellation/expiry are
   * distinct terminal outcomes; and leaving the screen best-effort cancels even an already-approved
   * token before it can mint a session. `adopt()` remains the single token/cache ownership boundary.
   */
  async loginWithQr(opts: QrLoginOptions = {}): Promise<AuthUser> {
    const seq = this.beginTransition();
    const now = opts.now ?? Date.now;
    const pollInterval = Math.max(0, Math.floor(opts.pollIntervalMs ?? 1_000));
    let token: string | null = null;
    let terminal = false;
    opts.onStatus?.("starting");
    try {
      const start = await executeWithPow(
        (pow) => this.api.post<QrStartResult>("/v1/auth/qr/start", pow ?? {}),
        {
          fetchChallenge: () => this.api.get<PowChallenge>("/v1/auth/pow"),
          ...(this.powRunner ? { runner: this.powRunner } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onPowProgress ? { onProgress: opts.onPowProgress } : {}),
        },
      );
      this.ensureCurrent(seq);
      if (
        typeof start?.qr_token !== "string" ||
        !/^[0-9a-f]{96}$/i.test(start.qr_token) ||
        !Number.isFinite(start.expires_in) ||
        start.expires_in <= 0
      ) {
        throw new QrLoginError("QR_INVALID_RESPONSE", "Invalid QR login start response");
      }
      token = start.qr_token;
      const expiresAt = now() + Math.floor(start.expires_in * 1_000);
      opts.onReady?.({
        token,
        link: `greenchat://auth/qr/${encodeURIComponent(token)}`,
        expiresAt,
      });
      opts.onStatus?.("waiting");

      for (;;) {
        if (opts.signal?.aborted) throw qrAbortError();
        this.ensureCurrent(seq);
        if (now() >= expiresAt) throw new QrLoginError("QR_EXPIRED", "QR login expired");

        let poll: QrPollResult;
        try {
          poll = await this.api.post<QrPollResult>("/v1/auth/qr/poll", {
            qr_token: token,
            ...(opts.devicePubkey ? { device_pubkey: opts.devicePubkey } : {}),
          });
        } catch (error) {
          if (opts.signal?.aborted) throw qrAbortError();
          const code = apiErrorCode(error);
          if (code === "NOT_FOUND") throw new QrLoginError("QR_EXPIRED", "QR login expired");
          if (!isTransientQrPollError(error)) throw error;
          opts.onStatus?.("offline");
          await waitForQrPoll(pollInterval, opts.signal);
          opts.onStatus?.("waiting");
          continue;
        }
        this.ensureCurrent(seq);
        if (!poll || typeof poll !== "object" || typeof poll.status !== "string") {
          throw new QrLoginError("QR_INVALID_RESPONSE", "Invalid QR login poll response");
        }
        if (poll.status === "pending") {
          opts.onStatus?.("waiting");
          await waitForQrPoll(pollInterval, opts.signal);
          continue;
        }
        if (poll.status === "denied") {
          terminal = true;
          throw new QrLoginError("QR_DENIED", "QR login denied");
        }
        if (poll.status === "cancelled") {
          terminal = true;
          throw qrAbortError();
        }
        if (poll.status !== "approved") {
          throw new QrLoginError("QR_INVALID_RESPONSE", "Unknown QR login status");
        }
        terminal = true;
        return await this.adopt(poll, seq);
      }
    } finally {
      if (token && !terminal) {
        try {
          await this.api.post("/v1/auth/qr/cancel", { qr_token: token });
        } catch {
          // Short TTL remains the final backstop when the device disappears offline.
        }
      }
    }
  }

  // Best-effort server revoke, then wipe ALL local state regardless (a network failure must not trap a
  // user in a session they asked to end). Beyond the token/refresh slice, this ALSO deletes the durable
  // cache (IndexedDB messages/chats/media) so a shared computer leaks nothing to the next person (T-423).
  async logout(): Promise<void> {
    if (this.logoutInFlight?.seq === this.lifecycleSeq) return this.logoutInFlight.task;
    const seq = this.beginTransition();
    const shouldRevoke = this.user !== null || this.tokens.access !== null || this.tokens.refresh !== null;
    // Stop/abort account-owned work immediately. The best-effort server revoke may be slow or offline;
    // no old upload/outbox/sync continuation is allowed to run during that network wait.
    this.beginClearBoundary(seq);
    const task = (async () => {
      if (shouldRevoke) {
        try {
          await this.api.post("/v1/auth/logout");
        } catch {
          // ignore — clear locally anyway when this is still the active lifecycle
        }
      }
      if (!this.isCurrent(seq)) return; // a newer login owns the shared token/cache namespace
      await this.wipeFor(seq);
    })();
    const flight = { seq, task };
    this.logoutInFlight = flight;
    try {
      await task;
    } finally {
      if (this.logoutInFlight === flight) this.logoutInFlight = null;
    }
  }

  // The server owns the cancellable deletion window. Credentials and encrypted local data are wiped only
  // after an authenticated, password-confirmed success; a rejection leaves the live session untouched so
  // the user can correct the password or resolve a server-side blocker without losing local evidence.
  async deleteAccount(password: string): Promise<AccountDeletionResult> {
    if (this.deleteInFlight?.seq === this.lifecycleSeq)
      return this.deleteInFlight.task;
    if (!this.isAuthed())
      throw new Error("Account deletion requires an authenticated session");
    if (password.length === 0)
      throw new Error("Account deletion requires the current password");
    const seq = this.beginTransition();
    const task = (async () => {
      const result = this.api.deleteAccount
        ? await this.api.deleteAccount(password)
        : await this.api.delete<AccountDeletionResult>("/v1/account", {
            body: { password },
          });
      this.ensureCurrent(seq);
      if (!result || result.deleted !== true)
        throw new Error("Account deletion returned an invalid result");
      await this.wipeFor(seq);
      return result;
    })();
    const flight = { seq, task };
    this.deleteInFlight = flight;
    try {
      return await task;
    } finally {
      if (this.deleteInFlight === flight) this.deleteInFlight = null;
    }
  }

  // Wipe ALL local state WITHOUT a server round-trip: the in-memory access token + the persisted
  // refresh/user slice, plus the durable cache (IndexedDB store + media CacheStorage) via LocalData.
  // Used by logout() after its best-effort revoke, and directly when switching to a DIFFERENT server
  // while signed out — a different server is a different account namespace, so nothing from the previous
  // one may survive the switch (T-419 «свой сервер» pairs the address change with this wipe; T-423
  // privacy). Idempotent and best-effort: a wipe failure must never trap the user.
  async wipeLocalData(): Promise<void> {
    if (this.wipeInFlight?.seq === this.lifecycleSeq) return this.wipeInFlight.task;
    const seq = this.beginTransition();
    this.beginClearBoundary(seq);
    const task = this.wipeFor(seq);
    const flight = { seq, task };
    this.wipeInFlight = flight;
    try {
      await task;
    } finally {
      if (this.wipeInFlight === flight) this.wipeInFlight = null;
    }
  }

  private async wipeFor(seq: number): Promise<void> {
    if (!this.isCurrent(seq)) return;
    this.clearLocal(seq); // synchronous security boundary; physical stores drain below
    if (this.storage.flush) {
      try { await this.storage.flush(); } catch { /* logout remains best-effort when the OS vault is unavailable */ }
    }
    if (this.localData) {
      await this.enqueueLocalData(async () => {
        try {
          await this.localData!.wipe();
        } catch {
          // best-effort — a wipe failure must not leave the user stuck
        }
        await this.finishClearBoundary();
      });
    } else {
      await this.finishClearBoundary();
    }
    if (this.isCurrent(seq)) this.emit();
  }

  private clearLocal(seq: number): void {
    this.beginClearBoundary(seq);
    this.tokens.access = null;
    this.tokens.refresh = null;
    this.tokens.refreshNext = null;
    this.tokens.accessExpiresAt = null;
    this.committedTokens = { access: null, refresh: null, refreshNext: null, accessExpiresAt: null };
    this.user = null;
    this.storage.clear();
  }

  // Cold boot: if a refresh token was saved, exchange it for an access token BEFORE any guarded call.
  // Returns true when a session is active afterwards. Offline → keep the optimistic session (T-422).
  async restore(): Promise<boolean> {
    const seq = this.beginTransition();
    const saved = this.storage.load();
    if (!saved) return false;
    // The restored account owns the cache; serialize behind any physical wipe from the previous lifecycle.
    try {
      await this.reconcileOwner(saved.user.id, seq);
    } catch (err) {
      if (!this.isCurrent(seq)) return false;
      throw err;
    }
    if (!this.isCurrent(seq)) return false;

    // ApiClient.refreshTokens rotates this shared holder in place. Keep the attempt isolated by generation
    // and restore the last committed holder if another login/logout wins while the request is in flight.
    this.tokens.access = null;
    this.tokens.refresh = saved.refresh;
    this.tokens.refreshNext = saved.pendingRefresh ?? null;
    this.tokens.accessExpiresAt = null;
    let ok: boolean;
    try {
      ok = await this.api.refreshTokens();
    } catch {
      if (!this.isCurrent(seq)) {
        this.restoreCommittedTokens();
        return false;
      }
      // Transient (offline/5xx): keep an optimistic refresh-only session and let the app retry.
      this.tokens.access = null;
      this.tokens.refresh = saved.refresh;
      this.tokens.refreshNext = saved.pendingRefresh ?? null;
      this.tokens.accessExpiresAt = null;
      this.user = saved.user;
      this.commitTokenSnapshot();
      this.emit();
      return true;
    }
    if (!this.isCurrent(seq)) {
      this.restoreCommittedTokens();
      return false;
    }
    if (!ok) {
      // Server verdict: the refresh token is dead → honest local wipe for this lifecycle only.
      await this.wipeFor(seq);
      return false;
    }
    this.user = saved.user;
    // Ordinary/native clients persist the rotation here. The browser coordinator already saved it
    // while holding the origin-wide refresh lock; writing again after lock release could roll back a
    // newer peer rotation and trigger the server's refresh-reuse revocation policy.
    if (!this.refreshStorageManaged && this.tokens.refresh) {
      this.storage.save({ refresh: this.tokens.refresh, user: saved.user });
    }
    this.commitTokenSnapshot();
    this.emit();
    return true;
  }
}
