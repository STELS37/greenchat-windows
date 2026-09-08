// SPDX-License-Identifier: AGPL-3.0-or-later
// UI port, NOT an invented HTTP backend. The shell supplies official provider auth and server reads.
export const GAME_PROVIDERS = ["tiktok", "epic"] as const;
export type GameProvider = typeof GAME_PROVIDERS[number];
export interface LinkedAccount {
  readonly id: string;
  readonly displayName: string;
  readonly verified: true;
  readonly visible: boolean;
}
export interface ProviderState {
  readonly provider: GameProvider;
  readonly available: boolean;
  readonly account: LinkedAccount | null;
}
export interface GameConnectionsPort {
  /** Server response: [{provider, available, account:{id,displayName,verified:true,visible}|null}]. */
  list(signal: AbortSignal): Promise<unknown>;
  /** Resolve after official auth. Success alone is NOT evidence of a linked account. */
  link(provider: GameProvider, signal: AbortSignal): Promise<void>;
  /** The backend MUST check expectedAccountId atomically before mutating the current link. */
  unlink(provider: GameProvider, signal: AbortSignal, expectedAccountId: string): Promise<void>;
  setVisibility(provider: GameProvider, visible: boolean, signal: AbortSignal, expectedAccountId: string): Promise<void>;
}
export type ConnectionAction = "link" | "unlink" | "visibility";
export type ConnectionIssue = "load" | "action" | "timeout" | "unconfirmed" | "cancelled" | "offline" | "stale" | null;
export interface ConnectionsState {
  /** A negative platform connectivity hint. true alone does not prove server reachability. */
  readonly online: boolean;
  readonly providers: readonly ProviderState[];
  readonly loading: boolean;
  readonly busy: GameProvider | null;
  readonly action: ConnectionAction | null;
  /** False after an uncertain outcome. Last-known account data is for display only until refreshed. */
  readonly fresh: boolean;
  readonly issue: ConnectionIssue;
}
const emptyProviders = (): readonly ProviderState[] => Object.freeze(GAME_PROVIDERS.map(provider =>
  Object.freeze({ provider, available: false, account: null })));
const initialState = (): ConnectionsState => Object.freeze({
  online: true, providers: emptyProviders(), loading: false, busy: null, action: null, fresh: false, issue: null,
});
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider response");
  return value as Record<string, unknown>;
};
const shortString = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid provider text");
  return value;
};
export function normalizeProviders(value: unknown): readonly ProviderState[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid providers response");
  const known = new Map<GameProvider, ProviderState>();
  for (const raw of value) {
    const row = record(raw);
    if (!GAME_PROVIDERS.includes(row.provider as GameProvider)) continue;
    const provider = row.provider as GameProvider;
    if (known.has(provider) || typeof row.available !== "boolean") throw new Error("Ambiguous provider response");
    // Undefined/omitted is NOT equivalent to a confirmed null. Reject truncated responses.
    if (!("account" in row) || row.account === undefined) throw new Error("Missing account state");
    let account: LinkedAccount | null = null;
    if (row.account !== null) {
      const item = record(row.account);
      if (item.verified !== true || typeof item.visible !== "boolean") throw new Error("Unverified account response");
      account = Object.freeze({ id: shortString(item.id, 256), displayName: shortString(item.displayName, 128),
        verified: true, visible: item.visible });
    }
    known.set(provider, Object.freeze({ provider, available: row.available, account }));
  }
  return Object.freeze(GAME_PROVIDERS.map(provider => known.get(provider) ??
    Object.freeze({ provider, available: false, account: null })));
}
function explicitlyLists(raw: unknown, provider: GameProvider): boolean {
  // Called only after normalizeProviders has validated the response.
  return Array.isArray(raw) && raw.some(row => row?.provider === provider);
}
function omitsLinkedAccount(raw: unknown, previous: readonly ProviderState[]): boolean {
  return previous.some(row => row.account !== null && !explicitlyLists(raw, row.provider));
}
class DeadlineError extends Error {}
function bounded<T>(run: (signal: AbortSignal) => Promise<T>, controller: AbortController, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = (): void => finish(() => reject(new Error("Cancelled")));
    const timer = setTimeout(() => { finish(() => reject(new DeadlineError("Timed out"))); controller.abort(); }, ms);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Cancelled");
      return run(controller.signal);
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
export interface ConnectionTiming { readMs?: number; actionMs?: number; writeMs?: number }
function deadline(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new RangeError("Invalid connection deadline");
  return value;
}
export interface GameConnectionsModel {
  get(): ConnectionsState;
  subscribe(listener: (state: ConnectionsState) => void): () => void;
  refresh(): Promise<void>;
  /** Invalidate/abort local waiting when offline. Reconnect never replays a mutation or starts auth. */
  setOnline(online: boolean): void;
  link(provider: GameProvider): Promise<boolean>;
  unlink(provider: GameProvider): Promise<boolean>;
  setVisibility(provider: GameProvider, visible: boolean): Promise<boolean>;
  /** Cancels local waiting. A request already accepted by the server may still commit. */
  cancel(): void;
  destroy(): void;
}
export function createGameConnectionsModel(port?: GameConnectionsPort, timing: ConnectionTiming = {}): GameConnectionsModel {
  const readMs = deadline(timing.readMs, 15_000);
  const authMs = deadline(timing.actionMs, 180_000);
  const writeMs = deadline(timing.writeMs, 15_000);
  let state = initialState();
  let generation = 0;
  let disposed = false;
  let current: AbortController | undefined;
  const listeners = new Set<(state: ConnectionsState) => void>();
  const update = (patch: Partial<ConnectionsState>): void => {
    const next = state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) {
      if (disposed || state !== next) break;
      if (listeners.has(listener)) listener(next);
    }
  };
  const row = (p: GameProvider): ProviderState | undefined => state.providers.find(v => v.provider === p);
  async function refresh(): Promise<void> {
    if (disposed || !port || !state.online || state.busy) return;
    // Invalidate first: abort callbacks are allowed to run synchronously.
    const mine = ++generation;
    const previousRequest = current;
    const controller = current = new AbortController();
    // Assign the replacement BEFORE abort: an adapter abort listener may synchronously refresh.
    previousRequest?.abort();
    if (disposed || mine !== generation || controller.signal.aborted) { controller.abort(); return; }
    update({ loading: true, fresh: false, issue: null });
    try {
      const raw = await bounded(s => port.list(s), controller, readMs);
      if (disposed || mine !== generation) return;
      const providers = normalizeProviders(raw);
      // Disappearing from a partial response is not evidence that a real link was removed.
      if (omitsLinkedAccount(raw, state.providers)) throw new Error("Incomplete linked account snapshot");
      update({ providers, loading: false, fresh: true, issue: null });
    } catch (error) {
      if (!disposed && mine === generation) update({ loading: false, fresh: false, issue: error instanceof DeadlineError ? "timeout" : "load" });
    } finally {
      if (mine === generation) current = undefined;
    }
  }
  async function action(provider: GameProvider, kind: ConnectionAction, visible = false): Promise<boolean> {
    if (disposed || !port || !state.online || !state.fresh || state.loading || state.busy) return false;
    const previous = row(provider);
    if (!previous || (kind === "link" ? (!previous.available || previous.account !== null) : previous.account === null)) return false;
    // A fresh, already-confirmed value needs no write or authentication round-trip.
    if (kind === "visibility" && previous.account?.visible === visible) return true;
    const expectedId = previous.account?.id;
    const mine = ++generation;
    const previousRequest = current;
    const controller = current = new AbortController();
    previousRequest?.abort();
    if (disposed || mine !== generation || controller.signal.aborted) { controller.abort(); return false; }
    update({ busy: provider, action: kind, fresh: false, issue: null });
    try {
      await bounded(s => {
        if (kind === "link") return port.link(provider, s);
        if (kind === "unlink") return port.unlink(provider, s, expectedId!);
        return port.setVisibility(provider, visible, s, expectedId!);
      }, controller, kind === "link" ? authMs : writeMs);
      if (disposed || mine !== generation || controller.signal.aborted) return false;
      const raw = await bounded(s => port.list(s), controller, readMs);
      const providers = normalizeProviders(raw);
      if (disposed || mine !== generation) return false;
      if (omitsLinkedAccount(raw, state.providers)) {
        update({ busy: null, action: null, fresh: false, issue: "unconfirmed" });
        return false;
      }
      const after = providers.find(v => v.provider === provider)?.account;
      const confirmed = explicitlyLists(raw, provider) && (kind === "link" ? !!after :
        kind === "unlink" ? after === null : after?.id === expectedId && after?.visible === visible);
      update({ providers, busy: null, action: null, fresh: confirmed, issue: confirmed ? null : "unconfirmed" });
      return confirmed;
    } catch (error) {
      if (!disposed && mine === generation) update({ busy: null, action: null, fresh: false, issue: error instanceof DeadlineError ? "timeout" : "action" });
      return false;
    } finally {
      if (mine === generation) current = undefined;
    }
  }
  return {
    get: () => state,
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    setOnline(online) {
      if (disposed || typeof online !== "boolean" || online === state.online) return;
      // Publish the offline guard BEFORE aborting: an adapter's abort handler can re-enter
      // refresh synchronously. Never abort whatever a listener starts after a later reconnect.
      ++generation;
      const pending = current;
      current = undefined;
      try {
        update({ online, loading: false, busy: null, action: null, fresh: false,
          issue: online ? (port ? "stale" : null) : "offline" });
      } finally { pending?.abort(); }
    },
    refresh, link: p => action(p, "link"), unlink: p => action(p, "unlink"),
    // JS/native bridge callers do not have TypeScript's runtime guarantees. Missing visibility
    // must not be interpreted as the default false and accidentally hide a public account.
    setVisibility: (p, visible) => typeof visible === "boolean"
      ? action(p, "visibility", visible) : Promise.resolve(false),
    cancel() {
      if (disposed || (!state.loading && state.busy === null)) return;
      const mine = ++generation;
      const pending = current;
      current = undefined;
      pending?.abort();
      if (!disposed && mine === generation)
        update({ loading: false, busy: null, action: null, fresh: false, issue: "cancelled" });
    },
    destroy() {
      if (disposed) return;
      disposed = true; generation++; current?.abort(); current = undefined; listeners.clear(); state = initialState();
    },
  };
}
