// T-403 — CacheSync cold start: "instant render from cache → delta by seq", against a LIVE server.
// A SyncEngine is wired to fold durable events into a ClientStore and persist the cursor; a second
// CacheSync over the same store proves warm-start renders with zero network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, waitFor, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { MemoryStore } from "../src/store.ts";
import { SyncEngine } from "../src/sync.ts";
import { CacheSync } from "../src/cache.ts";
import type { SessionResult, SyncEvent } from "../src/types.ts";

let srv: LiveServer;
before(async () => {
  srv = await startLiveServer();
});
after(async () => {
  await srv.teardown();
});

let uSeq = 0;
function uname(): string {
  return `u${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}
function client(): ApiClient {
  return new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
}
async function register(api: ApiClient, name = "User"): Promise<SessionResult & { user: { id: number } }> {
  const r = await api.post<SessionResult>(
    "/v1/auth/register",
    { username: uname(), password: "password1", name, legal_accepted: true, age_confirmed: true },
    { idempotent: false },
  );
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
  return r as SessionResult & { user: { id: number } };
}

test("CacheSync: cold start folds live deltas into the store, persists the cursor, and warm-renders instantly", async () => {
  const apiA = client();
  const apiB = client();
  await register(apiA, "Alice");
  const b = await register(apiB, "Bob");
  const chat = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: b.user.id }, { idempotent: false });

  // B: empty store, cold cache, a live SyncEngine bound to it (the exact wiring CacheSync documents).
  const store = new MemoryStore();
  const cache = new CacheSync({ store });
  const seen: SyncEvent[] = [];
  let lastCursor = 0;
  const engine = new SyncEngine({
    api: apiB,
    baseUrl: srv.base,
    onEvent: (e) => {
      seen.push(e);
      void cache.apply(e);
    },
    onCursor: (s) => {
      lastCursor = Math.max(lastCursor, s);
      void cache.setCursor(s);
    },
  });
  const countMsgNew = (): number => seen.filter((e) => e.type === "message.new").length;

  try {
    engine.setCursor(await cache.getCursor()); // explicit 0 — replay from the beginning of the retained window
    engine.start();
    await waitFor(() => engine.getWsState() === "open");

    // A sends the first message → it must fold into B's cache.
    await apiA.post(`/v1/chats/${chat.id}/messages`, { client_msg_id: "c-1", text: "первое" });
    await waitFor(() => countMsgNew() >= 1);
    await cache.settled();
    await cache.setCursor(lastCursor); // flush the fire-and-forget cursor write deterministically

    const msgs1 = await cache.cachedMessages(chat.id);
    assert.equal(msgs1.length, 1);
    assert.equal((msgs1[0] as { text?: string }).text, "первое");
    const chats1 = await cache.cachedChats();
    assert.ok(
      chats1.some((c) => c.id === chat.id && typeof c.last_message_id === "number"),
      "chat row carries a last-message pointer",
    );
    const cursor1 = await cache.getCursor();
    assert.ok(cursor1 > 0, "cursor persisted after the first delta");

    // Warm restart: a NEW CacheSync over the SAME store renders instantly, with NO network.
    const warm = new CacheSync({ store });
    assert.equal((await warm.cachedMessages(chat.id)).length, 1, "instant render from cache");
    assert.ok((await warm.getCursor()) >= cursor1, "warm start resumes from the persisted cursor");

    // Delta by seq: a second message advances the live cache and moves the cursor forward.
    const before = await cache.getCursor();
    await apiA.post(`/v1/chats/${chat.id}/messages`, { client_msg_id: "c-2", text: "второе" });
    await waitFor(() => countMsgNew() >= 2);
    await cache.settled();
    await cache.setCursor(lastCursor);
    assert.equal((await cache.cachedMessages(chat.id)).length, 2);
    assert.ok((await cache.getCursor()) > before, "cursor advanced past the first delta");
  } finally {
    engine.stop();
  }
});
