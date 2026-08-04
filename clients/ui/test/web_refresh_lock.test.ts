import { test } from "node:test";
import assert from "node:assert/strict";
import { browserRefreshBarrier, browserRefreshCoordinator } from "../../web/src/refresh_lock.ts";
import type { TokenStore } from "../../core/src/api.ts";
import type { PersistedSession, SessionStorage } from "../src/screens/session.ts";

class MemorySessionStorage implements SessionStorage {
  value: PersistedSession | null;
  constructor(value: PersistedSession | null) { this.value = value; }
  load(): PersistedSession | null { return this.value ? structuredClone(this.value) : null; }
  save(value: PersistedSession): void { this.value = structuredClone(value); }
  clear(): void { this.value = null; }
}

class SerialLockManager {
  readonly names: string[] = [];
  private tail: Promise<void> = Promise.resolve();

  request<T>(name: string, _options: LockOptions, callback: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
    this.names.push(name);
    const run = this.tail.then(() => callback({ name, mode: "exclusive" } as Lock));
    this.tail = Promise.resolve(run).then(() => undefined, () => undefined);
    return Promise.resolve(run);
  }
}

async function withNavigatorLocks<T>(locks: SerialLockManager | null, task: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: locks ? { locks } : {},
  });
  try {
    return await task();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  }
}

test("refresh barrier waits for rotation persistence before security reload", async () => {
  const locks = new SerialLockManager();
  await withNavigatorLocks(locks, async () => {
    const storage = new MemorySessionStorage({
      refresh: "refresh-0",
      user: { id: 7, username: "alice", name: "Alice" },
    });
    const tokens: TokenStore = { access: null, refresh: "refresh-0", accessExpiresAt: null };
    const coordinate = browserRefreshCoordinator(tokens, storage);
    const order: string[] = [];

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseRotation!: () => void;
    const rotationGate = new Promise<void>((resolve) => { releaseRotation = resolve; });

    const rotation = coordinate(async () => {
      order.push("rotation-start");
      markStarted();
      await rotationGate;
      tokens.access = "access-1";
      tokens.refresh = "refresh-1";
      tokens.accessExpiresAt = 123;
      order.push("rotation-finished");
      return true;
    });

    await started;
    let reloaded = false;
    const barrier = browserRefreshBarrier(() => {
      reloaded = true;
      order.push("reload");
      assert.equal(storage.value?.refresh, "refresh-1", "reload observes the durably persisted successor token");
    });

    await Promise.resolve();
    assert.equal(reloaded, false, "reload cannot overtake an in-flight refresh");
    releaseRotation();
    await Promise.all([rotation, barrier]);

    assert.deepEqual(order, ["rotation-start", "rotation-finished", "reload"]);
    assert.deepEqual(locks.names, ["greenchat.session.refresh", "greenchat.session.refresh"]);
  });
});

test("refresh barrier degrades to immediate execution without Web Locks", async () => {
  await withNavigatorLocks(null, async () => {
    let ran = false;
    await browserRefreshBarrier(() => { ran = true; });
    assert.equal(ran, true);
  });
});


test("refresh journal survives a lost response and is reused after restart", async () => {
  const locks = new SerialLockManager();
  await withNavigatorLocks(locks, async () => {
    const storage = new MemorySessionStorage({
      refresh: "refresh-0",
      user: { id: 7, username: "alice", name: "Alice" },
    });
    const tokens: TokenStore = { access: null, refresh: "refresh-0", accessExpiresAt: null };
    const coordinate = browserRefreshCoordinator(tokens, storage);
    let proposed = "";

    await assert.rejects(
      () => coordinate(async () => {
        proposed = tokens.refreshNext ?? "";
        assert.match(proposed, /^[0-9a-f]{96}$/);
        assert.equal(storage.value?.pendingRefresh, proposed, "successor is durable before the request starts");
        throw new Error("response lost after server commit");
      }),
      /response lost/,
    );
    assert.equal(storage.value?.refresh, "refresh-0");
    assert.equal(storage.value?.pendingRefresh, proposed, "failed acknowledgement keeps the journal");

    // Simulate a fresh process: only durable storage survives.
    const restarted: TokenStore = { access: null, refresh: null, accessExpiresAt: null };
    const resume = browserRefreshCoordinator(restarted, storage);
    const ok = await resume(async () => {
      assert.equal(restarted.refresh, "refresh-0");
      assert.equal(restarted.refreshNext, proposed, "restart reuses the exact same successor");
      restarted.access = "access-1";
      restarted.refresh = proposed;
      restarted.refreshNext = null;
      restarted.accessExpiresAt = 123;
      return true;
    });
    assert.equal(ok, true);
    assert.deepEqual(storage.value, {
      refresh: proposed,
      user: { id: 7, username: "alice", name: "Alice" },
    });
  });
});
