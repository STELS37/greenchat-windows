// crypto_store/container.ts — иерархия ключей и обёртка MK (T-519, DS-01).
//
// Реализует DEVICE_SECURITY.md §3.1 ДОСЛОВНО:
//   MK (32 байта CSPRNG) — корень.
//   Доменные ключи   = HKDF-SHA256(MK, "gc-<домен>-v1").
//   KEK              = HKDF-SHA256(S_hw ∥ S_user, salt16, "gc-kek-v1").
//   WRAP             = AES-256-GCM(KEK, MK).
//   Смена кода       = пере-обёртка MK (сам MK не меняется).
//
// Модуль — самостоятельный: он НЕ трогает store/outbox/sync. Интеграция шифрования записей
// (EncryptedStore, §3.3) — это DS-02, вне области T-519.

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  concatBytes,
  fromBase64,
  hkdfSha256,
  randomBytes,
  timingSafeEqual,
  toBase64,
  utf8,
  zeroize,
} from "./primitives.ts";
import {
  assertContainerHeader,
  assertContainerMeta,
  assertWrappedContainer,
  containerHeaderAad,
  InvalidContainerError,
  parseWrappedContainer,
} from "./format.ts";
import { assertArgon2idParams, platformClassUsesHardwareSecret } from "./policy.ts";
import {
  ARGON2_DEFAULT,
  type Argon2idParams,
  type ContainerHeader,
  type ContainerMeta,
  type DuressEnvelope,
  type HardwareSecretProvider,
  type KeyDomain,
  type PlatformClass,
  type UserSecretDeriver,
  type WrappedContainer,
} from "./types.ts";

const MK_LEN = 32; // 256-битный master key
const KEK_LEN = 32; // AES-256 → 32-байтный KEK
const DOMAIN_KEY_LEN = 32; // доменные ключи — 256 бит
const SUSER_LEN = 32; // S_user из Argon2id — 32 байта
const USER_SALT_LEN = 16;
const KEK_SALT_LEN = 16; // salt16 из §3.1
const GCM_IV_LEN = 12;

/** info-метка HKDF доменного ключа: "gc-<домен>-v1" (§3.1). */
function domainInfo(domain: KeyDomain): Uint8Array {
  return utf8(`gc-${domain}-v1`);
}

/** info-метка HKDF для KEK: "gc-kek-v1" (§3.1). */
const KEK_INFO = utf8("gc-kek-v1");

/** Контекст для аппаратного секрета S_hw (стабилен для контейнера). */
const SHW_CONTEXT = utf8("gc-crypto-store-shw-v1");

const DURESS_SALT_LEN = 16;
const DURESS_TAG_LEN = 32;
const DURESS_PAYLOAD_IV_LEN = 12;
const DURESS_TAG_INFO = utf8("gc-duress-tag-v1");
const DURESS_PAYLOAD_INFO = utf8("gc-duress-payload-key-v1");
const DURESS_PAYLOAD_AAD_PREFIX = "gc-duress-payload-v1";
const TRUSTED_USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/i;

/**
 * Материал контейнера на диске: открытый заголовок + завёрнутый MK. Секрета не содержит.
 */
/** Факторы, из которых выводится KEK. */
export interface KekFactors {
  readonly hw: HardwareSecretProvider | null; // null для web-user-only
  readonly user: UserSecretDeriver;
}

export interface DuressAction {
  readonly trustedUsername: string | null;
}

export type ContainerCodeResult =
  | { readonly kind: "unlock"; readonly mk: Uint8Array }
  | { readonly kind: "duress"; readonly action: DuressAction };

function assertFactorsMatchPlatformClass(
  platformClass: PlatformClass,
  factors: KekFactors,
): void {
  const factorClass = factors.hw?.platformClass ?? "web-user-only";
  if (platformClass !== factorClass) {
    throw new Error(
      `crypto_store: platformClass=${platformClass} не согласован с провайдером S_hw (${factorClass})`,
    );
  }
}

/**
 * Один дорогой вывод факторов на попытку входа. T-526 использует тот же материал и для обычного
 * KEK, и для duress-verifier, поэтому второй код не удваивает Argon2id и не ухудшает UX.
 * Владелец результата ОБЯЗАН обнулить его после операции.
 */
async function deriveContainerFactorMaterial(
  code: string,
  header: ContainerHeader,
  factors: KekFactors,
): Promise<Uint8Array> {
  assertContainerHeader(header);
  assertFactorsMatchPlatformClass(header.platformClass, factors);
  const userSalt = fromBase64(header.userSalt);
  let sUser: Uint8Array | null = null;
  let sHw: Uint8Array | null = null;
  try {
    sUser = await factors.user.derive(code, userSalt, header.argon2);
    if (sUser.length !== SUSER_LEN) {
      throw new Error(`crypto_store: S_user должен быть ${SUSER_LEN} байт, получено ${sUser.length}`);
    }
    if (header.usesHardwareSecret) {
      if (!factors.hw) throw new Error("crypto_store: контейнер требует S_hw, но провайдер не задан");
      await factors.hw.ensure();
      sHw = await factors.hw.sHw(SHW_CONTEXT);
      if (sHw.length !== SUSER_LEN) {
        throw new Error(`crypto_store: S_hw должен быть ${SUSER_LEN} байт, получено ${sHw.length}`);
      }
    } else {
      sHw = new Uint8Array(0);
    }
    return concatBytes(sHw, sUser); // S_hw ∥ S_user
  } finally {
    zeroize(sUser, sHw);
  }
}

async function deriveKekFromMaterial(material: Uint8Array, header: ContainerHeader): Promise<Uint8Array> {
  return hkdfSha256(material, fromBase64(header.kekSalt), KEK_INFO, KEK_LEN);
}

async function deriveKek(code: string, header: ContainerHeader, factors: KekFactors): Promise<Uint8Array> {
  const material = await deriveContainerFactorMaterial(code, header, factors);
  try {
    return await deriveKekFromMaterial(material, header);
  } finally {
    zeroize(material);
  }
}

/**
 * Создаёт новый контейнер: генерирует MK (CSPRNG), выводит KEK из факторов и кода,
 * заворачивает MK. MK возвращается вызывающему в открытом виде (состояние UNLOCKED) —
 * владелец обязан вызвать unlockedKeysZeroize/lock при переходе в LOCKED.
 *
 * Возвращает и материал на диск (WrappedContainer), и «живой» MK для немедленного
 * получения доменных ключей.
 */
function normalizeTrustedUsername(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!TRUSTED_USERNAME_RE.test(normalized)) {
    throw new Error("crypto_store: некорректное имя доверенного контакта");
  }
  return normalized;
}

function duressPayloadAad(envelope: Pick<DuressEnvelope, "salt" | "tag" | "signal">): Uint8Array {
  return utf8(JSON.stringify([
    DURESS_PAYLOAD_AAD_PREFIX,
    envelope.salt,
    envelope.tag,
    envelope.signal,
  ]));
}

/** Создаёт factor-bound duress-verifier; при наличии S_hw он аппаратно привязан к устройству. */
export async function createDuressEnvelope(opts: {
  code: string;
  container: WrappedContainer;
  factors: KekFactors;
  trustedUsername?: string | null;
}): Promise<DuressEnvelope> {
  const { header } = parseWrappedContainer(opts.container);
  const trustedUsername = normalizeTrustedUsername(opts.trustedUsername);
  const salt = randomBytes(DURESS_SALT_LEN);
  const payloadIv = randomBytes(DURESS_PAYLOAD_IV_LEN);
  let material: Uint8Array | null = null;
  let tag: Uint8Array | null = null;
  let payloadKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    material = await deriveContainerFactorMaterial(opts.code, header, opts.factors);
    tag = await hkdfSha256(material, salt, DURESS_TAG_INFO, DURESS_TAG_LEN);
    payloadKey = await hkdfSha256(material, salt, DURESS_PAYLOAD_INFO, KEK_LEN);
    const envelopeBase = {
      salt: toBase64(salt),
      tag: toBase64(tag),
      signal: trustedUsername !== null,
    };
    plaintext = new Uint8Array(32);
    if (trustedUsername !== null) {
      const encoded = utf8(trustedUsername);
      // v2 uses the whole fixed-size payload and zero padding, so all valid 32-char usernames fit.
      plaintext.set(encoded, 0);
      zeroize(encoded);
    }
    const payload = await aesGcmEncrypt(
      payloadKey,
      payloadIv,
      plaintext,
      duressPayloadAad(envelopeBase),
    );
    return {
      magic: "gc-duress",
      version: 2,
      salt: envelopeBase.salt,
      tag: envelopeBase.tag,
      payloadIv: toBase64(payloadIv),
      payload: toBase64(payload),
      signal: envelopeBase.signal,
    };
  } finally {
    zeroize(material, tag, payloadKey, plaintext, salt, payloadIv);
  }
}

/**
 * Одна попытка кода: один Argon2id, затем и обычный unwrap, и постоянное по времени сравнение
 * duress-verifier. Интерфейс ввода одинаков; неправильный код неотличим от старого поведения.
 */
/** Проверяет только совпадение с настроенным duress-verifier; код и payload наружу не раскрываются. */
export async function matchesDuressCode(opts: {
  code: string;
  container: WrappedContainer;
  factors: KekFactors;
}): Promise<boolean> {
  const { header } = parseWrappedContainer(opts.container);
  if (!header.duress) return false;
  let material: Uint8Array | null = null;
  let candidateTag: Uint8Array | null = null;
  try {
    material = await deriveContainerFactorMaterial(opts.code, header, opts.factors);
    candidateTag = await hkdfSha256(
      material,
      fromBase64(header.duress.salt),
      DURESS_TAG_INFO,
      DURESS_TAG_LEN,
    );
    return timingSafeEqual(candidateTag, fromBase64(header.duress.tag));
  } finally {
    zeroize(material, candidateTag);
  }
}

export async function unlockContainerOrDuress(opts: {
  code: string;
  container: WrappedContainer;
  factors: KekFactors;
}): Promise<ContainerCodeResult> {
  const { header, wrap } = parseWrappedContainer(opts.container);
  if (!header.duress) return { kind: "unlock", mk: await unlockContainer(opts) };

  let material: Uint8Array | null = null;
  let normalKek: Uint8Array | null = null;
  let candidateTag: Uint8Array | null = null;
  let payloadKey: Uint8Array | null = null;
  let mk: Uint8Array | null = null;
  try {
    material = await deriveContainerFactorMaterial(opts.code, header, opts.factors);
    normalKek = await deriveKekFromMaterial(material, header);
    candidateTag = await hkdfSha256(
      material,
      fromBase64(header.duress.salt),
      DURESS_TAG_INFO,
      DURESS_TAG_LEN,
    );
    payloadKey = await hkdfSha256(
      material,
      fromBase64(header.duress.salt),
      DURESS_PAYLOAD_INFO,
      KEK_LEN,
    );

    // Always attempt both authenticated decryptions before deciding. A normal, duress, or wrong code
    // therefore follows the same Argon2id + HKDF + two AES-GCM operations at the local boundary.
    try {
      const candidateMk = await aesGcmDecrypt(
        normalKek,
        fromBase64(header.wrapIv),
        fromBase64(wrap),
        containerHeaderAad(header),
      );
      if (candidateMk.byteLength === MK_LEN) mk = candidateMk;
      else zeroize(candidateMk);
    } catch {
      mk = null;
    }

    let trustedUsername: string | null = null;
    try {
      const plaintext = await aesGcmDecrypt(
        payloadKey,
        fromBase64(header.duress.payloadIv),
        fromBase64(header.duress.payload),
        duressPayloadAad(header.duress),
      );
      try {
        if (header.duress.version === 1) {
          const length = plaintext[0] ?? 0;
          if (length > 31) throw new Error("crypto_store: corrupt v1 payload length");
          trustedUsername = length === 0
            ? null
            : normalizeTrustedUsername(new TextDecoder().decode(plaintext.subarray(1, 1 + length)));
        } else {
          const zeroAt = plaintext.indexOf(0);
          const end = zeroAt >= 0 ? zeroAt : plaintext.byteLength;
          trustedUsername = end === 0
            ? null
            : normalizeTrustedUsername(new TextDecoder().decode(plaintext.subarray(0, end)));
        }
      } finally {
        zeroize(plaintext);
      }
    } catch {
      // Expected for ordinary/wrong codes; for duress, local erasure remains authoritative on corruption.
      trustedUsername = null;
    }

    const isDuress = timingSafeEqual(candidateTag, fromBase64(header.duress.tag));
    if (isDuress) {
      zeroize(mk);
      mk = null;
      return { kind: "duress", action: { trustedUsername } };
    }

    if (mk) {
      const unlocked = mk;
      mk = null;
      return { kind: "unlock", mk: unlocked };
    }
    throw new WrongCodeError();
  } finally {
    zeroize(material, normalKek, candidateTag, payloadKey, mk);
  }
}

export async function createContainer(opts: {
  code: string;
  platformClass: PlatformClass;
  factors: KekFactors;
  argon2?: Argon2idParams;
}): Promise<{ container: WrappedContainer; mk: Uint8Array }> {
  const argon2 = opts.argon2 ?? ARGON2_DEFAULT;
  assertArgon2idParams(argon2);
  const usesHardwareSecret = platformClassUsesHardwareSecret(opts.platformClass);
  assertFactorsMatchPlatformClass(opts.platformClass, opts.factors);

  const userSalt = randomBytes(USER_SALT_LEN);
  const kekSalt = randomBytes(KEK_SALT_LEN);
  const wrapIv = randomBytes(GCM_IV_LEN);

  const header: ContainerHeader = {
    magic: "gc-crypto-store",
    version: 1,
    platformClass: opts.platformClass,
    argon2: { ...argon2 },
    userSalt: toBase64(userSalt),
    kekSalt: toBase64(kekSalt),
    wrapIv: toBase64(wrapIv),
    usesHardwareSecret,
  };
  assertContainerHeader(header);

  const mk = randomBytes(MK_LEN);
  let kek: Uint8Array | null = null;
  let succeeded = false;
  try {
    kek = await deriveKek(opts.code, header, opts.factors);
    const wrap = await aesGcmEncrypt(kek, wrapIv, mk, containerHeaderAad(header));
    const container = { header, wrap: toBase64(wrap) } satisfies WrappedContainer;
    assertWrappedContainer(container);
    succeeded = true;
    return { container, mk };
  } finally {
    zeroize(kek);
    if (!succeeded) zeroize(mk);
  }
}

/**
 * Открывает контейнер: выводит KEK из факторов+кода и расшифровывает WRAP → MK.
 * Неверный код (или чужой чип) → провал аутентификации GCM → бросаем WrongCodeError.
 * При успехе MK байт-в-байт совпадает с исходным (§3.1, «оба фактора и только это устройство»).
 */
export async function unlockContainer(opts: {
  code: string;
  container: WrappedContainer;
  factors: KekFactors;
}): Promise<Uint8Array> {
  const { header, wrap } = parseWrappedContainer(opts.container);
  const kek = await deriveKek(opts.code, header, opts.factors);
  try {
    const mk = await aesGcmDecrypt(
      kek,
      fromBase64(header.wrapIv),
      fromBase64(wrap),
      containerHeaderAad(header),
    );
    if (mk.byteLength !== MK_LEN) {
      zeroize(mk);
      throw new InvalidContainerError("WRAP расшифрован в MK неверной длины");
    }
    return mk;
  } catch (e) {
    throw new WrongCodeError(e);
  } finally {
    zeroize(kek);
  }
}

/**
 * Смена кода = пере-обёртка MK (§3.1, «мгновенно»). MK НЕ меняется — меняется только KEK
 * и WRAP (новая соль KEK и новый IV). Требует уже открытого MK (состояние UNLOCKED).
 * Возвращает новый WrappedContainer; переданный mk не трогается (владелец продолжает им владеть).
 */
export async function rewrapContainer(opts: {
  mk: Uint8Array;
  newCode: string;
  container: WrappedContainer;
  factors: KekFactors;
  /** undefined = preserve, null = remove, envelope = replace. */
  duress?: DuressEnvelope | null;
}): Promise<WrappedContainer> {
  const current = parseWrappedContainer(opts.container);
  if (opts.mk.length !== MK_LEN) {
    throw new Error("crypto_store: передан некорректный MK для пере-обёртки");
  }
  // Новые соль KEK и IV — чтобы WRAP не переиспользовал (KEK, IV) пару.
  const kekSalt = randomBytes(KEK_SALT_LEN);
  const wrapIv = randomBytes(GCM_IV_LEN);
  const { duress: currentDuress, ...baseHeader } = current.header;
  const nextDuress = opts.duress === undefined ? currentDuress : opts.duress;
  const header: ContainerHeader = {
    ...baseHeader,
    kekSalt: toBase64(kekSalt),
    wrapIv: toBase64(wrapIv),
    ...(nextDuress ? { duress: nextDuress } : {}),
  };
  assertContainerHeader(header);
  const kek = await deriveKek(opts.newCode, header, opts.factors);
  try {
    const wrap = await aesGcmEncrypt(kek, wrapIv, opts.mk, containerHeaderAad(header));
    const container = {
      header,
      wrap: toBase64(wrap),
      // Метаданные (lastOpenAt) переживают смену кода: она не есть «открытие», отметку не трогаем.
      ...(current.meta !== undefined ? { meta: current.meta } : {}),
    } satisfies WrappedContainer;
    assertWrappedContainer(container);
    return container;
  } finally {
    zeroize(kek);
  }
}

// ── T-522 (DS-04): НЕшифрованные метаданные и криптостирание ──────────────────────────────

/** §3.4: >7 дней без открытия приложения → «холодное состояние», следующий вход по коду. */
export const COLD_AFTER_SECONDS = 7 * 24 * 60 * 60;

/**
 * Возвращает копию контейнера с обновлённой отметкой последнего открытия (unix-секунды UTC).
 * Вызывается машиной состояний при каждом успешном unlock; результат сохраняется на диск
 * рядом с WRAP. Отметка не входит в AAD и не требует пере-шифрования (см. types.ts).
 */
export function containerWithLastOpen(
  container: WrappedContainer,
  nowSeconds: number,
): WrappedContainer {
  const parsed = parseWrappedContainer(container);
  const meta: ContainerMeta = { lastOpenAt: nowSeconds };
  assertContainerMeta(meta);
  return { header: parsed.header, wrap: parsed.wrap, meta };
}

/**
 * «Холодное состояние» §3.4: true, если контейнер не открывался дольше COLD_AFTER_SECONDS.
 * Контейнер БЕЗ отметки (создан до T-522 или первая установка) считается холодным — честный
 * дефолт: неизвестная давность = вход по коду, после первого unlock отметка появится.
 * НИКАКИХ «раз в N часов» здесь нет и не будет (§3.4 прямо запрещает; профили — T-525).
 */
export function isContainerCold(
  container: WrappedContainer,
  nowSeconds: number,
  coldAfterSeconds = COLD_AFTER_SECONDS,
): boolean {
  if (!Number.isFinite(coldAfterSeconds) || coldAfterSeconds < 0) {
    throw new Error("crypto_store: coldAfterSeconds must be a non-negative number");
  }
  const parsed = parseWrappedContainer(container);
  const lastOpenAt = parsed.meta?.lastOpenAt;
  if (lastOpenAt === undefined) return true;
  return nowSeconds - lastOpenAt > coldAfterSeconds;
}

/**
 * Криптостирание (WIPED, §3.4): уничтожение WRAP — MK становится математически невосстановимым,
 * весь шифротекст доменов превращается в шум. Модуль не владеет хранилищем (контейнер — значение,
 * persist — зона вызывающего), поэтому стирание выражено контрактом: destroyWrap() отдаёт
 * tombstone, которым вызывающий ОБЯЗАН перезаписать место хранения контейнера. Tombstone не
 * содержит ни байта WRAP/солей и никогда не пройдёт parseWrappedContainer → unlock невозможен.
 * Инвалидация S_hw (SecureKey.invalidate()) и серверный revoke — зона T-526/T-528, не этого модуля.
 */
export interface WipedContainerTombstone {
  readonly magic: "gc-crypto-store-wiped";
  readonly version: 1;
}

export function destroyWrap(container: WrappedContainer): WipedContainerTombstone {
  // Стирать можно только настоящий контейнер — защита от вызова с мусором/уже стёртым значением.
  parseWrappedContainer(container);
  return { magic: "gc-crypto-store-wiped", version: 1 };
}

/** true, если значение на диске — маркер криптостирания (контейнер был уничтожен). */
export function isWipedTombstone(value: unknown): value is WipedContainerTombstone {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { magic?: unknown }).magic === "gc-crypto-store-wiped" &&
    (value as { version?: unknown }).version === 1
  );
}

/**
 * Доменный ключ из MK (§3.1): HKDF-SHA256(MK, "gc-<домен>-v1"). Соль пустая — домен несёт info.
 * Детерминирован (один MK+домен → один ключ) и различен между доменами. Владелец обязан
 * обнулить результат при lock.
 */
export async function deriveDomainKey(mk: Uint8Array, domain: KeyDomain): Promise<Uint8Array> {
  if (mk.length !== MK_LEN) {
    throw new Error("crypto_store: MK должен быть 32 байта для вывода доменного ключа");
  }
  return hkdfSha256(mk, new Uint8Array(0), domainInfo(domain), DOMAIN_KEY_LEN);
}

/** Ошибка неверного кода/чужого устройства: провал GCM-аутентификации при unwrap (§3.1). */
export class WrongCodeError extends Error {
  override readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("crypto_store: неверный код или недоступен аппаратный фактор — контейнер не открыт");
    this.name = "WrongCodeError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Новый обычный код совпал с настроенным duress-кодом; переобёртка запрещена. */
export class DuressCodeConflictError extends Error {
  constructor() {
    super("crypto_store: обычный код должен отличаться от duress-кода");
    this.name = "DuressCodeConflictError";
  }
}

export const CONTAINER_CONSTANTS = {
  MK_LEN,
  KEK_LEN,
  DOMAIN_KEY_LEN,
  USER_SALT_LEN,
  KEK_SALT_LEN,
  GCM_IV_LEN,
} as const;
