// T-421 (revision #25) — a WS close 4401 is NOT an unconditional logout.
//
// The server sends close 4401 both for a REVOKED session and for a merely EXPIRED access token
// (resolveAccessToken does not distinguish; access TTL = 3600s). The old WsClient treated any 4401
// as fatal onAuthLost, so a routine access expiry logged the user out. The fix: on 4401, try ONE
// single-flight refresh; on success reconnect with the fresh token; onAuthLost only if the server
// rejects the refresh. Anti-loop: at most one refresh round per connection cycle — a repeat 4401
// right after a successful refresh is a genuine revocation -> honest logout.
//
// Driven by a controllable fake WebSocket so the four branches are hermetic and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WsClient } from "../src/ws.ts";
import { NetworkError } from "../src/errors.ts";

// A minimal, test-driven WebSocket: the test decides when the socket opens, receives hello, or is
// closed by the "server". WsClient (typed against the DOM WebSocket) drives it through the cast.
class FakeWs {
  static instances: FakeWs[] = [];
  readonly url: string;
  readyState = 0; // 0 CONNECTING, 1 OPEN, 3 CLOSED
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
  }

  // ---- test drivers ----
  drveOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverHello(seq = 0): void {
    this.onmessage?.({
      data: JSON.stringify({ type: "hello", user_id: 1, session_id: 1, now: Date.now(), last_seq: seq }),
    });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  authFrame(): { type?: string; token?: string; since?: number } {
    return this.sent.length ? (JSON.parse(this.sent[0]!) as { type?: string; token?: string }) : {};
  }
}

const wsImpl = FakeWs as unknown as typeof WebSocket;
const tick = (ms = 8): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeClient(opts: {
  tokens: { access: string | null; refresh: string | null; accessExpiresAt: number | null };
  refresh?: () => Promise<boolean>;
  onAuthLost: () => void;
}): WsClient {
  return new WsClient({
    baseUrl: "http://127.0.0.1:1",
    tokens: opts.tokens,
    getSince: () => undefined,
    ...(opts.refresh ? { refresh: opts.refresh } : {}),
    onAuthLost: opts.onAuthLost,
    wsImpl,
    minBackoffMs: 10,
    maxBackoffMs: 20,
    authTimeoutMs: 1_000,
    randomImpl: () => 0,
  });
}

test("T-421: 4401 on an expired access token refreshes once and reconnects — no logout", async () => {
  FakeWs.instances.length = 0;
  const tokens = { access: "expired", refresh: "R", accessExpiresAt: null };
  let refreshCalls = 0;
  let authLost = 0;
  const ws = makeClient({
    tokens,
    refresh: async () => {
      refreshCalls++;
      tokens.access = "fresh"; // a real refresh rotates the in-memory access token
      return true;
    },
    onAuthLost: () => {
      authLost++;
    },
  });
  try {
    ws.start();
    const s1 = FakeWs.instances[0]!;
    s1.drveOpen();
    assert.equal(s1.authFrame().token, "expired", "first socket authed with the expired token");
    s1.serverClose(4401); // server rejects the expired access token
    await tick();

    assert.equal(refreshCalls, 1, "exactly one refresh round");
    assert.equal(authLost, 0, "a recoverable expiry must NOT log out");
    assert.equal(FakeWs.instances.length, 2, "reconnected with a fresh socket");

    const s2 = FakeWs.instances[1]!;
    s2.drveOpen();
    assert.equal(s2.authFrame().token, "fresh", "reconnect authed with the refreshed token");
    s2.serverHello(0);
    assert.equal(ws.getState(), "open", "back to open after the fresh token is accepted");
  } finally {
    ws.close();
  }
});

test("T-421: 4401 the server refuses to refresh (verdict) logs out exactly once", async () => {
  FakeWs.instances.length = 0;
  const tokens = { access: "expired", refresh: "revoked", accessExpiresAt: null };
  let refreshCalls = 0;
  let authLost = 0;
  const ws = makeClient({
    tokens,
    refresh: async () => {
      refreshCalls++;
      return false; // server verdict: refresh rejected (reuse/expired/revoked)
    },
    onAuthLost: () => {
      authLost++;
    },
  });
  try {
    ws.start();
    const s1 = FakeWs.instances[0]!;
    s1.drveOpen();
    s1.serverClose(4401);
    await tick();

    assert.equal(refreshCalls, 1, "one refresh attempt");
    assert.equal(authLost, 1, "exactly one onAuthLost on a server verdict");
    assert.equal(FakeWs.instances.length, 1, "did not reconnect after a verdict");
    assert.equal(ws.getState(), "closed");
  } finally {
    ws.close();
  }
});

test("T-421: a repeat 4401 right after a successful refresh is a real revocation (anti-loop)", async () => {
  FakeWs.instances.length = 0;
  const tokens = { access: "expired", refresh: "R", accessExpiresAt: null };
  let refreshCalls = 0;
  let authLost = 0;
  const ws = makeClient({
    tokens,
    refresh: async () => {
      refreshCalls++;
      tokens.access = "fresh";
      return true;
    },
    onAuthLost: () => {
      authLost++;
    },
  });
  try {
    ws.start();
    const s1 = FakeWs.instances[0]!;
    s1.drveOpen();
    s1.serverClose(4401); // -> refresh true -> reconnect
    await tick();
    assert.equal(FakeWs.instances.length, 2, "reconnected after the refresh");

    const s2 = FakeWs.instances[1]!;
    s2.drveOpen();
    assert.equal(s2.authFrame().token, "fresh");
    s2.serverClose(4401); // the FRESH token is ALSO rejected -> genuine revocation
    await tick();

    assert.equal(refreshCalls, 1, "did NOT refresh again on the same cycle (anti-loop)");
    assert.equal(authLost, 1, "logged out once the fresh token was rejected");
    assert.equal(FakeWs.instances.length, 2, "no third socket");
    assert.equal(ws.getState(), "closed");
  } finally {
    ws.close();
  }
});

test("T-421: a transient (offline) refresh failure keeps the session and retries with backoff", async () => {
  FakeWs.instances.length = 0;
  const tokens = { access: "expired", refresh: "R", accessExpiresAt: null };
  let refreshCalls = 0;
  let authLost = 0;
  const ws = makeClient({
    tokens,
    refresh: async () => {
      refreshCalls++;
      throw new NetworkError("offline during refresh", null); // transient, not a verdict
    },
    onAuthLost: () => {
      authLost++;
    },
  });
  try {
    ws.start();
    const s1 = FakeWs.instances[0]!;
    s1.drveOpen();
    s1.serverClose(4401);
    await tick(40); // let the backoff reconnect fire (minBackoff 10ms)

    assert.equal(authLost, 0, "an offline refresh must never log out (T-422 semantics via WS)");
    assert.equal(refreshCalls, 1, "one refresh attempt on this cycle");
    assert.ok(FakeWs.instances.length >= 2, "scheduled a reconnect to try again later");
  } finally {
    ws.close();
  }
});

test("T-421: with no refresh hook wired, a 4401 stays fatal (back-compat)", async () => {
  FakeWs.instances.length = 0;
  const tokens = { access: "expired", refresh: "R", accessExpiresAt: null };
  let authLost = 0;
  const ws = makeClient({ tokens, onAuthLost: () => { authLost++; } }); // no refresh
  try {
    ws.start();
    const s1 = FakeWs.instances[0]!;
    s1.drveOpen();
    s1.serverClose(4401);
    await tick();
    assert.equal(authLost, 1, "without a refresher, 4401 is still an honest logout");
    assert.equal(ws.getState(), "closed");
  } finally {
    ws.close();
  }
});
