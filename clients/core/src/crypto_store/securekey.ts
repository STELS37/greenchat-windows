// crypto_store/securekey.ts — мост SecureKey и адаптеры S_hw по платформам (T-519, DS-01).
//
// SecureKey — тонкий нативный плагин из §3.2: ensure()/deviceHmac(data)/hmac(data)/sign(data)/invalidate(),
// без сторонних SDK. Здесь — его TS-контракт (реализуют Kotlin/Swift в clients/mobile), адаптеры,
// превращающие каждый источник S_hw в общий HardwareSecretProvider (см. container.ts), и ЧИСТЫЙ
// селектор класса платформы — матрица честности §3.2 в виде кода.
//
// Файл не импортирует Capacitor/DOM-специфику статически: web-провайдеры обращаются к navigator
// лениво/через переданные зависимости, поэтому модуль остаётся тестируемым в Node (`node --test`).

import { hmacSha256, randomBytes, zeroize } from "./primitives.ts";
import { type HardwareSecretProvider, type PlatformClass } from "./types.ts";

/**
 * Контракт нативного плагина SecureKey (§3.2). Реализации:
 *  - deviceHmac(data): device-bound recovery-фактор для WRAP_code. Он требует недавнюю сильную
 *    системную аутентификацию (биометрия ИЛИ PIN/пароль устройства), но переживает смену enrollment;
 *  - hmac(data): отдельный auth-bound/biometric фактор будущего WRAP_bio (T-524), который вправе
 *    инвалидироваться при смене биометрии;
 *  - sign(data): P-256 подпись для серверных примитивов §8.
 */
export interface SecureKey {
  /** Гарантирует только неинтерактивные device/signing keys; bio-key здесь не трогается. */
  ensure(): Promise<void>;
  /** Device-bound recovery-секрет: system auth с credential fallback, без enrollment invalidation. */
  deviceHmac(data: Uint8Array): Promise<Uint8Array>;
  /** Auth-bound биометрический секрет только для отдельного WRAP_bio (T-524). */
  hmac(data: Uint8Array): Promise<Uint8Array>;

  /** Удаляет только enrollment-bound bio-key; recovery/signing keys обязаны сохраниться. */
  resetBiometric(): Promise<void>;

  /** Stable non-PII marker for the current OS boot; no authentication prompt. */
  bootMarker(): Promise<string>;
  /** P-256 подпись данных ключом Secure Enclave/Keystore (для §8; в T-519 не используется). */
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** Удаляет/инвалидирует аппаратный ключ (смена биометрии, wipe). */
  invalidate(): Promise<void>;
}

/**
 * Адаптер основного code-wrap: S_device = SecureKey.deviceHmac(context). После смены биометрии
 * recovery остаётся доступным через системный PIN/пароль + код приложения. Класс «max» — §3.2.
 */
export function secureKeyHardwareSecret(plugin: SecureKey): HardwareSecretProvider {
  return {
    platformClass: "max",
    ensure: () => plugin.ensure(),
    sHw: async (context) => requireHardwareSecret(await plugin.deviceHmac(context)),
  };
}

/** Отдельный auth-bound фактор для T-524. Никогда не использовать для основного WRAP_code. */
export function secureKeyBiometricSecret(plugin: SecureKey): HardwareSecretProvider {
  return {
    platformClass: "max",
    // Bio-key is created lazily by hmac(); common ensure() intentionally never touches it.
    ensure: async () => {},
    sHw: async (context) => requireHardwareSecret(await plugin.hmac(context)),
  };
}

const HARDWARE_SECRET_LEN = 32;

function requireHardwareSecret(secret: Uint8Array): Uint8Array {
  if (secret.byteLength !== HARDWARE_SECRET_LEN) {
    zeroize(secret);
    throw new Error(
      `crypto_store: S_hw должен быть ${HARDWARE_SECRET_LEN} байт, получено ${secret.byteLength}`,
    );
  }
  return secret;
}

/**
 * Desktop (Tauri): секрет из OS keyring без аппаратного троттлинга — класс «средний», фраза
 * обязательна (§3.2). Адаптируем асинхронный доступ к keyring-секрету: S_hw = HMAC(secret, context).
 * `getSecret` возвращает стабильный для устройства секрет (создаётся/читается вызывающей оболочкой).
 */
export function keyringHardwareSecret(deps: {
  getSecret: () => Promise<Uint8Array>;
  ensure?: () => Promise<void>;
}): HardwareSecretProvider {
  return {
    platformClass: "desktop",
    ensure: deps.ensure ?? (async () => {}),
    sHw: async (context) => {
      const secret = await deps.getSecret();
      try {
        return requireHardwareSecret(await hmacSha256(secret, context));
      } finally {
        // getSecret() обязан отдавать свежую принадлежащую адаптеру копию: keyring-секрет не
        // должен оставаться в управляемом JS-буфере после единственной HMAC-операции.
        zeroize(secret);
      }
    },
  };
}

/** Копия байтов в свежий ArrayBuffer (строгий BufferSource для WebAuthn при strict-типах). */
function freshBuffer(u: Uint8Array): ArrayBuffer {
  return new Uint8Array(u).buffer;
}

/** Расширение WebAuthn PRF (не во всех lib.dom версиях) — объявляем локально. */
interface PrfExtensionInput {
  prf?: { eval?: { first: BufferSource; second?: BufferSource } };
}
interface PrfExtensionOutput {
  prf?: { results?: { first?: BufferSource } };
}

/**
 * WebAuthn PRF не ответил секретом. Существующий web-prf контейнер понижать нельзя: это
 * изменило бы его факторы. web-user-only разрешён только как честный класс нового контейнера.
 */
export class WebAuthnPrfUnavailableError extends Error {
  constructor() {
    super(
      "crypto_store: WebAuthn PRF недоступен; новый контейнер можно создать как " +
        "web-user-only, но существующий web-prf контейнер понижать нельзя",
    );
    this.name = "WebAuthnPrfUnavailableError";
  }
}

/** Приводит BufferSource (ArrayBuffer или view) к Uint8Array-копии. */
function bufferSourceToBytes(src: BufferSource): Uint8Array {
  const view =
    src instanceof ArrayBuffer
      ? new Uint8Array(src)
      : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(view);
}

/**
 * Web с passkey: S_hw = WebAuthn PRF (§3.2, класс «web-prf»). Секрет выводит аутентификатор из
 * своего непокидающего устройство ключа под указанный salt (context) — это наш второй фактор.
 * Требует заранее зарегистрированный passkey (credentialId) и navigator.credentials с PRF.
 * Оболочка/веб-код передаёт зависимости, чтобы модуль не тянул DOM статически и оставался
 * тестируемым; при отсутствии PRF выбрасывает — вызывающий откатывается на web-user-only.
 */
export function webauthnPrfHardwareSecret(deps: {
  credentialId: Uint8Array;
  rpId?: string;
  getCredentials: () => CredentialsContainer;
}): HardwareSecretProvider {
  return {
    platformClass: "web-prf",
    ensure: async () => {},
    sHw: async (context) => {
      const prfInput: PrfExtensionInput = { prf: { eval: { first: freshBuffer(context) } } };
      const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: freshBuffer(randomBytes(32)),
        allowCredentials: [{ type: "public-key", id: freshBuffer(deps.credentialId) }],
        userVerification: "required",
        ...(deps.rpId ? { rpId: deps.rpId } : {}),
        extensions: prfInput as AuthenticationExtensionsClientInputs,
      };
      const assertion = (await deps.getCredentials().get({
        publicKey,
      })) as (PublicKeyCredential & { getClientExtensionResults(): PrfExtensionOutput }) | null;
      const first = assertion?.getClientExtensionResults?.().prf?.results?.first;
      if (!first) {
        throw new WebAuthnPrfUnavailableError();
      }
      return requireHardwareSecret(bufferSourceToBytes(first));
    },
  };
}

/** Наблюдаемые возможности среды для выбора класса защиты (§3.2). */
export interface PlatformCaps {
  /** Нативная оболочка Capacitor (Android/iOS) с рабочим SecureKey. */
  nativeSecureKey: boolean;
  /** Desktop-оболочка (Tauri) с доступом к OS keyring. */
  desktopKeyring: boolean;
  /** В браузере доступен WebAuthn PRF от зарегистрированного passkey. */
  webauthnPrf: boolean;
}

/**
 * Матрица честности §3.2 как чистая функция: по фактическим возможностям выбирает класс защиты,
 * который затем пишется в заголовок контейнера. Приоритет — от сильнейшего к слабейшему; web без
 * PRF честно опускается до «web-user-only» (слабейший класс).
 */
export function selectPlatformClass(caps: PlatformCaps): PlatformClass {
  if (caps.nativeSecureKey) return "max";
  if (caps.desktopKeyring) return "desktop";
  if (caps.webauthnPrf) return "web-prf";
  return "web-user-only";
}

/** Нужен ли для класса аппаратный второй фактор (S_hw). Для web-user-only — нет. */
export { platformClassUsesHardwareSecret as classUsesHardwareSecret } from "./policy.ts";

/** Desktop не имеет аппаратного троттлинга, поэтому §3.2 разрешает там только парольную фразу. */
export function platformRequiresPassphrase(cls: PlatformClass): boolean {
  return cls === "desktop";
}
