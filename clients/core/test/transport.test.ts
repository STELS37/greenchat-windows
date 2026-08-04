// T-402 — core SDK transport against a LIVE compiled server (register -> chat -> message -> event).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, waitFor } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { WsClient } from "../src/ws.ts";
import { SyncEngine } from "../src/sync.ts";
import { ApiError } from "../src/errors.ts";
import type { SyncEvent, SessionResult } from "../src/types.ts";

let uSeq = 0;
function uname(): string {
  return `u${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}

function client(base: string): ApiClient {
  return new ApiClient({ baseUrl: base, clientId: "node/0.1.0", tokens: emptyTokens() });
}

async function register(api: ApiClient, name = "User"): Promise<SessionResult & { user: { id: number } }> {
  const r = await api.post<SessionResult>("/v1/auth/register", {
    username: uname(),
    password: "password1",
    name,
    legal_accepted: true,
    age_confirmed: true,
  }, { idempotent: false });
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
  return r as SessionResult & { user: { id: number } };
}

test("ApiClient: register decodes the ok-envelope into result", async () => {
  const srv = await startLiveServer();
  try {
    const api = client(srv.base);
    const r = await register(api, "Alice");
    assert.equal(typeof r.access_token, "string");
    assert.equal(typeof r.refresh_token, "string");
    assert.ok(r.user && typeof r.user.id === "number");
  } finally {
    await srv.teardown();
  }
});

test("ApiClient: server error maps to ApiError with Appendix-D code + httpStatus", async () => {
  const srv = await startLiveServer();
  try {
    const api = client(srv.base);
    const username = uname();
    const body = { username, password: "password1", name: "Dup", legal_accepted: true, age_confirmed: true };
    const first = await api.post<SessionResult>("/v1/auth/register", body, { idempotent: false });
    assert.ok(first.access_token);
    await assert.rejects(
      () => api.post("/v1/auth/register", body, { idempotent: false }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, "must be ApiError");
        assert.equal(err.code, "USERNAME_TAKEN");
        assert.equal(err.httpStatus, 409);
        return true;
      },
    );
  } finally {
    await srv.teardown();
  }
});

test("SyncEngine over WS: A's message reaches B live as message.new (cursor advances)", async () => {
  const srv = await startLiveServer();
  const engines: SyncEngine[] = [];
  try {
    const apiA = client(srv.base);
    const apiB = client(srv.base);
    const a = await register(apiA, "Alice");
    const b = await register(apiB, "Bob");

    // A opens a dialog with B.
    const dialog = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: b.user.id }, { idempotent: false });
    assert.ok(typeof dialog.id === "number");

    // B goes live over WS.
    const received: SyncEvent[] = [];
    const engineB = new SyncEngine({
      api: apiB,
      baseUrl: srv.base,
      onEvent: (e) => received.push(e),
    });
    engines.push(engineB);
    engineB.start();
    await waitFor(() => engineB.getWsState() === "open");

    // A sends a message; B must receive message.new with the text.
    await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "m-1", text: "привет" });
    await waitFor(() => received.some((e) => e.type === "message.new"));

    const evt = received.find((e) => e.type === "message.new");
    assert.ok(evt, "message.new delivered");
    const payload = evt.payload as { message: { text: string; chat_id: number } };
    assert.equal(payload.message.text, "привет");
    assert.equal(payload.message.chat_id, dialog.id);
    assert.ok(engineB.getCursor() > 0, "cursor advanced past the delivered event");
    assert.ok((evt.seq ?? 0) > 0, "durable event carries a seq");

    // a mentions Alice's id is unused elsewhere — keep lint happy.
    assert.ok(a.user.id > 0);
  } finally {
    for (const e of engines) e.stop();
    await srv.teardown();
  }
});

test("WsClient: resume by seq replays messages missed while disconnected (no loss, no dup)", async () => {
  const srv = await startLiveServer();
  let ws: WsClient | null = null;
  try {
    const apiA = client(srv.base);
    const apiB = client(srv.base);
    await register(apiA, "Alice");
    const b = await register(apiB, "Bob");
    const dialog = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: b.user.id }, { idempotent: false });

    // B connects a raw WsClient (cold start: no since -> live from head).
    const seen: number[] = [];
    let lastSeq = 0;
    const mkWs = (since: number | undefined) =>
      new WsClient({
        baseUrl: srv.base,
        tokens: apiB.tokens,
        getSince: () => since,
        onEvent: (e) => {
          if (e.seq !== null) {
            seen.push(e.seq);
            lastSeq = Math.max(lastSeq, e.seq);
          }
        },
      });

    ws = mkWs(undefined);
    ws.start();
    await waitFor(() => ws!.getState() === "open");

    // First message while connected -> delivered live.
    await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "r-1", text: "one" });
    await waitFor(() => seen.length >= 1);
    const seqAfterFirst = lastSeq;

    // Disconnect B, then A sends a second message into the gap.
    ws.close();
    await waitFor(() => ws!.getState() === "closed");
    await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "r-2", text: "two" });

    // Reconnect with since=<lastSeq>: the server must replay exactly the missed event.
    ws = mkWs(seqAfterFirst);
    ws.start();
    await waitFor(() => seen.length >= 2);

    // No duplicates: every seq is unique and strictly increasing.
    const unique = new Set(seen);
    assert.equal(unique.size, seen.length, "no duplicate seqs across reconnect");
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], "seqs strictly increasing");
  } finally {
    if (ws) ws.close();
    await srv.teardown();
  }
});

test("ApiClient: single-flight refresh coalesces concurrent refreshes into one network call", async () => {
  const srv = await startLiveServer();
  try {
    let refreshCalls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/v1/auth/refresh")) refreshCalls++;
      return fetch(input, init);
    };
    const api = new ApiClient({
      baseUrl: srv.base,
      clientId: "node/0.1.0",
      tokens: emptyTokens(),
      fetchImpl: countingFetch,
    });
    await register(api, "Carol");
    const oldAccess = api.tokens.access;

    // Fire three refreshes at once; single-flight must collapse them to ONE POST /v1/auth/refresh.
    const [r1, r2, r3] = await Promise.all([api.refreshTokens(), api.refreshTokens(), api.refreshTokens()]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(r3, true);
    assert.equal(refreshCalls, 1, "exactly one refresh network call");
    assert.notEqual(api.tokens.access, oldAccess, "access token rotated");

    // The new access token actually works.
    const me = await api.get<{ id: number }>("/v1/users/me");
    assert.ok(me && typeof me.id === "number");
  } finally {
    await srv.teardown();
  }
});

test("long-poll: GET /v1/updates?since= returns durable events with a next_since cursor", async () => {
  const srv = await startLiveServer();
  try {
    const apiA = client(srv.base);
    const apiB = client(srv.base);
    await register(apiA, "Alice");
    const b = await register(apiB, "Bob");
    const dialog = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: b.user.id }, { idempotent: false });

    // A sends BEFORE B connects any realtime transport -> B must catch up via long-poll.
    await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "lp-1", text: "history" });

    const r = await apiB.get<{ events: { seq: number; type: string }[]; next_since: number; resync?: boolean }>(
      "/v1/updates?since=0&timeout=0",
    );
    assert.ok(Array.isArray(r.events));
    assert.ok(r.events.some((e) => e.type === "message.new"), "long-poll carried the message");
    assert.ok(r.next_since > 0, "next_since advanced");
    assert.notEqual(r.resync, true);
  } finally {
    await srv.teardown();
  }
});
