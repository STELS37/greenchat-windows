// crypto_store/format.ts — строгая проверка и AAD открытого заголовка (T-519, DS-01).

import { fromBase64, utf8 } from "./primitives.ts";
import { assertArgon2idParams, platformClassUsesHardwareSecret } from "./policy.ts";
import {
  PLATFORM_CLASSES,
  type ContainerHeader,
  type ContainerMeta,
  type DuressEnvelope,
  type PlatformClass,
  type WrappedContainer,
} from "./types.ts";

const HEADER_KEYS = [
  "argon2",
  "kekSalt",
  "magic",
  "platformClass",
  "userSalt",
  "usesHardwareSecret",
  "version",
  "wrapIv",
] as const;
const DURESS_KEYS = ["magic", "payload", "payloadIv", "salt", "signal", "tag", "version"] as const;
const ARGON2_KEYS = ["memLimitKib", "opsLimit", "parallelism"] as const;
const PLATFORM_CLASS_SET: ReadonlySet<string> = new Set(PLATFORM_CLASSES);

function isPlatformClass(value: string): value is PlatformClass {
  return PLATFORM_CLASS_SET.has(value);
}

export class InvalidContainerError extends Error {
  override readonly cause?: unknown;

  constructor(detail: string, cause?: unknown) {
    super(`crypto_store: некорректный формат контейнера (${detail})`);
    this.name = "InvalidContainerError";
    if (cause !== undefined) this.cause = cause;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidContainerError(`${label} должен быть объектом`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new InvalidContainerError(`${label}: неизвестные или отсутствующие поля`);
  }
}

function decodeExact(value: unknown, bytes: number, label: string): Uint8Array {
  if (typeof value !== "string") {
    throw new InvalidContainerError(`${label} должен быть строкой base64`);
  }
  const encodedLength = 4 * Math.ceil(bytes / 3);
  if (value.length !== encodedLength) {
    throw new InvalidContainerError(`${label}: ожидается ${bytes} байт`);
  }
  try {
    const decoded = fromBase64(value);
    if (decoded.byteLength !== bytes) {
      throw new InvalidContainerError(`${label}: ожидается ${bytes} байт`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof InvalidContainerError) throw error;
    throw new InvalidContainerError(`${label}: некорректный base64`, error);
  }
}

/** Проверяет аутентифицированную конфигурацию duress-кода. */
export function assertDuressEnvelope(value: unknown): asserts value is DuressEnvelope {
  const envelope = record(value, "duress");
  assertExactKeys(envelope, DURESS_KEYS, "duress");
  if (
    envelope.magic !== "gc-duress" ||
    (envelope.version !== 1 && envelope.version !== 2)
  ) {
    throw new InvalidContainerError("duress: неподдерживаемый magic/version");
  }
  decodeExact(envelope.salt, 16, "duress.salt");
  decodeExact(envelope.tag, 32, "duress.tag");
  decodeExact(envelope.payloadIv, 12, "duress.payloadIv");
  // 32 байта фиксированного plaintext + 16-байтный GCM-tag: длина username не раскрывается.
  decodeExact(envelope.payload, 48, "duress.payload");
  if (typeof envelope.signal !== "boolean") {
    throw new InvalidContainerError("duress.signal должен быть boolean");
  }
}

export function parseDuressEnvelope(value: unknown): DuressEnvelope {
  assertDuressEnvelope(value);
  return {
    magic: value.magic,
    version: value.version,
    salt: value.salt,
    tag: value.tag,
    payloadIv: value.payloadIv,
    payload: value.payload,
    signal: value.signal,
  };
}

/** Проверяет открытый заголовок как недоверенный материал с диска. */
export function assertContainerHeader(value: unknown): asserts value is ContainerHeader {
  const header = record(value, "заголовок");
  assertExactKeys(header, "duress" in header ? [...HEADER_KEYS, "duress"] : HEADER_KEYS, "заголовок");
  if (header.magic !== "gc-crypto-store") {
    throw new InvalidContainerError("magic заголовка не поддерживается");
  }
  if (header.version !== 1) {
    throw new InvalidContainerError("version заголовка не поддерживается");
  }
  if (typeof header.platformClass !== "string" || !isPlatformClass(header.platformClass)) {
    throw new InvalidContainerError("неизвестный platformClass");
  }
  const argon2 = record(header.argon2, "argon2");
  assertExactKeys(argon2, ARGON2_KEYS, "argon2");
  try {
    assertArgon2idParams(argon2);
  } catch (error) {
    throw new InvalidContainerError("параметры Argon2id нарушают политику v1", error);
  }
  decodeExact(header.userSalt, 16, "userSalt");
  decodeExact(header.kekSalt, 16, "kekSalt");
  decodeExact(header.wrapIv, 12, "wrapIv");
  if (typeof header.usesHardwareSecret !== "boolean") {
    throw new InvalidContainerError("usesHardwareSecret должен быть boolean");
  }
  const expectedHardware = platformClassUsesHardwareSecret(header.platformClass);
  if (header.usesHardwareSecret !== expectedHardware) {
    throw new InvalidContainerError("platformClass не согласован с usesHardwareSecret");
  }
  if ("duress" in header) assertDuressEnvelope(header.duress);
}

/**
 * Проверяет НЕшифрованные метаданные рядом с контейнером (T-522). lastOpenAt — unix-секунды UTC.
 * Метаданные сознательно не входят в AAD (см. types.ts) — это данные удобства, не криптографии.
 */
export function assertContainerMeta(value: unknown): asserts value is ContainerMeta {
  const meta = record(value, "meta");
  for (const key of Object.keys(meta)) {
    if (key !== "lastOpenAt") {
      throw new InvalidContainerError("meta: неизвестные поля");
    }
  }
  if (meta.lastOpenAt !== undefined) {
    if (
      typeof meta.lastOpenAt !== "number" ||
      !Number.isSafeInteger(meta.lastOpenAt) ||
      meta.lastOpenAt < 0
    ) {
      throw new InvalidContainerError("meta.lastOpenAt должен быть unix-временем в секундах");
    }
  }
}

/** Проверяет весь открытый контейнер, включая длину WRAP (MK32 + GCM-tag16). */
export function assertWrappedContainer(value: unknown): asserts value is WrappedContainer {
  const container = record(value, "контейнер");
  const keys = "meta" in container ? ["header", "meta", "wrap"] : ["header", "wrap"];
  assertExactKeys(container, keys, "контейнер");
  assertContainerHeader(container.header);
  if ("meta" in container) assertContainerMeta(container.meta);
  decodeExact(container.wrap, 48, "wrap");
}

/** Проверяет недоверенный JSON и возвращает отдельную нормализованную копию формата v1. */
export function parseWrappedContainer(value: unknown): WrappedContainer {
  assertWrappedContainer(value);
  return {
    header: {
      magic: value.header.magic,
      version: value.header.version,
      platformClass: value.header.platformClass,
      argon2: { ...value.header.argon2 },
      userSalt: value.header.userSalt,
      kekSalt: value.header.kekSalt,
      wrapIv: value.header.wrapIv,
      usesHardwareSecret: value.header.usesHardwareSecret,
      ...(value.header.duress !== undefined ? { duress: parseDuressEnvelope(value.header.duress) } : {}),
    },
    wrap: value.wrap,
    // Контейнер до T-522 не имеет meta — нормализованная копия тоже без него (байт-в-байт формат).
    ...(value.meta !== undefined
      ? {
          meta: {
            ...(value.meta.lastOpenAt !== undefined ? { lastOpenAt: value.meta.lastOpenAt } : {}),
          },
        }
      : {}),
  };
}

/** Канонические связанные данные AES-GCM: любое изменение заголовка ломает аутентификацию. */
export function containerHeaderAad(header: ContainerHeader): Uint8Array {
  assertContainerHeader(header);
  const fields: unknown[] = [
    "gc-wrap-header-v1",
    header.magic,
    header.version,
    header.platformClass,
    header.argon2.memLimitKib,
    header.argon2.opsLimit,
    header.argon2.parallelism,
    header.userSalt,
    header.kekSalt,
    header.wrapIv,
    header.usesHardwareSecret,
  ];
  // Legacy header AAD remains byte-for-byte unchanged. Duress fields are appended only when configured.
  if (header.duress) {
    fields.push([
      header.duress.magic,
      header.duress.version,
      header.duress.salt,
      header.duress.tag,
      header.duress.payloadIv,
      header.duress.payload,
      header.duress.signal,
    ]);
  }
  return utf8(JSON.stringify(fields));
}
