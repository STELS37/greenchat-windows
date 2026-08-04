// clients/core/src/diagnostics.ts — client-quality telemetry controller (T-418, PRODUCT_UX §7).
//
// A DOM-free, platform-agnostic controller that measures two KPIs WITHOUT any third-party service:
//   • crash-free rate  — captured crashes (window.onerror / unhandledrejection in the web & WebView
//     shells, or the Tauri panic-hook) are queued locally and POSTed to /v1/client/crash.
//   • push delivery p95 — each push payload carries `sent_at` (server dispatch time, unix-seconds); the
//     receipt time minus that (clock_offset-corrected, T-125) is a latency sample. Once a day the p50/p95
//     aggregate is POSTed to /v1/client/diag (the server folds it into gc_push_latency_p95_ms).
//
// EVERYTHING here is STRICTLY opt-in. `consent` (default OFF) is checked before EVERY network call and
// before collecting anything; with consent OFF the controller issues ZERO diagnostic requests and keeps
// no telemetry (opting out purges the local queues). Reports are pseudonymous — keyed only by a per-install
// UUID (install_id), never a user/account/device id, and carry no message text, chat/contact ids or PII.
//
// The controller owns POLICY (consent gate, daily cadence, quantiles, drain/retry); the shell injects
// the transport (DiagApi superset of ApiClient), persistence (DiagStore — localStorage/IndexedDB on web,
// in-memory in tests), a clock and the T-125 clock offset. Every path is best-effort: a failure goes to
// onError and never throws into the caller (telemetry must never break the app).
import { ApiError, NetworkError } from "./errors.ts";
import { redactStack, redactBreadcrumb } from "./diag_redact.ts";

/** The client platforms the server allowlists (client_quality.ts PLATFORMS). */
export type DiagPlatform = "web" | "android" | "ios" | "desktop";

/** The minimal transport the controller needs — the core ApiClient satisfies it structurally. */
export interface DiagApi {
  post<T>(path: string, body?: unknown, opts?: { noAuth?: boolean }): Promise<T>;
}

/** A crash captured locally, awaiting delivery. `id`/`at` are local bookkeeping — never sent. */
export interface QueuedCrash {
  id: string;
  stack: string;
  breadcrumbs: string[];
  at: number; // ms epoch when captured (local only)
}

/** One push-delivery latency observation: the payload's sent_at vs. the local receipt time. */
export interface LatencySample {
  sentAtSec: number; // server dispatch time from the push payload (unix seconds)
  receivedAtMs: number; // local receipt time (ms epoch)
}

/**
 * Durable state the controller relies on. The web shell backs this with IndexedDB (shared with the
 * service worker, which samples pushes) + localStorage; tests pass an in-memory fake. All async so an
 * IndexedDB implementation fits without ceremony.
 */
export interface DiagStore {
  /** A stable per-install UUID; minted + persisted on first read. NEVER a user/device id. */
  installId(): Promise<string>;
  getConsent(): Promise<boolean>;
  setConsent(on: boolean): Promise<void>;
  pushCrash(c: QueuedCrash): Promise<void>;
  listCrashes(): Promise<QueuedCrash[]>;
  dropCrash(id: string): Promise<void>;
  clearCrashes(): Promise<void>;
  addSample(s: LatencySample): Promise<void>;
  listSamples(): Promise<LatencySample[]>;
  clearSamples(): Promise<void>;
  /** ms epoch of the last accepted diag (0 = never). Gates the once-a-day cadence across reloads. */
  lastDiagAt(): Promise<number>;
  setLastDiagAt(ms: number): Promise<void>;
}

/** Static, non-PII build metadata attached to every crash. */
export interface DiagMeta {
  platform: DiagPlatform;
  appVersion: string;
  osVersion: string;
}

export interface DiagnosticsOptions {
  api: DiagApi;
  store: DiagStore;
  meta: DiagMeta;
  /** ms-epoch clock (default Date.now) — injectable for deterministic tests. */
  now?: () => number;
  /** T-125 clock_offset = server_time − client_time, in SECONDS (default 0 when /v1/config is absent). */
  clockOffsetSec?: () => number;
  /** Sink for best-effort failures (default: swallow). */
  onError?: (err: unknown) => void;
  /** Breadcrumb ring size (default 20 — the server cap). */
  maxBreadcrumbs?: number;
  /** Minimum gap between diag aggregates (default 24h). */
  diagIntervalMs?: number;
}

/** What a crash-capture site hands the controller. All fields optional so an error boundary is trivial. */
export interface CrashCapture {
  message?: string | undefined;
  stack?: string | undefined;
  breadcrumbs?: readonly string[] | undefined;
}

export interface Diagnostics {
  installId(): Promise<string>;
  getConsent(): Promise<boolean>;
  /** Persist the opt-in. Turning ON drains any queue + sends a due aggregate; OFF purges local telemetry. */
  setConsent(on: boolean): Promise<void>;
  /** Note a screen the user reached (breadcrumb; deduped, bounded, screen NAMES only — no content). */
  recordScreen(name: string): void;
  breadcrumbs(): string[];
  /** Capture a crash into the local queue and attempt delivery (both consent-gated). */
  reportError(input: CrashCapture): Promise<void>;
  /** Record one push-delivery latency sample (consent-gated). Web samples in the SW; this serves tests/other shells. */
  sample(s: LatencySample): Promise<void>;
  /** Drain queued crashes + send a due aggregate (consent-gated). Call once at boot. */
  start(): Promise<void>;
}

const CRASH_QUEUE_MAX = 20; // never hoard crashes locally
const SAMPLES_MAX = 100_000; // server ceiling on the reported sample count
const LAT_MAX_MS = 3_600_000; // 1h ceiling — drop absurd clocks rather than report garbage
const DEFAULT_DIAG_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BREADCRUMBS = 20;

// Local crash-id source (a store key only, never transmitted).
let idSeq = 0;
function localId(nowMs: number): string {
  return `${nowMs.toString(36)}-${(idSeq++).toString(36)}`;
}

// Nearest-rank quantile over an ascending-sorted array. p in 0..100. Exported for unit tests.
export function quantile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return Math.round(sortedAsc[idx] as number);
}

/**
 * Fold latency samples into a {p50, p95, samples} aggregate, applying the T-125 clock offset. A sample's
 * server sent_at is converted to the LOCAL clock (client = server − offset) before differencing, so a
 * skewed device clock does not bias the latency. Non-finite/negative/absurd deltas are discarded.
 * Exported for unit tests.
 */
export function computeAggregate(
  samples: readonly LatencySample[],
  offsetSec = 0,
): { p50: number; p95: number; samples: number } {
  const lat: number[] = [];
  for (const s of samples) {
    const sentLocalMs = (s.sentAtSec - offsetSec) * 1000; // server → local clock
    const d = s.receivedAtMs - sentLocalMs;
    if (Number.isFinite(d) && d >= 0 && d <= LAT_MAX_MS) lat.push(d);
  }
  if (lat.length === 0) return { p50: 0, p95: 0, samples: 0 };
  lat.sort((a, b) => a - b);
  return { p50: quantile(lat, 50), p95: quantile(lat, 95), samples: Math.min(lat.length, SAMPLES_MAX) };
}

export function createDiagnostics(opts: DiagnosticsOptions): Diagnostics {
  const { api, store, meta } = opts;
  const now = opts.now ?? ((): number => Date.now());
  const clockOffsetSec = opts.clockOffsetSec ?? ((): number => 0);
  const onError = opts.onError ?? ((): void => {});
  const maxBreadcrumbs = Math.max(1, opts.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS);
  const diagIntervalMs = Math.max(0, opts.diagIntervalMs ?? DEFAULT_DIAG_INTERVAL_MS);

  const crumbs: string[] = [];
  let draining = false;
  let sending = false;
  // Synchronous consent mirror for the sync recordScreen() path. store.getConsent() is async, but a
  // breadcrumb is recorded synchronously as the user navigates, so we cache the verdict here and treat
  // an UNCONFIRMED state as DENY (T-515 #2). Refreshed in start(); written through in setConsent().
  let consentCache = false;
  let consentCacheKnown = false;
  let consentRevision = 0;
  let consentMutationChain: Promise<void> = Promise.resolve();
  const activeCollectors = new Set<Promise<unknown>>();

  function trackCollector<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => { activeCollectors.delete(tracked); });
    activeCollectors.add(tracked);
    return tracked;
  }

  function consentStillAllowed(revision: number): boolean {
    return revision === consentRevision && (!consentCacheKnown || consentCache);
  }

  async function syncConsent(): Promise<void> {
    const revision = consentRevision;
    const persisted = await store.getConsent();
    if (revision !== consentRevision) return;
    consentCache = persisted;
    consentCacheKnown = true;
  }

  function recordScreen(name: string): void {
    if (!consentCache) return; // T-515 #2: default-deny, keep NOTHING until consent is confirmed ON
    const n = redactBreadcrumb(name); // R1/R2/R3/R5 applied AT RECORD TIME (only redacted crumbs persist)
    if (!n) return;
    if (crumbs[crumbs.length - 1] === n) return; // dedupe consecutive visits
    crumbs.push(n);
    while (crumbs.length > maxBreadcrumbs) crumbs.shift();
  }

  // Merge the ring buffer with any breadcrumbs the capture site supplied, keeping the LAST maxBreadcrumbs.
  function crumbsFor(extra: readonly string[] | undefined): string[] {
    const merged =
      extra && extra.length ? [...crumbs, ...extra.map(redactBreadcrumb).filter((s) => s !== "")] : crumbs;
    return merged.slice(-maxBreadcrumbs);
  }

  function stackFrom(input: CrashCapture): string {
    const raw = (input.stack && input.stack.trim() !== "" ? input.stack : input.message) ?? "";
    return redactStack(raw); // R1-R4: sanitise+cap header, mask PII, reduce frames to file:line:column
  }

  async function drainCrashes(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      if (!(await store.getConsent())) return; // opt-in gate — no request when OFF
      const installId = await store.installId();
      const list = await store.listCrashes();
      for (const c of list) {
        if (!(await store.getConsent())) break; // consent could flip mid-drain
        const body: Record<string, unknown> = {
          install_id: installId,
          platform: meta.platform,
          app_version: meta.appVersion,
          os_version: meta.osVersion,
          stack: c.stack,
        };
        if (c.breadcrumbs.length) body.breadcrumbs = c.breadcrumbs;
        try {
          await api.post("/v1/client/crash", body, { noAuth: true });
          await store.dropCrash(c.id); // delivered → forget
        } catch (err) {
          onError(err);
          if (err instanceof NetworkError) break; // offline → keep queue, retry next start
          await store.dropCrash(c.id); // server verdict (4xx/429/5xx) → drop, don't wedge the queue
        }
      }
    } catch (err) {
      onError(err);
    } finally {
      draining = false;
    }
  }

  async function maybeSendDiag(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      if (!(await store.getConsent())) return; // opt-in gate
      const last = await store.lastDiagAt();
      if (now() - last < diagIntervalMs) return; // once a day at most
      const samples = await store.listSamples();
      if (samples.length === 0) return; // nothing to report — don't advance the window
      const agg = computeAggregate(samples, clockOffsetSec());
      if (agg.samples === 0) {
        // every sample was invalid (clock skew) — drop them and reset the window so they can't pile up.
        await store.clearSamples();
        await store.setLastDiagAt(now());
        return;
      }
      try {
        await api.post(
          "/v1/client/diag",
          { install_id: await store.installId(), push_p50_ms: agg.p50, push_p95_ms: agg.p95, samples: agg.samples },
          { noAuth: true },
        );
        await store.clearSamples();
        await store.setLastDiagAt(now());
      } catch (err) {
        onError(err);
        // Network failure → keep samples + window, retry next start. A server verdict (429 already-sent
        // today / 4xx malformed) → stop retrying this window so we never loop.
        if (err instanceof ApiError) {
          await store.clearSamples();
          await store.setLastDiagAt(now());
        }
      }
    } catch (err) {
      onError(err);
    } finally {
      sending = false;
    }
  }

  return {
    installId(): Promise<string> {
      return store.installId();
    },
    getConsent(): Promise<boolean> {
      return store.getConsent();
    },
    setConsent(on: boolean): Promise<void> {
      const revision = ++consentRevision;
      consentCache = on; // write through synchronously so recordScreen() honours the new verdict at once
      consentCacheKnown = true;
      if (!on) crumbs.length = 0; // T-515 #3: opting out purges the in-memory breadcrumb buffer too

      const operation = consentMutationChain.then(async () => {
        try {
          await store.setConsent(on);
          if (revision !== consentRevision) return; // a newer explicit verdict owns all side effects
          if (on) {
            await drainCrashes();
            if (revision === consentRevision) await maybeSendDiag();
          } else {
            // A collector that passed its initial consent check may already be inside an IndexedDB write.
            // Wait every old operation (including ones that start during this loop and fail closed via the
            // synchronous cache), then perform the authoritative final purge.
            while (activeCollectors.size > 0) {
              await Promise.allSettled([...activeCollectors]);
            }
            if (revision !== consentRevision) return;
            await store.clearCrashes();
            await store.clearSamples();
          }
        } catch (err) {
          onError(err);
        }
      });
      consentMutationChain = operation.catch(() => undefined);
      return operation;
    },
    recordScreen,
    breadcrumbs(): string[] {
      return [...crumbs];
    },
    reportError(input: CrashCapture): Promise<void> {
      const revision = consentRevision;
      const collect = trackCollector((async (): Promise<boolean> => {
        try {
          if (!(await store.getConsent()) || !consentStillAllowed(revision)) return false;
          const stack = stackFrom(input);
          if (stack === "") return false;
          const list = await store.listCrashes();
          if (!consentStillAllowed(revision)) return false;
          if (list.length >= CRASH_QUEUE_MAX) {
            // Bounded queue: shed the oldest so a crash loop can't grow unbounded before a drain.
            await store.dropCrash(list[0]!.id);
            if (!consentStillAllowed(revision)) return false;
          }
          await store.pushCrash({ id: localId(now()), stack, breadcrumbs: crumbsFor(input.breadcrumbs), at: now() });
          return true;
        } catch (err) {
          onError(err);
          return false;
        }
      })());
      return (async () => {
        const collected = await collect;
        if (collected && consentStillAllowed(revision)) await drainCrashes();
        // If opt-out won during pushCrash, setConsent(false) waited for collect and clears afterwards.
      })();
    },
    sample(s: LatencySample): Promise<void> {
      const revision = consentRevision;
      return trackCollector((async () => {
        try {
          if (!(await store.getConsent()) || !consentStillAllowed(revision)) return;
          await store.addSample(s);
          // A concurrent opt-out waits for this local write and clears after it commits.
        } catch (err) {
          onError(err);
        }
      })());
    },
    async start(): Promise<void> {
      try {
        await store.installId(); // ensure a stable id exists before any report
        await syncConsent(); // stale hydration cannot overwrite a newer explicit verdict
        await drainCrashes();
        await maybeSendDiag();
      } catch (err) {
        onError(err);
      }
    },
  };
}
