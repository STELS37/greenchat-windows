// T-403 — Outbox: the offline send queue, against a LIVE compiled server (one boot for the file).
// Covers undo-cancel, immediate send + reconcile, FIFO-per-chat ordering, resume across a restart,
// and the failed→retry path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, waitFor, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { MemoryStore } from "../src/store.ts";
import { Outbox, type OutboxChange, type OutboxItem } from "../src/outbox.ts";
import type { SessionResult } from "../src/types.ts";

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
async function dialog(apiA: ApiClient, otherId: number): Promise<number> {
  const d = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: otherId }, { idempotent: false });
  return d.id;
}

test("Outbox: cancel() inside the undo window removes a queued item before it hits the wire", async () => {
  const apiA = client();
  const apiB = client();
  await register(apiA, "Alice");
  const b = await register(apiB, "Bob");
  const chat = await dialog(apiA, b.user.id);

  const store = new MemoryStore();
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api: apiA, store, undoMs: 1000, onChange: (c) => changes.push(c) });

  const id = await ob.enqueueMessage(chat, { text: "undo me" });
  assert.equal((await store.get<OutboxItem>("outbox", id))?.status, "queued"); // optimistic + persisted

  const cancelled = await ob.cancel(id);
  assert.equal(cancelled, true);
  assert.equal(await store.get("outbox", id), undefined); // gone from the store
  assert.equal((await ob.list()).length, 0);
  assert.ok(
    !changes.some((c) => c.item.status === "sending" || c.item.status === "sent"),
    "it never reached the wire",
  );
  assert.ok(changes.some((c) => c.removed === true), "emitted a removed change for the UI to reconcile");
});

test("Outbox: default policy sends messages immediately and keeps undo only for delete", async () => {
  const apiA = client();
  const apiB = client();
  await register(apiA, "Alice");
  const b = await register(apiB, "Bob");
  const chat = await dialog(apiA, b.user.id);

  const store = new MemoryStore();
  const changes: OutboxChange[] = [];
  // No undoMs override: this is the production policy used by the web/Android shell.
  const ob = new Outbox({ api: apiA, store, onChange: (c) => changes.push(c) });

  const id = await ob.enqueueMessage(chat, { text: "ping" });
  await waitFor(() => changes.some((c) => c.removed === true && c.item.id === id && c.item.status === "sent"));

  const sent = changes.find((c) => c.removed === true && c.item.id === id && c.item.status === "sent");
  assert.ok(sent, "default message send reconciles without a five-second hold");
  assert.ok(sent.item.result && typeof sent.item.result === "object", "carries the server's message");
  assert.equal(await store.get("outbox", id), undefined, "dropped from the queue once sent");

  // Destructive delete remains cancellable before it reaches the wire.
  const deleteId = await ob.enqueueDelete(chat, 999_999);
  assert.equal((await store.get<OutboxItem>("outbox", deleteId))?.status, "queued");
  assert.equal(await ob.cancel(deleteId), true, "delete retains its default undo window");
  assert.equal(await store.get("outbox", deleteId), undefined);
  assert.equal(
    changes.some((c) => c.item.id === deleteId && (c.item.status === "sending" || c.item.status === "failed")),
    false,
    "cancelled delete never touches the wire",
  );
});

test("Outbox: FIFO per chat — sends reconcile strictly in enqueue order", async () => {
  const apiA = client();
  const apiB = client();
  await register(apiA, "Alice");
  const b = await register(apiB, "Bob");
  const chat = await dialog(apiA, b.user.id);

  const store = new MemoryStore();
  const sentOrder: string[] = [];
  const ob = new Outbox({
    api: apiA,
    store,
    undoMs: 0,
    onChange: (c) => {
      if (c.removed === true && c.item.status === "sent") sentOrder.push(c.item.id);
    },
  });

  const id1 = await ob.enqueueMessage(chat, { client_msg_id: "fifo-1", text: "one" });
  const id2 = await ob.enqueueMessage(chat, { client_msg_id: "fifo-2", text: "two" });
  const id3 = await ob.enqueueMessage(chat, { client_msg_id: "fifo-3", text: "three" });

  await waitFor(() => sentOrder.length === 3, 8000);
  assert.deepEqual(sentOrder, [id1, id2, id3], "N+1 never overtakes N");
});

test("Outbox: resume() re-sends a queue persisted by a prior session (restart)", async () => {
  const apiA = client();
  const apiB = client();
  await register(apiA, "Alice");
  const b = await register(apiB, "Bob");
  const chat = await dialog(apiA, b.user.id);

  const store = new MemoryStore();
  // A queue row written by a previous app session that was killed before the undo elapsed.
  const persisted: OutboxItem = {
    id: "resumed-1",
    chat_id: chat,
    kind: "message",
    method: "POST",
    path: `/v1/chats/${chat}/messages`,
    body: { client_msg_id: "resumed-1", text: "survived a restart" },
    status: "queued",
    created_at: Date.now() - 60_000, // 60 s old → the 5 s undo window is long gone
    attempts: 0,
  };
  await store.put("outbox", persisted.id, persisted);

  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api: apiA, store, undoMs: 5000, onChange: (c) => changes.push(c) });
  await ob.resume(); // remaining undo = max(0, 5000 - 60000) = 0 → send now

  await waitFor(() => changes.some((c) => c.removed === true && c.item.status === "sent"));
  assert.equal(await store.get("outbox", "resumed-1"), undefined, "sent and cleared after resume");
});

test("Outbox: a rejected mutation parks as failed and is retryable", async () => {
  const apiA = client();
  await register(apiA, "Alice");

  const store = new MemoryStore();
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api: apiA, store, undoMs: 0, onChange: (c) => changes.push(c) });

  // Edit a message that does not exist → the server rejects → the item parks as "failed".
  const id = await ob.enqueueEdit(1, 999_999, "nope");
  await waitFor(() => changes.some((c) => c.item.id === id && c.item.status === "failed"));

  const failed = await store.get<OutboxItem>("outbox", id);
  assert.equal(failed?.status, "failed");
  assert.ok(failed?.error?.code, "carries an Appendix-D error code");
  assert.equal(failed?.attempts, 1);

  // retry() runs it again (fails again), incrementing attempts — proving the manual retry path.
  changes.length = 0;
  await ob.retry(id);
  await waitFor(() => changes.some((c) => c.item.id === id && c.item.status === "failed" && c.item.attempts >= 2));
  assert.ok((await store.get<OutboxItem>("outbox", id))!.attempts >= 2);
});

test("Outbox.pause cancels undo timers, rejects new plaintext work, and resume drains the encrypted row", async () => {
  let calls = 0;
  const api = new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: "a", refresh: "r", accessExpiresAt: null },
    maxRetries: 0,
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true, result: { id: calls } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const store = new MemoryStore();
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api, store, undoMs: 80, onChange: (change) => changes.push(change) });

  const id = await ob.enqueueMessage(7, { client_msg_id: "pause-undo", text: "encrypted pending" });
  ob.pause();
  assert.equal(ob.isPaused(), true);
  await assert.rejects(ob.enqueueMessage(7, { text: "must not enter RAM/disk while locked" }), /paused/);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls, 0, "the cancelled undo timer cannot touch the wire while LOCKED");
  assert.equal((await store.get<OutboxItem>("outbox", id))?.status, "queued");

  await ob.resume();
  await waitFor(() => changes.some((change) => change.removed === true && change.item.id === id));
  assert.equal(calls, 1);
  assert.equal(await store.get("outbox", id), undefined);
});

test("Outbox.pause aborts an active request, marks no fake failure, and safely replays after unlock", async () => {
  let calls = 0;
  let aborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls++;
    if (calls === 1) {
      markStarted();
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { id: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: "a", refresh: "r", accessExpiresAt: null },
    fetchImpl,
    maxRetries: 3,
    sleepImpl: async () => { throw new Error("caller abort must not enter retry backoff"); },
  });
  const store = new MemoryStore();
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api, store, undoMs: 0, onChange: (change) => changes.push(change) });

  const id = await ob.enqueueMessage(8, { client_msg_id: "pause-active", text: "ambiguous but idempotent" });
  await started;
  ob.pause();
  await waitFor(() => aborted);
  assert.equal(ob.isPaused(), true);
  assert.equal(calls, 1, "abort must not trigger hidden retries");
  assert.equal(
    changes.some((change) => change.item.id === id && change.item.status === "failed"),
    false,
    "a lifecycle pause is not shown as a delivery failure",
  );
  assert.equal((await store.get<OutboxItem>("outbox", id))?.status, "sending");

  await ob.resume();
  await waitFor(() => changes.some((change) => change.removed === true && change.item.id === id));
  assert.equal(calls, 2, "the ambiguous row is replayed once after unlock");
  assert.equal(await store.get("outbox", id), undefined);
});

test("Outbox: two tabs sharing one durable item perform only one wire request", async () => {
  let calls = 0;
  const api = new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: "a", refresh: "r", accessExpiresAt: null },
    maxRetries: 0,
    fetchImpl: (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response(JSON.stringify({ ok: true, result: { id: 99 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const store = new MemoryStore();
  const item: OutboxItem = {
    id: "shared-tab-item",
    chat_id: 9,
    kind: "message",
    method: "POST",
    path: "/v1/chats/9/messages",
    body: { client_msg_id: "shared-tab-item", text: "once" },
    status: "queued",
    created_at: Date.now() - 60_000,
    attempts: 0,
  };
  await store.put("outbox", item.id, item);

  let tail = Promise.resolve();
  const runExclusive = async (_key: string, task: () => Promise<void>): Promise<void> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await task(); } finally { release(); }
  };
  const tabA = new Outbox({ api, store, undoMs: 0, runExclusive });
  const tabB = new Outbox({ api, store, undoMs: 0, runExclusive });
  await Promise.all([tabA.resume(), tabB.resume()]);
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(await store.get("outbox", item.id), undefined, "the durable item must leave the queue");
  assert.equal(calls, 1, "one durable row must have only one active sender across tabs");
});
