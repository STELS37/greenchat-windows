// crypto_store — крипто-контейнер локального хранилища Green Chat (T-519, DS-01).
//
// Самостоятельный модуль: иерархия ключей (MK → доменные ключи → WRAP/KEK) по
// DEVICE_SECURITY.md §3.1 и матрица честности платформ §3.2. Не зависит от store/outbox/sync;
// интеграция шифрования записей (EncryptedStore) — отдельная задача DS-02.
//
// Крипто — поверх WebCrypto (AES-256-GCM / HKDF-SHA256 / HMAC), доступного и в браузере,
// и в Node 22. S_user (Argon2id) — через ленивый провайдер (libsodium-WASM), см. ./argon2.ts:
// он подключается динамически и НЕ попадает в основной веб-бандл (бюджет §13.1).

export {
  createContainer,
  unlockContainer,
  rewrapContainer,
  deriveDomainKey,
  WrongCodeError,

  DuressCodeConflictError,
  CONTAINER_CONSTANTS,
  type KekFactors,

  type DuressAction,
} from "./container.ts";

// T-522 (DS-04): НЕшифрованные метаданные lastOpenAt, cold-правило §3.4 и криптостирание WRAP.
export {
  COLD_AFTER_SECONDS,
  containerWithLastOpen,
  isContainerCold,
  destroyWrap,
  isWipedTombstone,
  type WipedContainerTombstone,
} from "./container.ts";

export { CryptoSession } from "./session.ts";


// T-524 (DS-06): independent auth-bound WRAP_bio. WRAP_code remains the recovery authority.
export {
  createBiometricWrap,
  unlockBiometricWrap,
  parseBiometricWrap,
  InvalidBiometricWrapError,
  BiometricWrapInvalidatedError,
  type BiometricWrap,
} from "./biometric_wrap.ts";

// T-522 (DS-04): машина состояний COLD→UNLOCKED→LOCKED→WIPED + автолок (§3.4). Платформенные
// сигналы и persist инжектируются — web-wiring (visibilitychange и т.п.) придёт с T-523.
export {
  LockMachine,
  InvalidLockTransitionError,
  BACKGROUND_LOCK_DEFAULT_SECONDS,
  type LockState,
  type LockReason,
  type WipeReason,
  type ManualLockReason,
  type LockClock,
  type PlatformSignals,
  type PersistContainer,
  type LockMachineOptions,
} from "./lock_machine.ts";

export {
  parseWrappedContainer,
  assertWrappedContainer,
  assertContainerMeta,
  InvalidContainerError,
} from "./format.ts";

export {
  ARGON2_DEFAULT,
  ARGON2_WEAK,
  PLATFORM_CLASSES,
  type Argon2idParams,
  type ContainerHeader,
  type ContainerMeta,

  type DuressEnvelope,
  type HardwareSecretProvider,
  type UserSecretDeriver,
  type KeyDomain,
  type PlatformClass,
  type HardwarePlatformClass,
  type WrappedContainer,
} from "./types.ts";

export {
  randomBytes,
  zeroize,
  timingSafeEqual,
  toBase64,
  fromBase64,
} from "./primitives.ts";

// Argon2id-провайдер S_user (libsodium-WASM). Импорт этого символа НЕ грузит WASM —
// загрузка происходит лениво при первом derive() (динамический import, вне основного бандла).
export { Argon2idUserSecret, argon2idUserSecret } from "./argon2.ts";

// Мост SecureKey и адаптеры S_hw по платформам (§3.2). Нативные реализации Kotlin/Swift —
// в clients/mobile; здесь только TS-контракт, адаптеры и чистый селектор класса платформы.
export {
  type SecureKey,
  secureKeyHardwareSecret,

  secureKeyBiometricSecret,
  keyringHardwareSecret,
  webauthnPrfHardwareSecret,
  WebAuthnPrfUnavailableError,
  selectPlatformClass,
  classUsesHardwareSecret,
  platformRequiresPassphrase,
  type PlatformCaps,
} from "./securekey.ts";

// T-523 (DS-05): application-lock policy/controller.
export {
  AppLockController,
  InvalidAppCodeError,
  AppLockThrottledError,
  AppLockFailedError,
  AppLockWipedError,
  AppLockMigrationError,
  AppBiometricError,
  estimateAppCode,
  assertValidAppCode,
  appLockDelaySeconds,
  normalizeWipeAfter,
  normalizeAppLockSnapshot,
  APP_LOCK_WIPE_DEFAULT,
  APP_LOCK_WIPE_MIN,
  APP_LOCK_WIPE_MAX,
  APP_LOCK_DELAY_CAP_SECONDS,

  APP_LOCK_BIOMETRIC_FAILURE_LIMIT,
  APP_LOCK_PARANOID_INACTIVITY_SECONDS,
  APP_LOCK_PARANOID_REAUTH_SECONDS,
  type AppLockState,

  type AppLockProfile,
  type AppColdReason,
  type AppCodeKind,
  type AppCodeProblem,
  type AppCodeStrength,
  type AppCodeEstimate,
  type AppLockPolicy,
  type AppLockAttempts,
  type AppLockMigrationState,
  type AppLockMigrationKeys,
  type AppBiometricProblem,
  type AppBiometricSnapshot,
  type AppBiometricStatus,

  type AppColdSnapshot,
  type AppColdStatus,

  type AppDuressStatus,
  type AppLockSnapshot,
  type AppLockPersistence,
  type AppLockControllerOptions,
} from "./app_lock.ts";
