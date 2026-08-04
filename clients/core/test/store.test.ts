// T-403 — ClientStore semantics (MemoryStore), plus IndexedDbStore's browser-only guard. Pure unit
// tests, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.ts";
import { IndexedDbStore } from "../src/indexeddb_store.ts";

type FakeDb = {
  onversionchange: ((event: IDBVersionChangeEvent) => unknown) | null;
  closeCalls: number;
  close(): void;
};

type FakeOpenRequest = {
  result: IDBDatabase;
  error: DOMException | null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => unknown) | null;
  onsuccess: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
};

function fakeIndexedDbFactory(invalidateFirst = false): {
  factory: IDBFactory;
  databases: FakeDb[];
  openCount: () => number;
} {
  const databases: FakeDb[] = [];
  let opens = 0;
  const factory = {
    open(): IDBOpenDBRequest {
      opens += 1;
      const invalidateImmediately = invalidateFirst && opens === 1;
      const db: FakeDb = {
        onversionchange: null,
        closeCalls: 0,
        close() {
          this.closeCalls += 1;
        },
      };
      databases.push(db);
      const request: FakeOpenRequest = {
        result: db as unknown as IDBDatabase,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        request.onsuccess?.(new Event("success"));
        if (invalidateImmediately) {
          db.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
        }
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return { factory, databases, openCount: () => opens };
}

test("MemoryStore: put/get round-trips and isolates by structured clone", async () => {
  const s = new MemoryStore();
  const msg = { id: 1, chat_id: 7, text: "hi", tags: ["a"] };
  await s.put("messages", 1, msg);

  const got = await s.get<{ id: number; text: string; tags: string[] }>("messages", 1);
  assert.equal(got?.text, "hi");

  // Mutating the returned object must NOT change what the store holds (clone-in, clone-out).
  got!.text = "TAMPERED";
  got!.tags.push("b");
  const again = await s.get<{ text: string; tags: string[] }>("messages", 1);
  assert.equal(again?.text, "hi");
  assert.deepEqual(again?.tags, ["a"]);

  // Mutating the ORIGINAL after put must not leak in either.
  msg.text = "also-tampered";
  const third = await s.get<{ text: string }>("messages", 1);
  assert.equal(third?.text, "hi");

  assert.equal(await s.get("messages", 999), undefined);
});

test("MemoryStore: scan orders by key and supports reverse + limit", async () => {
  const s = new MemoryStore();
  for (const id of [10, 2, 30, 1]) await s.put("messages", id, { id, chat_id: 1 });

  const asc = await s.scan<{ id: number }>("messages");
  assert.deepEqual(asc.map((m) => m.id), [1, 2, 10, 30]); // numeric, not lexicographic

  const desc = await s.scan<{ id: number }>("messages", { reverse: true });
  assert.deepEqual(desc.map((m) => m.id), [30, 10, 2, 1]);

  const top2 = await s.scan<{ id: number }>("messages", { reverse: true, limit: 2 });
  assert.deepEqual(top2.map((m) => m.id), [30, 10]);
});

test("MemoryStore: scan filters by a secondary index field", async () => {
  const s = new MemoryStore();
  await s.put("messages", 1, { id: 1, chat_id: 5 });
  await s.put("messages", 2, { id: 2, chat_id: 9 });
  await s.put("messages", 3, { id: 3, chat_id: 5 });

  const inChat5 = await s.scan<{ id: number }>("messages", { index: "chat_id", value: 5 });
  assert.deepEqual(inChat5.map((m) => m.id), [1, 3]);
});

test("MemoryStore: batch applies puts and deletes atomically", async () => {
  const s = new MemoryStore();
  await s.put("chats", 1, { id: 1, updated_at: 1 });
  await s.batch([
    { op: "put", collection: "messages", key: 100, value: { id: 100, chat_id: 1 } },
    { op: "put", collection: "chats", key: 1, value: { id: 1, updated_at: 2, last_message_id: 100 } },
    { op: "delete", collection: "chats", key: 42 },
  ]);
  assert.equal((await s.get<{ last_message_id: number }>("chats", 1))?.last_message_id, 100);
  assert.equal((await s.get<{ id: number }>("messages", 100))?.id, 100);
});

test("MemoryStore: entries preserves primary keys and clone isolation", async () => {
  const s = new MemoryStore();
  await s.put("meta", "last_seq", { value: 7 });
  await s.put("meta", "install_id", { value: "abc" });
  const rows = await s.entries<{ value: number | string }>("meta");
  assert.deepEqual(rows.map((row) => row.key), ["install_id", "last_seq"]);
  rows[0]!.value.value = "tampered";
  assert.deepEqual(await s.get("meta", "install_id"), { value: "abc" });
});

test("MemoryStore: batch rolls back every collection if a later clone fails", async () => {
  const s = new MemoryStore();
  await s.put("messages", 1, { id: 1, text: "before" });
  await s.put("chats", 1, { id: 1, updated_at: 1 });

  await assert.rejects(
    s.batch([
      { op: "put", collection: "messages", key: 1, value: { id: 1, text: "after" } },
      // structuredClone cannot clone functions; the entire staged batch must remain invisible.
      { op: "put", collection: "chats", key: 1, value: { id: 1, bad: () => 1 } },
    ]),
  );
  assert.deepEqual(await s.get("messages", 1), { id: 1, text: "before" });
  assert.deepEqual(await s.get("chats", 1), { id: 1, updated_at: 1 });
});

test("MemoryStore: delete and clear", async () => {
  const s = new MemoryStore();
  await s.put("contacts", 1, { id: 1 });
  await s.put("contacts", 2, { id: 2 });
  await s.delete("contacts", 1);
  assert.equal(await s.get("contacts", 1), undefined);
  assert.equal((await s.scan("contacts")).length, 1);
  await s.clear("contacts");
  assert.equal((await s.scan("contacts")).length, 0);
});

test("IndexedDbStore: open() rejects when no IndexedDB factory is available (Node)", async () => {
  const s = new IndexedDbStore();
  await assert.rejects(() => s.open(), /IndexedDB is unavailable/);
  // Constructing it must not throw or touch the (absent) global — browser-only, lazy on open().
  assert.ok(s instanceof IndexedDbStore);
});

test("IndexedDbStore: versionchange closes the stale connection and reopens on next use", async () => {
  const fake = fakeIndexedDbFactory();
  const store = new IndexedDbStore({ name: "gc-versionchange-test", factory: fake.factory });
  const [first, concurrent] = await Promise.all([store.open(), store.open()]);
  const firstFake = first as unknown as FakeDb;

  assert.equal(fake.openCount(), 1);
  assert.equal(concurrent, first);
  assert.equal(typeof firstFake.onversionchange, "function");
  firstFake.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
  assert.equal(firstFake.closeCalls, 1);

  const second = await store.open();
  assert.equal(fake.openCount(), 2);
  assert.notEqual(second, first);
});

test("IndexedDbStore: versionchange during open never returns the invalidated handle", async () => {
  const fake = fakeIndexedDbFactory(true);
  const store = new IndexedDbStore({ name: "gc-versionchange-race", factory: fake.factory });
  const opened = await store.open();

  assert.equal(fake.openCount(), 2);
  assert.equal(opened, fake.databases[1] as unknown as IDBDatabase);
  assert.notEqual(opened, fake.databases[0] as unknown as IDBDatabase);
});
