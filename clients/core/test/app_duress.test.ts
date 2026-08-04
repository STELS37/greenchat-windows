// T-526 (DS-08): duress code crypto envelope, one-pass unlock and silent fresh-install transition.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppLockController,
  normalizeAppLockSnapshot,
  type AppLockSnapshot,
} from "../src/index.ts";
import {
  CryptoSession,

  DuressCodeConflictError,
  WrongCodeError,
  createContainer,
  fromBase64,

  isWipedTombstone,
  type Argon2idParams,
  type DuressAction,
  type KekFactors,
  type UserSecretDeriver,
} from "../src/crypto_store/index.ts";

import { unlockContainerOrDuress } from "../src/crypto_store/container.ts";
import { hmacSha256, utf8 } from "../src/crypto_store/primitives.ts";

const CODE = "correct horse battery staple";
const DURESS = "silent river warning phrase";
const NEXT_CODE = "new correct horse battery staple";

class CountingUserSecret implements UserSecretDeriver {
  calls = 0;
  async derive(code: string, salt: Uint8Array, _params: Argon2idParams): Promise<Uint8Array> {
    this.calls++;
    return hmacSha256(utf8(code), salt);
  }
}

function factors(user = new CountingUserSecret()): KekFactors & { user: CountingUserSecret } {
  return { user, hw: null };
}

async function configuredContainer(trustedUsername: string | null = "trusted_friend") {
  const f = factors();
  const created = await createContainer({
    code: CODE,
    platformClass: "web-user-only",
    factors: f,
  });
  const session = CryptoSession.adoptMasterKey({
    mk: created.mk,
    container: created.container,
    factors: f,
  });
  const container = await session.configureDuress(CODE, DURESS, trustedUsername);
  session.lock();
  return { container, factors: f };
}

test("T-526 container: ordinary, duress and wrong entries each perform exactly one user KDF", async () => {
  const setup = await configuredContainer();

  setup.factors.user.calls = 0;
  const ordinary = await unlockContainerOrDuress({ code: CODE, container: setup.container, factors: setup.factors });
  assert.equal(ordinary.kind, "unlock");
  if (ordinary.kind === "unlock") ordinary.mk.fill(0);
  assert.equal(setup.factors.user.calls, 1);

  setup.factors.user.calls = 0;
  const duress = await unlockContainerOrDuress({ code: DURESS, container: setup.container, factors: setup.factors });
  assert.deepEqual(duress, { kind: "duress", action: { trustedUsername: "trusted_friend" } });
  assert.equal(setup.factors.user.calls, 1);

  setup.factors.user.calls = 0;
  await assert.rejects(
    unlockContainerOrDuress({ code: "totally wrong phrase", container: setup.container, factors: setup.factors }),
    WrongCodeError,
  );
  assert.equal(setup.factors.user.calls, 1);
});

test("T-526 envelope: trusted username is fixed-size encrypted and AAD prevents removal/tamper", async () => {
  const setup = await configuredContainer("contact_123");
  const envelope = setup.container.header.duress;
  assert.ok(envelope);
  assert.equal(fromBase64(envelope.payload).byteLength, 48, "32-byte fixed payload + 16-byte GCM tag");
  const serialized = JSON.stringify(setup.container);
  assert.ok(!serialized.includes("contact_123"));
  assert.ok(!serialized.includes(DURESS));

  const removed = structuredClone(setup.container) as unknown as Record<string, unknown>;
  const removedHeader = { ...setup.container.header } as Record<string, unknown>;
  delete removedHeader.duress;
  removed.header = removedHeader;
  await assert.rejects(
    unlockContainerOrDuress({ code: CODE, container: removed as never, factors: setup.factors }),
    WrongCodeError,
    "removing authenticated duress metadata must invalidate the main WRAP",
  );

  const changed = structuredClone(setup.container);
  if (!changed.header.duress) throw new Error("missing duress envelope");
  const changedEnvelope = { ...changed.header.duress, signal: !changed.header.duress.signal };
  const changedContainer = {
    ...changed,
    header: { ...changed.header, duress: changedEnvelope },
  };
  await assert.rejects(
    unlockContainerOrDuress({ code: CODE, container: changedContainer, factors: setup.factors }),
    WrongCodeError,
  );
});

function clone(snapshot: AppLockSnapshot): AppLockSnapshot {
  return structuredClone(snapshot);
}

function controllerFixture() {
  const f = factors();
  let saved = normalizeAppLockSnapshot();
  let physicalWipes = 0;
  const actions: DuressAction[] = [];
  const events: string[] = [];

  const persistenceHistory: AppLockSnapshot[] = [];
  const controller = new AppLockController({
    snapshot: saved,
    factors: f,
    platformClass: "web-user-only",
    migrateLocalData: async () => {},
    persistence: { save(next) { saved = clone(next); persistenceHistory.push(clone(next)); } },
    wipeLocalData: () => { physicalWipes++; events.push("physical-wipe"); },
    onDuress: (action) => { actions.push(action); events.push("duress-callback"); },
  });
  controller.subscribe((state) => events.push(`state:${state}`));
  return {
    controller,
    factors: f,
    snapshot: () => clone(saved),
    physicalWipes: () => physicalWipes,
    actions,
    events,

    persistenceHistory,
  };
}

test("T-526 controller: duress entry silently crypto-erases and lands on fresh-install state", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);
  await f.controller.configureDuress(CODE, DURESS, "trusted_friend");
  assert.deepEqual(f.controller.duress, { enabled: true, signal: true });
  assert.ok(!JSON.stringify(f.snapshot()).includes("trusted_friend"));
  assert.ok(!JSON.stringify(f.snapshot()).includes(DURESS));

  f.controller.lock();
  f.events.length = 0;
  await f.controller.unlock(DURESS);

  assert.equal(f.controller.state, "DISABLED");
  assert.equal(f.controller.passthroughAllowed(), true);
  assert.equal(f.snapshot().container, null);

  assert.equal(
    f.persistenceHistory.some((snapshot) => isWipedTombstone(snapshot.container)),
    false,
    "duress persistence must atomically replace WRAP with a fresh snapshot, never a WIPED receipt",
  );
  assert.deepEqual(f.controller.attempts, { failures: 0, blockedUntil: 0 });
  assert.equal(f.physicalWipes(), 1);
  assert.deepEqual(f.actions, [{ trustedUsername: "trusted_friend" }]);
  assert.ok(!f.events.includes("state:WIPED"), "observer must never see a wipe receipt during duress");
  assert.ok(f.events.indexOf("duress-callback") < f.events.indexOf("state:DISABLED"));
});

test("T-526 lifecycle: replace/remove works, and changing ordinary code preserves duress", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);
  await f.controller.configureDuress(CODE, DURESS, null);
  assert.deepEqual(f.controller.duress, { enabled: true, signal: false });


  const beforeConflict = JSON.stringify(f.snapshot().container);
  await assert.rejects(f.controller.changeCode(CODE, DURESS), DuressCodeConflictError);
  assert.equal(JSON.stringify(f.snapshot().container), beforeConflict, "conflicting rotation must not mutate WRAP");

  await f.controller.changeCode(CODE, NEXT_CODE);
  f.controller.lock();
  const actionCount = f.actions.length;
  await f.controller.unlock(DURESS);
  assert.equal(f.actions.length, actionCount + 1, "duress verifier survives ordinary code rotation");

  const clean = controllerFixture();
  await clean.controller.enable(CODE);
  await clean.controller.configureDuress(CODE, DURESS, null);
  await clean.controller.disableDuress(CODE);
  assert.deepEqual(clean.controller.duress, { enabled: false, signal: false });
  clean.controller.lock();
  await assert.rejects(clean.controller.unlock(DURESS));
});


test("T-526 beta.3: v2 fixed payload round-trips a full 32-character trusted username", async () => {
  const username = "a" + "b".repeat(31);
  const setup = await configuredContainer(username);
  assert.equal(setup.container.header.duress?.version, 2);
  assert.equal(fromBase64(setup.container.header.duress?.payload ?? "").byteLength, 48);
  assert.ok(!JSON.stringify(setup.container).includes(username));

  const result = await unlockContainerOrDuress({
    code: DURESS,
    container: setup.container,
    factors: setup.factors,
  });
  assert.deepEqual(result, { kind: "duress", action: { trustedUsername: username } });
});

test("T-526 beta.3: a crash after WRAP destruction leaves a durable generic cleanup marker", async () => {
  const first = controllerFixture();
  await first.controller.enable(CODE);
  await first.controller.configureDuress(CODE, DURESS, null);
  first.controller.lock();
  await first.controller.unlock(DURESS);

  const pending = first.snapshot();
  assert.equal(pending.container, null);
  assert.equal(pending.localResetPending, true);
  first.controller.dispose();

  let saved = clone(pending);
  let recoveryWipes = 0;
  const restarted = new AppLockController({
    snapshot: saved,
    factors: first.factors,
    platformClass: "web-user-only",
    migrateLocalData: async () => {},
    persistence: { save(next) { saved = clone(next); } },
    wipeLocalData: () => { recoveryWipes++; },
  });

  assert.equal(restarted.state, "DISABLED");
  assert.equal(restarted.localResetPending, true);
  await restarted.completeLocalReset();
  assert.equal(recoveryWipes, 1);
  assert.equal(saved.localResetPending, false);

  await restarted.completeLocalReset();
  assert.equal(recoveryWipes, 1, "cleanup completion is idempotent after the marker is cleared");
  restarted.dispose();
});
