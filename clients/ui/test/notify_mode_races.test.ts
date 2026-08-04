import { test } from "node:test";
import assert from "node:assert/strict";
import { webNotifyModePort } from "../../web/src/notify_mode.ts";

interface PendingOpen {
  req: IDBOpenDBRequest;
  complete(): void;
}

function fakeIndexedDb(): {
  factory: IDBFactory;
  opens: PendingOpen[];
  value(): unknown;
  failNextWrite(error: Error): void;
} {
  const opens: PendingOpen[] = [];
  let stored: unknown;
  let nextError: Error | null = null;

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    transaction: () => {
      const tx = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          put: (value: unknown) => {
            const rq = { result: undefined, onsuccess: null as (() => void) | null };
            queueMicrotask(() => {
              if (nextError) {
                tx.error = nextError;
                nextError = null;
                tx.onerror?.();
                return;
              }
              stored = value;
              rq.onsuccess?.();
              tx.oncomplete?.();
            });
            return rq;
          },
          get: () => {
            const rq = { result: stored, onsuccess: null as (() => void) | null };
            queueMicrotask(() => { rq.onsuccess?.(); tx.oncomplete?.(); });
            return rq;
          },
        }),
      };
      return tx;
    },
  };

  const factory = {
    open: () => {
      const req = {
        result: db,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      opens.push({ req: req as unknown as IDBOpenDBRequest, complete: () => req.onsuccess?.() });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return {
    factory,
    opens,
    value: () => stored,
    failNextWrite: (error) => { nextError = error; },
  };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("notification mode writes preserve invocation order even when IndexedDB opens complete out of order", async () => {
  const previous = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const fake = fakeIndexedDb();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = fake.factory;
  try {
    const port = webNotifyModePort();
    const first = port.set("name");
    const latest = port.set("generic");
    await microtasks();

    if (fake.opens.length === 2) {
      // Pre-fix: both DB opens are already in flight. Complete the newer write first.
      fake.opens[1]!.complete();
      await latest;
      fake.opens[0]!.complete();
      await first;
    } else {
      // Serialized implementation: the second open is not created until the first write commits.
      assert.equal(fake.opens.length, 1);
      fake.opens[0]!.complete();
      await first;
      await microtasks();
      assert.equal(fake.opens.length, 2);
      fake.opens[1]!.complete();
      await latest;
    }

    assert.equal(fake.value(), "generic", "the latest user choice must be the durable SW-visible mode");
  } finally {
    if (previous === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    else (globalThis as { indexedDB?: IDBFactory }).indexedDB = previous;
  }
});

test("a failed notification-mode write releases the queue for the next choice", async () => {
  const previous = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const fake = fakeIndexedDb();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = fake.factory;
  try {
    const port = webNotifyModePort();
    fake.failNextWrite(new Error("idb failed"));
    const failed = port.set("name");
    const latest = port.set("generic");
    await microtasks();

    fake.opens[0]!.complete();
    await assert.rejects(failed, /idb failed/);
    await microtasks();

    const latestOpen = fake.opens.at(-1)!;
    latestOpen.complete();
    await latest;
    assert.equal(fake.value(), "generic");
  } finally {
    if (previous === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    else (globalThis as { indexedDB?: IDBFactory }).indexedDB = previous;
  }
});
