// clients/core — push registrar against a LIVE compiled server (T-414). Drives registerPush (CLIENTS
// §5.4) through a scripted PushBridge and verifies the server side of the contract end-to-end: the
// initial token is subscribed, a refreshed token supersedes the old endpoint, a WS-only (null) bridge
// registers nothing, and stop() unsubscribes. Delivery/crypto is covered by the server's RFC 8291
// golden-vector unit test; here we pin the registration lifecycle the app depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, waitFor } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { registerPush, type PushBridge, type PushToken, type PushData } from "../src/index.ts";
import type { SessionResult } from "../src/types.ts";

let uSeq = 0;
function uname(): string {
  return `u${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}
function client(base: string): ApiClient {
  return new ApiClient({ baseUrl: base, clientId: "node/0.1.0", tokens: emptyTokens() });
}
async function register(api: ApiClient, name = "User"): Promise<void> {
  const r = await api.post<SessionResult>("/v1/auth/register", { username: uname(), password: "password1", name, legal_accepted: true, age_confirmed: true }, { idempotent: false });
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
}

// A scripted PushBridge: replays the tokens the test feeds it, records setBadge calls.
class FakeBridge implements PushBridge {
  private tokenCbs = new Set<(t: PushToken | null) => void>();
  private pushCbs = new Set<(d: PushData) => void>();
  readonly badges: number[] = [];
  private readonly initial: PushToken | null;
  // Node's `node --test` strips types in strip-only mode, which rejects TS parameter properties — so the
  // field is declared and assigned explicitly rather than via a `constructor(private readonly …)` shorthand.
  constructor(initial: PushToken | null) { this.initial = initial; }
  getToken(): Promise<PushToken | null> { return Promise.resolve(this.initial); }
  onToken(cb: (t: PushToken | null) => void): () => void { this.tokenCbs.add(cb); return () => { this.tokenCbs.delete(cb); }; }
  onPush(cb: (d: PushData) => void): () => void { this.pushCbs.add(cb); return () => { this.pushCbs.delete(cb); }; }
  setBadge(n: number): void { this.badges.push(n); }
  emitToken(t: PushToken | null): void { for (const cb of [...this.tokenCbs]) cb(t); }
}

test("registerPush: subscribes the initial FCM token with the server", async () => {
  const srv = await startLiveServer();
  try {
    const api = client(srv.base);
    await register(api, "Alice");
    const bridge = new FakeBridge({ platform: "fcm", endpoint: "fcm-tok-1" });
    const reg = registerPush(api, bridge);

    await waitFor(() => reg.endpoint() === "fcm-tok-1");
    // The row must exist server-side: a direct unsubscribe removes exactly one.
    const un = await api.post<{ removed: number }>("/v1/push/unsubscribe", { endpoint: "fcm-tok-1" });
    assert.equal(un.removed, 1, "the initial token was registered");
    await reg.stop();
  } finally {
    await srv.teardown();
  }
});

test("registerPush: a refreshed token supersedes the stale endpoint", async () => {
  const srv = await startLiveServer();
  try {
    const api = client(srv.base);
    await register(api, "Bob");
    const bridge = new FakeBridge({ platform: "fcm", endpoint: "tok-old" });
    const reg = registerPush(api, bridge);
    await waitFor(() => reg.endpoint() === "tok-old");

    bridge.emitToken({ platform: "fcm", endpoint: "tok-new" });
    await waitFor(() => reg.endpoint() === "tok-new");

    // The old endpoint must have been retired by the registrar; the new one is live.
    const oldGone = await api.post<{ removed: number }>("/v1/push/unsubscribe", { endpoint: "tok-old" });
    assert.equal(oldGone.removed, 0, "stale endpoint was already unsubscribed on refresh");
    const newLive = await api.post<{ removed: number }>("/v1/push/unsubscribe", { endpoint: "tok-new" });
    assert.equal(newLive.removed, 1, "refreshed endpoint is the live subscription");
    await reg.stop();
  } finally {
    await srv.teardown();
  }
});

test("registerPush: a WS-only bridge (null token) registers nothing", async () => {
  const srv = await startLiveServer();
  try {
    const api = client(srv.base);
    await register(api, "Carol");
    const bridge = new FakeBridge(null);
    const reg = registerPush(api, bridge);

    // Give the async getToken() a few ticks; nothing should be registered.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(reg.endpoint(), null, "no endpoint registered in WS-only mode");
    await reg.stop();
  } finally {
    await srv.teardown();
  }
});

test("registerPush: stop() unsubscribes the live endpoint", async () => {
  const srv = await startLiveServer();
  try {
    const api = client(srv.base);
    await register(api, "Dan");
    const bridge = new FakeBridge({ platform: "unifiedpush", endpoint: "https://ntfy.example/up-XYZ" });
    const reg = registerPush(api, bridge);
    await waitFor(() => reg.endpoint() === "https://ntfy.example/up-XYZ");

    await reg.stop();
    assert.equal(reg.endpoint(), null, "endpoint cleared after stop");
    // stop() already unsubscribed it, so a second unsubscribe removes nothing.
    const un = await api.post<{ removed: number }>("/v1/push/unsubscribe", { endpoint: "https://ntfy.example/up-XYZ" });
    assert.equal(un.removed, 0, "stop() already unsubscribed the device");
  } finally {
    await srv.teardown();
  }
});
