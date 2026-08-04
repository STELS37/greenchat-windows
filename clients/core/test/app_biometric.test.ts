// T-524 (DS-06): independent biometric WRAP_bio and one-code recovery semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppBiometricError,
  AppLockController,
  BiometricWrapInvalidatedError,
  InvalidBiometricWrapError,
  createBiometricWrap,

  normalizeAppLockSnapshot,
  parseBiometricWrap,
  unlockBiometricWrap,
  type AppLockSnapshot,
} from "../src/index.ts";
import { createContainer } from "../src/crypto_store/index.ts";
import type {
  Argon2idParams,
  HardwareSecretProvider,
  KekFactors,
  LockClock,
  UserSecretDeriver,
} from "../src/crypto_store/index.ts";
import { hmacSha256, utf8 } from "../src/crypto_store/primitives.ts";

import {
  APP_LOCK_BIOMETRIC_FAILURE_LIMIT,
  APP_LOCK_PARANOID_REAUTH_SECONDS,
} from "../src/crypto_store/app_lock.ts";

const CODE = "river amber lantern orbit";

class CountingUserSecret implements UserSecretDeriver {
  calls = 0;
  async derive(code: string, salt: Uint8Array, _params: Argon2idParams): Promise<Uint8Array> {
    this.calls++;
    return hmacSha256(utf8(code), salt);
  }
}

class MutableHardware implements HardwareSecretProvider {
  readonly platformClass = "max" as const;
  calls = 0;
  mode: "ok" | "cancelled" | "busy" | "failed" | "lockout" | "invalidated" = "ok";
  #generation = 1;

  async ensure(): Promise<void> {}

  async sHw(context: Uint8Array): Promise<Uint8Array> {
    this.calls++;
    if (this.mode === "cancelled") throw new Error("SecureKey.hmac: AUTH_CANCELLED");
    if (this.mode === "busy") throw new Error("SecureKey.hmac: AUTH_BUSY");

    if (this.mode === "failed") throw new Error("SecureKey.hmac: AUTH_FAILED");
    if (this.mode === "lockout") throw new Error("SecureKey.hmac: AUTH_LOCKOUT");
    if (this.mode === "invalidated") throw new Error("SecureKey: KEY_INVALIDATED");
    return hmacSha256(new Uint8Array(32).fill(this.#generation), context);
  }

  /** Simulates OS biometric enrollment changing behind an existing WRAP_bio. */
  rotateEnrollment(): void {
    this.#generation++;
  }

  /** Simulates deleting and recreating only the auth-bound biometric key. */
  reset(): void {
    this.#generation++;
    this.mode = "ok";
  }
}

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
    const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= this.now);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

function clone(snapshot: AppLockSnapshot): AppLockSnapshot {
  return structuredClone(snapshot);
}

function biometricFixture(opts: {
  snapshot?: AppLockSnapshot;
  clock?: FakeClock;
  user?: CountingUserSecret;
  recovery?: MutableHardware;
  biometric?: MutableHardware;

  bootId?: string | null;
} = {}) {
  const user = opts.user ?? new CountingUserSecret();
  const recovery = opts.recovery ?? new MutableHardware();
  const biometric = opts.biometric ?? new MutableHardware();
  const factors: KekFactors = { user, hw: recovery };
  let saved = clone(opts.snapshot ?? normalizeAppLockSnapshot());

  const history: AppLockSnapshot[] = [];
  const events: string[] = [];
  const clock = opts.clock ?? new FakeClock();
  let resets = 0;
  const controller = new AppLockController({
    snapshot: saved,
    factors,
    platformClass: "max",
    biometricFactor: biometric,
    resetBiometric: () => {
      resets++;
      events.push("reset-biometric");
      biometric.reset();
    },
    currentBootId: opts.bootId === undefined ? "boot-A" : opts.bootId,
    persistence: { save: (next) => {
      saved = clone(next);
      history.push(clone(saved));
      events.push(`save:${saved.container && "magic" in saved.container ? saved.container.magic : "container"}:${saved.biometric.wrap ? "bio" : "no-bio"}`);
    } },
    migrateLocalData: async () => {},
    clock,
  });
  return {
    controller,
    user,
    recovery,
    biometric,
    clock,
    snapshot: () => clone(saved),
    resets: () => resets,

    history: () => history.map(clone),
    events: () => [...events],
  };
}

test("WRAP_bio round-trips MK, binds to WRAP_code, and a changed key invalidates only the fast wrap", async () => {
  const provider = new MutableHardware();
  const recovery = new MutableHardware();
  const user = new CountingUserSecret();
  const created = await createContainer({
    code: CODE,
    platformClass: "max",
    factors: { user, hw: recovery },
  });
  const mk = created.mk;
  const before = mk.slice();
  const wrap = await createBiometricWrap(mk, provider, created.container);

  assert.deepEqual(mk, before, "creating the secondary wrap must not mutate the live MK");
  assert.equal(parseBiometricWrap(wrap).magic, "gc-app-lock-bio-wrap");
  assert.notEqual(wrap.wrap, Buffer.from(mk).toString("base64"));
  assert.deepEqual(await unlockBiometricWrap(wrap, provider, created.container), mk);

  const foreignContainer = structuredClone(created.container);
  const foreignBytes = Buffer.from(foreignContainer.wrap, "base64");
  foreignBytes[0] = foreignBytes[0]! ^ 1;
  (foreignContainer as { wrap: string }).wrap = foreignBytes.toString("base64");
  await assert.rejects(
    unlockBiometricWrap(wrap, provider, foreignContainer),
    InvalidBiometricWrapError,
    "a valid biometric wrap must not be transferable to a different WRAP_code",
  );

  provider.rotateEnrollment();
  await assert.rejects(
    unlockBiometricWrap(wrap, provider, created.container),
    BiometricWrapInvalidatedError,
  );
  assert.throws(() => parseBiometricWrap({ ...wrap, extra: true }), InvalidBiometricWrapError);
  assert.throws(() => parseBiometricWrap({ ...wrap, iv: "AA==" }), InvalidBiometricWrapError);
  mk.fill(0);
});

test("biometric unlock is a fast path: no user KDF, no code-attempt mutation, and under 300 ms with a ready provider", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  const codeKdfCalls = f.user.calls;
  const attempts = f.controller.attempts;
  f.controller.lock();

  const started = performance.now();
  await f.controller.unlockBiometric();
  const elapsed = performance.now() - started;

  assert.equal(f.controller.state, "UNLOCKED");
  assert.equal(f.user.calls, codeKdfCalls, "biometric path must not run Argon2/user KDF");
  assert.deepEqual(f.controller.attempts, attempts, "biometric success does not touch code-attempt policy");
  assert.ok(elapsed < 300, `ready fake biometric path took ${elapsed.toFixed(1)} ms`);
});

test("cancel/busy never consume a code attempt or destroy a valid WRAP_bio", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  const originalWrap = f.snapshot().biometric.wrap;
  f.controller.lock();

  f.biometric.mode = "cancelled";
  await assert.rejects(
    f.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "cancelled",
  );
  assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });
  assert.deepEqual(f.snapshot().biometric.wrap, originalWrap);

  f.biometric.mode = "busy";
  await assert.rejects(
    f.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "busy",
  );
  assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });
  assert.deepEqual(f.snapshot().biometric.wrap, originalWrap);
});

test("enrollment change burns only WRAP_bio; exactly one code unlock repairs it", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  f.controller.lock();

  f.biometric.rotateEnrollment();
  await assert.rejects(
    f.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "code_required",
  );
  assert.equal(f.controller.state, "LOCKED");
  assert.equal(f.snapshot().biometric.enabled, true);
  assert.equal(f.snapshot().biometric.wrap, null, "stale secondary wrap is discarded");
  assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });

  const beforeRepairKdf = f.user.calls;
  await f.controller.unlock(CODE);
  assert.equal(f.user.calls, beforeRepairKdf + 1, "one code verification repairs the fast door");
  assert.ok(f.snapshot().biometric.wrap, "successful code recovery recreated WRAP_bio");
  assert.ok(f.resets() >= 2, "only the biometric alias was recreated");

  f.controller.lock();
  const afterRepairKdf = f.user.calls;
  await f.controller.unlockBiometric();
  assert.equal(f.user.calls, afterRepairKdf, "repaired biometric path no longer needs the code");
  assert.equal(f.controller.state, "UNLOCKED");
});

test("cold-entry rule requires code before any biometric prompt, then repairs normal fast access", async () => {
  const first = biometricFixture();
  await first.controller.enable(CODE);
  await first.controller.setBiometricEnabled(true);
  first.controller.lock();
  const snapshot = first.snapshot();
  const clock = first.clock;
  first.controller.dispose();

  clock.advance(7 * 24 * 60 * 60 + 1);
  const restarted = biometricFixture({
    snapshot,
    clock,
    user: first.user,
    recovery: first.recovery,
    biometric: first.biometric,
  });
  const callsBefore = restarted.biometric.calls;
  assert.equal(restarted.controller.biometric.codeRequired, true);
  await assert.rejects(
    restarted.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "code_required",
  );
  assert.equal(restarted.biometric.calls, callsBefore, "cold policy is checked before invoking biometrics");

  await restarted.controller.unlock(CODE);
  restarted.controller.lock();
  await restarted.controller.unlockBiometric();
  assert.equal(restarted.controller.state, "UNLOCKED");
});

test("disabling biometrics deletes only WRAP_bio and leaves code recovery authoritative", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  await f.controller.setBiometricEnabled(false);
  assert.deepEqual(f.controller.biometric, {
    available: true,
    enabled: false,
    ready: false,
    codeRequired: false,
    failures: 0,
  });
  assert.equal(f.snapshot().biometric.wrap, null);

  f.controller.lock();
  await assert.rejects(
    f.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "disabled",
  );
  await f.controller.unlock(CODE);
  assert.equal(f.controller.state, "UNLOCKED");
});


test("changing the app code rebinds WRAP_bio to the new WRAP_code", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  const oldWrap = JSON.stringify(f.snapshot().biometric.wrap);

  await f.controller.changeCode(CODE, "new river amber lantern orbit");
  const next = f.snapshot();
  assert.ok(next.biometric.wrap);
  assert.notEqual(JSON.stringify(next.biometric.wrap), oldWrap);

  f.controller.lock();
  await f.controller.unlockBiometric();
  assert.equal(f.controller.state, "UNLOCKED");
});

test("wipe persists no tombstone while a live WRAP_bio still exists", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  assert.ok(f.snapshot().biometric.wrap);

  await f.controller.wipe();
  assert.equal(f.controller.state, "WIPED");
  const tombstones = f.history().filter((snapshot) =>
    snapshot.container !== null &&
    "magic" in snapshot.container &&
    snapshot.container.magic === "gc-crypto-store-wiped",
  );
  assert.ok(tombstones.length > 0);
  for (const snapshot of tombstones) {
    assert.equal(snapshot.biometric.wrap, null);
    assert.equal(snapshot.biometric.enabled, false);
  }

  const events = f.events();
  const tombstoneAt = events.findIndex((event) => event === "save:gc-crypto-store-wiped:no-bio");
  assert.ok(tombstoneAt >= 0);
  const resetAt = events.slice(0, tombstoneAt).lastIndexOf("reset-biometric");
  assert.ok(resetAt >= 0 && resetAt < tombstoneAt, "native bio-key deletion precedes tombstone persistence");
});


test("T-525: cancellation/busy do not count; five biometric failures require one app-code recovery", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  f.controller.lock();
  const wrap = f.snapshot().biometric.wrap;

  for (const mode of ["cancelled", "busy"] as const) {
    f.biometric.mode = mode;
    await assert.rejects(
      f.controller.unlockBiometric(),
      (error: unknown) => error instanceof AppBiometricError && error.problem === mode,
    );
    assert.equal(f.snapshot().biometric.failures, 0);
    assert.deepEqual(f.snapshot().biometric.wrap, wrap);
    assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });
  }

  f.biometric.mode = "failed";
  for (let attempt = 1; attempt <= APP_LOCK_BIOMETRIC_FAILURE_LIMIT; attempt++) {
    await assert.rejects(
      f.controller.unlockBiometric(),
      (error: unknown) => error instanceof AppBiometricError && error.problem === (
        attempt === APP_LOCK_BIOMETRIC_FAILURE_LIMIT ? "code_required" : "failed"
      ),
    );
    assert.equal(f.snapshot().biometric.failures, attempt);
    assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });
  }
  assert.equal(f.controller.cold.reason, "biometric_failures");
  assert.deepEqual(f.snapshot().biometric.wrap, wrap, "five misses do not destroy the valid fast wrap");

  f.biometric.mode = "ok";
  const callsBeforeGate = f.biometric.calls;
  await assert.rejects(
    f.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "code_required",
  );
  assert.equal(f.biometric.calls, callsBeforeGate, "the app-code gate is checked before invoking the OS prompt");

  await f.controller.unlock(CODE);
  assert.equal(f.snapshot().biometric.failures, 0);
  assert.equal(f.controller.cold.reason, null);
  f.controller.lock();
  await f.controller.unlockBiometric();
  assert.equal(f.controller.state, "UNLOCKED");
});

test("T-525: native OS lockout jumps directly to the code screen without code-attempt punishment", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  f.controller.lock();
  f.biometric.mode = "lockout";

  await assert.rejects(
    f.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "code_required",
  );
  assert.equal(f.snapshot().biometric.failures, APP_LOCK_BIOMETRIC_FAILURE_LIMIT);
  assert.equal(f.controller.cold.reason, "biometric_failures");
  assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });
});

test("T-525: OS reboot marker mismatch requires code once and then restores biometric access", async () => {
  const first = biometricFixture({ bootId: "boot-A" });
  await first.controller.enable(CODE);
  await first.controller.setBiometricEnabled(true);
  first.controller.lock();
  const snapshot = first.snapshot();
  first.controller.dispose();

  const restarted = biometricFixture({
    snapshot,
    clock: first.clock,
    user: first.user,
    recovery: first.recovery,
    biometric: first.biometric,
    bootId: "boot-B",
  });
  const callsBefore = restarted.biometric.calls;
  assert.equal(restarted.controller.cold.reason, "reboot");
  await assert.rejects(
    restarted.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "code_required",
  );
  assert.equal(restarted.biometric.calls, callsBefore);

  await restarted.controller.unlock(CODE);
  assert.equal(restarted.snapshot().cold.bootId, "boot-B");
  restarted.controller.lock();
  await restarted.controller.unlockBiometric();
  assert.equal(restarted.controller.state, "UNLOCKED");
});

test("T-525 acceptance: an active default-profile week performs zero additional code KDFs", async () => {
  const f = biometricFixture();
  await f.controller.enable(CODE);
  await f.controller.setBiometricEnabled(true);
  const initialCodeCalls = f.user.calls;

  for (let day = 0; day < 7; day++) {
    f.controller.lock();
    await f.controller.unlockBiometric();
    f.clock.advance(24 * 60 * 60);
  }
  assert.equal(f.user.calls, initialCodeCalls, "normal active week must require zero app-code entries");
  assert.equal(f.controller.cold.reason, null);
});

test("T-525: paranoid profile adds 48h code reauth while default never does", async () => {
  const defaultProfile = biometricFixture();
  await defaultProfile.controller.enable(CODE);
  await defaultProfile.controller.setBiometricEnabled(true);
  defaultProfile.clock.advance(APP_LOCK_PARANOID_REAUTH_SECONDS + 1);
  defaultProfile.controller.lock();
  await defaultProfile.controller.unlockBiometric();
  assert.equal(defaultProfile.controller.state, "UNLOCKED", "default profile has no periodic code timer");

  const paranoid = biometricFixture();
  await paranoid.controller.enable(CODE);
  await paranoid.controller.setBiometricEnabled(true);
  await paranoid.controller.setProfile("paranoid");
  paranoid.clock.advance(APP_LOCK_PARANOID_REAUTH_SECONDS + 1);
  paranoid.controller.lock();
  assert.equal(paranoid.controller.cold.reason, "periodic_reauth");
  await assert.rejects(
    paranoid.controller.unlockBiometric(),
    (error: unknown) => error instanceof AppBiometricError && error.problem === "code_required",
  );
  await paranoid.controller.unlock(CODE);
  assert.equal(paranoid.controller.cold.reason, null);
});
