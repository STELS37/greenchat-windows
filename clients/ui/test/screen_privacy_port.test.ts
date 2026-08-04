import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScreenPrivacyPort,
  type NativeScreenPrivacyBridge,
  type ScreenPrivacyStorage,
} from "../../web/src/screen_privacy.ts";

class MemoryStorage implements ScreenPrivacyStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("screen privacy port persists only after applying the native state", async () => {
  const storage = new MemoryStorage();
  const calls: boolean[] = [];
  const native: NativeScreenPrivacyBridge = {
    async setSecureScreen(enabled) { calls.push(enabled); },
  };
  const port = createScreenPrivacyPort(native, storage);
  assert.equal(await port.get(), false);
  await port.set(true);
  assert.equal(await port.get(), true);
  await port.set(false);
  assert.equal(await port.get(), false);
  assert.deepEqual(calls, [true, false]);
});

test("screen privacy port rolls storage and native state back when the platform rejects a change", async () => {
  const storage = new MemoryStorage();
  storage.setItem("gc.screen_privacy.v1", "1");
  const calls: boolean[] = [];
  let first = true;
  const native: NativeScreenPrivacyBridge = {
    async setSecureScreen(enabled) {
      calls.push(enabled);
      if (first) {
        first = false;
        throw new Error("native failure");
      }
    },
  };
  const port = createScreenPrivacyPort(native, storage);
  await assert.rejects(() => port.set(false), /native failure/);
  assert.equal(await port.get(), true);
  assert.deepEqual(calls, [false, true]);
});
