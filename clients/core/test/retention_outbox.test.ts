// T-529 — cloud-only outbox lives in RAM, can migrate without loss, and clears on LOCK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api.ts";
import { MemoryStore } from "../src/store.ts";
import { Outbox, type OutboxChange, type OutboxItem } from "../src/outbox.ts";

function fakeApi(onCall?: () => void): ApiClient {
  return new ApiClient({
    baseUrl: "http://outbox.test",
    clientId: "node/0.1.0",
    tokens: { access: "a", refresh: "r", accessExpiresAt: null },
    maxRetries: 0,
    fetchImpl: (async () => {
      onCall?.();
      return new Response(JSON.stringify({ ok: true, result: { id: 42 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("T-529 outbox migrates durable ↔ RAM-only after a policy change without losing the pending item", async () => {
  const store = new MemoryStore();
  let persist = true;
  const ob = new Outbox({
    api: fakeApi(),
    store,
    undoMs: 60_000,
    persistForChat: () => persist,
  });

  const id = await ob.enqueueMessage(7, { client_msg_id: "policy-move", text: "pending" });
  assert.equal((await store.get<OutboxItem>("outbox", id))?.status, "queued");

  persist = false;
  await ob.applyPersistencePolicy(7);
  assert.equal(await store.get("outbox", id), undefined, "cloud-only leaves no durable queue row");
  assert.deepEqual((await ob.list(7)).map((item) => item.id), [id], "RAM queue preserves the operation");

  persist = true;
  await ob.applyPersistencePolicy(7);
  assert.equal((await store.get<OutboxItem>("outbox", id))?.id, id, "leaving cloud-only re-encrypts the row");
  assert.deepEqual((await ob.list(7)).map((item) => item.id), [id]);
  ob.pause();
});

test("T-529 cloud-only send is exactly-once and never appears in the durable store", async () => {
  const store = new MemoryStore();
  const changes: OutboxChange[] = [];
  let calls = 0;
  const ob = new Outbox({
    api: fakeApi(() => { calls += 1; }),
    store,
    undoMs: 0,
    persistForChat: (chatId) => chatId !== 9,
    onChange: (change) => changes.push(change),
  });

  const id = await ob.enqueueMessage(9, { client_msg_id: "cloud-send", text: "RAM only" });
  assert.equal(await store.get("outbox", id), undefined);
  await waitFor(() => changes.some((change) => change.removed === true && change.item.id === id));
  assert.equal(calls, 1);
  assert.equal(await store.get("outbox", id), undefined);
  assert.equal((await ob.list(9)).length, 0);
});

test("T-529 LOCK clears a cloud-only pending queue so plaintext cannot survive in RAM", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const ob = new Outbox({
    api: fakeApi(() => { calls += 1; }),
    store,
    undoMs: 80,
    persistForChat: () => false,
  });

  const id = await ob.enqueueMessage(3, { client_msg_id: "cloud-lock", text: "erase on lock" });
  assert.equal(await store.get("outbox", id), undefined);
  assert.equal((await ob.list(3)).length, 1);
  ob.pause();
  assert.equal((await ob.list(3)).length, 0, "volatile plaintext queue is zeroized by lifecycle lock");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls, 0, "cancelled undo timer cannot send after LOCK");
});
