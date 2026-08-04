import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePersistedSession,
  webSessionStorage,
  type WebSessionStorageArea,
} from "../../web/src/session_storage.ts";

class FakeArea implements WebSessionStorageArea {
  readonly values = new Map<string, string>();
  removals = 0;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.removals += 1; this.values.delete(key); }
}

const valid = JSON.stringify({
  refresh: "refresh-token-1",
  user: { id: 7, username: "ann", name: "Ann" },
});

test("parsePersistedSession accepts only the server-issued session slice", () => {
  assert.deepEqual(parsePersistedSession(valid), {
    refresh: "refresh-token-1",
    user: { id: 7, username: "ann", name: "Ann" },
  });
  // Additive fields from a newer server are ignored rather than persisted into the UI snapshot.
  assert.deepEqual(parsePersistedSession(JSON.stringify({
    refresh: "refresh-token-2",
    user: { id: 8, username: "bob", name: "Bob", email: "private@example.test" },
    access_token: "must-not-persist",
  })), {
    refresh: "refresh-token-2",
    user: { id: 8, username: "bob", name: "Bob" },
  });
});

test("corrupt, scalar, oversized and structurally invalid sessions are rejected", () => {
  const cases: unknown[] = [
    "{",
    "null",
    "[]",
    '"string"',
    JSON.stringify({ refresh: "", user: { id: 1, username: "u", name: "U" } }),
    JSON.stringify({ refresh: "x".repeat(4097), user: { id: 1, username: "u", name: "U" } }),
    JSON.stringify({ refresh: "r", pendingRefresh: "short", user: { id: 1, username: "u", name: "U" } }),
    JSON.stringify({ refresh: "a".repeat(96), pendingRefresh: "a".repeat(96), user: { id: 1, username: "u", name: "U" } }),
    JSON.stringify({ refresh: "r", user: "not-an-object" }),
    JSON.stringify({ refresh: "r", user: { id: 0, username: "u", name: "U" } }),
    JSON.stringify({ refresh: "r", user: { id: Number.MAX_SAFE_INTEGER + 1, username: "u", name: "U" } }),
    JSON.stringify({ refresh: "r", user: { id: 1, username: "", name: "U" } }),
    JSON.stringify({ refresh: "r", user: { id: 1, username: 5, name: "U" } }),
    JSON.stringify({ refresh: "r", user: { id: 1, username: "u", name: 5 } }),
  ];
  for (const item of cases) {
    const raw = typeof item === "string" ? item : JSON.stringify(item);
    assert.equal(parsePersistedSession(raw), null, raw.slice(0, 80));
  }
});

test("webSessionStorage deletes corrupt data before Session.restore can observe it", () => {
  const area = new FakeArea();
  area.values.set("gc.session", JSON.stringify({
    refresh: "CORRUPT_OFFLINE_REFRESH",
    user: "not-an-auth-user",
  }));
  const storage = webSessionStorage("gc.session", area);
  assert.equal(storage.load(), null);
  assert.equal(area.values.has("gc.session"), false);
  assert.equal(area.removals, 1);

  // A second load is inert; corruption cannot repeatedly trigger recovery/network work.
  assert.equal(storage.load(), null);
  assert.equal(area.removals, 1);
});

test("webSessionStorage round-trips a valid session and clear remains idempotent", () => {
  const area = new FakeArea();
  const storage = webSessionStorage("custom.session", area);
  const value = { refresh: "refresh-token", user: { id: 11, username: "user11", name: "Eleven" } };
  storage.save(value);
  assert.deepEqual(storage.load(), value);
  storage.clear();
  storage.clear();
  assert.equal(storage.load(), null);
});


test("webSessionStorage preserves a durable in-progress refresh rotation", () => {
  const area = new FakeArea();
  const storage = webSessionStorage("rotation.session", area);
  const value = {
    refresh: "current-refresh",
    pendingRefresh: "a".repeat(96),
    user: { id: 12, username: "user12", name: "Twelve" },
  };
  storage.save(value);
  assert.deepEqual(storage.load(), value);
});


test("webSessionStorage.flush waits for a native secure-store durability hook", async () => {
  const runtime = globalThis as typeof globalThis & { __gcFlushSessionStorage?: () => Promise<void> };
  const previous = runtime.__gcFlushSessionStorage;
  let calls = 0;
  runtime.__gcFlushSessionStorage = async () => { calls++; };
  try {
    const storage = webSessionStorage("flush.session", new FakeArea());
    storage.save({ refresh: "r", user: { id: 13, username: "user13", name: "Thirteen" } });
    await storage.flush?.();
    assert.equal(calls, 1);
  } finally {
    if (previous) runtime.__gcFlushSessionStorage = previous;
    else delete runtime.__gcFlushSessionStorage;
  }
});
