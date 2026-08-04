import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScreenPrivacyPort,
  type NativeScreenPrivacyBridge,
  type ScreenPrivacyStorage,
} from "../../web/src/screen_privacy.ts";

function deferredVoid(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function memoryStorage(initial = false): ScreenPrivacyStorage & { enabled(): boolean } {
  const rows = new Map<string, string>();
  if (initial) rows.set("gc.screen_privacy.v1", "1");
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); },
    removeItem: (key) => { rows.delete(key); },
    enabled: () => rows.get("gc.screen_privacy.v1") === "1",
  };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("screen privacy serializes rapid toggles so storage and the native secure flag end on the latest choice", async () => {
  const first = deferredVoid();
  const calls: boolean[] = [];
  let nativeEnabled = false;
  const native: NativeScreenPrivacyBridge = {
    async setSecureScreen(enabled) {
      calls.push(enabled);
      if (calls.length === 1) await first.promise;
      nativeEnabled = enabled;
    },
  };
  const storage = memoryStorage(false);
  const port = createScreenPrivacyPort(native, storage);

  const enable = port.set(true);
  const disable = port.set(false);
  await microtasks();

  assert.deepEqual(calls, [true], "the second native transition must wait for the first one");
  first.resolve();
  await Promise.all([enable, disable]);

  assert.deepEqual(calls, [true, false]);
  assert.equal(storage.enabled(), false);
  assert.equal(nativeEnabled, false, "native and storage state must agree with the latest user choice");
});

test("a failed screen-privacy transition rolls back before the queued next choice and does not wedge the queue", async () => {
  const first = deferredVoid();
  const calls: boolean[] = [];
  let nativeEnabled = false;
  const native: NativeScreenPrivacyBridge = {
    async setSecureScreen(enabled) {
      calls.push(enabled);
      if (calls.length === 1) {
        await first.promise;
        throw new Error("native failed");
      }
      nativeEnabled = enabled;
    },
  };
  const storage = memoryStorage(false);
  const port = createScreenPrivacyPort(native, storage);

  const failedEnable = port.set(true);
  const finalDisable = port.set(false);
  await microtasks();
  assert.deepEqual(calls, [true]);

  first.resolve();
  await assert.rejects(failedEnable, /native failed/);
  await finalDisable;

  assert.deepEqual(calls, [true, false, false], "rollback completes before the queued final choice");
  assert.equal(storage.enabled(), false);
  assert.equal(nativeEnabled, false);
});

test("separate screen-privacy ports do not block one another", async () => {
  const blocked = deferredVoid();
  const calls: string[] = [];
  const first = createScreenPrivacyPort({
    async setSecureScreen(enabled) { calls.push(`a:${enabled}`); await blocked.promise; },
  }, memoryStorage());
  const second = createScreenPrivacyPort({
    async setSecureScreen(enabled) { calls.push(`b:${enabled}`); },
  }, memoryStorage());

  const a = first.set(true);
  await second.set(true);
  assert.deepEqual(calls, ["a:true", "b:true"]);

  blocked.resolve();
  await a;
});
