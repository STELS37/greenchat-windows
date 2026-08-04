// clients/ui/src/screens/support.ts — T-512 (MS-2) support controller: the glue that owns the api call,
// the offline queue (S-003), and the mapping of every server/transport outcome to a SupportSubmitResult
// the overlay can render. Kept DOM-free except open() (which mounts the overlay via an injected mount):
// classifySupportError / attemptSend / createSupportQueue are pure and unit-tested without a browser.
//
// POST /v1/support/tickets is NON-idempotent at the transport (idempotency there keys off client_msg_id,
// not our client_ref) — so a 429/5xx/network failure throws at once instead of being hammered by backoff.
// Retry + idempotency are OURS: the offline queue replays by client_ref, and the server dedupes on it (S-001).
import type { I18n } from "../i18n.ts";
import type { ApiLike, SupportTicketPayload, SupportDiagnostics } from "./api.ts";
import { apiErrorCode, apiErrorData, isNetworkError, describeError } from "./api.ts";
import { withoutDiagnostics } from "./support_model.ts";
import {
  createSupportOverlay,
  type SupportSubmitResult, type SupportPrefill, type SupportOverlayDeps, type SupportOverlay,
} from "./support_overlay.ts";
import type { SupportAutoFields } from "./support_model.ts";

// ---- offline queue (S-003) -----------------------------------------------------------------------

// A queued ticket. `payload` is stored VERBATIM — its diagnostics were already redacted at write time
// (R1–R7 in the diag buffer), so nothing sensitive is added by persisting it to localStorage.
export interface SupportQueueItem {
  client_ref: string;
  payload: SupportTicketPayload;
  created_at: number;
}

export interface SupportQueuePort {
  list(): SupportQueueItem[]; // oldest first
  add(item: SupportQueueItem): void;
  remove(clientRef: string): void;

  clear(): void;
  size(): number;
}

// The 2 methods we need off a Web Storage (localStorage) — narrowed so the queue is trivially fakeable.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SUPPORT_QUEUE_KEY = "gc.support.queue";
export const SUPPORT_QUEUE_MAX = 20;

// A localStorage-backed queue, deduped by client_ref (a replay of the same draft never doubles up), with
// a hard cap (oldest evicted). All storage access is wrapped — a full/again disabled Storage never throws.
export function createSupportQueue(
  storage: StorageLike,
  key: string = SUPPORT_QUEUE_KEY,
  max: number = SUPPORT_QUEUE_MAX,
): SupportQueuePort {
  const read = (): SupportQueueItem[] => {
    try {
      const raw = storage.getItem(key);
      if (!raw) return [];
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? (v as SupportQueueItem[]) : [];
    } catch {
      return [];
    }
  };
  const write = (items: SupportQueueItem[]): void => {
    try { storage.setItem(key, JSON.stringify(items)); } catch { /* quota / disabled → best-effort */ }
  };
  return {
    list: () => read(),
    add(item) {
      const items = read().filter((i) => i.client_ref !== item.client_ref);
      items.push(item);
      while (items.length > max) items.shift();
      write(items);
    },
    remove(clientRef) { write(read().filter((i) => i.client_ref !== clientRef)); },
    clear() { write([]); },
    size: () => read().length,
  };
}

// ---- error → result mapping (pure) ---------------------------------------------------------------

function numOr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function httpStatusOf(err: unknown): number {
  if (err && typeof err === "object") {
    const s = (err as { httpStatus?: unknown }).httpStatus;
    if (typeof s === "number") return s;
  }
  return 0;
}

// The subset of SupportSubmitResult a FAILURE can map to (never "created"). "queued" means the caller
// should persist the payload and retry later (offline or a transient server hiccup).
export type SupportFailure = Exclude<SupportSubmitResult, { kind: "created" }>;

export function classifySupportError(err: unknown, hasDiagnostics: boolean, i18n: I18n): SupportFailure {
  if (isNetworkError(err)) return { kind: "queued" };
  const code = apiErrorCode(err);
  if (code === "FEATURE_DISABLED") return { kind: "disabled" };
  if (code === "LIMIT_EXCEEDED") {
    const ra = numOr(apiErrorData(err)["retry_after"]);
    return ra !== undefined ? { kind: "limit", retryAfter: ra } : { kind: "limit" };
  }
  // A validation failure WITH diagnostics is almost always the oversize cap — offer a resend without the
  // blob (S-002). Without diagnostics it is a genuine content error → surface the localised message.
  if (code === "VALIDATION_FAILED") {
    return hasDiagnostics ? { kind: "oversize" } : { kind: "error", message: describeError(err, i18n) };
  }
  // A malformed response or any 5xx is a transient server hiccup → queue and retry later.
  if (code === "BAD_RESPONSE" || httpStatusOf(err) >= 500) return { kind: "queued" };
  return { kind: "error", message: describeError(err, i18n) };
}

type CreateFn = (body: SupportTicketPayload) => Promise<{ ref: string; status: string; chat_id: number | null }>;

// One POST attempt mapped to a result. Never throws.
export async function attemptSend(create: CreateFn, payload: SupportTicketPayload, i18n: I18n): Promise<SupportSubmitResult> {
  try {
    const res = await create(payload);
    return { kind: "created", ref: res.ref };
  } catch (err) {
    return classifySupportError(err, !!payload.diagnostics, i18n);
  }
}

// ---- controller ----------------------------------------------------------------------------------

export interface OpenSupportOptions {
  auto: SupportAutoFields;
  diagnostics?: SupportDiagnostics | null;
  prefill?: SupportPrefill;
}

export interface SupportControllerDeps {
  api: ApiLike;
  i18n: I18n;
  queue: SupportQueuePort;
  // Attach the overlay root to the DOM (the shell passes (root)=>document.body.appendChild(root)).
  mount(root: HTMLElement): void;
  newClientRef(): string;
  now?(): number;
  online?(): boolean;
  toast?(msg: string): void;
  onReport?(): void; // hand-off to the T-113 "report a user/content" flow (NOT a ticket).
}

export interface SupportController {
  open(opts: OpenSupportOptions): void;
  // Drain the offline queue (call on "online" / app resume). Returns how many tickets were accepted.
  flushQueue(): Promise<number>;

  // Drop every account-owned draft and invalidate work when auth ownership changes.
  reset(): void;
  pendingCount(): number;
}

export function createSupportController(deps: SupportControllerDeps): SupportController {
  const now = deps.now ?? (() => Date.now());
  const create: CreateFn | null = deps.api.createSupportTicket ? deps.api.createSupportTicket.bind(deps.api) : null;

  // online + resume/startSync can fire together. Share one drain PER account epoch so the same
  // client_ref is never submitted twice, while a logout immediately detaches the next account from
  // every previous-account request.
  let accountEpoch = 0;
  let flushInFlight: { epoch: number; task: Promise<number> } | null = null;
  const activeOverlays = new Set<SupportOverlay>();
  const staleSubmit = (): SupportSubmitResult => ({ kind: "error", message: deps.i18n.error(null) });

  const toItem = (payload: SupportTicketPayload): SupportQueueItem =>
    ({ client_ref: payload.client_ref, payload, created_at: now() });

  const trySend = async (payload: SupportTicketPayload): Promise<SupportSubmitResult> => {
    const epoch = accountEpoch;
    if (!create) return staleSubmit();
    // Known-offline: don't even attempt — queue immediately so the user gets the "saved" toast at once.
    if (deps.online && !deps.online()) {
      if (epoch !== accountEpoch) return staleSubmit();
      deps.queue.add(toItem(payload));
      return { kind: "queued" };
    }
    const res = await attemptSend(create, payload, deps.i18n);
    if (epoch !== accountEpoch) return staleSubmit();
    if (res.kind === "queued") deps.queue.add(toItem(payload));
    else if (res.kind === "created") deps.queue.remove(payload.client_ref); // clear a prior queued copy
    return res;
  };

  const open = (opts: OpenSupportOptions): void => {
    // Build deps with only the keys that are actually set (exactOptionalPropertyTypes rejects `undefined`).
    const overlayDeps: SupportOverlayDeps = {
      i18n: deps.i18n,
      auto: opts.auto,
      diagnostics: opts.diagnostics ?? null,
      newClientRef: deps.newClientRef,
      submit: trySend,
    };
    if (opts.prefill) overlayDeps.prefill = opts.prefill;
    if (deps.onReport) overlayDeps.onReport = deps.onReport;
    if (deps.toast) overlayDeps.toast = deps.toast;
    let overlay!: SupportOverlay;
    overlayDeps.onClose = () => { activeOverlays.delete(overlay); };
    overlay = createSupportOverlay(overlayDeps);
    activeOverlays.add(overlay);
    deps.mount(overlay.root);
    overlay.focus();
  };

  const runFlushQueue = async (epoch: number): Promise<number> => {
    if (!create || epoch !== accountEpoch) return 0;
    if (deps.online && !deps.online()) return 0;
    let sent = 0;
    for (const item of deps.queue.list()) {
      if (epoch !== accountEpoch) return 0;
      const res = await attemptSend(create, item.payload, deps.i18n);
      if (epoch !== accountEpoch) return 0;
      if (res.kind === "created") {
        deps.queue.remove(item.client_ref);
        deps.toast?.(deps.i18n.t("support.created", { ref: res.ref }));
        sent++;
        continue;
      }
      // Transient / soft — stop and keep the whole tail for the next drain (offline, rate cap, or the
      // operator temporarily turned the feature off; none of these should discard queued tickets).
      if (res.kind === "queued" || res.kind === "limit" || res.kind === "disabled") break;
      // Oversize on replay: try once without the blob (same client_ref → idempotent), else drop.
      if (res.kind === "oversize" && item.payload.diagnostics) {
        const retry = await attemptSend(create, withoutDiagnostics(item.payload), deps.i18n);
        if (epoch !== accountEpoch) return 0;
        if (retry.kind === "created") {
          deps.queue.remove(item.client_ref);
          deps.toast?.(deps.i18n.t("support.created", { ref: retry.ref }));
          sent++;
          continue;
        }
        if (retry.kind === "queued" || retry.kind === "limit" || retry.kind === "disabled") break;
      }
      // Permanent (validation w/o diagnostics, feature disabled, other 4xx) → drop so we never loop forever.
      deps.queue.remove(item.client_ref);
    }
    return sent;
  };

  const flushQueue = (): Promise<number> => {
    const epoch = accountEpoch;
    if (flushInFlight?.epoch === epoch) return flushInFlight.task;
    let task!: Promise<number>;
    task = Promise.resolve()
      .then(() => runFlushQueue(epoch))
      .finally(() => {
        if (flushInFlight?.task === task) flushInFlight = null;
      });
    flushInFlight = { epoch, task };
    return task;
  };

  return {
    open,
    flushQueue,
    reset(): void {
      accountEpoch += 1;
      flushInFlight = null;
      deps.queue.clear();
      for (const overlay of [...activeOverlays]) overlay.close();
      activeOverlays.clear();
    },
    pendingCount: () => deps.queue.size(),
  };
}

// Re-exported so the shell can pull the whole support surface from one module.
export { createSupportOverlay } from "./support_overlay.ts";
export type { SupportOverlayDeps, SupportOverlay } from "./support_overlay.ts";
