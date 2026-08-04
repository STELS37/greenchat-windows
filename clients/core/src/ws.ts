// clients/core — WsClient realtime transport (T-402).
//
// A thin, reconnecting client for the /v1/ws gateway (server contract in server/src/realtime/ws.ts):
//   - open the socket, then send {type:"auth", token, since?} within the server's 10s auth window.
//   - the server replies {type:"hello", user_id, session_id, now, last_seq, resync?}. resync:true
//     means our `since` fell behind the 30-day event window -> the app must refetch (SyncEngine
//     turns this into an onResync callback).
//   - durable/volatile events arrive as {type:"event", seq?, event_type, payload}; we normalise and
//     hand them up. The highest seq is remembered so a reconnect resumes with since=<last_seq>.
//   - reconnect with exponential backoff 1s -> 30s plus jitter. A server close 4401 is AMBIGUOUS
//     (the server sends it for a revoked session AND for a merely expired access token — T-421), so
//     we first try ONE single-flight refresh and reconnect with the fresh token; onAuthLost (return
//     to login) fires only if the server rejects the refresh. Anti-loop: at most one refresh round
//     per connection cycle — a repeat 4401 right after a successful refresh is a real revocation.
//   - app-level keepalive: every heartbeat we send {type:"ping"} and expect {type:"pong"}.
// Uses the global WebSocket (Node 22 + browsers) so clients/core keeps zero runtime dependencies.
import type { TokenStore } from "./api.ts";
import type { HelloFrame, SyncEvent, WsEventFrame } from "./types.ts";

export type WsState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

// A call signaling frame as it travels the socket (server/src/modules/calls.ts). Kept structural and
// open-ended on purpose: the transport must relay SDP/ICE payloads verbatim without ever parsing
// them — the media is peer-to-peer and the server (and this layer) must stay content-blind.
export interface CallSignalFrame {
  type: string; // "call.incoming" | "call.ringing" | "call.answer" | "call.ice" | ...
  [key: string]: unknown;
}

// WS close code the server uses for "auth required / session revoked" (server/src/realtime/ws.ts).
export const CLOSE_AUTH = 4401;

export interface WsClientOptions {
  // http(s):// origin or ws(s):// url; /v1/ws is appended. Same-origin web may pass location.origin.
  baseUrl: string;
  tokens: TokenStore;
  // Resume cursor: the highest seq the app has durably applied (SyncEngine owns it). undefined on a
  // cold start -> the server starts us live from its head with no replay.
  getSince: () => number | undefined;
  onHello?: (hello: HelloFrame) => void;
  onEvent?: (evt: SyncEvent) => void;
  // Call signaling (T-202 / V75). Frames whose type starts with "call." are NOT sync events: they
  // carry no seq, must never advance the resume cursor, and are worthless once stale. They are
  // therefore handed up on their own channel, verbatim, and dropped when nobody listens.
  onCallFrame?: (frame: CallSignalFrame) => void;
  // Fired when the server (hello.resync) says our cursor is too old -> refetch lists/histories.
  onResync?: () => void;
  onStateChange?: (state: WsState) => void;
  // Session is unrecoverable -> stop and go to login. Fired ONLY after a refresh attempt is rejected
  // by the server (T-421); a plain access-token expiry is recovered transparently, not fatal.
  onAuthLost?: () => void;
  // Single-flight token refresh, shared with ApiClient so the WS 4401 path coalesces with the HTTP
  // path (T-421). Resolves true -> reconnect with the fresh access token; false -> server verdict ->
  // logout; rejects (offline/5xx) -> transient, keep the session and retry with backoff.
  refresh?: () => Promise<boolean>;
  // Tunables (defaults chosen to match the plan). Overridable for tests.
  minBackoffMs?: number; // default 1_000
  maxBackoffMs?: number; // default 30_000
  heartbeatMs?: number; // default 25_000 (< server 30s idle terminate)
  authTimeoutMs?: number; // default 8_000 (< server 10s auth window)
  // Injected for tests.
  wsImpl?: typeof WebSocket;
  randomImpl?: () => number;
}

const DEFAULT_MIN_BACKOFF = 1_000;
const DEFAULT_MAX_BACKOFF = 30_000;
const DEFAULT_HEARTBEAT = 25_000;
const DEFAULT_AUTH_TIMEOUT = 8_000;

// http://h:p -> ws://h:p/v1/ws (https -> wss). Accepts an already-ws url too.
export function toWsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return "wss://" + trimmed.slice("https://".length) + "/v1/ws";
  if (trimmed.startsWith("http://")) return "ws://" + trimmed.slice("http://".length) + "/v1/ws";
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed + "/v1/ws";
  return trimmed + "/v1/ws";
}

export class WsClient {
  private readonly url: string;
  private readonly tokens: TokenStore;
  private readonly getSince: () => number | undefined;
  private readonly opts: WsClientOptions;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly heartbeatMs: number;
  private readonly authTimeoutMs: number;
  private readonly WsCtor: typeof WebSocket;
  private readonly randomImpl: () => number;

  private ws: WebSocket | null = null;
  private state: WsState = "idle";
  private attempts = 0; // consecutive failed connects (drives backoff)
  private authed = false; // hello received on the current socket
  private lastSeq: number | null = null; // highest seq seen (also seeds resume)
  private wantOpen = false; // true between start() and close(); gates auto-reconnect
  // T-421 anti-loop: at most ONE refresh round per connection cycle. Set once we hold a
  // freshly-refreshed token pending validation; reset on hello (a healthy auth). A 4401 that arrives
  // while this is set means the FRESH token was rejected -> genuine revocation -> logout.
  private didRefreshThisCycle = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WsClientOptions) {
    this.url = toWsUrl(opts.baseUrl);
    this.tokens = opts.tokens;
    this.getSince = opts.getSince;
    this.opts = opts;
    this.minBackoff = opts.minBackoffMs ?? DEFAULT_MIN_BACKOFF;
    this.maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT;
    this.authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT;
    this.WsCtor = opts.wsImpl ?? globalThis.WebSocket;
    this.randomImpl = opts.randomImpl ?? Math.random;
  }

  getState(): WsState {
    return this.state;
  }

  // Highest seq the client has observed on this connection lifecycle (resume cursor).
  getLastSeq(): number | null {
    return this.lastSeq;
  }

  // Advance the live resume cursor monotonically as hello/event frames arrive.
  setLastSeq(seq: number): void {
    if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
  }

  // Replace the persisted seed between connection lifecycles (for example after logout/login into a
  // different account). Live event handling continues to use monotonic setLastSeq().
  seedLastSeq(seq: number): void {
    this.lastSeq = seq;
  }

  start(): void {
    if (this.wantOpen) return;
    this.wantOpen = true;
    this.attempts = 0;
    this.didRefreshThisCycle = false;
    this.open();
  }

  // Close intentionally (logout / teardown). Stops reconnection.
  close(): void {
    this.wantOpen = false;
    this.clearTimers();
    this.setState("closed");
    if (this.ws) {
      try {
        this.ws.close(1000, "client closing");
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  // Send a typing indicator (volatile; server throttles to 1/3s per chat).
  sendTyping(chatId: number): void {
    this.send({ type: "typing", chat_id: chatId });
  }

  // Advance the read marker over WS (volatile channel; mirrors POST /v1/chats/:id/read).
  sendMarkRead(chatId: number, upToMessageId: number): void {
    this.send({ type: "mark_read", chat_id: chatId, up_to_message_id: upToMessageId });
  }

  private open(): void {
    if (!this.wantOpen) return;
    this.authed = false;
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new this.WsCtor(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Send the auth frame with our resume cursor. The server replies hello (or closes 4401).
      const since = this.getSince();
      const frame: Record<string, unknown> = { type: "auth", token: this.tokens.access ?? "" };
      if (typeof since === "number" && since >= 0) frame.since = since;
      this.rawSend(frame);
      // Guard the server's 10s auth window from our side; if hello never lands, drop and retry.
      this.authTimer = setTimeout(() => {
        if (!this.authed) this.dropAndReconnect();
      }, this.authTimeoutMs);
    };

    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev);

    ws.onclose = (ev: CloseEvent) => {
      this.clearAuthTimer();
      this.stopHeartbeat();
      this.ws = null;
      if (!this.wantOpen) return; // intentional close
      if (ev.code === CLOSE_AUTH) {
        // Ambiguous: a REVOKED session OR a merely EXPIRED access token (the server does not
        // distinguish — T-421). Try one single-flight refresh before deciding; onAuthLost fires only
        // if the server rejects it.
        void this.handleAuthClose();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onerror is always followed by onclose; let onclose drive the reconnect. Swallow here so an
      // unhandled 'error' event never throws in Node.
    };
  }

  private onMessage(ev: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return; // ignore non-JSON
    }
    const type = typeof msg.type === "string" ? msg.type : "";

    if (type === "hello") {
      this.authed = true;
      this.attempts = 0; // a successful auth resets backoff
      this.didRefreshThisCycle = false; // healthy auth resets the one-refresh-per-cycle guard (T-421)
      this.clearAuthTimer();
      this.setState("open");
      this.startHeartbeat();
      const hello = msg as unknown as HelloFrame;
      // A resync hello advertises the server head, not an applied client cursor. Keep it out of the
      // local resume state until SyncEngine's async snapshot barrier succeeds.
      if (hello.resync !== true && typeof hello.last_seq === "number") this.setLastSeq(hello.last_seq);
      this.opts.onHello?.(hello);
      if (hello.resync === true) this.opts.onResync?.();
      return;
    }

    if (type === "event") {
      const f = msg as unknown as WsEventFrame;
      const seq = typeof f.seq === "number" ? f.seq : null;
      if (seq !== null) this.setLastSeq(seq);
      this.opts.onEvent?.({ seq, type: f.event_type, payload: f.payload });
      return;
    }

    // Call signaling: relayed straight to the call layer. Deliberately NOT routed through onEvent —
    // a ringing call is live state, not history, so it carries no seq and must not touch the cursor.
    if (type.startsWith("call.")) {
      this.opts.onCallFrame?.(msg as CallSignalFrame);
      return;
    }

    // pong / other server frames: nothing to do (heartbeat liveness is implicit in the socket).
  }

  // Send a call signaling frame (offer/answer/ice/hangup/reject). Volatile like typing: if the socket
  // is down the frame is dropped, because a call that cannot reach the server has already failed and
  // the call layer surfaces that as a lost call rather than replaying a stale offer minutes later.
  sendCall(frame: CallSignalFrame): void {
    this.send(frame as unknown as Record<string, unknown>);
  }

  // Send an app frame if the socket is open and authed. Volatile intents are dropped when offline
  // (the app re-derives them; there is no durable queue for typing/mark_read here).
  private send(frame: Record<string, unknown>): void {
    if (!this.authed) return;
    this.rawSend(frame);
  }

  private rawSend(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closed mid-send; onclose will reconnect */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.rawSend({ type: "ping" }), this.heartbeatMs);
    // Do not keep the Node event loop alive just for the heartbeat (matches server .unref()).
    const t = this.heartbeatTimer as unknown as { unref?: () => void };
    t.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private dropAndReconnect(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, "auth timeout");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  // T-421: recover from a 4401 close. One refresh round per connection cycle (didRefreshThisCycle).
  private async handleAuthClose(): Promise<void> {
    if (!this.wantOpen) return; // closed intentionally in the meantime
    // Already spent our one refresh on this cycle (or nothing to refresh with) and STILL 4401 -> the
    // fresh token is rejected -> genuine revocation.
    if (this.didRefreshThisCycle || !this.opts.refresh) {
      this.fatalAuthLost();
      return;
    }
    this.didRefreshThisCycle = true;
    let ok: boolean;
    try {
      ok = await this.opts.refresh();
    } catch {
      // Transient refresh failure (offline / 5xx): the session is NOT dead (T-422). Keep the tokens,
      // clear the one-shot guard, and retry the whole connect with backoff — the next 4401 gets a
      // fresh refresh attempt once the network recovers.
      this.didRefreshThisCycle = false;
      if (this.wantOpen) this.scheduleReconnect();
      return;
    }
    if (!ok) {
      // Server verdict (refresh reused/expired/revoked) -> honest logout, exactly once.
      this.fatalAuthLost();
      return;
    }
    // Fresh access token in hand -> reconnect immediately (no backoff). didRefreshThisCycle stays set
    // so an immediate repeat 4401 before the next hello takes the fatal branch above.
    if (this.wantOpen) this.open();
  }

  private fatalAuthLost(): void {
    this.wantOpen = false;
    this.setState("closed");
    this.opts.onAuthLost?.();
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen) return;
    this.stopHeartbeat();
    this.setState("reconnecting");
    const delay = this.backoff(this.attempts);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
    const t = this.reconnectTimer as unknown as { unref?: () => void };
    t.unref?.();
  }

  // Exponential backoff min*2^attempt capped at max, plus full jitter (random in [0, computed]).
  private backoff(attempt: number): number {
    const ceiling = Math.min(this.maxBackoff, this.minBackoff * 2 ** attempt);
    // Keep at least minBackoff/2 so a hot loop cannot spin; full jitter over the ceiling otherwise.
    return Math.floor(this.minBackoff / 2 + this.randomImpl() * (ceiling - this.minBackoff / 2));
  }

  private setState(s: WsState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearAuthTimer();
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
