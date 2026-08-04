import test from "node:test";
import assert from "node:assert/strict";
import { checkManualUpdate, type ManualUpdateEnv } from "../src/manual_update_check.ts";

function env(overrides: Partial<ManualUpdateEnv> = {}): ManualUpdateEnv {
  return {
    nativeInfo: () => null,
    fetchNative: async () => ({ state: "unknown" }),
    serviceWorkerRegistration: async () => null,
    hasServiceWorkerController: () => false,
    timeoutMs: 5,
    ...overrides,
  };
}

test("V205: manual web update check reports current without reloading the authenticated app", async () => {
  let checked = 0;
  const registration = {
    waiting: null,
    installing: null,
    update: async () => { checked += 1; },
  } as unknown as ServiceWorkerRegistration;
  const result = await checkManualUpdate(env({
    serviceWorkerRegistration: async () => registration,
    hasServiceWorkerController: () => true,
  }));
  assert.deepEqual(result, { state: "latest" });
  assert.equal(checked, 1);
});

test("V205: a waiting PWA worker is reported as an available update", async () => {
  const registration = {
    waiting: { state: "installed" },
    installing: null,
    update: async () => {},
  } as unknown as ServiceWorkerRegistration;
  assert.deepEqual(await checkManualUpdate(env({
    serviceWorkerRegistration: async () => registration,
    hasServiceWorkerController: () => true,
  })), { state: "available" });
});

test("V205: native manifest verdict includes the offered version", async () => {
  const result = await checkManualUpdate(env({
    nativeInfo: () => ({ platform: "android", arch: "universal", version: "1.0.0", build: 100 }),
    fetchNative: async () => ({ state: "available", version: "1.1.0" }),
  }));
  assert.deepEqual(result, { state: "available", version: "1.1.0" });
});

test("V205: network failure is an honest unknown verdict, never a reload", async () => {
  const registration = {
    waiting: null,
    installing: null,
    update: async () => { throw new Error("offline"); },
  } as unknown as ServiceWorkerRegistration;
  assert.deepEqual(await checkManualUpdate(env({
    serviceWorkerRegistration: async () => registration,
  })), { state: "unknown" });
});
