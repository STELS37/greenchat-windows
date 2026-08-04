// T-523 (DS-05): application lock policy, throttling, crypto-wipe and store wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_LOCK_DELAY_CAP_SECONDS,
  AppLockController,
  AppLockFailedError,
  AppLockMigrationError,
  AppLockThrottledError,
  AppLockWipedError,
  EncryptedStore,
  MediaCache,
  MemoryStore,
  appLockDelaySeconds,
  estimateAppCode,
  normalizeAppLockSnapshot,
  type AppLockControllerOptions,
  type AppLockSnapshot,
} from "../src/index.ts";
import {
  isWipedTombstone,
  type Argon2idParams,
  type KekFactors,
  type LockClock,
  type UserSecretDeriver,
} from "../src/crypto_store/index.ts";
import { hmacSha256, utf8 } from "../src/crypto_store/primitives.ts";

class TestUserSecret implements UserSecretDeriver {
  async derive(code: string, salt: Uint8Array, _params: Argon2idParams): Promise<Uint8Array> {
    return hmacSha256(utf8(code), salt);
  }
}

const factors: KekFactors = { user: new TestUserSecret(), hw: null };

class FakeClock implements LockClock {
  now = 1_700_000_000;
  #next = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  nowSeconds(): number { return this.now; }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms / 1000, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.#timers.delete(handle as number); }
  advance(seconds: number): void {
    this.now += seconds;
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

function cloneSnapshot(snapshot: AppLockSnapshot): AppLockSnapshot {
  return structuredClone(snapshot);
}

function fixture(opts: {
  snapshot?: AppLockSnapshot;
  clock?: FakeClock;
  migrateLocalData?: AppLockControllerOptions["migrateLocalData"];
  wipeLocalData?: () => void | Promise<void>;
  failSaveWhen?: (snapshot: AppLockSnapshot, call: number) => boolean;

  factors?: KekFactors;
} = {}) {
  let saved = cloneSnapshot(opts.snapshot ?? normalizeAppLockSnapshot());
  let saveCalls = 0;
  const clock = opts.clock ?? new FakeClock();
  const controller = new AppLockController({
    snapshot: saved,
    factors: opts.factors ?? factors,
    platformClass: "web-user-only",
    persistence: {
      save: (next) => {
        saveCalls++;
        if (opts.failSaveWhen?.(next, saveCalls)) throw new Error("simulated persistence failure");
        saved = cloneSnapshot(next);
      },
    },
    clock,
    migrateLocalData: opts.migrateLocalData ?? (async () => {}),
    ...(opts.wipeLocalData ? { wipeLocalData: opts.wipeLocalData } : {}),
  });
  return {
    controller,
    clock,
    snapshot: () => cloneSnapshot(saved),
    saveCalls: () => saveCalls,
  };
}

const CODE = "correct horse battery staple";

test("app_lock policy: PIN/passphrase validation is conservative and delays cap at five minutes", () => {
  assert.deepEqual(
    { valid: estimateAppCode("12345").valid, problem: estimateAppCode("12345").problem },
    { valid: false, problem: "pin_too_short" },
  );
  const repeated = estimateAppCode("111111");
  assert.equal(repeated.valid, true);
  assert.equal(repeated.score, 1);
  assert.ok(repeated.estimatedBits <= 4);

  const six = estimateAppCode("593817");
  assert.equal(six.valid, true);
  assert.equal(six.score, 1, "ordinary six-digit PIN is never advertised as strong");
  assert.equal(estimateAppCode("593817", true).problem, "passphrase_required");

  const phrase = estimateAppCode("river amber lantern orbit");
  assert.equal(phrase.valid, true);
  assert.ok(phrase.score >= 3);
  assert.equal(estimateAppCode("short").problem, "passphrase_too_short");

  assert.deepEqual([1, 2, 3, 4, 5, 6].map(appLockDelaySeconds), [1, 2, 4, 8, 16, 32]);
  assert.equal(appLockDelaySeconds(100), APP_LOCK_DELAY_CAP_SECONDS);
});
test("app_lock: enable is fail-closed from the first KDF tick (no plaintext race window)", async () => {
  const lower = new MemoryStore();
  const legacy = { id: 41, chat_id: 8, text: "plaintext before opt-in" };
  await lower.put("messages", 41, legacy);

  let markStarted!: () => void;
  let releaseKdf!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseKdf = resolve; });
  const slowUser: UserSecretDeriver = {
    async derive(code, salt) {
      markStarted();
      await released;
      return hmacSha256(utf8(code), salt);
    },
  };

  let store!: EncryptedStore;
  const f = fixture({
    factors: { user: slowUser, hw: null },
    migrateLocalData: async ({ dbKey }) => {
      await lower.batch(await store.preparePlaintextMigrationOps(dbKey));
      await store.assertFullyEncryptedAtRest();
    },
  });
  store = new EncryptedStore({
    store: lower,
    key: () => f.controller.currentDbKey,
    allowPassthrough: () => f.controller.passthroughAllowed(),
    warn: () => {},
  });
  const states: string[] = [];
  f.controller.subscribe((state) => states.push(state));

  const enabling = f.controller.enable(CODE);
  await started;
  assert.equal(f.controller.state, "LOCKED");
  assert.equal(f.controller.enabled, true);
  assert.equal(f.controller.passthroughAllowed(), false);
  assert.equal(f.controller.currentDbKey, null);
  assert.deepEqual(states, ["LOCKED"]);
  await assert.rejects(store.get("messages", 41), /locked/);
  assert.deepEqual(await lower.get("messages", 41), legacy, "KDF latency cannot mutate source data");

  releaseKdf();
  await enabling;
  assert.equal(f.controller.state, "UNLOCKED");
  assert.equal(f.controller.passthroughAllowed(), false);
  assert.deepEqual(await store.get("messages", 41), legacy);
  const raw = await lower.get<Record<string, unknown>>("messages", 41);
  assert.equal(raw?.__gc_enc, 1);
  assert.equal(raw?.text, undefined);
});

test("app_lock: a pre-container KDF failure safely resumes DISABLED passthrough", async () => {
  const lower = new MemoryStore();
  const legacy = { id: 42, text: "still safe after failed opt-in" };
  await lower.put("messages", 42, legacy);
  const failingUser: UserSecretDeriver = {
    async derive() { throw new Error("simulated KDF failure"); },
  };
  const f = fixture({ factors: { user: failingUser, hw: null } });
  const store = new EncryptedStore({
    store: lower,
    key: () => f.controller.currentDbKey,
    allowPassthrough: () => f.controller.passthroughAllowed(),
    warn: () => {},
  });
  const states: string[] = [];
  f.controller.subscribe((state) => states.push(state));

  const enabling = f.controller.enable(CODE);
  assert.equal(f.controller.state, "LOCKED", "enable closes passthrough synchronously");
  await assert.rejects(enabling, /simulated KDF failure/);
  assert.equal(f.controller.state, "DISABLED");
  assert.equal(f.controller.enabled, false);
  assert.equal(f.controller.passthroughAllowed(), true);
  assert.deepEqual(states, ["LOCKED", "DISABLED"]);
  assert.deepEqual(await store.get("messages", 42), legacy);
  assert.equal(f.snapshot().container, null);
  assert.equal(f.snapshot().migration, null);
});

test("app_lock: enable atomically preserves+encrypts DB+media and LOCKED fails closed", async () => {
  const lower = new MemoryStore();
  const legacy = { id: 1, chat_id: 10, text: "legacy plaintext" };
  const mediaBytes = new TextEncoder().encode("legacy-media-canary");
  await lower.put("messages", 1, legacy);
  await lower.put("media", 9, {
    id: 9, bytes: mediaBytes, mime: "image/png", size: mediaBytes.byteLength, at: 123,
  });

  let store!: EncryptedStore;
  let mediaCache!: MediaCache;
  let migrations = 0;
  const f = fixture({
    migrateLocalData: async ({ dbKey, filesKey }) => {
      migrations++;
      const [dbOps, mediaOps] = await Promise.all([
        store.preparePlaintextMigrationOps(dbKey),
        mediaCache.preparePlaintextMigrationOps(filesKey),
      ]);
      await lower.batch([...dbOps, ...mediaOps]);
      await store.assertFullyEncryptedAtRest();
      await mediaCache.assertFullyEncryptedAtRest();
    },
  });
  store = new EncryptedStore({
    store: lower,
    key: () => f.controller.currentDbKey,
    allowPassthrough: () => f.controller.passthroughAllowed(),
    warn: () => {},
  });
  mediaCache = new MediaCache({
    baseUrl: "http://files.test",
    tokens: { access: null, refresh: null, accessExpiresAt: null },
    clientId: "test/0",
    store: lower,
    session: f.controller,
    allowPassthrough: () => f.controller.passthroughAllowed(),
    fetchImpl: async () => new Response("not expected", { status: 500 }),
  });

  assert.equal(f.controller.state, "DISABLED");
  assert.deepEqual(await store.get("messages", 1), legacy);

  await f.controller.enable(CODE);
  assert.equal(migrations, 1);
  assert.equal(f.controller.state, "UNLOCKED");
  assert.equal(f.controller.currentDbKey?.byteLength, 32);
  assert.equal(f.snapshot().migration, null);

  const migrated = await lower.get<Record<string, unknown>>("messages", 1);
  assert.equal(migrated?.text, undefined, "legacy plaintext is not left at rest");
  assert.equal(migrated?.__gc_enc, 1);
  assert.deepEqual(await store.get("messages", 1), legacy, "legacy DB row survives semantically");

  const migratedMediaRaw = await lower.get<Record<string, unknown>>("media", 9);
  assert.equal(migratedMediaRaw?.enc, 1);
  assert.equal(migratedMediaRaw?.mime, "application/octet-stream");
  assert.notDeepEqual(migratedMediaRaw?.bytes, mediaBytes);
  const migratedMedia = await mediaCache.get(9);
  assert.deepEqual(migratedMedia.bytes, mediaBytes);
  assert.equal(migratedMedia.mime, "image/png");

  const row = { id: 2, chat_id: 10, text: "encrypted locally" };
  await store.put("messages", 2, row);
  const raw = await lower.get<Record<string, unknown>>("messages", 2);
  assert.equal(raw?.text, undefined);
  assert.equal(raw?.__gc_enc, 1);
  assert.deepEqual(await store.get("messages", 2), row);

  f.controller.lock();
  assert.equal(f.controller.state, "LOCKED");
  assert.equal(f.controller.currentDbKey, null);
  await assert.rejects(store.get("messages", 2), /locked/);
  await assert.rejects(store.put("messages", 3, { id: 3, text: "must not leak" }), /locked/);

  // Even an attacker-planted/legacy plaintext record cannot be read through the locked wrapper.
  await lower.put("messages", 99, { id: 99, text: "plaintext on disk" });
  await assert.rejects(store.get("messages", 99), /locked/);

  await f.controller.unlock(CODE);
  assert.deepEqual(await store.get("messages", 2), row);
});

test("app_lock: failed migration keeps plaintext intact + pending, restart resumes idempotently", async () => {
  const lower = new MemoryStore();
  const legacy = { id: 7, chat_id: 3, text: "do not lose me" };
  await lower.put("messages", 7, legacy);

  let firstStore!: EncryptedStore;
  const first = fixture({
    migrateLocalData: async () => {
      throw new Error("simulated migration failure before atomic batch");
    },
  });
  firstStore = new EncryptedStore({
    store: lower,
    key: () => first.controller.currentDbKey,
    allowPassthrough: () => first.controller.passthroughAllowed(),
    warn: () => {},
  });

  await assert.rejects(first.controller.enable(CODE), AppLockMigrationError);
  assert.equal(first.controller.state, "LOCKED");
  assert.equal(first.controller.currentDbKey, null);
  assert.deepEqual(first.snapshot().migration, { version: 1, state: "pending" });
  assert.deepEqual(await lower.get("messages", 7), legacy, "failed transaction leaves source plaintext intact");
  await assert.rejects(firstStore.get("messages", 7), /locked/);

  let restartedStore!: EncryptedStore;
  const restarted = fixture({
    snapshot: first.snapshot(),
    clock: first.clock,
    migrateLocalData: async ({ dbKey }) => {
      const ops = await restartedStore.preparePlaintextMigrationOps(dbKey);
      await lower.batch(ops);
      await restartedStore.assertFullyEncryptedAtRest();
    },
  });
  restartedStore = new EncryptedStore({
    store: lower,
    key: () => restarted.controller.currentDbKey,
    allowPassthrough: () => restarted.controller.passthroughAllowed(),
    warn: () => {},
  });

  await restarted.controller.unlock(CODE);
  assert.equal(restarted.controller.state, "UNLOCKED");
  assert.equal(restarted.snapshot().migration, null);
  assert.deepEqual(await restartedStore.get("messages", 7), legacy);
  const raw = await lower.get<Record<string, unknown>>("messages", 7);
  assert.equal(raw?.__gc_enc, 1);
  assert.equal(raw?.text, undefined);
});

test("app_lock: final marker save failure re-locks; encrypted batch resumes without data loss", async () => {
  const lower = new MemoryStore();
  const legacy = { id: 11, chat_id: 4, text: "already encrypted before marker" };
  await lower.put("messages", 11, legacy);

  let firstStore!: EncryptedStore;
  const first = fixture({
    failSaveWhen: (snapshot) => snapshot.container !== null && snapshot.migration === null,
    migrateLocalData: async ({ dbKey }) => {
      await lower.batch(await firstStore.preparePlaintextMigrationOps(dbKey));
      await firstStore.assertFullyEncryptedAtRest();
    },
  });
  firstStore = new EncryptedStore({
    store: lower,
    key: () => first.controller.currentDbKey,
    allowPassthrough: () => first.controller.passthroughAllowed(),
    warn: () => {},
  });

  await assert.rejects(first.controller.enable(CODE), AppLockMigrationError);
  assert.equal(first.controller.state, "LOCKED");
  assert.deepEqual(first.snapshot().migration, { version: 1, state: "pending" });
  const encrypted = await lower.get<Record<string, unknown>>("messages", 11);
  assert.equal(encrypted?.__gc_enc, 1, "data transaction committed before marker save failed");
  assert.equal(encrypted?.text, undefined);

  let resumedStore!: EncryptedStore;
  let preparedOps = -1;
  const resumed = fixture({
    snapshot: first.snapshot(),
    clock: first.clock,
    migrateLocalData: async ({ dbKey }) => {
      const ops = await resumedStore.preparePlaintextMigrationOps(dbKey);
      preparedOps = ops.length;
      await lower.batch(ops);
      await resumedStore.assertFullyEncryptedAtRest();
    },
  });
  resumedStore = new EncryptedStore({
    store: lower,
    key: () => resumed.controller.currentDbKey,
    allowPassthrough: () => resumed.controller.passthroughAllowed(),
    warn: () => {},
  });

  await resumed.controller.unlock(CODE);
  assert.equal(preparedOps, 0, "retry recognizes already-encrypted rows and is idempotent");
  assert.equal(resumed.controller.state, "UNLOCKED");
  assert.equal(resumed.snapshot().migration, null);
  assert.deepEqual(await resumedStore.get("messages", 11), legacy);
});

test("app_lock: failed-attempt throttle is persisted and a successful unlock resets it", async () => {
  const first = fixture();
  await first.controller.enable(CODE, { wipeAfter: null });
  first.controller.lock();

  await assert.rejects(
    first.controller.unlock("wrong"),
    (error: unknown) => error instanceof AppLockFailedError && error.failures === 1 && error.retryAfterSeconds === 1,
  );
  await assert.rejects(
    first.controller.unlock("wrong again"),
    (error: unknown) => error instanceof AppLockThrottledError && error.retryAfterSeconds === 1,
  );

  // Simulate a process restart: attempts/block deadline came from persisted local metadata.
  const restarted = fixture({ snapshot: first.snapshot(), clock: first.clock });
  assert.equal(restarted.controller.state, "COLD");
  assert.equal(restarted.controller.retryAfterSeconds(), 1);
  restarted.clock.advance(1);
  await assert.rejects(
    restarted.controller.unlock("wrong"),
    (error: unknown) => error instanceof AppLockFailedError && error.failures === 2 && error.retryAfterSeconds === 2,
  );
  restarted.clock.advance(2);
  await restarted.controller.unlock(CODE);
  assert.deepEqual(restarted.controller.attempts, { failures: 0, blockedUntil: 0 });
});

test("app_lock: changing code requires the current code and persists the new WRAP", async () => {
  const f = fixture();
  await f.controller.enable(CODE);

  await assert.rejects(f.controller.changeCode("wrong", "new correct horse battery staple"));
  await f.controller.changeCode(CODE, "new correct horse battery staple");
  f.controller.lock();

  await assert.rejects(f.controller.unlock(CODE), AppLockFailedError);
  f.clock.advance(1);
  await f.controller.unlock("new correct horse battery staple");
  assert.equal(f.controller.state, "UNLOCKED");
});

test("app_lock: wipe-after-N destroys WRAP first and runs physical cache cleanup", async () => {
  let wiped = 0;
  const f = fixture({ wipeLocalData: () => { wiped++; } });
  await f.controller.enable(CODE, { wipeAfter: 5 });
  f.controller.lock();

  for (let attempt = 1; attempt <= 4; attempt++) {
    await assert.rejects(f.controller.unlock("wrong"), AppLockFailedError);
    f.clock.advance(appLockDelaySeconds(attempt));
  }
  await assert.rejects(f.controller.unlock("wrong"), AppLockWipedError);

  assert.equal(f.controller.state, "WIPED");
  assert.equal(f.controller.currentDbKey, null);
  assert.equal(wiped, 1);
  assert.equal(isWipedTombstone(f.snapshot().container), true);
  await assert.rejects(f.controller.unlock(CODE), AppLockWipedError);
});

test("app_lock: disable verifies code, wipes cache and returns to explicit passthrough", async () => {
  let wiped = 0;
  const f = fixture({ wipeLocalData: () => { wiped++; } });
  await f.controller.enable(CODE);
  await assert.rejects(f.controller.disableAndWipe("wrong"));
  assert.equal(f.controller.state, "UNLOCKED");

  await f.controller.disableAndWipe(CODE);
  assert.equal(f.controller.state, "DISABLED");
  assert.equal(f.controller.passthroughAllowed(), true);
  assert.equal(f.snapshot().container, null);
  assert.equal(wiped, 1);
});
