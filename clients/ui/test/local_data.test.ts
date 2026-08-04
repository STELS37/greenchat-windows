import { test } from "node:test";
import assert from "node:assert/strict";
import { EncryptedStore, MemoryStore } from "../../core/src/index.ts";
import { webLocalData, type OwnerStorage } from "../../web/src/local_data.ts";

class MemoryOwnerStorage implements OwnerStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("T-523 cache owner: external marker remains readable while EncryptedStore is LOCKED", async () => {
  const lower = new MemoryStore();
  const locked = new EncryptedStore({
    store: lower,
    key: () => null,
    allowPassthrough: false,
    warn: () => {},
  });
  const ownerStorage = new MemoryOwnerStorage();
  const local = webLocalData({ store: locked, ownerStorage, dbName: "gc-test-owner-locked" });

  await local.setOwner(42); // encrypted meta write fails, but the non-secret external marker succeeds
  assert.equal(await local.getOwner(), 42);
  assert.equal(ownerStorage.getItem("gc.cache_owner.v1"), "42");
});

test("T-523 cache owner: legacy meta marker is promoted before lock enable", async () => {
  const store = new MemoryStore();
  await store.put("meta", "owner_user_id", 77);
  const ownerStorage = new MemoryOwnerStorage();
  const local = webLocalData({ store, ownerStorage, dbName: "gc-test-owner-migrate" });

  assert.equal(await local.getOwner(), 77);
  assert.equal(ownerStorage.getItem("gc.cache_owner.v1"), "77");
});

test("T-523 cache owner: wipe clears both durable rows and the external marker", async () => {
  const store = new MemoryStore();
  await store.put("messages", 1, { text: "must disappear" });
  const ownerStorage = new MemoryOwnerStorage();
  const local = webLocalData({ store, ownerStorage, dbName: "gc-test-owner-wipe" });

  await local.setOwner(91);
  assert.equal(await local.getOwner(), 91);
  await local.wipe();

  assert.equal(ownerStorage.getItem("gc.cache_owner.v1"), null);
  assert.equal(await store.get("messages", 1), undefined);
});

test("T-523 cache owner: corrupt external value is discarded without trusting it", async () => {
  const store = new MemoryStore();
  const ownerStorage = new MemoryOwnerStorage();
  ownerStorage.setItem("gc.cache_owner.v1", "not-an-id");
  const local = webLocalData({ store, ownerStorage, dbName: "gc-test-owner-corrupt" });

  assert.equal(await local.getOwner(), null);
  assert.equal(ownerStorage.getItem("gc.cache_owner.v1"), null);
});


test("T-807 IndexedDB wipe: blocked waits for delete completion instead of reporting success", async () => {
  type FakeDeleteRequest = {
    onsuccess: ((event: Event) => unknown) | null;
    onerror: ((event: Event) => unknown) | null;
    onblocked: ((event: Event) => unknown) | null;
  };

  const request: FakeDeleteRequest = {
    onsuccess: null,
    onerror: null,
    onblocked: null,
  };
  let markRequested: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const factory = {
    deleteDatabase(): IDBOpenDBRequest {
      markRequested?.();
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });

  try {
    const local = webLocalData({ store: new MemoryStore(), dbName: "gc-test-blocked-delete" });
    let settled = false;
    const wiping = local.wipe().then(() => { settled = true; });

    await requested;
    request.onblocked?.(new Event("blocked"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "blocked is not a completed deletion");

    request.onsuccess?.(new Event("success"));
    await wiping;
    assert.equal(settled, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});


test("T-807 IndexedDB wipe: an uncooperative tab cannot block logout forever", async () => {
  const factory = {
    deleteDatabase(): IDBOpenDBRequest {
      return {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      } as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });

  try {
    const local = webLocalData({
      store: new MemoryStore(),
      dbName: "gc-test-delete-timeout",
      deleteDatabaseTimeoutMs: 5,
    });
    const outcome = await Promise.race([
      local.wipe().then(() => "resolved" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    assert.equal(outcome, "resolved");
  } finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
