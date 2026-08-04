// QA: cursor durability must never outrun the cache mutation it acknowledges.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { ApiClient } from "../src/api.ts";
import { CacheSync } from "../src/cache.ts";
import { SyncEngine } from "../src/sync.ts";
import {
  MemoryStore,
  type Collection,
  type StoreKey,
  type WriteOp,
} from "../src/store.ts";
import type { SyncEvent } from "../src/types.ts";

const CURSOR_KEY = "last_seq";

function durableMessage(seq: number): SyncEvent {
  return {
    seq,
    type: "message.new",
    payload: {
      message: {
        id: seq,
        chat_id: 1,
        created_at: 1_800_000_000 + seq,
        text: `message-${seq}`,
      },
    },
  } as SyncEvent;
}

async function nextTurns(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class DeferredLowCursorPutStore extends MemoryStore {
  private releaseLow!: () => void;
  private markLowStarted!: () => void;
  private blockLow = true;
  readonly lowStarted = new Promise<void>((resolve) => { this.markLowStarted = resolve; });
  private readonly lowGate = new Promise<void>((resolve) => { this.releaseLow = resolve; });

  release(): void {
    this.releaseLow();
  }

  override async put(collection: Collection, key: StoreKey, value: unknown): Promise<void> {
    const cursor = value as { value?: unknown };
    if (this.blockLow && collection === "meta" && key === CURSOR_KEY && cursor?.value === 10) {
      this.blockLow = false;
      this.markLowStarted();
      await this.lowGate;
    }
    await super.put(collection, key, value);
  }
}

class DeferredEventBatchStore extends MemoryStore {
  private releaseBatch!: () => void;
  private markBatchStarted!: () => void;
  private blockBatch = true;
  readonly batchStarted = new Promise<void>((resolve) => { this.markBatchStarted = resolve; });
  private readonly batchGate = new Promise<void>((resolve) => { this.releaseBatch = resolve; });

  release(): void {
    this.releaseBatch();
  }

  override async batch(ops: WriteOp[]): Promise<void> {
    if (this.blockBatch) {
      this.blockBatch = false;
      this.markBatchStarted();
      await this.batchGate;
    }
    await super.batch(ops);
  }
}

class FailingEventBatchStore extends MemoryStore {
  override batch(_ops: WriteOp[]): Promise<void> {
    return Promise.reject(new Error("simulated cache transaction failure"));
  }
}

test("CacheSync cursor writes remain monotonic when an older write completes last", async () => {
  const store = new DeferredLowCursorPutStore();
  const cache = new CacheSync({ store });

  const low = cache.setCursor(10);
  await store.lowStarted;
  const high = cache.setCursor(20);
  await nextTurns();
  store.release();
  await Promise.all([low, high]);

  assert.equal(await cache.getCursor(), 20, "a delayed older write must not roll the durable cursor back");
});

test("CacheSync does not persist a cursor until the corresponding event transaction has committed", async () => {
  const store = new DeferredEventBatchStore();
  const cache = new CacheSync({ store });

  const apply = cache.apply(durableMessage(7));
  await store.batchStarted;
  const cursor = cache.setCursor(7);
  await nextTurns();
  const beforeCommit = await store.get("meta", CURSOR_KEY);

  store.release();
  await Promise.all([apply, cursor]);

  assert.equal(beforeCommit, undefined, "crashing before the event commit must leave the durable cursor behind");
  assert.equal(await cache.getCursor(), 7);
  assert.ok(await store.get("messages", 7));
});

test("CacheSync leaves the durable cursor behind a failed event so restart can replay it", async () => {
  const store = new FailingEventBatchStore();
  const cache = new CacheSync({ store });

  await cache.apply(durableMessage(9));
  await cache.setCursor(9);

  assert.equal(await cache.getCursor(), 0, "a failed durable event must never be acknowledged on disk");
});

class SilentWebSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 0;
  constructor(_url: string) {}
  send(_data: string): void {}
  close(): void {}
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("SyncEngine announces a durable event before its cursor can be persisted", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (!(req.url ?? "").startsWith("/v1/updates")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    calls += 1;
    res.setHeader("content-type", "application/json");
    const result = calls === 1
      ? { events: [{ seq: 12, type: "message.new", payload: durableMessage(12).payload }], next_since: 12 }
      : { events: [], next_since: 12 };
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const order: string[] = [];
  const api = new ApiClient({
    baseUrl: base,
    clientId: "qa/cache-cursor",
    tokens: { access: "test", refresh: null, accessExpiresAt: null },
  });
  const engine = new SyncEngine({
    api,
    baseUrl: base,
    wsImpl: SilentWebSocket as unknown as typeof WebSocket,
    longPollTimeoutSec: 1,
    onEvent: () => { order.push("event"); },
    onCursor: () => { order.push("cursor"); },
  });

  try {
    engine.start();
    await waitFor(() => order.length >= 2);
    assert.deepEqual(order.slice(0, 2), ["event", "cursor"]);
  } finally {
    engine.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test("SyncEngine replaces a stopped session cursor when a different account is seeded", () => {
  const api = new ApiClient({
    baseUrl: "http://127.0.0.1:1",
    clientId: "qa/cache-cursor",
    tokens: { access: "test", refresh: null, accessExpiresAt: null },
  });
  const engine = new SyncEngine({
    api,
    baseUrl: "http://127.0.0.1:1",
    wsImpl: SilentWebSocket as unknown as typeof WebSocket,
    onEvent: () => undefined,
  });

  engine.setCursor(100);
  assert.equal(engine.getCursor(), 100);
  assert.equal(engine.socket.getLastSeq(), 100);

  // logout/wipe clears the store; the next account seeds zero into the same long-lived engine object.
  engine.setCursor(0);
  assert.equal(engine.getCursor(), 0, "the previous account cursor must not survive a new seed");
  assert.equal(engine.socket.getLastSeq(), 0, "the WebSocket resume state follows the exact seed");
});


test("CacheSync reset drains old-account writes and gates the next account", async () => {
  const store = new DeferredEventBatchStore();
  const cache = new CacheSync({ store });

  const oldApply = cache.apply(durableMessage(31));
  await store.batchStarted;
  const reset = cache.reset();
  // The session-level wipe can finish before the old IndexedDB transaction commits.
  await Promise.all([
    store.clear("messages"),
    store.clear("chats"),
    store.delete("meta", CURSOR_KEY),
  ]);

  let nextReadSettled = false;
  const nextRead = cache.getCursor().then((value) => {
    nextReadSettled = true;
    return value;
  });
  await nextTurns();
  assert.equal(nextReadSettled, false, "the next account waits for old writes and post-drain cleanup");

  store.release();
  await oldApply;
  await reset;
  assert.equal(await nextRead, 0);
  assert.equal(await store.get("messages", 31), undefined, "late old-account data is erased");
  assert.equal(await store.get("chats", 1), undefined);

  await cache.apply(durableMessage(32));
  await cache.setCursor(32);
  assert.ok(await store.get("messages", 32), "new-account data is accepted after the barrier");
  assert.equal(await cache.getCursor(), 32);
});

class FailOnceEventBatchStore extends MemoryStore {
  failNextBatch = true;

  override batch(ops: WriteOp[]): Promise<void> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      return Promise.reject(new Error("one cache transaction failed"));
    }
    return super.batch(ops);
  }
}

test("CacheSync reset clears the failed-event cursor barrier for a new account", async () => {
  const store = new FailOnceEventBatchStore();
  const cache = new CacheSync({ store });

  await cache.apply(durableMessage(40));
  await cache.setCursor(40);
  assert.equal(await cache.getCursor(), 0);

  await cache.reset();
  await cache.apply(durableMessage(41));
  await cache.setCursor(41);
  assert.equal(await cache.getCursor(), 41);
  assert.ok(await store.get("messages", 41));
});
