import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CryptoSession,
  WrongCodeError,
  createContainer,
  timingSafeEqual,
  unlockContainer,
  zeroize,
  type Argon2idParams,
  type KekFactors,
  type UserSecretDeriver,
  type WrappedContainer,
} from "../src/crypto_store/index.ts";
import { hmacSha256, utf8 } from "../src/crypto_store/primitives.ts";

class TestUserSecret implements UserSecretDeriver {
  async derive(code: string, salt: Uint8Array, _params: Argon2idParams): Promise<Uint8Array> {
    return hmacSha256(utf8(code), salt);
  }
}

const testFactors: KekFactors = {
  user: new TestUserSecret(),
  hw: {
    platformClass: "max",
    ensure: async () => {},
    sHw: async (context) => hmacSha256(utf8("race-device"), context),
  },
};

type UnsafeSessionConstructor = new (
  mk: Uint8Array,
  container: WrappedContainer,
  factors: KekFactors,
) => CryptoSession;
const SessionConstructor = CryptoSession as unknown as UnsafeSessionConstructor;

async function sessionWithOwnedMk(factors = testFactors): Promise<{
  session: CryptoSession;
  mk: Uint8Array;
}> {
  const created = await createContainer({ code: "race-old", platformClass: "max", factors });
  return {
    session: new SessionConstructor(created.mk, created.container, factors),
    mk: created.mk,
  };
}

test("CryptoSession: lock отменяет начатый вывод доменного ключа и чистит его результат", async () => {
  const { session, mk } = await sessionWithOwnedMk();
  const pending = session.domainKey("vault");
  session.lock();

  await assert.rejects(pending, /LOCKED|заблокирован|отмен/i);
  assert.ok(mk.every((byte) => byte === 0));
});

test("CryptoSession: параллельные запросы одного домена получают один принадлежащий сессии буфер", async () => {
  const { session } = await sessionWithOwnedMk();
  const [first, second] = await Promise.all([session.domainKey("db"), session.domainKey("db")]);

  assert.strictEqual(first, second);
  session.lock();
  assert.ok(first.every((byte) => byte === 0));
});

test("CryptoSession: lock во время changeCode не публикует WRAP от обнулённого MK", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const base = new TestUserSecret();
  const gatedUser: UserSecretDeriver = {
    derive: async (code, salt, params) => {
      if (code === "race-new") {
        started();
        await gate;
      }
      return base.derive(code, salt, params);
    },
  };
  const factors = { ...testFactors, user: gatedUser };
  const { session, mk } = await sessionWithOwnedMk(factors);
  const original = session.container;
  const pending = session.changeCode("race-new");
  await didStart;

  session.lock();
  release();

  await assert.rejects(pending, /LOCKED|заблокирован|отмен/i);
  assert.deepEqual(session.container, original);
  assert.ok(mk.every((byte) => byte === 0));
});

test("CryptoSession: lock остаётся идемпотентным после завершённых операций", async () => {
  const { session, mk } = await sessionWithOwnedMk();
  const key = await session.domainKey("drafts");
  session.lock();
  session.lock();
  assert.ok(mk.every((byte) => byte === 0));
  assert.ok(key.every((byte) => byte === 0));
  zeroize(mk, key);
});

test("CryptoSession: конкурентные changeCode сериализуются в порядке вызова", async () => {
  const calls: string[] = [];
  const base = new TestUserSecret();
  const factors: KekFactors = {
    ...testFactors,
    user: {
      derive: async (code, salt, params) => {
        calls.push(code);
        return base.derive(code, salt, params);
      },
    },
  };
  const { session, mk } = await sessionWithOwnedMk(factors);
  calls.length = 0;
  const [first, second] = await Promise.all([
    session.changeCode("first-new-code"),
    session.changeCode("second-new-code"),
  ]);

  assert.deepEqual(calls, ["first-new-code", "second-new-code"]);
  const afterFirst = await unlockContainer({
    code: "first-new-code",
    container: first,
    factors,
  });
  const afterSecond = await unlockContainer({
    code: "second-new-code",
    container: second,
    factors,
  });
  assert.ok(timingSafeEqual(afterFirst, mk));
  assert.ok(timingSafeEqual(afterSecond, mk));
  assert.deepEqual(session.container, second);
  await assert.rejects(
    unlockContainer({ code: "first-new-code", container: session.container, factors }),
    WrongCodeError,
  );
  session.lock();
  zeroize(afterFirst, afterSecond);
});

test("CryptoSession: container getter не даёт изменить внутренний заголовок", async () => {
  const { session } = await sessionWithOwnedMk();
  const outside = session.container as unknown as {
    header: { platformClass: string };
  };
  outside.header.platformClass = "desktop";
  assert.equal(session.container.header.platformClass, "max");
  session.lock();
});
