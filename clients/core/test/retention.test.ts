// T-529 / DS-11 — local cache retention and cloud-only policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.ts";
import type { Collection, StoreEntry, StoreKey } from "../src/store.ts";
import { CacheSync } from "../src/cache.ts";
import {
  LocalCachePolicy,
  normalizePolicySnapshot,
  type CacheRetentionMode,
} from "../src/retention.ts";
import type { SyncEvent } from "../src/types.ts";

const DAY = 24 * 60 * 60;

function message(id: number, chatId: number, createdAt: number, fileId?: number): Record<string, unknown> {
  return {
    id,
    chat_id: chatId,
    created_at: createdAt,
    text: `m-${id}`,
    ...(fileId ? { file: { id: fileId, name: `f-${fileId}`, mime: "image/png", size: 10 } } : {}),
  };
}

test("T-529 policy normalizes corrupt input and fails closed until encrypted meta loads", async () => {
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => 1_000_000 });

  assert.equal(policy.isLoaded(), false);
  assert.equal(policy.shouldPersistChat(7), false, "pre-load policy cannot permit a disk write");
  assert.ok((policy.cutoffSec(7) ?? 0) > 1_000_000);

  await store.put("meta", "local_cache_policy_v1", {
    id: "local_cache_policy_v1",
    value: {
      magic: "wrong",
      version: 99,
      global: "7d",
      chats: { "7": "cloud_only", "bad": "24h", "8": "invalid", "9": "inherit" },
    },
  });
  await policy.load();

  assert.equal(policy.globalMode(), "7d");
  assert.equal(policy.chatMode(7), "cloud_only");
  assert.equal(policy.chatMode(8), "inherit");
  assert.equal(policy.chatMode(9), "inherit");
  assert.equal(policy.shouldPersistChat(7), false);
  assert.equal(policy.shouldPersistChat(8), true);

  assert.deepEqual(normalizePolicySnapshot({ global: "nope", chats: null }), {
    magic: "gc-local-cache-policy",
    version: 1,
    global: "forever",
    chats: {},

    media: {},
  });
});

test("T-529 24h pruning removes expired rows/media and repairs a stale chat preview atomically", async () => {
  const now = 2_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();

  const old = message(1, 11, now - 2 * DAY, 101);
  const fresh = message(2, 11, now - 60, 102);
  await store.batch([
    { op: "put", collection: "messages", key: 1, value: old },
    { op: "put", collection: "messages", key: 2, value: fresh },
    {
      op: "put",
      collection: "chats",
      key: 11,
      value: { id: 11, updated_at: now - 2 * DAY, last_message_id: 1, last_message: old, draft: "old draft" },
    },
    { op: "put", collection: "files", key: 101, value: { id: 101 } },
    { op: "put", collection: "media", key: 101, value: { id: 101, bytes: new Uint8Array([1]), size: 1, at: 1, mime: "x" } },
    { op: "put", collection: "files", key: 102, value: { id: 102 } },
    { op: "put", collection: "media", key: 102, value: { id: 102, bytes: new Uint8Array([2]), size: 1, at: 2, mime: "x" } },
  ]);

  await policy.setGlobal("24h");

  assert.equal(await store.get("messages", 1), undefined);
  assert.ok(await store.get("messages", 2));
  assert.equal(await store.get("files", 101), undefined);
  assert.equal(await store.get("media", 101), undefined);
  assert.ok(await store.get("files", 102));
  assert.ok(await store.get("media", 102));

  const chat = await store.get<Record<string, unknown>>("chats", 11);
  assert.equal(chat?.last_message_id, 2);
  assert.equal((chat?.last_message as { id?: number } | undefined)?.id, 2);
  assert.equal(chat?.draft, null, "expired draft is not retained when the preview is repaired");
});

test("T-529 cloud-only removes this chat's local history and media but never deletes its pending outbox", async () => {
  const now = 3_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();

  const row = message(10, 77, now, 555);
  await store.batch([
    { op: "put", collection: "messages", key: 10, value: row },
    { op: "put", collection: "chats", key: 77, value: { id: 77, updated_at: now, last_message_id: 10, last_message: row } },
    { op: "put", collection: "files", key: 555, value: { id: 555 } },
    { op: "put", collection: "media", key: 555, value: { id: 555, bytes: new Uint8Array([9]), size: 1, at: 1, mime: "x" } },
    { op: "put", collection: "outbox", key: "pending-77", value: { id: "pending-77", chat_id: 77, status: "queued" } },
  ]);

  await policy.setChat(77, "cloud_only");

  assert.equal(await store.get("messages", 10), undefined);
  assert.equal(await store.get("chats", 77), undefined);
  assert.equal(await store.get("files", 555), undefined);
  assert.equal(await store.get("media", 555), undefined);
  assert.ok(await store.get("outbox", "pending-77"), "policy pruning never discards an unsent operation");
  assert.equal(policy.shouldPersistChat(77), false);

  const stored = await store.get<{ value?: { chats?: Record<string, string> } }>("meta", "local_cache_policy_v1");
  assert.equal(stored?.value?.chats?.["77"], "cloud_only");
});

test("T-529 CacheSync obeys cloud-only and finite retention while legacy no-policy mode stays unchanged", async () => {
  const now = 4_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();
  await policy.setGlobal("24h");
  await policy.setChat(2, "cloud_only");
  const cache = new CacheSync({ store, policy, nowSec: () => now });

  const event = (id: number, chatId: number, createdAt: number): SyncEvent => ({
    seq: id,
    type: "message.new",
    payload: { message: message(id, chatId, createdAt) },
  } as SyncEvent);

  await cache.apply(event(1, 1, now - 2 * DAY));
  await cache.apply(event(2, 1, now));
  await cache.apply(event(3, 2, now));
  await cache.settled();

  assert.equal(await store.get("messages", 1), undefined, "expired event is never written");
  assert.ok(await store.get("messages", 2), "fresh retained event is written");
  assert.equal(await store.get("messages", 3), undefined, "cloud-only event is never written");
  assert.equal(await store.get("chats", 2), undefined);
  assert.deepEqual((await cache.cachedMessages(1)).map((m) => m.id), [2]);
  assert.deepEqual(await cache.cachedMessages(2), []);

  const legacyStore = new MemoryStore();
  const legacy = new CacheSync({ store: legacyStore, nowSec: () => now });
  await legacy.apply(event(9, 9, now - 100 * DAY));
  await legacy.settled();
  assert.ok(await legacyStore.get("messages", 9), "omitting policy preserves the pre-T-529 contract");
});

test("T-529 per-chat override wins over global retention and inherit restores the global value", async () => {
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => 5_000_000 });
  await policy.load();
  await policy.setGlobal("7d");
  await policy.setChat(5, "forever");
  assert.equal(policy.effectiveMode(5), "forever");
  await policy.setChat(5, "inherit");
  assert.equal(policy.effectiveMode(5), "7d");
  for (const mode of ["forever", "30d", "7d", "24h"] satisfies CacheRetentionMode[]) {
    await policy.setGlobal(mode);
    assert.equal(policy.globalMode(), mode);
  }
});


test("T-529 policy notifies only encrypted load/reset, not ordinary setters that would remount Settings", async () => {
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => 6_000_000 });
  let notifications = 0;
  const stop = policy.subscribe(() => { notifications += 1; });

  await policy.load();
  assert.equal(notifications, 1, "COLD policy hydration rerenders consumers once");
  await policy.setGlobal("24h");
  await policy.setChat(42, "cloud_only");
  assert.equal(notifications, 1, "ordinary selects keep their current route/tab mounted");
  policy.resetMemory();
  assert.equal(notifications, 2, "account switch clears visible user-specific policy");
  stop();
  await policy.load();
  assert.equal(notifications, 2, "unsubscribe prevents stale screen callbacks");
});


class DeferredFirstPolicyReadStore extends MemoryStore {
  private releaseFirstRead!: () => void;
  private markFirstReadStarted!: () => void;
  private firstPolicyRead = true;
  readonly firstReadStarted = new Promise<void>((resolve) => { this.markFirstReadStarted = resolve; });
  private readonly firstReadGate = new Promise<void>((resolve) => { this.releaseFirstRead = resolve; });

  release(): void {
    this.releaseFirstRead();
  }

  override async get<T = unknown>(collection: Collection, key: StoreKey): Promise<T | undefined> {
    const captured = await super.get<T>(collection, key);
    if (collection === "meta" && key === "local_cache_policy_v1" && this.firstPolicyRead) {
      this.firstPolicyRead = false;
      this.markFirstReadStarted();
      await this.firstReadGate;
    }
    return captured;
  }
}

class FailingPruneStore extends MemoryStore {
  failMessagesRead = true;

  override entries<T = unknown>(collection: Collection): Promise<Array<StoreEntry<T>>> {
    if (this.failMessagesRead && collection === "messages") {
      return Promise.reject(new Error("simulated encrypted-store read failure"));
    }
    return super.entries<T>(collection);
  }
}

test("T-529 a stale policy load cannot overwrite the next account after reset", async () => {
  const store = new DeferredFirstPolicyReadStore();
  await store.put("meta", "local_cache_policy_v1", {
    id: "local_cache_policy_v1",
    value: { magic: "gc-local-cache-policy", version: 1, global: "24h", chats: {}, media: {} },
  });
  const policy = new LocalCachePolicy({ store, nowSec: () => 6_500_000 });

  const previousAccountLoad = policy.load();
  await store.firstReadStarted;
  policy.resetMemory();
  await store.clear("meta");
  await policy.load();
  assert.equal(policy.globalMode(), "forever", "the new account loaded its own default policy");

  store.release();
  await previousAccountLoad;
  assert.equal(policy.globalMode(), "forever", "late completion from the old account is ignored");
  assert.equal(policy.isLoaded(), true);
});

test("T-529 a prune/read failure keeps policy fail-closed and allows a clean retry", async () => {
  const store = new FailingPruneStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => 6_600_000 });

  await assert.rejects(policy.load(), /simulated encrypted-store read failure/);
  assert.equal(policy.isLoaded(), false, "failed hydration must not expose a half-loaded policy");
  assert.equal(policy.shouldPersistChat(1), false, "failed hydration stays fail-closed");

  store.failMessagesRead = false;
  await policy.load();
  assert.equal(policy.isLoaded(), true, "a later healthy store read can recover");
  assert.equal(policy.shouldPersistChat(1), true);
});

class DeferredPolicyPutStore extends MemoryStore {
  blockNextPolicyPut = false;
  private releasePut!: () => void;
  private markPutStarted!: () => void;
  readonly putStarted = new Promise<void>((resolve) => { this.markPutStarted = resolve; });
  private readonly putGate = new Promise<void>((resolve) => { this.releasePut = resolve; });

  release(): void {
    this.releasePut();
  }

  override async put(collection: Collection, key: StoreKey, value: unknown): Promise<void> {
    if (this.blockNextPolicyPut && collection === "meta" && key === "local_cache_policy_v1") {
      this.blockNextPolicyPut = false;
      this.markPutStarted();
      await this.putGate;
    }
    await super.put(collection, key, value);
  }
}

class DeferredPolicyBatchStore extends MemoryStore {
  blockNextBatch = false;
  private releaseBatch!: () => void;
  private markBatchStarted!: () => void;
  readonly batchStarted = new Promise<void>((resolve) => { this.markBatchStarted = resolve; });
  private readonly batchGate = new Promise<void>((resolve) => { this.releaseBatch = resolve; });

  release(): void {
    this.releaseBatch();
  }

  override async batch(ops: import("../src/store.ts").WriteOp[]): Promise<void> {
    if (this.blockNextBatch) {
      this.blockNextBatch = false;
      this.markBatchStarted();
      await this.batchGate;
    }
    await super.batch(ops);
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("T-529 reset drains an in-flight policy write before the next account can load", async () => {
  const store = new DeferredPolicyPutStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => 6_700_000 });
  await policy.load();

  store.blockNextPolicyPut = true;
  const staleWrite = policy.setGlobal("24h");
  await store.putStarted;

  policy.resetMemory();
  await store.clear("meta"); // the session wipe completed while the old IndexedDB put was still pending
  let nextLoadSettled = false;
  const nextLoad = policy.load().then(() => { nextLoadSettled = true; });
  await nextTurn();
  assert.equal(nextLoadSettled, false, "new-account hydration waits until stale writes are drained");

  store.release();
  await staleWrite;
  await nextLoad;

  assert.equal(policy.globalMode(), "forever");
  assert.equal(
    await store.get("meta", "local_cache_policy_v1"),
    undefined,
    "the late old-account put is erased after it completes",
  );
});

test("T-529 reset drains an in-flight prune batch before the next account data plane starts", async () => {
  const now = 6_800_000;
  const store = new DeferredPolicyBatchStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();
  await store.batch([
    { op: "put", collection: "messages", key: 1, value: message(1, 1, now) },
    { op: "put", collection: "chats", key: 1, value: { id: 1, last_message_id: 1, updated_at: now } },
  ]);

  store.blockNextBatch = true;
  const stalePrune = policy.setChat(1, "cloud_only");
  await store.batchStarted;

  policy.resetMemory();
  await Promise.all([
    store.clear("meta"),
    store.clear("messages"),
    store.clear("chats"),
    store.clear("files"),
    store.clear("media"),
  ]);
  let nextLoadSettled = false;
  const nextLoad = policy.load().then(() => { nextLoadSettled = true; });
  await nextTurn();
  assert.equal(nextLoadSettled, false, "sync for the next account cannot race a stale prune commit");

  store.release();
  await stalePrune;
  await nextLoad;

  await store.batch([
    { op: "put", collection: "messages", key: 1, value: message(1, 1, now + 1) },
    { op: "put", collection: "chats", key: 1, value: { id: 1, last_message_id: 1, updated_at: now + 1 } },
  ]);
  assert.ok(await store.get("messages", 1), "new-account rows survive after the reset barrier opens");
  assert.ok(await store.get("chats", 1));
});

test("T-529 finite retention keeps an old chat whose recent activity is inside the window", async () => {
  const now = 20_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();
  await store.put("chats", 44, {
    id: 44,
    created_at: now - 90 * DAY,
    updated_at: now - 60,
    draft: "recent draft",
  });

  await policy.setGlobal("24h");

  const chat = await store.get<Record<string, unknown>>("chats", 44);
  assert.ok(chat, "chat activity, not chat creation, controls cache retention");
  assert.equal(chat?.draft, "recent draft");
});

test("T-529 encrypted media ownership keeps a shared blob until every retaining chat drops it", async () => {
  const now = 7_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();
  await store.put("media", 700, { id: 700, at: now * 1000, size: 4, bytes: new Uint8Array(4), mime: "x" });
  await policy.recordMedia(1, 700);
  await policy.recordMedia(2, 700);

  await policy.setChat(1, "cloud_only");
  assert.ok(await store.get("media", 700), "second chat still owns the shared cached blob");
  let saved = await store.get<{ value?: { media?: Record<string, number[]> } }>("meta", "local_cache_policy_v1");
  assert.deepEqual(saved?.value?.media?.["700"], [2]);

  await policy.setChat(2, "cloud_only");
  assert.equal(await store.get("media", 700), undefined);
  saved = await store.get<{ value?: { media?: Record<string, number[]> } }>("meta", "local_cache_policy_v1");
  assert.equal(saved?.value?.media?.["700"], undefined);
});

test("T-529 cloud-only flushes legacy media with unknown ownership rather than risking residue", async () => {
  const now = 8_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();
  await store.put("media", 701, { id: 701, at: now * 1000, size: 1, bytes: new Uint8Array([1]), mime: "x" });

  await policy.setChat(9, "cloud_only");
  assert.equal(await store.get("media", 701), undefined, "unknown legacy blob is safer to re-download than retain");
});

test("T-529 finite global retention ages out standalone media by LRU timestamp", async () => {
  const now = 9_000_000;
  const store = new MemoryStore();
  const policy = new LocalCachePolicy({ store, nowSec: () => now });
  await policy.load();
  await store.put("media", 702, {
    id: 702,
    at: (now - 2 * DAY) * 1000,
    size: 1,
    bytes: new Uint8Array([2]),
    mime: "x",
  });

  await policy.setGlobal("24h");
  assert.equal(await store.get("media", 702), undefined);
});
