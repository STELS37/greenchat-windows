import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARGON2_WEAK,
  Argon2idUserSecret,
  CryptoSession,
  InvalidContainerError,
  WebAuthnPrfUnavailableError,
  WrongCodeError,
  createContainer,
  deriveDomainKey,
  fromBase64,
  keyringHardwareSecret,
  platformRequiresPassphrase,
  rewrapContainer,
  selectPlatformClass,

  secureKeyBiometricSecret,
  secureKeyHardwareSecret,
  timingSafeEqual,
  toBase64,
  unlockContainer,
  webauthnPrfHardwareSecret,
  zeroize,
  type Argon2idParams,
  type HardwareSecretProvider,
  type HardwarePlatformClass,
  type KekFactors,
  type PlatformClass,

  type SecureKey,
  type UserSecretDeriver,
  type WrappedContainer,
} from "../src/crypto_store/index.ts";
import {
  createSodiumLoader,
  type SodiumLike,
} from "../src/crypto_store/argon2.ts";
import { concatBytes, hmacSha256, utf8 } from "../src/crypto_store/primitives.ts";

class HmacUserSecret implements UserSecretDeriver {
  readonly calls: Array<{ code: string; salt: Uint8Array; params: Argon2idParams }> = [];
  readonly outputs: Uint8Array[] = [];

  async derive(code: string, salt: Uint8Array, params: Argon2idParams): Promise<Uint8Array> {
    this.calls.push({ code, salt: salt.slice(), params: { ...params } });
    const key = utf8(`fake-user:${code}`);
    const input = concatBytes(
      salt,
      utf8(`${params.memLimitKib}:${params.opsLimit}:${params.parallelism}`),
    );
    try {
      const output = await hmacSha256(key, input);
      this.outputs.push(output);
      return output;
    } finally {
      zeroize(key, input);
    }
  }
}

class HmacHardwareSecret implements HardwareSecretProvider {
  readonly platformClass: HardwarePlatformClass;
  readonly outputs: Uint8Array[] = [];
  ensureCalls = 0;
  readonly #key = utf8("fake-device-key-for-tests-only");

  constructor(platformClass: HardwarePlatformClass = "max") {
    this.platformClass = platformClass;
  }

  async ensure(): Promise<void> {
    this.ensureCalls += 1;
  }

  async sHw(context: Uint8Array): Promise<Uint8Array> {
    const output = await hmacSha256(this.#key, context);
    this.outputs.push(output);
    return output;
  }
}

function factors(): {
  factors: KekFactors;
  user: HmacUserSecret;
  hw: HmacHardwareSecret;
} {
  const user = new HmacUserSecret();
  const hw = new HmacHardwareSecret();
  return { factors: { user, hw }, user, hw };
}

async function expectCreateRejected(platformClass: PlatformClass, hw: HardwareSecretProvider | null) {
  const user = new HmacUserSecret();
  let accepted: Awaited<ReturnType<typeof createContainer>> | null = null;
  try {
    accepted = await createContainer({ code: "correct horse", platformClass, factors: { user, hw } });
  } catch (error) {
    assert.match(String(error), /platform|S_hw|аппаратн/i);
    return;
  }
  zeroize(accepted.mk);
  assert.fail(`platformClass=${platformClass} accepted an inconsistent S_hw provider`);
}

test("crypto_store: create → WRAP → unwrap сохраняет MK, неверный код не проходит GCM", async () => {
  const f = factors();
  const created = await createContainer({
    code: "correct horse",
    platformClass: "max",
    factors: f.factors,
  });
  const expectedMk = created.mk.slice();

  await assert.rejects(
    unlockContainer({ code: "wrong code", container: created.container, factors: f.factors }),
    WrongCodeError,
  );
  const unlocked = await unlockContainer({
    code: "correct horse",
    container: structuredClone(created.container),
    factors: f.factors,
  });

  assert.equal(unlocked.byteLength, 32);
  assert.ok(timingSafeEqual(unlocked, expectedMk));
  assert.equal(created.container.header.userSalt.length, 24);
  assert.equal(created.container.header.kekSalt.length, 24);
  assert.equal(created.container.header.wrapIv.length, 16);
  assert.equal(created.container.wrap.length, 64);
  assert.ok(f.user.outputs.every((output) => output.every((byte) => byte === 0)));
  assert.ok(f.hw.outputs.every((output) => output.every((byte) => byte === 0)));
  zeroize(created.mk, expectedMk, unlocked);
});

test("crypto_store: base64 различает повреждённую и неканоническую запись", () => {
  assert.throws(() => fromBase64("!!!!"), /некорректный base64/);
  assert.throws(() => fromBase64("Zh=="), /неканонический base64/);
});

test("crypto_store: доменные HKDF-ключи детерминированы и разделены по доменам", async () => {
  const mk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const domains = ["db", "files", "drafts", "vault"] as const;
  const keys = await Promise.all(domains.map((domain) => deriveDomainKey(mk, domain)));
  const repeatedDb = await deriveDomainKey(mk, "db");

  assert.deepEqual(repeatedDb, keys[0]);
  assert.equal(new Set(keys.map((key) => Buffer.from(key).toString("hex"))).size, domains.length);
  zeroize(mk, repeatedDb, ...keys);
});

test("crypto_store: смена кода переоборачивает тот же MK и отключает старый код", async () => {
  const f = factors();
  const created = await createContainer({ code: "old phrase", platformClass: "max", factors: f.factors });
  const expectedMk = created.mk.slice();
  const next = await rewrapContainer({
    mk: created.mk,
    newCode: "new phrase",
    container: created.container,
    factors: f.factors,
  });

  assert.ok(timingSafeEqual(created.mk, expectedMk), "rewrap must not mutate or replace MK");
  assert.notEqual(next.wrap, created.container.wrap);
  assert.notEqual(next.header.kekSalt, created.container.header.kekSalt);
  assert.notEqual(next.header.wrapIv, created.container.header.wrapIv);
  await assert.rejects(
    unlockContainer({ code: "old phrase", container: next, factors: f.factors }),
    WrongCodeError,
  );
  const unlocked = await unlockContainer({ code: "new phrase", container: next, factors: f.factors });
  assert.ok(timingSafeEqual(unlocked, expectedMk));
  zeroize(created.mk, expectedMk, unlocked);
});

test("crypto_store: lock обнуляет MK и все выданные доменные буферы", async () => {
  const f = factors();
  const created = await createContainer({ code: "lock me", platformClass: "max", factors: f.factors });
  type UnsafeSessionConstructor = new (
    mk: Uint8Array,
    container: WrappedContainer,
    factors: KekFactors,
  ) => CryptoSession;
  const SessionConstructor = CryptoSession as unknown as UnsafeSessionConstructor;
  const session = new SessionConstructor(created.mk, created.container, f.factors);
  const db = await session.domainKey("db");
  const files = await session.domainKey("files");

  session.lock();

  assert.equal(session.isUnlocked, false);
  assert.ok(created.mk.every((byte) => byte === 0));
  assert.ok(db.every((byte) => byte === 0));
  assert.ok(files.every((byte) => byte === 0));
  await assert.rejects(session.domainKey("db"), /LOCKED|заблокирована/);
});

test("crypto_store: Argon2id-параметры заголовка читаются и передаются дериверу", async () => {
  const createFactors = factors();
  const created = await createContainer({
    code: "weak-device-code",
    platformClass: "max",
    factors: createFactors.factors,
    argon2: ARGON2_WEAK,
  });
  assert.deepEqual(created.container.header.argon2, ARGON2_WEAK);
  assert.deepEqual(createFactors.user.calls.at(-1)?.params, ARGON2_WEAK);

  const unlockFactors = factors();
  const unlocked = await unlockContainer({
    code: "weak-device-code",
    container: structuredClone(created.container),
    factors: unlockFactors.factors,
  });
  assert.deepEqual(unlockFactors.user.calls.at(-1)?.params, ARGON2_WEAK);
  zeroize(created.mk, unlocked);
});

test("crypto_store: версия 1 принимает только m=64/32 МиБ, t=3, p=1", async () => {
  const invalid = [
    { ...ARGON2_WEAK, memLimitKib: 8 * 1024 },
    { ...ARGON2_WEAK, opsLimit: 1 },
    { ...ARGON2_WEAK, parallelism: 2 },
  ];
  for (const argon2 of invalid) {
    await assert.rejects(
      createContainer({
        code: "too weak",
        platformClass: "max",
        factors: factors().factors,
        argon2,
      }),
      /Argon2id|параметр/i,
    );
  }
});

test("crypto_store: реальный libsodium Argon2id соблюдает 32 МиБ/t=3/p=1", async () => {
  const deriver = new Argon2idUserSecret();
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
  const first = await deriver.derive("argon-test-code", salt, ARGON2_WEAK);
  const second = await deriver.derive("argon-test-code", salt, { ...ARGON2_WEAK });
  assert.equal(first.byteLength, 32);
  assert.deepEqual(first, second);
  assert.equal(
    Buffer.from(first).toString("hex"),
    "401c0d0ba43f3b85c895e128bba62fdbfa094d3f36767c0af063bf0fda4fd9b5",
  );
  zeroize(first, second, salt);
});

function fakeSodium(ready: Promise<void> = Promise.resolve()): SodiumLike {
  return {
    ready,
    crypto_pwhash_SALTBYTES: 16,
    crypto_pwhash_ALG_ARGON2ID13: 2,
    crypto_pwhash: () => new Uint8Array(32),
  };
}

test("crypto_store: loader libsodium повторяет import/ready после временного отказа", async () => {
  for (const failedPhase of ["import", "ready"] as const) {
    let imports = 0;
    const loaded = fakeSodium();
    const loader = createSodiumLoader(async () => {
      imports += 1;
      if (imports === 1) {
        if (failedPhase === "import") throw new Error("temporary import failure");
        return { default: fakeSodium(Promise.reject(new Error("temporary ready failure"))) };
      }
      return { default: loaded };
    });

    await assert.rejects(loader(), /temporary/);
    assert.strictEqual(await loader(), loaded);
    assert.strictEqual(await loader(), loaded);
    assert.equal(imports, 2, `${failedPhase}: success must stay cached`);
  }
});

test("crypto_store: класс платформы и наличие S_hw всегда согласованы", async () => {
  for (const platformClass of ["max", "desktop", "web-prf"] as const) {
    await expectCreateRejected(platformClass, null);
  }
  await expectCreateRejected("web-user-only", new HmacHardwareSecret());
  await expectCreateRejected("desktop", new HmacHardwareSecret("max"));
  await expectCreateRejected("web-prf", new HmacHardwareSecret("desktop"));

  const created = await createContainer({
    code: "class-bound",
    platformClass: "max",
    factors: factors().factors,
  });
  const user = new HmacUserSecret();
  await assert.rejects(
    unlockContainer({
      code: "class-bound",
      container: created.container,
      factors: { user, hw: new HmacHardwareSecret("desktop") },
    }),
    /platformClass.*desktop/i,
  );
  assert.equal(user.calls.length, 0, "provider class mismatch must fail before KDF");
  zeroize(created.mk);
});

test("crypto_store: заголовок валидируется и аутентифицируется как AES-GCM AAD", async () => {
  const f = factors();
  const created = await createContainer({ code: "header-code", platformClass: "max", factors: f.factors });

  const tamperedClass: WrappedContainer = {
    ...structuredClone(created.container),
    header: { ...created.container.header, platformClass: "desktop" },
  };
  await assert.rejects(
    unlockContainer({
      code: "header-code",
      container: tamperedClass,
      factors: { user: f.user, hw: new HmacHardwareSecret("desktop") },
    }),
    WrongCodeError,
  );

  const nonCanonical: WrappedContainer = {
    ...structuredClone(created.container),
    header: {
      ...created.container.header,
      userSalt: `${created.container.header.userSalt}=`,
    },
  };
  await assert.rejects(
    unlockContainer({ code: "header-code", container: nonCanonical, factors: f.factors }),
    /base64|userSalt|заголов/i,
  );

  const badMagic = structuredClone(created.container) as unknown as {
    header: Record<string, unknown>;
    wrap: string;
  };
  badMagic.header.magic = "not-green-chat";
  await assert.rejects(
    unlockContainer({
      code: "header-code",
      container: badMagic as unknown as WrappedContainer,
      factors: f.factors,
    }),
    /magic|заголов|формат/i,
  );

  // Порядок JSON-полей не является частью формата: AAD строится канонически.
  const h = created.container.header;
  const reordered: WrappedContainer = {
    header: {
      usesHardwareSecret: h.usesHardwareSecret,
      wrapIv: h.wrapIv,
      userSalt: h.userSalt,
      platformClass: h.platformClass,
      version: h.version,
      magic: h.magic,
      kekSalt: h.kekSalt,
      argon2: {
        parallelism: h.argon2.parallelism,
        memLimitKib: h.argon2.memLimitKib,
        opsLimit: h.argon2.opsLimit,
      },
    },
    wrap: created.container.wrap,
  };
  const reorderedMk = await unlockContainer({
    code: "header-code",
    container: reordered,
    factors: f.factors,
  });
  assert.ok(timingSafeEqual(reorderedMk, created.mk));
  zeroize(reorderedMk);
  zeroize(created.mk);
});

test("crypto_store: строгие границы формата отклоняются до вызова дорогого KDF", async () => {
  const f = factors();
  const created = await createContainer({ code: "parse-first", platformClass: "max", factors: f.factors });
  type MutableContainer = {
    header: Record<string, unknown>;
    wrap?: unknown;
    [key: string]: unknown;
  };
  const argon = (container: MutableContainer) =>
    container.header.argon2 as Record<string, unknown>;
  const cases: ReadonlyArray<readonly [string, (container: MutableContainer) => void]> = [
    ["unknown container key", (container) => { container.unexpected = true; }],
    ["missing container key", (container) => { delete container.wrap; }],
    ["unknown header key", (container) => { container.header.unexpected = true; }],
    ["missing header key", (container) => { delete container.header.wrapIv; }],
    ["unknown Argon2 key", (container) => { argon(container).unexpected = true; }],
    ["missing Argon2 key", (container) => { delete argon(container).parallelism; }],
    ["wrong field type", (container) => { container.header.usesHardwareSecret = "true"; }],
    ["wrong decoded length", (container) => { container.header.userSalt = toBase64(new Uint8Array(15)); }],
    ["platform/hardware mismatch", (container) => { container.header.platformClass = "web-user-only"; }],
    ["oversized base64", (container) => { container.header.userSalt = "A".repeat(1_000_000); }],
    ["wrong wrap type", (container) => { container.wrap = 42; }],
    ["wrong wrap length", (container) => { container.wrap = toBase64(new Uint8Array(47)); }],
  ];

  for (const [label, mutate] of cases) {
    const callsBefore = f.user.calls.length;
    const malformed = structuredClone(created.container) as unknown as MutableContainer;
    mutate(malformed);
    await assert.rejects(
      unlockContainer({
        code: "parse-first",
        container: malformed as unknown as WrappedContainer,
        factors: f.factors,
      }),
      InvalidContainerError,
      label,
    );
    assert.equal(f.user.calls.length, callsBefore, `${label}: KDF must not run`);
  }
  zeroize(created.mk);
});

test("crypto_store: промежуточный S_user обнуляется, даже если аппаратный фактор отказал", async () => {
  const user = new HmacUserSecret();
  const hw: HardwareSecretProvider = {
    platformClass: "max",
    ensure: async () => {
      throw new Error("biometric unavailable");
    },
    sHw: async () => new Uint8Array(32),
  };
  await assert.rejects(
    createContainer({ code: "cleanup", platformClass: "max", factors: { user, hw } }),
    /biometric unavailable/,
  );
  assert.equal(user.outputs.length, 1);
  assert.ok(user.outputs[0]!.every((byte) => byte === 0));
});

test("crypto_store: S_hw обязан иметь ровно 32 байта", async () => {
  const shortSecret = new Uint8Array(31).fill(7);
  await assert.rejects(
    createContainer({
      code: "bad hardware",
      platformClass: "max",
      factors: {
        user: new HmacUserSecret(),
        hw: { platformClass: "max", ensure: async () => {}, sHw: async () => shortSecret },
      },
    }),
    /S_hw.*32/i,
  );
  assert.ok(shortSecret.every((byte) => byte === 0));
});

test("native SecureKey keeps code-wrap and biometric-wrap on separate hardware channels", async () => {
  const calls: string[] = [];
  const plugin: SecureKey = {
    ensure: async () => { calls.push("ensure"); },
    deviceHmac: async (context) => { calls.push("deviceHmac"); return new Uint8Array(32).fill(context[0] ?? 1); },
    hmac: async (context) => { calls.push("hmac"); return new Uint8Array(32).fill(context[0] ?? 2); },

    resetBiometric: async () => { calls.push("resetBiometric"); },

    bootMarker: async () => "boot-test",
    sign: async () => new Uint8Array(64),
    invalidate: async () => {},
  };
  const context = new Uint8Array([7]);
  const codeWrap = secureKeyHardwareSecret(plugin);
  const bioWrap = secureKeyBiometricSecret(plugin);

  await codeWrap.ensure();
  assert.equal((await codeWrap.sHw(context))[0], 7);
  assert.deepEqual(calls, ["ensure", "deviceHmac"], "code-wrap must never invoke biometric hmac");

  calls.length = 0;
  await bioWrap.ensure();
  assert.equal((await bioWrap.sHw(context))[0], 7);
  assert.deepEqual(calls, ["hmac"], "bio-wrap must use only the lazy auth-bound channel");
});

test("crypto_store: матрица классов честна, desktop требует фразу и чистит keyring-копию", async () => {
  assert.equal(selectPlatformClass({ nativeSecureKey: true, desktopKeyring: true, webauthnPrf: true }), "max");
  assert.equal(selectPlatformClass({ nativeSecureKey: false, desktopKeyring: true, webauthnPrf: true }), "desktop");
  assert.equal(selectPlatformClass({ nativeSecureKey: false, desktopKeyring: false, webauthnPrf: true }), "web-prf");
  assert.equal(selectPlatformClass({ nativeSecureKey: false, desktopKeyring: false, webauthnPrf: false }), "web-user-only");
  assert.equal(platformRequiresPassphrase("desktop"), true);
  assert.equal(platformRequiresPassphrase("max"), false);

  const keyringCopy = new Uint8Array(32).fill(9);
  const provider = keyringHardwareSecret({ getSecret: async () => keyringCopy });
  assert.equal(provider.platformClass, "desktop");
  const output = await provider.sHw(utf8("keyring-test"));
  assert.equal(output.byteLength, 32);
  assert.ok(keyringCopy.every((byte) => byte === 0));
  zeroize(output);
});

function fakeCredentials(
  result: BufferSource | undefined,
  capture?: (options: CredentialRequestOptions) => void,
): CredentialsContainer {
  return {
    get: async (options: CredentialRequestOptions) => {
      capture?.(options);
      return {
        getClientExtensionResults: () =>
          result === undefined ? {} : { prf: { results: { first: result } } },
      } as PublicKeyCredential;
    },
  } as unknown as CredentialsContainer;
}

function bufferSourceBytes(source: BufferSource): Uint8Array {
  return source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

test("crypto_store: WebAuthn PRF принимает ArrayBuffer/view и формирует строгий запрос", async () => {
  const credentialId = Uint8Array.of(7, 8, 9);
  const context = utf8("gc-webauthn-test");
  const arrayResult = new Uint8Array(32).fill(4).buffer;
  const backing = new Uint8Array(40).fill(99);
  backing.fill(5, 4, 36);
  const viewResult = new Uint8Array(backing.buffer, 4, 32);

  for (const result of [arrayResult, viewResult] as const) {
    let request: CredentialRequestOptions | undefined;
    const provider = webauthnPrfHardwareSecret({
      credentialId,
      rpId: "chat.example",
      getCredentials: () => fakeCredentials(result, (options) => { request = options; }),
    });
    const secret = await provider.sHw(context);

    assert.equal(provider.platformClass, "web-prf");
    assert.deepEqual(secret, bufferSourceBytes(result));
    const publicKey = request?.publicKey;
    assert.ok(publicKey);
    assert.equal(publicKey.rpId, "chat.example");
    assert.equal(publicKey.userVerification, "required");
    assert.equal(bufferSourceBytes(publicKey.challenge).byteLength, 32);
    assert.deepEqual(
      bufferSourceBytes(publicKey.allowCredentials?.[0]?.id ?? new ArrayBuffer(0)),
      credentialId,
    );
    const extensions = publicKey.extensions as PrfExtensionInputForTest;
    assert.deepEqual(new Uint8Array(extensions.prf.eval.first), context);
    zeroize(secret);
  }
});

interface PrfExtensionInputForTest extends AuthenticationExtensionsClientInputs {
  prf: { eval: { first: ArrayBuffer } };
}

test("crypto_store: WebAuthn PRF различает недоступность и секрет неверной длины", async () => {
  const context = utf8("gc-webauthn-test");
  const unavailable = webauthnPrfHardwareSecret({
    credentialId: Uint8Array.of(1),
    getCredentials: () => fakeCredentials(undefined),
  });
  await assert.rejects(
    unavailable.sHw(context),
    (error: unknown) => {
      assert.ok(error instanceof WebAuthnPrfUnavailableError);
      assert.match(error.message, /новый контейнер.*web-user-only.*существующий.*нельзя/i);
      return true;
    },
  );

  const wrongLength = webauthnPrfHardwareSecret({
    credentialId: Uint8Array.of(1),
    getCredentials: () => fakeCredentials(new Uint8Array(31)),
  });
  await assert.rejects(wrongLength.sHw(context), /S_hw.*32/i);
});
