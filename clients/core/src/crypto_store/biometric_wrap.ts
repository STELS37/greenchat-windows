// crypto_store/biometric_wrap.ts — отдельная биометрическая «быстрая дверь» (T-524, DS-06).
//
// Основной WRAP_code остаётся единственным recovery-путём и зависит от кода + device-bound S_hw.
// Этот модуль хранит ВТОРУЮ обёртку того же MK:
//   WRAP_bio = AES-256-GCM(K_bio, MK, AAD="gc-app-lock-bio-wrap-v1")
// где K_bio получается только после системной биометрической аутентификации. Смена набора
// отпечатков/лица инвалидирует K_bio, но не основной device-key и не WRAP_code.
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  fromBase64,

  hmacSha256,
  randomBytes,
  toBase64,

  timingSafeEqual,
  utf8,
  zeroize,
} from "./primitives.ts";
import { parseWrappedContainer } from "./format.ts";
import type { HardwareSecretProvider, WrappedContainer } from "./types.ts";

const MK_LEN = 32;
const KEY_LEN = 32;
const IV_LEN = 12;
const WRAP_LEN = MK_LEN + 16;
const BIO_CONTEXT = utf8("gc-app-lock-biometric-key-v1");
const BIO_AAD = utf8(JSON.stringify(["gc-app-lock-bio-wrap", 1]));

export interface BiometricWrap {
  readonly magic: "gc-app-lock-bio-wrap";
  readonly version: 1;
  readonly iv: string;
  readonly wrap: string;

  /** HMAC(MK, canonical current WRAP_code) prevents cross-container swap. */
  readonly containerTag: string;
}

export class InvalidBiometricWrapError extends Error {
  override readonly cause?: unknown;

  constructor(detail: string, cause?: unknown) {
    super(`app_lock: invalid biometric wrap (${detail})`);
    this.name = "InvalidBiometricWrapError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** GCM authentication failed: the auth-bound key changed/was replaced or the wrap was tampered. */
export class BiometricWrapInvalidatedError extends Error {
  override readonly cause?: unknown;

  constructor(cause?: unknown) {
    super("app_lock: biometric wrap is no longer decryptable; app code is required once");
    this.name = "BiometricWrapInvalidatedError";
    if (cause !== undefined) this.cause = cause;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidBiometricWrapError("value must be an object");
  }
  return value as Record<string, unknown>;
}

function decodeExact(value: unknown, bytes: number, label: string): Uint8Array {
  if (typeof value !== "string") throw new InvalidBiometricWrapError(`${label} must be base64`);
  if (value.length !== 4 * Math.ceil(bytes / 3)) {
    throw new InvalidBiometricWrapError(`${label} must decode to ${bytes} bytes`);
  }
  try {
    const decoded = fromBase64(value);
    if (decoded.byteLength !== bytes) {
      throw new InvalidBiometricWrapError(`${label} must decode to ${bytes} bytes`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof InvalidBiometricWrapError) throw error;
    throw new InvalidBiometricWrapError(`${label} is not canonical base64`, error);
  }
}

export function parseBiometricWrap(value: unknown): BiometricWrap {
  const raw = record(value);
  const keys = Object.keys(raw).sort();
  const expected = ["containerTag", "iv", "magic", "version", "wrap"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new InvalidBiometricWrapError("unknown or missing fields");
  }
  if (raw.magic !== "gc-app-lock-bio-wrap" || raw.version !== 1) {
    throw new InvalidBiometricWrapError("unsupported magic/version");
  }
  decodeExact(raw.iv, IV_LEN, "iv");
  decodeExact(raw.wrap, WRAP_LEN, "wrap");

  decodeExact(raw.containerTag, 32, "containerTag");
  return {
    magic: "gc-app-lock-bio-wrap",
    version: 1,
    iv: raw.iv as string,
    wrap: raw.wrap as string,

    containerTag: raw.containerTag as string,
  };
}

async function biometricKey(provider: HardwareSecretProvider): Promise<Uint8Array> {
  if (provider.platformClass !== "max") {
    throw new Error("app_lock: biometric fast path requires native auth-bound hardware");
  }
  await provider.ensure();
  const key = await provider.sHw(BIO_CONTEXT);
  if (key.byteLength !== KEY_LEN) {
    zeroize(key);
    throw new Error(`app_lock: K_bio must be ${KEY_LEN} bytes`);
  }
  return key;
}

function containerBinding(container: WrappedContainer): Uint8Array {
  const parsed = parseWrappedContainer(container);
  // meta.lastOpenAt is intentionally excluded: it changes after every unlock. Code re-wrap changes
  // header/wrap and therefore requires a fresh WRAP_bio, preventing cross-container substitution.
  return utf8(JSON.stringify({ header: parsed.header, wrap: parsed.wrap }));
}

/** Creates/replaces WRAP_bio. The caller retains ownership of MK; this function never mutates it. */
export async function createBiometricWrap(
  mk: Uint8Array,
  provider: HardwareSecretProvider,
  container: WrappedContainer,
): Promise<BiometricWrap> {
  if (mk.byteLength !== MK_LEN) throw new Error(`app_lock: MK must be ${MK_LEN} bytes`);
  const iv = randomBytes(IV_LEN);
  let key: Uint8Array | null = null;
  let ciphertext: Uint8Array | null = null;

  let tag: Uint8Array | null = null;
  let binding: Uint8Array | null = null;
  try {
    key = await biometricKey(provider);
    ciphertext = await aesGcmEncrypt(key, iv, mk, BIO_AAD);

    binding = containerBinding(container);
    tag = await hmacSha256(mk, binding);
    const result: BiometricWrap = {
      magic: "gc-app-lock-bio-wrap",
      version: 1,
      iv: toBase64(iv),
      wrap: toBase64(ciphertext),

      containerTag: toBase64(tag),
    };
    return parseBiometricWrap(result);
  } finally {
    zeroize(key, ciphertext, tag, binding, iv);
  }
}

/**
 * Decrypts WRAP_bio after the platform has authenticated biometrics. On success ownership of the
 * returned MK transfers to the caller. Any GCM failure is a safe code-fallback, never a code failure.
 */
export async function unlockBiometricWrap(
  value: BiometricWrap,
  provider: HardwareSecretProvider,
  container: WrappedContainer,
): Promise<Uint8Array> {
  const wrap = parseBiometricWrap(value);
  const iv = fromBase64(wrap.iv);
  const ciphertext = fromBase64(wrap.wrap);
  const storedTag = fromBase64(wrap.containerTag);
  let key: Uint8Array | null = null;
  let expectedTag: Uint8Array | null = null;
  let binding: Uint8Array | null = null;
  try {
    key = await biometricKey(provider);
    const mk = await aesGcmDecrypt(key, iv, ciphertext, BIO_AAD);
    if (mk.byteLength !== MK_LEN) {
      zeroize(mk);
      throw new InvalidBiometricWrapError("decrypted MK has wrong length");
    }
    binding = containerBinding(container);
    expectedTag = await hmacSha256(mk, binding);
    if (!timingSafeEqual(expectedTag, storedTag)) {
      zeroize(mk);
      throw new InvalidBiometricWrapError("container binding mismatch");
    }
    return mk;
  } catch (error) {
    if (error instanceof InvalidBiometricWrapError) throw error;
    // Provider-side errors (cancel/unavailable/key-invalidated) are classified by AppLockController.
    // Only a WebCrypto decrypt failure is converted to a definite stale/tampered wrap signal.
    if (error instanceof DOMException && error.name === "OperationError") {
      throw new BiometricWrapInvalidatedError(error);
    }
    throw error;
  } finally {
    zeroize(key, expectedTag, binding, storedTag, iv, ciphertext);
  }
}
