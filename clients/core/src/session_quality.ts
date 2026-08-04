// Privacy-safe app-session denominator for the crash-free Open Beta gate.
//
// The producer is strictly opt-in and stores only pseudonymous per-install session markers, immutable
// local session events and acknowledged daily counters. It never reads auth state, user/account ids,
// routes, message text or crash stacks.

export type SessionQualityPlatform = "web" | "android" | "ios" | "desktop";

export interface SessionQualityApi {
  post<T>(path: string, body?: unknown, opts?: { noAuth?: boolean }): Promise<T>;
}

/** Minimal synchronous Storage shape; localStorage satisfies it and tests use an in-memory fake. */
export interface SessionQualityStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionQualityScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export type SessionQualityExclusive = (key: string, task: () => Promise<void>) => Promise<void>;

export interface SessionQualityMeta {
  platform: SessionQualityPlatform;
  appVersion: string;
}

export interface SessionQualityOptions {
  api: SessionQualityApi;
  storage: SessionQualityStorage;
  consent: () => Promise<boolean>;
  installId: () => Promise<string>;
  meta: SessionQualityMeta;
  now?: () => number;
  randomId?: () => string;
  scheduler?: SessionQualityScheduler;

  /** Origin-wide exclusive section; web uses Web Locks so tabs cannot lose cumulative baselines. */
  exclusive?: SessionQualityExclusive;
  heartbeatMs?: number;
  staleAfterMs?: number;
  onError?: (error: unknown) => void;
}

export interface SessionQuality {
  /** Recover stale markers, begin this boot when consent is on, and flush changed counters. */
  start(): Promise<void>;
  /** Keep session telemetry in lockstep with the diagnostics opt-in. */
  setConsent(on: boolean): Promise<void>;
  /** Count this boot as crashed exactly once. Synchronous so a fatal handler can persist it. */
  markCrashed(): void;
  /** Count this boot as clean unless it was already counted as crashed. Synchronous for pagehide. */
  close(): void;
  /** Send changed cumulative daily aggregates. Safe to call repeatedly. */
  flush(): Promise<void>;
}

interface Marker {
  id: string;
  started_at: number;
  heartbeat_at: number;
  platform: SessionQualityPlatform;
  app_version: string;
  crashed: boolean;
}

interface SessionEvent {
  id: string;
  window_start: number;
  window_end: number;
  platform: SessionQualityPlatform;
  app_version: string;
  crashed: boolean;
}

interface DailyAggregate {
  window_start: number;
  window_end: number;
  platform: SessionQualityPlatform;
  app_version: string;
  sent_total: number;
  sent_crashed: number;
  /** Event ids durably acknowledged before their separate localStorage keys are removed. */
  acked_event_ids?: string[];
}

const PREFIX = "gc.session-quality.v1.";
const MARKER_PREFIX = `${PREFIX}marker.`;
const EVENT_PREFIX = `${PREFIX}event.`;
const AGG_PREFIX = `${PREFIX}aggregate.`;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 120_000;
const DAY_MS = 86_400_000;
const DAY_SEC = 86_400;
const LOCAL_RETENTION_MS = 31 * DAY_MS;
const MAX_LOCAL_SESSIONS_PER_DAY = 10_000;

function safeJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function utcWindow(nowMs: number): { startSec: number; endSec: number } {
  const startMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { startSec: Math.floor(startMs / 1000), endSec: Math.floor((startMs + DAY_MS) / 1000) };
}

function platformValid(value: unknown): value is SessionQualityPlatform {
  return value === "web" || value === "android" || value === "ios" || value === "desktop";
}

function versionValid(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 64;
}

function validMeta(meta: SessionQualityMeta): boolean {
  return platformValid(meta.platform) && versionValid(meta.appVersion);
}

function validMarker(value: unknown): value is Marker {
  const v = value as Partial<Marker> | null;
  return !!v && typeof v.id === "string" && v.id !== "" &&
    typeof v.started_at === "number" && Number.isFinite(v.started_at) && v.started_at >= 0 &&
    typeof v.heartbeat_at === "number" && Number.isFinite(v.heartbeat_at) && v.heartbeat_at >= v.started_at &&
    platformValid(v.platform) && versionValid(v.app_version) && typeof v.crashed === "boolean";
}

function validEvent(value: unknown): value is SessionEvent {
  const v = value as Partial<SessionEvent> | null;
  return !!v && typeof v.id === "string" && v.id !== "" &&
    Number.isInteger(v.window_start) && Number.isInteger(v.window_end) &&
    (v.window_start as number) >= 0 && v.window_end === (v.window_start as number) + DAY_SEC &&
    platformValid(v.platform) && versionValid(v.app_version) && typeof v.crashed === "boolean";
}

function validAggregate(value: unknown): value is DailyAggregate {
  const v = value as Partial<DailyAggregate> | null;
  const ackedValid = v?.acked_event_ids === undefined || (
    Array.isArray(v.acked_event_ids) && v.acked_event_ids.length <= MAX_LOCAL_SESSIONS_PER_DAY &&
    v.acked_event_ids.every((id) => typeof id === "string" && id !== "" && id.length <= 128)
  );
  return !!v && Number.isInteger(v.window_start) && Number.isInteger(v.window_end) &&
    (v.window_start as number) >= 0 && v.window_end === (v.window_start as number) + DAY_SEC &&
    platformValid(v.platform) && versionValid(v.app_version) &&
    Number.isInteger(v.sent_total) && (v.sent_total as number) >= 0 &&
    Number.isInteger(v.sent_crashed) && (v.sent_crashed as number) >= 0 &&
    (v.sent_crashed as number) <= (v.sent_total as number) && ackedValid;
}

function defaultRandomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const defaultScheduler: SessionQualityScheduler = {
  setInterval(fn, ms) { return globalThis.setInterval(fn, ms); },
  clearInterval(id) { globalThis.clearInterval(id as ReturnType<typeof setInterval>); },
};

export function createSessionQuality(opts: SessionQualityOptions): SessionQuality {
  const { api, storage, meta } = opts;
  if (!validMeta(meta)) throw new Error("invalid session quality metadata");

  const now = opts.now ?? (() => Date.now());
  const randomId = opts.randomId ?? defaultRandomId;
  const scheduler = opts.scheduler ?? defaultScheduler;

  const exclusive: SessionQualityExclusive = opts.exclusive ?? (async (_key, task) => task());
  const heartbeatMs = Math.max(1_000, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const staleAfterMs = Math.max(heartbeatMs * 2, opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const onError = opts.onError ?? (() => {});

  let consentOn = false;
  let consentRevision = 0;
  let markerKey: string | null = null;
  let counted = false;
  let heartbeat: unknown | null = null;
  let flushRequested = 0;
  let flushCompleted = 0;
  let flushWorker: Promise<void> | null = null;

  function consentStillAllowed(revision: number): boolean {
    return consentOn && revision === consentRevision;
  }

  function keys(prefix: string): string[] {
    const out: string[] = [];
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) out.push(key);
      }
    } catch (error) {
      onError(error);
    }
    return out;
  }

  function remove(key: string): void {
    try { storage.removeItem(key); } catch (error) { onError(error); }
  }

  function write(key: string, value: unknown): boolean {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function readMarker(key: string): Marker | null {
    try {
      const value = safeJson<unknown>(storage.getItem(key));
      if (validMarker(value)) return value;
      if (value !== null) remove(key);
    } catch (error) {
      onError(error);
    }
    return null;
  }

  function readEvent(key: string): SessionEvent | null {
    try {
      const value = safeJson<unknown>(storage.getItem(key));
      if (validEvent(value)) return value;
      if (value !== null) remove(key);
    } catch (error) {
      onError(error);
    }
    return null;
  }

  function readAggregate(key: string): DailyAggregate | null {
    try {
      const value = safeJson<unknown>(storage.getItem(key));
      if (validAggregate(value)) return value;
      if (value !== null) remove(key);
    } catch (error) {
      onError(error);
    }
    return null;
  }

  function aggregateKey(value: Pick<SessionEvent, "window_start" | "platform" | "app_version">): string {
    return `${AGG_PREFIX}${value.window_start}.${value.platform}.${encodeURIComponent(value.app_version)}`;
  }

  function count(marker: Marker, crashed: boolean, atMs: number): boolean {
    if (!consentOn) return false;
    const window = utcWindow(atMs);
    const event: SessionEvent = {
      id: marker.id,
      window_start: window.startSec,
      window_end: window.endSec,
      platform: marker.platform,
      app_version: marker.app_version,
      crashed,
    };
    // Unique immutable keys avoid shared-counter lost updates between tabs. Recovering the same stale
    // marker in two tabs writes the same key and therefore still counts one session. Do not remove the
    // source marker unless this durable event write succeeded; quota/storage failures must not bias the KPI.
    return write(`${EVENT_PREFIX}${marker.id}`, event);
  }

  function pruneExpired(atMs: number): void {
    const cutoff = atMs - LOCAL_RETENTION_MS;
    for (const key of keys(MARKER_PREFIX)) {
      if (key === markerKey) continue;
      const marker = readMarker(key);
      if (marker && marker.heartbeat_at < cutoff) remove(key);
    }
    for (const key of keys(EVENT_PREFIX)) {
      const event = readEvent(key);
      if (event && event.window_end * 1000 < cutoff) remove(key);
    }
    for (const key of keys(AGG_PREFIX)) {
      const aggregate = readAggregate(key);
      if (aggregate && aggregate.window_end * 1000 < cutoff) remove(key);
    }
  }

  function recoverStale(): void {
    if (!consentOn) return;
    const at = now();
    pruneExpired(at);
    for (const key of keys(MARKER_PREFIX)) {
      if (key === markerKey) continue;
      const marker = readMarker(key);
      if (!marker) continue;
      if (marker.crashed || at - marker.heartbeat_at >= staleAfterMs) {
        if (count(marker, true, marker.started_at)) remove(key);
      }
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat !== null) scheduler.clearInterval(heartbeat);
    heartbeat = null;
  }

  function heartbeatTick(): void {
    if (!consentOn || markerKey === null || counted) return;
    const marker = readMarker(markerKey);
    if (!marker) return;
    marker.heartbeat_at = now();
    write(markerKey, marker);
    recoverStale();
    void flush();
  }

  function begin(): void {
    if (!consentOn) return;
    if (markerKey !== null) {
      // A previous pagehide/fatal path may have retained its marker after a storage write failure. BFCache
      // restore must resume the heartbeat instead of leaving that session permanently wedged.
      if (!counted && heartbeat === null && readMarker(markerKey)) {
        heartbeat = scheduler.setInterval(heartbeatTick, heartbeatMs);
      }
      return;
    }
    const id = randomId();
    const at = now();
    const marker: Marker = {
      id,
      started_at: at,
      heartbeat_at: at,
      platform: meta.platform,
      app_version: meta.appVersion,
      crashed: false,
    };
    const key = `${MARKER_PREFIX}${id}`;
    if (!write(key, marker)) return;
    markerKey = key;
    counted = false;
    stopHeartbeat();
    heartbeat = scheduler.setInterval(heartbeatTick, heartbeatMs);
  }

  function purge(): void {
    stopHeartbeat();
    markerKey = null;
    counted = false;
    for (const key of keys(PREFIX)) remove(key);
  }

  function reconcileAcknowledgedEvents(): void {
    for (const key of keys(AGG_PREFIX)) {
      const aggregate = readAggregate(key);
      if (!aggregate || !aggregate.acked_event_ids?.length) continue;
      for (const id of aggregate.acked_event_ids) remove(`${EVENT_PREFIX}${id}`);
      aggregate.acked_event_ids = [];
      // If this cleanup write fails, the ids remain and the same idempotent removal is retried later.
      write(key, aggregate);
    }
  }

  async function flushUnlocked(revision: number): Promise<void> {
    if (!consentStillAllowed(revision)) return;
    try {
      const installId = await opts.installId();
      if (!consentStillAllowed(revision)) return;
      const at = now();
      pruneExpired(at);
      reconcileAcknowledgedEvents();

      const groups = new Map<string, {
        aggregateKey: string;
        template: SessionEvent;
        events: Array<{ key: string; event: SessionEvent }>;
      }>();
      for (const key of keys(EVENT_PREFIX)) {
        const event = readEvent(key);
        if (!event) continue;
        const keyForAggregate = aggregateKey(event);
        let group = groups.get(keyForAggregate);
        if (!group) {
          group = { aggregateKey: keyForAggregate, template: event, events: [] };
          groups.set(keyForAggregate, group);
        }
        group.events.push({ key, event });
      }

      for (const group of groups.values()) {
        if (!consentStillAllowed(revision)) return;
        const event = group.template;
        const baseline = readAggregate(group.aggregateKey) ?? {
          window_start: event.window_start,
          window_end: event.window_end,
          platform: event.platform,
          app_version: event.app_version,
          sent_total: 0,
          sent_crashed: 0,
          acked_event_ids: [],
        };
        const remaining = MAX_LOCAL_SESSIONS_PER_DAY - baseline.sent_total;
        if (remaining <= 0) {
          for (const item of group.events) remove(item.key);
          onError(new Error("session quality daily local cap reached"));
          continue;
        }

        const snapshot = group.events.slice(0, remaining);
        const totalSessions = baseline.sent_total + snapshot.length;
        const crashedSessions = baseline.sent_crashed + snapshot.reduce(
          (sum, item) => sum + (item.event.crashed ? 1 : 0),
          0,
        );
        try {
          const response = await api.post<{
            accepted: boolean;
            total_sessions?: number;
            crashed_sessions?: number;
          }>(
            "/v1/client/sessions",
            {
              install_id: installId,
              platform: baseline.platform,
              app_version: baseline.app_version,
              window_start: baseline.window_start,
              window_end: baseline.window_end,
              total_sessions: totalSessions,
              crashed_sessions: crashedSessions,
            },
            { noAuth: true },
          );
          if (!consentStillAllowed(revision)) return;

          const authoritativeTotal = response.total_sessions ?? totalSessions;
          const authoritativeCrashed = response.crashed_sessions ?? crashedSessions;
          if (!Number.isInteger(authoritativeTotal) || !Number.isInteger(authoritativeCrashed) ||
              authoritativeTotal < totalSessions || authoritativeCrashed < crashedSessions ||
              authoritativeCrashed > authoritativeTotal || authoritativeTotal > MAX_LOCAL_SESSIONS_PER_DAY) {
            throw new Error("invalid authoritative session aggregate");
          }

          // A server-ahead reply means this local baseline was stale. Keep the current immutable events,
          // heal the acknowledged baseline and queue another pass; the next request sends baseline+events.
          if (authoritativeTotal !== totalSessions || authoritativeCrashed !== crashedSessions) {
            const latest = readAggregate(group.aggregateKey) ?? baseline;
            const healed: DailyAggregate = {
              ...latest,
              sent_total: Math.max(latest.sent_total, authoritativeTotal),
              sent_crashed: Math.max(latest.sent_crashed, authoritativeCrashed),
            };
            if (write(group.aggregateKey, healed)) ++flushRequested;
            continue;
          }

          // localStorage cannot atomically update the cumulative baseline and delete separate event keys.
          // Persist the acknowledgement first, including the exact event ids. A crash before deletion is
          // healed by reconcileAcknowledgedEvents(); a crash before this write simply retries the same
          // cumulative request, which the server treats idempotently.
          const latest = readAggregate(group.aggregateKey) ?? baseline;
          const acknowledged = new Set(latest.acked_event_ids ?? []);
          for (const item of snapshot) acknowledged.add(item.event.id);
          const committed: DailyAggregate = {
            ...latest,
            sent_total: Math.max(latest.sent_total, totalSessions),
            sent_crashed: Math.max(latest.sent_crashed, crashedSessions),
            acked_event_ids: [...acknowledged],
          };
          if (!write(group.aggregateKey, committed)) continue;
          if (!consentStillAllowed(revision)) return;

          for (const item of snapshot) remove(item.key);
          const afterDelete = readAggregate(group.aggregateKey) ?? committed;
          const removedIds = new Set(snapshot.map((item) => item.event.id));
          afterDelete.acked_event_ids = (afterDelete.acked_event_ids ?? []).filter((id) => !removedIds.has(id));
          write(group.aggregateKey, afterDelete);
        } catch (error) {
          onError(error);
          // Events remain durable for retry. Another tab may advance the shared baseline meanwhile.
        }
      }
    } catch (error) {
      onError(error);
    }
  }

  async function flushOnce(revision: number): Promise<void> {
    try {
      await exclusive("greenchat.session-quality.flush.v1", async () => {
        if (consentStillAllowed(revision)) await flushUnlocked(revision);
      });
    } catch (error) {
      onError(error);
    }
  }

  async function flush(): Promise<void> {
    const requested = ++flushRequested;
    while (flushCompleted < requested) {
      if (flushWorker === null) {
        flushWorker = (async () => {
          while (flushCompleted < flushRequested) {
            const target = flushRequested;
            const revision = consentRevision;
            await flushOnce(revision);
            flushCompleted = target;
          }
        })().finally(() => { flushWorker = null; });
      }
      await flushWorker;
    }
  }

  return {
    async start(): Promise<void> {
      const revision = consentRevision;
      try {
        const persistedConsent = await opts.consent();
        // A newer explicit toggle owns the state. Late boot hydration must never re-enable collection
        // after opt-out or tear down a session that the user explicitly enabled meanwhile.
        if (revision !== consentRevision) return;
        consentOn = persistedConsent;
        if (!consentOn) {
          purge();
          return;
        }
        recoverStale();
        begin();
        await flush();
      } catch (error) {
        onError(error);
      }
    },
    async setConsent(on: boolean): Promise<void> {
      ++consentRevision;
      consentOn = on === true;
      if (!consentOn) {
        // Invalidate every in-flight flush before the authoritative synchronous local purge. Even if the
        // user re-enables immediately, an older request can no longer resurrect pre-opt-out aggregates.
        purge();
        return;
      }
      recoverStale();
      begin();
      await flush();
    },
    markCrashed(): void {
      if (!consentOn || counted || markerKey === null) return;
      const marker = readMarker(markerKey);
      if (!marker) return;
      marker.crashed = true;
      write(markerKey, marker); // recovery hint if the separate immutable event write fails
      if (!count(marker, true, marker.started_at)) {
        stopHeartbeat();
        return;
      }
      remove(markerKey);
      markerKey = null;
      counted = true;
      stopHeartbeat();
      void flush();
    },
    close(): void {
      if (!consentOn || counted || markerKey === null) return;
      const marker = readMarker(markerKey);
      if (!marker) {
        markerKey = null;
        counted = true;
        stopHeartbeat();
        return;
      }
      if (!count(marker, marker.crashed, marker.started_at)) {
        stopHeartbeat();
        return;
      }
      remove(markerKey);
      markerKey = null;
      counted = true;
      stopHeartbeat();
    },
    flush,
  };
}
