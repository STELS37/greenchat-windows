// clients/core — SyncEngine (T-402).
//
// The single source of truth for the durable event cursor (`last_seq`) and the bridge between the
// two delivery transports (CLIENTS.md §5.1, server contract T-015/T-018):
//   - while the WebSocket is OPEN, live events flow over it (WsClient).
//   - whenever the socket is NOT open (cold start gap, reconnecting, offline), a long-poll loop on
//     GET /v1/updates?since=<last_seq> keeps the cursor moving. The two never double-apply because
//     every event passes through applyEvent(), which drops anything with seq <= last_seq.
//   - resync:true (our cursor is older than the server's event window) -> pause durable delivery,
//     refetch lists/histories through an async barrier, then acknowledge the head and drain buffered
//     live events. A failed refetch keeps the old cursor and retries (PRODUCT_UX scenario C2).
import type { ApiClient } from "./api.ts";
import { WsClient, type CallSignalFrame, type WsState } from "./ws.ts";
import type { HelloFrame, SyncEvent, UpdatesResponse } from "./types.ts";

// Aggregate delivery health for user-facing status. Calls still inspect getWsState(): volatile SDP/ICE
// cannot use long-poll, while durable messages can. Keeping the two states separate prevents a healthy
// fallback from being advertised as a connection failure.
export type SyncDeliveryState = "stopped" | "websocket" | "fallback" | "unavailable";

export interface SyncEngineOptions {
  api: ApiClient;
  // ws(s)/http(s) origin for the WebSocket (usually the same baseUrl as the ApiClient).
  baseUrl: string;
  // Applied to every durable AND volatile event, already de-duplicated by seq and in order.
  onEvent: (evt: SyncEvent) => void;
  // The server says our cursor is too old: refetch chat list + open histories. This is an ASYNC
  // durability barrier: the engine acknowledges/persists `head` only after the callback succeeds.
  // A rejection keeps the old cursor and is retried; live durable events wait behind the barrier.
  onResync?: (head: number | null) => void | Promise<void>;
  onStateChange?: (state: WsState) => void;
  // Call signaling (T-202 / V75). Relayed verbatim from the socket and deliberately kept OUT of
  // onEvent: a ringing call carries no seq, must not advance the resume cursor and is worthless once
  // replayed. The engine only forwards — it never inspects SDP/ICE.
  onCallFrame?: (frame: CallSignalFrame) => void;
  // Session dead (WS 4401 or refresh failure) -> return to login.
  onAuthLost?: () => void;
  // Persist the advancing cursor (optional; the store owns durability across restarts).
  onCursor?: (lastSeq: number) => void;
  // long-poll tunables.
  longPollTimeoutSec?: number; // default 25 (server cap)
  pollErrorBackoffMs?: number; // default 1_000
  sleepImpl?: (ms: number) => Promise<void>;
  // Injected for tests: a fake WebSocket that never opens keeps the engine in long-poll mode.
  wsImpl?: typeof WebSocket;
  randomImpl?: () => number;
}

const DEFAULT_POLL_TIMEOUT = 25;
const DEFAULT_POLL_BACKOFF = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SyncEngine {
  private readonly api: ApiClient;
  private readonly opts: SyncEngineOptions;
  private readonly ws: WsClient;
  private readonly longPollTimeoutSec: number;
  private readonly pollBackoffMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  // null = the engine was never seeded (true cold start); 0 = an explicit replay cursor supplied by
  // persistent storage. Collapsing those states loses the first failed durable event on restart.
  private lastSeq: number | null = null;
  private running = false;
  private wsState: WsState = "idle";
  private pollLoopActive = false; // guards a single long-poll loop
  private pollGeneration = 0; // bump to cancel an in-flight loop

  // null = the fallback request is in flight/not yet proven; true = last poll reached the server;
  // false = both realtime paths are currently unproven. The public getter combines this with wsState.
  private pollReachable: boolean | null = null;
  private lifecycleGeneration = 0; // invalidates async resync work across stop/account changes
  private resyncInFlight: Promise<void> | null = null;
  private resyncHead: number | null = null;
  private resyncBuffer: SyncEvent[] = [];

  constructor(opts: SyncEngineOptions) {
    this.api = opts.api;
    this.opts = opts;
    this.longPollTimeoutSec = opts.longPollTimeoutSec ?? DEFAULT_POLL_TIMEOUT;
    this.pollBackoffMs = opts.pollErrorBackoffMs ?? DEFAULT_POLL_BACKOFF;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;

    this.ws = new WsClient({
      baseUrl: opts.baseUrl,
      tokens: this.api.tokens,
      getSince: () => this.lastSeq ?? undefined,
      onHello: (h: HelloFrame) => this.onHello(h),
      onEvent: (e: SyncEvent) => this.applyEvent(e),
      onStateChange: (s: WsState) => this.onWsState(s),
      ...(opts.onCallFrame ? { onCallFrame: opts.onCallFrame } : {}),
      // Share ApiClient's single-flight refresh so a WS 4401 tries to recover an expired access token
      // (and coalesces with the HTTP refresh) before ever surfacing onAuthLost (T-421).
      refresh: () => this.api.refreshTokens(),
      ...(opts.onAuthLost ? { onAuthLost: opts.onAuthLost } : {}),
      ...(opts.wsImpl ? { wsImpl: opts.wsImpl } : {}),
      ...(opts.randomImpl ? { randomImpl: opts.randomImpl } : {}),
    });
  }

  // Seed the cursor from persistent storage before start() so a warm start resumes correctly. A
  // stopped engine may be reused by a different account, therefore the pre-start seed REPLACES the
  // previous lifecycle. While running, only monotonic forward movement is accepted.
  setCursor(lastSeq: number): void {
    const next = Number.isSafeInteger(lastSeq) && lastSeq >= 0 ? lastSeq : 0;
    if (this.running) {
      if (this.lastSeq === null || next > this.lastSeq) this.lastSeq = next;
      this.ws.setLastSeq(this.lastSeq ?? next);
      return;
    }
    // Pre-start seeding is exact, not monotonic: another account may legitimately start at zero.
    this.lastSeq = next;
    this.ws.seedLastSeq(next);
  }

  getCursor(): number {
    return this.lastSeq ?? 0;
  }

  getWsState(): WsState {
    return this.wsState;
  }

  getDeliveryState(): SyncDeliveryState {
    if (!this.running) return "stopped";
    if (this.wsState === "open") return "websocket";
    // A pending long-poll is itself the active fallback transport. We only call the aggregate path
    // unavailable after that request actually fails; otherwise every normal 25 s hold would look dead.
    return this.pollReachable === false ? "unavailable" : "fallback";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollReachable = null;
    this.lifecycleGeneration++;
    // Kick the WS; the long-poll loop starts on its own if the socket is not open shortly after.
    this.ws.start();
    // Cover the cold-start gap: until the socket reports "open", poll so no event is missed.
    this.ensurePolling();
  }

  stop(): void {
    this.running = false;
    this.lifecycleGeneration++;
    this.pollGeneration++; // cancel any in-flight long-poll loop
    this.pollLoopActive = false;
    this.pollReachable = null;
    this.resyncInFlight = null;
    this.resyncHead = null;
    this.resyncBuffer = [];
    this.ws.close();
  }

  // Expose the socket for volatile intents (typing / read markers) — same object the engine drives.
  get socket(): WsClient {
    return this.ws;
  }

  private onHello(h: HelloFrame): void {
    const head = Number.isSafeInteger(h.last_seq) && h.last_seq >= 0 ? h.last_seq : null;
    if (h.resync === true) {
      // Do not adopt/persist the head until the full snapshot has been refetched successfully.
      void this.handleResync(head);
      return;
    }
    // Only a never-seeded engine is a true cold start. Explicit zero means replay from zero.
    if (this.lastSeq === null && head !== null) {
      this.lastSeq = head;
      this.opts.onCursor?.(head);
    }
  }

  private onWsState(s: WsState): void {
    this.wsState = s;
    this.opts.onStateChange?.(s);
    if (s === "open") {
      // Socket carries live events now; stop polling.
      this.pollGeneration++;
      this.pollLoopActive = false;
    } else if (this.running) {
      // Not open (connecting/reconnecting/closed) -> keep the cursor moving via long-poll.
      this.ensurePolling();
    }
  }

  // Apply one event with strict de-duplication and monotonic cursor advance. Durable events received
  // while a full snapshot is in flight are buffered: applying them to stale state before the snapshot
  // lands can create an unrecoverable gap. Volatile events remain best-effort and pass through.
  private applyEvent(evt: SyncEvent): void {
    if (evt.seq !== null && this.resyncInFlight) {
      this.resyncBuffer.push(evt);
      return;
    }
    this.applyEventNow(evt);
  }

  private applyEventNow(evt: SyncEvent): void {
    if (evt.seq !== null) {
      const current = this.lastSeq ?? 0;
      if (evt.seq <= current) return; // already applied (dup across transports) -> drop
      this.lastSeq = evt.seq;
      // The cache mutation must be enqueued before its durable cursor acknowledgement. CacheSync uses
      // one serial queue, so this call order prevents a crash from persisting seq N while event N is
      // still uncommitted (or has failed).
      this.opts.onEvent(evt);
      this.opts.onCursor?.(evt.seq);
      return;
    }
    this.opts.onEvent(evt);
  }

  // Full resync is a retrying async barrier. `head` is the server's next_since/hello.last_seq; null
  // means the server did not provide one, so refetch still runs but the old cursor remains until a
  // later authoritative response. Concurrent resync signals coalesce and the newest head wins.
  private handleResync(head: number | null): Promise<void> {
    const normalized = head !== null && Number.isSafeInteger(head) && head >= 0 ? head : null;
    if (normalized !== null && (this.resyncHead === null || normalized > this.resyncHead)) {
      this.resyncHead = normalized;
    }
    if (this.resyncInFlight) return this.resyncInFlight;

    const generation = this.lifecycleGeneration;
    let operation: Promise<void>;
    operation = (async () => {
      for (;;) {
        if (!this.running || generation !== this.lifecycleGeneration) return;
        const targetHead = this.resyncHead;
        try {
          await this.opts.onResync?.(targetHead);
        } catch {
          if (!this.running || generation !== this.lifecycleGeneration) return;
          await this.sleepImpl(this.pollBackoffMs);
          continue;
        }
        if (!this.running || generation !== this.lifecycleGeneration) return;
        // A newer resync signal arrived while this snapshot was loading: refetch that edition before
        // acknowledging anything.
        if (targetHead !== this.resyncHead) continue;

        const current = this.lastSeq ?? 0;
        if (targetHead !== null && targetHead > current) {
          this.lastSeq = targetHead;
          this.opts.onCursor?.(targetHead);
        }
        const buffered = this.resyncBuffer;
        this.resyncBuffer = [];
        for (const event of buffered) this.applyEventNow(event);
        this.resyncHead = null;
        return;
      }
    })().finally(() => {
      if (this.resyncInFlight === operation) this.resyncInFlight = null;
    });
    this.resyncInFlight = operation;
    return operation;
  }

  private ensurePolling(): void {
    if (!this.running || this.pollLoopActive) return;
    if (this.wsState === "open") return;
    this.pollLoopActive = true;
    const gen = ++this.pollGeneration;
    void this.pollLoop(gen);
  }

  // Long-poll until this generation is cancelled (WS opened, or stop()).
  private async pollLoop(gen: number): Promise<void> {
    while (this.running && gen === this.pollGeneration && this.wsState !== "open") {
      try {
        const since = this.lastSeq ?? 0;
        const r = await this.api.get<UpdatesResponse>(
          `/v1/updates?since=${since}&timeout=${this.longPollTimeoutSec}`,
        );
        if (gen !== this.pollGeneration) break; // superseded (WS opened mid-poll)
        this.pollReachable = true;
        if (r.resync === true) {
          await this.handleResync(typeof r.next_since === "number" ? r.next_since : null);
          continue;
        }
        for (const e of r.events) {
          this.applyEvent({ seq: e.seq, type: e.type, payload: e.payload });
        }
        // Advance to next_since even if the batch was empty/all-dup (keeps the cursor fresh).
        const current = this.lastSeq ?? 0;
        if (typeof r.next_since === "number" && r.next_since > current) {
          this.lastSeq = r.next_since;
          this.opts.onCursor?.(r.next_since);
        }
      } catch {
        if (gen !== this.pollGeneration) break;
        this.pollReachable = false;
        // Network/server hiccup: back off, then retry (the WS is also trying in parallel).
        await this.sleepImpl(this.pollBackoffMs);
      }
    }
    if (gen === this.pollGeneration) this.pollLoopActive = false;
  }
}
