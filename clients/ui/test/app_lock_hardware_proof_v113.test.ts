// V113 — on Android the app lock chose its factor policy from a LABEL that the Android build never
// sets, and the label it wanted to trust proves nothing about the device anyway.
//
// Measured on the signed direct APK app.greenchat versionCode 1000013 (redroid 15, dedicated device,
// 2026-07-31):
//   * `window.__GC_NATIVE` was UNDEFINED inside the Capacitor WebView — only the Tauri desktop bridge
//     and the e2e fixtures ever assign it. So `nativePlatform()` returned "web" for EVERY Android
//     install: diagnostics, support reports and the app lock all saw a plain browser tab.
//   * `window.Capacitor.isNativePlatform()` WAS true there, and `window.__gcSecureKey` was installed.
//   * `SecureKey.ensure()` REJECTED on that device: SecureKeyPlugin.kt demands a TEE/StrongBox key
//     (`requireHardwareBacked`) plus a secure lock screen (`setUserAuthenticationRequired(true)`).
//
// Both halves matter. Fixing only the label would flip every Android install to platformClass "max"
// — including the ones where the hardware key cannot be created at all, and including installs whose
// container was already written as "web-user-only" while the label was broken. A container can only
// be opened by a provider of its OWN class, so that flip locks people out of their own data.
//
// The contract asserted here: the shell family comes from the host (Capacitor counts), the factor
// policy comes from a PROVEN hardware key (a completed native key operation, never a label), and an
// existing container's class always wins over both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../../core/src/store.ts";
import type { SecureKey } from "../../core/src/crypto_store/securekey.ts";
import { createWebAppLock } from "../../web/src/app_lock.ts";
import { hardwareKeyProven, nativeShellPlatform } from "../../web/src/native_shell.ts";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const STORAGE_KEY = "gc.app_lock.v1";
const PASSPHRASE = "river amber lantern orbit";
const PIN = "804152";

class MemoryStorage implements Storage {
  readonly #map = new Map<string, string>();
  get length(): number { return this.#map.size; }
  clear(): void { this.#map.clear(); }
  getItem(key: string): string | null { return this.#map.get(key) ?? null; }
  key(index: number): string | null { return [...this.#map.keys()][index] ?? null; }
  removeItem(key: string): void { this.#map.delete(key); }
  setItem(key: string, value: string): void { this.#map.set(key, value); }
}

interface TestWindow extends EventTarget {
  __gcSecureKey?: SecureKey;
  __gcSecureKeyHardware?: unknown;
  __GC_NATIVE?: { platform?: string };
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
}

function installWindow(): { win: TestWindow; restore(): void } {
  const oldWindow = (globalThis as { window?: unknown }).window;
  const oldDocument = (globalThis as { document?: unknown }).document;
  const win = new EventTarget() as TestWindow;
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = "visible";
  (globalThis as unknown as { window: TestWindow }).window = win;
  (globalThis as unknown as { document: unknown }).document = doc;
  return {
    win,
    restore() {
      if (oldWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = oldWindow;
      if (oldDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = oldDocument;
    },
  };
}

/** A working hardware bridge: deterministic per-context secrets, exactly what a TEE-backed key gives. */
function workingSecureKey(): SecureKey {
  const derive = (tag: number, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) out[i] = (tag * 31 + i * 7 + (data[i % data.length] ?? 0)) & 0xff;
    return out;
  };
  return {
    ensure: async () => {},
    deviceHmac: async (data) => derive(1, data),
    hmac: async (data) => derive(2, data),
    resetBiometric: async () => {},
    bootMarker: async () => "boot-1",
    sign: async (data) => derive(3, data),
    invalidate: async () => {},
  };
}

const noopMigration = async (): Promise<void> => {};

function containerClass(storage: Storage): string | undefined {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return undefined;
  return (JSON.parse(raw) as { container?: { header?: { platformClass?: string } } })
    .container?.header?.platformClass;
}

test("V113: the shell family is read from the host, so a Capacitor WebView is not a browser tab", () => {
  assert.equal(nativeShellPlatform(undefined), "web", "no host object at all is a plain web build");
  assert.equal(nativeShellPlatform({}), "web", "an empty window is a browser tab");

  // The measured Android reality: no __GC_NATIVE, but Capacitor's own runtime is present.
  const androidWebView = { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } };
  assert.equal(nativeShellPlatform(androidWebView), "android");

  // Capacitor also runs in a plain browser during development, where isNativePlatform() is false.
  const browserCapacitor = { Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" } };
  assert.equal(nativeShellPlatform(browserCapacitor), "web");

  // The desktop bridge keeps its explicit dialect, and it outranks a half-initialised Capacitor.
  assert.equal(nativeShellPlatform({ __GC_NATIVE: { platform: "desktop" } }), "desktop");

  // A hostile/broken host must never take the boot down: a throwing getter degrades to "web".
  const hostile = {
    get Capacitor(): never { throw new Error("boom"); },
    get __GC_NATIVE(): never { throw new Error("boom"); },
  };
  assert.equal(nativeShellPlatform(hostile), "web");
  assert.equal(hardwareKeyProven(hostile), false);
});

test("V113: a hardware key is only 'available' once a native key operation has actually succeeded", () => {
  assert.equal(hardwareKeyProven({}), false, "absence of the flag is fail-closed");
  assert.equal(hardwareKeyProven({ __gcSecureKeyHardware: "yes" }), false, "only a literal true counts");
  assert.equal(hardwareKeyProven({ __gcSecureKeyHardware: true }), true);
});

test("V113: an Android shell whose SecureKey.ensure() failed stays passphrase-only", async () => {
  const env = installWindow();
  const storage = new MemoryStorage();
  try {
    // The proxy is installed unconditionally by the bridge; on this device the key does not work.
    env.win.__gcSecureKey = workingSecureKey();
    env.win.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };

    const lock = createWebAppLock({
      store: new MemoryStore(),
      platform: "android",
      storage,
      migrateLocalData: noopMigration,
    });
    try {
      assert.equal(
        lock.port.policy.requirePassphrase,
        true,
        "no proven hardware key ⇒ a six-digit PIN would be defended by Argon2id alone",
      );
      await assert.rejects(
        () => lock.port.enable(PIN, { wipeAfter: 10 }),
        "a PIN must be refused while the device cannot bind the container to hardware",
      );
      await lock.port.enable(PASSPHRASE, { wipeAfter: 10 });
      assert.equal(
        containerClass(storage),
        "web-user-only",
        "the container must not claim a hardware class the device cannot provide",
      );
    } finally {
      lock.destroy();
    }
  } finally {
    env.restore();
  }
});

test("V113: a proven hardware key unlocks the PIN door and binds the container to it", async () => {
  const env = installWindow();
  const storage = new MemoryStorage();
  try {
    env.win.__gcSecureKey = workingSecureKey();
    env.win.__gcSecureKeyHardware = true;
    env.win.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };

    const lock = createWebAppLock({
      store: new MemoryStore(),
      platform: "android",
      storage,
      migrateLocalData: noopMigration,
    });
    try {
      assert.equal(lock.port.policy.requirePassphrase, false, "hardware throttling makes a PIN honest");
      await lock.port.enable(PIN, { wipeAfter: 10 });
      assert.equal(containerClass(storage), "max");
    } finally {
      lock.destroy();
    }
  } finally {
    env.restore();
  }
});

test("V113: an existing container keeps its own class when the hardware verdict changes", async () => {
  const env = installWindow();
  const storage = new MemoryStorage();
  const store = new MemoryStore();
  try {
    // Written while the platform label was broken: a passphrase container with no hardware factor.
    const first = createWebAppLock({ store, platform: "web", storage, migrateLocalData: noopMigration });
    await first.port.enable(PASSPHRASE, { wipeAfter: 10 });
    assert.equal(containerClass(storage), "web-user-only");
    first.controller.lock();
    first.destroy();

    // The fix lands: the shell now reports Android AND proves a hardware key. The container predates
    // both facts and can only be opened by a provider of its own class.
    env.win.__gcSecureKey = workingSecureKey();
    env.win.__gcSecureKeyHardware = true;
    env.win.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };

    const restarted = createWebAppLock({ store, platform: "android", storage, migrateLocalData: noopMigration });
    try {
      assert.equal(restarted.port.state, "COLD");
      await restarted.port.unlock(PASSPHRASE);
      assert.equal(restarted.port.state, "UNLOCKED", "an upgrade must never lock people out of their data");
      assert.equal(containerClass(storage), "web-user-only", "the stored class is never silently rewritten");
    } finally {
      restarted.destroy();
    }
  } finally {
    env.restore();
  }
});

test("V113: the shells feed the app the same two facts, and the mobile bridge proves the key", () => {
  const bridge = read("../../mobile/bridge/index.ts");
  assert.match(
    bridge,
    /__gcSecureKeyHardware/,
    "the Capacitor bridge must publish the hardware verdict — the web layer cannot ask the OS itself",
  );
  const proof = /await\s+secureKey\.ensure\(\)[\s\S]{0,200}?__gcSecureKeyHardware\s*=\s*true/;
  assert.match(bridge, proof, "the flag may only be set AFTER a real native key operation resolved");
  assert.match(
    bridge,
    /delete\s+win\.__gcSecureKeyHardware/,
    "a failed/rejected ensure() must leave no stale verdict behind",
  );

  const main = read("../../web/src/main.ts");
  assert.match(
    main,
    /from\s+"\.\/native_shell\.ts"/,
    "main.ts must derive the platform from the shared detector, not from __GC_NATIVE alone",
  );
  assert.ok(
    !/__GC_NATIVE\?\.platform/.test(main),
    "the Android-blind label read must be gone from main.ts",
  );
});
