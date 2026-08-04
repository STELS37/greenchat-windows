// T-523 integration: web/native-shell adapter persists only WRAP metadata and forwards screen-off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../core/src/store.ts";
import { EncryptedStore } from "../../core/src/encrypted_store.ts";
import type { AppLockMigrationKeys } from "../../core/src/crypto_store/app_lock.ts";
import type { SecureKey } from "../../core/src/crypto_store/securekey.ts";
import { createWebAppLock, recoverPendingLocalReset } from "../../web/src/app_lock.ts";

class MemoryStorage implements Storage {
  readonly #map = new Map<string, string>();
  sets = 0;
  get length(): number { return this.#map.size; }
  clear(): void { this.#map.clear(); }
  getItem(key: string): string | null { return this.#map.get(key) ?? null; }
  key(index: number): string | null { return [...this.#map.keys()][index] ?? null; }
  removeItem(key: string): void { this.#map.delete(key); }
  setItem(key: string, value: string): void { this.sets += 1; this.#map.set(key, value); }
  raw(): string { return [...this.#map.values()].join("\n"); }
}

interface TestWindow extends EventTarget {
  __gcAppLockScreenOff?: () => void;
  __gcSecureKey?: SecureKey;
  /** V113: the shell's verdict that a hardware-backed key really works here (see native_shell.ts). */
  __gcSecureKeyHardware?: boolean;
}
interface TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState;
}

function installSignals(): { win: TestWindow; doc: TestDocument; restore(): void } {
  const oldWindow = (globalThis as { window?: unknown }).window;
  const oldDocument = (globalThis as { document?: unknown }).document;
  const win = new EventTarget() as TestWindow;
  const doc = new EventTarget() as TestDocument;
  doc.visibilityState = "visible";
  (globalThis as unknown as { window: TestWindow }).window = win;
  (globalThis as unknown as { document: TestDocument }).document = doc;
  return {
    win,
    doc,
    restore() {
      if (oldWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = oldWindow;
      if (oldDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = oldDocument;
    },
  };
}

const CODE = "river amber lantern orbit";


function dbMigration(store: MemoryStore): (keys: AppLockMigrationKeys) => Promise<void> {
  const migrator = new EncryptedStore({
    store,
    key: () => null,
    allowPassthrough: true,
    warn: () => {},
  });
  return async ({ dbKey }) => {
    await store.batch(await migrator.preparePlaintextMigrationOps(dbKey));
    await migrator.assertFullyEncryptedAtRest();
  };
}

const noopMigration = async (): Promise<void> => {};

test("web app-lock: WRAP survives restart, code never persists, native screen-off locks immediately", async () => {
  const env = installSignals();
  const storage = new MemoryStorage();
  const store = new MemoryStore();
  await store.put("messages", 1, { id: 1, text: "legacy plaintext" });

  try {
    const first = createWebAppLock({ store, platform: "web", storage, migrateLocalData: dbMigration(store) });
    assert.equal(first.port.state, "DISABLED");
    await first.port.enable(CODE, { wipeAfter: 10 });
    assert.equal(first.port.state, "UNLOCKED");
    const raw = await store.get<Record<string, unknown>>("messages", 1);
    assert.equal(raw?.__gc_enc, 1, "enable migrates legacy plaintext to ciphertext");
    assert.equal(raw?.text, undefined);
    assert.ok(storage.raw().includes("gc-crypto-store"));
    assert.ok(!storage.raw().includes(CODE), "application code is never persisted");

    first.controller.lock();
    first.destroy();

    const restarted = createWebAppLock({ store, platform: "web", storage, migrateLocalData: dbMigration(store) });
    assert.equal(restarted.port.state, "COLD");
    await restarted.port.unlock(CODE);
    assert.equal(restarted.port.state, "UNLOCKED");

    assert.equal(typeof env.win.__gcAppLockScreenOff, "function");
    env.win.__gcAppLockScreenOff?.();
    assert.equal(restarted.port.state, "LOCKED", "real screen-off signal is immediate, not a timer");
    restarted.destroy();
  } finally {
    env.restore();
  }
});

test("manual/screen-off locks publish cross-tab signals while background/pagehide stay local", async () => {
  const env = installSignals();
  const storage = new MemoryStorage();
  const appLock = createWebAppLock({
    store: new MemoryStore(),
    platform: "web",
    storage,
    migrateLocalData: noopMigration,
  });
  try {
    await appLock.port.enable(CODE, { wipeAfter: 10 });
    assert.equal(appLock.port.state, "UNLOCKED");
    assert.equal(storage.getItem("gc.app_lock.lock-signal.v1"), null, "setup must not signal a manual lock");


    const writesBeforePageHide = storage.sets;
    const snapshotBeforePageHide = storage.getItem("gc.app_lock.v1");
    env.win.dispatchEvent(new Event("pagehide"));
    assert.equal(appLock.port.state, "LOCKED", "pagehide zeroizes this realm immediately for BFCache/navigation");
    assert.equal(storage.getItem("gc.app_lock.lock-signal.v1"), null, "pagehide must not lock peer tabs");
    assert.equal(storage.getItem("gc.app_lock.v1"), snapshotBeforePageHide, "pagehide cannot overwrite a newer peer snapshot");
    assert.equal(storage.sets, writesBeforePageHide, "memory-only lock performs no durable rewrite");

    await appLock.port.unlock(CODE);

    appLock.port.lock();
    const manual = storage.getItem("gc.app_lock.lock-signal.v1");
    assert.notEqual(manual, null, "manual lock publishes a peer invalidation nonce");

    await appLock.port.unlock(CODE);
    appLock.controller.lock("background");
    assert.equal(
      storage.getItem("gc.app_lock.lock-signal.v1"),
      manual,
      "a hidden tab's background timer must not lock an actively used peer tab",
    );

    await appLock.port.unlock(CODE);
    env.win.__gcAppLockScreenOff?.();
    const screenOff = storage.getItem("gc.app_lock.lock-signal.v1");
    assert.notEqual(screenOff, manual, "screen-off lock publishes a fresh nonce");
  } finally {
    appLock.destroy();
    env.restore();
  }
});

test("corrupt durable app-lock snapshots become recoverable WIPED tombstones", async () => {
  const env = installSignals();
  const corruptValues = [
    "{",
    "null",
    "[]",
    JSON.stringify({ container: { header: { magic: "tampered-container" } } }),
  ];
  try {
    for (const raw of corruptValues) {
      const storage = new MemoryStorage();
      const store = new MemoryStore();
      storage.setItem("gc.app_lock.v1", raw);
      storage.setItem("gc.session", "persisted-auth");
      await store.put("messages", 1, { id: 1, text: "local cache must be discarded" });
      const tokens = { access: "access", refresh: "refresh", accessExpiresAt: 123 };
      let sessionClears = 0;

      const appLock = createWebAppLock({
        store,
        platform: "web",
        storage,
        migrateLocalData: noopMigration,
      });
      assert.equal(appLock.port.state, "WIPED", raw);
      assert.equal(appLock.controller.localResetPending, true, raw);
      const immediate = JSON.parse(storage.getItem("gc.app_lock.v1") ?? "{}") as {
        container?: { magic?: string };
        localResetPending?: boolean;
      };
      assert.equal(immediate.container?.magic, "gc-crypto-store-wiped", "corrupt bytes are replaced before listeners start");
      assert.equal(immediate.localResetPending, true, "the durable receipt records unfinished local reset");

      await recoverPendingLocalReset(appLock.controller, tokens, {
        clear() { sessionClears += 1; storage.removeItem("gc.session"); },
      });

      assert.deepEqual(tokens, { access: null, refresh: null, accessExpiresAt: null });
      assert.equal(sessionClears, 1);
      assert.equal(await store.get("messages", 1), undefined);
      assert.equal(appLock.port.state, "WIPED");
      assert.equal(appLock.controller.localResetPending, false);
      const persisted = JSON.parse(storage.getItem("gc.app_lock.v1") ?? "{}") as {
        container?: { magic?: string };
        localResetPending?: boolean;
      };
      assert.equal(persisted.container?.magic, "gc-crypto-store-wiped");
      assert.equal(persisted.localResetPending, false);
      assert.equal(storage.getItem("gc.session"), null);
      appLock.destroy();
    }
  } finally {
    env.restore();
  }
});

test("external lock is live/no-reload while a durable snapshot invalidates exactly once", async () => {
  const env = installSignals();
  const storage = new MemoryStorage();
  let invalidations = 0;
  try {
    const appLock = createWebAppLock({
      store: new MemoryStore(),
      platform: "web",
      storage,
      migrateLocalData: noopMigration,
      onExternalSnapshotChange: () => { invalidations += 1; },
    });
    const dispatch = (key: string | null, oldValue: string | null, newValue: string | null): void => {
      const event = new Event("storage") as StorageEvent;
      Object.defineProperties(event, {
        key: { value: key },
        oldValue: { value: oldValue },
        newValue: { value: newValue },
        storageArea: { value: storage },
      });
      env.win.dispatchEvent(event);
    };

    await appLock.port.enable(CODE, { wipeAfter: 10 });
    assert.equal(appLock.port.state, "UNLOCKED");
    const localSignalBefore = storage.getItem("gc.app_lock.lock-signal.v1");

    dispatch("other.preference", null, "1");
    dispatch("gc.app_lock.v1", "same", "same");
    assert.equal(invalidations, 0);

    dispatch("gc.app_lock.lock-signal.v1", null, "peer-lock-1");
    assert.equal(appLock.port.state, "LOCKED", "peer manual lock is applied in the same JS realm");
    assert.equal(invalidations, 0, "content-free lock nonce must not reload the tab");
    assert.equal(
      storage.getItem("gc.app_lock.lock-signal.v1"),
      localSignalBefore,
      "externally applied lock must not echo another nonce",
    );

    await appLock.port.unlock(CODE);
    const unlockedRaw = storage.getItem("gc.app_lock.v1");
    assert.ok(unlockedRaw);
    const benign = JSON.parse(unlockedRaw) as {
      container: { wrap: string; meta?: { lastOpenAt?: number }; [key: string]: unknown };
      cold: { lastCodeUnlockAt: number; bootId: string | null };
      attempts: { failures: number; blockedUntil: number };
    };
    benign.cold = { ...benign.cold, lastCodeUnlockAt: benign.cold.lastCodeUnlockAt + 1 };
    benign.container = {
      ...benign.container,
      meta: { ...benign.container.meta, lastOpenAt: (benign.container.meta?.lastOpenAt ?? 0) + 1 },
    };
    const benignRaw = JSON.stringify(benign);
    dispatch("gc.app_lock.v1", unlockedRaw, benignRaw);
    assert.equal(invalidations, 0, "peer successful-unlock timestamps must not create reload ping-pong");

    const riskier = structuredClone(benign);
    riskier.container = { ...riskier.container, wrap: `${riskier.container.wrap}tampered` };
    riskier.attempts = { ...riskier.attempts, failures: riskier.attempts.failures + 1 };
    const riskierRaw = JSON.stringify(riskier);
    dispatch("gc.app_lock.v1", benignRaw, riskierRaw);
    dispatch("gc.app_lock.v1", riskierRaw, JSON.stringify({ ...riskier, localResetPending: true }));
    assert.equal(invalidations, 1, "WRAP/failure/key-posture changes latch this tab fail-closed");

    appLock.destroy();
    dispatch("gc.app_lock.v1", riskierRaw, "after-destroy");
    assert.equal(invalidations, 1, "destroy removes the storage listener");
  } finally {
    env.restore();
  }
});

test("user-only adapters require a passphrase whenever no hardware bridge is exposed", () => {
  const env = installSignals();
  try {
    for (const platform of ["web", "desktop", "android", "ios"] as const) {
      const appLock = createWebAppLock({
        store: new MemoryStore(), platform, storage: new MemoryStorage(), migrateLocalData: noopMigration,
      });
      assert.equal(appLock.port.policy.requirePassphrase, true, `${platform} must fail closed without S_hw`);
      assert.equal(appLock.port.estimate("593817").problem, "passphrase_required");
      assert.equal(appLock.port.estimate("correct horse battery staple").valid, true);

      assert.equal(appLock.port.biometric.available, false);
      appLock.destroy();
    }
  } finally {
    env.restore();
  }
});

test("native SecureKey bridge enables the independent biometric fast path by default", async () => {
  const env = installSignals();
  let bioHmacCalls = 0;
  let bioResets = 0;
  env.win.__gcSecureKey = {
    ensure: async () => {},
    deviceHmac: async () => new Uint8Array(32).fill(6),
    hmac: async () => {
      bioHmacCalls++;
      return new Uint8Array(32).fill(7);
    },
    resetBiometric: async () => { bioResets++; },

    bootMarker: async () => "android:7",
    sign: async () => new Uint8Array(64).fill(9),
    invalidate: async () => {},
  };
  // V113: this fixture models a device whose SecureKey.ensure() SUCCEEDS, so it must publish the same
  // hardware verdict the real Capacitor bridge publishes after that call. Without the verdict the lock
  // fails closed (passphrase-only), exactly as it now does on the emulator where ensure() rejects.
  env.win.__gcSecureKeyHardware = true;
  try {
    const appLock = createWebAppLock({
      store: new MemoryStore(), platform: "android", storage: new MemoryStorage(), migrateLocalData: noopMigration,
    });
    assert.equal(appLock.port.policy.requirePassphrase, false);
    assert.equal(appLock.port.estimate("593817").valid, true);
    assert.equal(appLock.port.biometric.available, true);

    await appLock.port.enable("593817", { wipeAfter: 10 });
    assert.equal(appLock.port.biometric.enabled, true);
    assert.equal(appLock.port.biometric.ready, true);
    assert.ok(bioResets >= 1);

    appLock.port.lock();
    await appLock.port.unlockBiometric();
    assert.equal(appLock.port.state, "UNLOCKED");
    assert.ok(bioHmacCalls >= 2, "one call creates WRAP_bio and another unlocks it");

    await appLock.port.setBiometricEnabled(false);
    assert.equal(appLock.port.biometric.enabled, false);
    appLock.port.lock();
    await appLock.port.unlock("593817");
    assert.equal(appLock.port.state, "UNLOCKED", "disabling biometrics leaves code recovery intact");
    appLock.destroy();
  } finally {
    env.restore();
  }
});


test("T-526 web adapter: duress uses the ordinary unlock port, clears storage, and invokes shell action", async () => {
  const env = installSignals();
  const storage = new MemoryStorage();
  const store = new MemoryStore();
  const actions: Array<{ trustedUsername: string | null }> = [];
  try {
    const appLock = createWebAppLock({
      store,
      platform: "web",
      storage,
      migrateLocalData: dbMigration(store),
      onDuress: (action) => { actions.push(action); },
    });
    await appLock.port.enable(CODE, { wipeAfter: 10 });
    await store.put("messages", 1, { id: 1, text: "encrypted local row" });
    await appLock.port.configureDuress(CODE, "silent river warning phrase", "trusted_friend");
    assert.deepEqual(appLock.port.duress, { enabled: true, signal: true });
    assert.ok(!storage.raw().includes("trusted_friend"));
    assert.ok(!storage.raw().includes("silent river warning phrase"));

    appLock.port.lock();
    await appLock.port.unlock("silent river warning phrase");
    assert.equal(appLock.port.state, "DISABLED");
    assert.deepEqual(actions, [{ trustedUsername: "trusted_friend" }]);
    assert.equal(storage.raw().includes('"container":null'), true);
    assert.equal(await store.get("messages", 1), undefined);
    appLock.destroy();
  } finally {
    env.restore();
  }
});


test("T-526 beta.3 web recovery clears auth synchronously and preserves only the neutral reset marker", async () => {
  const env = installSignals();
  const storage = new MemoryStorage();
  const store = new MemoryStore();
  storage.setItem("gc.session", "surviving-refresh-token");
  storage.setItem("gc.support.queue", "queued-content");
  storage.setItem("outside.origin.preference", "keep-me");

  try {
    const appLock = createWebAppLock({
      store,
      platform: "web",
      storage,
      migrateLocalData: dbMigration(store),
      onDuress: () => {},
    });
    await appLock.port.enable(CODE, { wipeAfter: 10 });
    await appLock.port.configureDuress(CODE, "silent river warning phrase", null);
    appLock.port.lock();
    await appLock.port.unlock("silent river warning phrase");

    const pending = JSON.parse(storage.getItem("gc.app_lock.v1") ?? "{}") as { localResetPending?: boolean };
    assert.equal(pending.localResetPending, true);
    assert.equal(storage.getItem("gc.session"), null);
    assert.equal(storage.getItem("gc.support.queue"), null);
    assert.equal(storage.getItem("outside.origin.preference"), "keep-me");

    const tokens = { access: "access", refresh: "refresh", accessExpiresAt: 123 };
    let sessionClears = 0;
    const recovery = recoverPendingLocalReset(appLock.controller, tokens, { clear() { sessionClears++; } });
    assert.deepEqual(tokens, { access: null, refresh: null, accessExpiresAt: null });
    assert.equal(sessionClears, 1, "auth storage is cleared before the first await");
    await recovery;

    const completed = JSON.parse(storage.getItem("gc.app_lock.v1") ?? "{}") as { localResetPending?: boolean };
    assert.equal(completed.localResetPending, false);
    appLock.destroy();
  } finally {
    env.restore();
  }
});
