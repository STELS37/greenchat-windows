// T-529 — transactional web glue: no policy/durable-outbox split-brain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebCachePolicyPort, type WebCachePolicyBackend } from "../../web/src/cache_policy.ts";
import type { ChatCacheMode } from "../../core/src/retention.ts";

function backend(initial: ChatCacheMode, calls: string[], failMode?: ChatCacheMode): WebCachePolicyBackend {
  let mode = initial;
  return {
    globalMode: () => "forever",
    setGlobal: async (next) => { calls.push(`global:${next}`); },
    chatMode: () => mode,
    setChat: async (_chatId, next) => {
      calls.push(`policy:${next}`);
      if (next === failMode) throw new Error("policy failed");
      mode = next;
    },
    shouldPersistChat: () => mode !== "cloud_only",
    recordMedia: async () => {},
    subscribe: () => () => {},
  };
}

test("T-529 entering cloud-only removes durable outbox before committing encrypted policy", async () => {
  const calls: string[] = [];
  const policy = backend("inherit", calls);
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (_chatId, persist) => { calls.push(`outbox:${String(persist)}`); },
  });

  await port.setChat(7, "cloud_only");
  assert.deepEqual(calls, ["outbox:false", "policy:cloud_only"]);
  assert.equal(port.getChat(7), "cloud_only");
});

test("T-529 leaving cloud-only durably protects the pending queue before policy opt-out commits", async () => {
  const calls: string[] = [];
  const policy = backend("cloud_only", calls);
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (_chatId, persist) => { calls.push(`outbox:${String(persist)}`); },
  });

  await port.setChat(7, "inherit");
  assert.deepEqual(calls, ["outbox:true", "policy:inherit"]);
  assert.equal(port.getChat(7), "inherit");
});

test("T-529 policy failure restores the previous outbox persistence plane", async () => {
  const calls: string[] = [];
  const policy = backend("inherit", calls, "cloud_only");
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (_chatId, persist) => { calls.push(`outbox:${String(persist)}`); },
  });

  await assert.rejects(() => port.setChat(8, "cloud_only"), /policy failed/);
  assert.deepEqual(calls, ["outbox:false", "policy:cloud_only", "outbox:true"]);
  assert.equal(port.getChat(8), "inherit");
});

test("T-529 outbox migration failure never commits the new policy and attempts rollback", async () => {
  const calls: string[] = [];
  const policy = backend("inherit", calls);
  let first = true;
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (_chatId, persist) => {
      calls.push(`outbox:${String(persist)}`);
      if (first) {
        first = false;
        throw new Error("outbox failed");
      }
    },
  });

  await assert.rejects(() => port.setChat(9, "cloud_only"), /outbox failed/);
  assert.deepEqual(calls, ["outbox:false", "outbox:true"]);
  assert.equal(port.getChat(9), "inherit");
});

test("T-529 finite retention changes do not churn outbox persistence", async () => {
  const calls: string[] = [];
  const policy = backend("7d", calls);
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async () => { calls.push("outbox"); },
  });
  await port.setChat(10, "24h");
  assert.deepEqual(calls, ["policy:24h"]);
});


function deferredVoid(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("T-529 concurrent changes for one chat are serialized so the latest intent wins", async () => {
  const calls: string[] = [];
  const firstOutbox = deferredVoid();
  const policy = backend("inherit", calls);
  let first = true;
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (_chatId, persist) => {
      calls.push(`outbox:${String(persist)}`);
      if (first) { first = false; await firstOutbox.promise; }
    },
  });

  const enterCloudOnly = port.setChat(7, "cloud_only");
  const returnToInherited = port.setChat(7, "inherit");
  await microtasks();

  assert.deepEqual(calls, ["outbox:false"], "the second transition must not observe a half-migrated first transition");

  firstOutbox.resolve();
  await Promise.all([enterCloudOnly, returnToInherited]);
  assert.deepEqual(calls, ["outbox:false", "policy:cloud_only", "outbox:true", "policy:inherit"]);
  assert.equal(port.getChat(7), "inherit", "the later user choice remains authoritative");
});

test("T-529 a failed transition releases the per-chat queue for the next choice", async () => {
  const calls: string[] = [];
  const firstOutbox = deferredVoid();
  const policy = backend("inherit", calls);
  let first = true;
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (_chatId, persist) => {
      calls.push(`outbox:${String(persist)}`);
      if (first) { first = false; await firstOutbox.promise; throw new Error("outbox failed"); }
    },
  });

  const failed = port.setChat(8, "cloud_only");
  const next = port.setChat(8, "24h");
  await microtasks();
  assert.deepEqual(calls, ["outbox:false"]);

  firstOutbox.resolve();
  await assert.rejects(failed, /outbox failed/);
  await next;
  assert.equal(port.getChat(8), "24h");
  assert.deepEqual(calls, ["outbox:false", "outbox:true", "policy:24h"]);
});

test("T-529 transitions for different chats remain independent", async () => {
  const calls: string[] = [];
  const blocked = deferredVoid();
  const modes = new Map<number, ChatCacheMode>([[1, "inherit"], [2, "inherit"]]);
  const policy: WebCachePolicyBackend = {
    globalMode: () => "forever",
    setGlobal: async () => {},
    chatMode: (chatId) => modes.get(chatId) ?? "inherit",
    setChat: async (chatId, mode) => { calls.push(`policy:${chatId}:${mode}`); modes.set(chatId, mode); },
    shouldPersistChat: (chatId) => (modes.get(chatId) ?? "inherit") !== "cloud_only",
    recordMedia: async () => {},
    subscribe: () => () => {},
  };
  const port = createWebCachePolicyPort(policy, {
    applyPersistencePolicy: async (chatId, persist) => {
      calls.push(`outbox:${String(chatId)}:${String(persist)}`);
      if (chatId === 1) await blocked.promise;
    },
  });

  const firstChat = port.setChat(1, "cloud_only");
  const secondChat = port.setChat(2, "cloud_only");
  await microtasks();

  assert.deepEqual(calls, ["outbox:1:false", "outbox:2:false", "policy:2:cloud_only"]);
  blocked.resolve();
  await Promise.all([firstChat, secondChat]);
  assert.equal(port.getChat(1), "cloud_only");
  assert.equal(port.getChat(2), "cloud_only");
});
