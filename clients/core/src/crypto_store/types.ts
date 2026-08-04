// crypto_store/types.ts — типы контейнера крипто-хранилища (T-519, DS-01).
// Схема и матрица честности: DEVICE_SECURITY.md §3.1 / §3.2.

/**
 * Класс защиты платформы (§3.2). Записывается в заголовок контейнера — честно фиксирует,
 * какой второй фактор реально доступен, чтобы UI/аудит могли это показать без иллюзий (P7).
 */
export const PLATFORM_CLASSES = [
  "max", // Android Keystore/StrongBox или iOS Secure Enclave: auth-bound S_hw
  "desktop", // OS keyring: секрет без аппаратного троттлинга, фраза обязательна
  "web-prf", // WebAuthn PRF от passkey: привязка слабее нативной
  "web-user-only", // Только S_user (Argon2id): честно слабейший класс
] as const;
export type PlatformClass = (typeof PLATFORM_CLASSES)[number];
export type HardwarePlatformClass = Exclude<PlatformClass, "web-user-only">;

/** Домены иерархии ключей (§3.1). Каждый домен → отдельный HKDF-ключ от MK. */
export type KeyDomain = "db" | "files" | "drafts" | "vault";

/**
 * Параметры Argon2id для S_user (§3.1). Фиксируются в заголовке контейнера,
 * чтобы будущая смена дефолтов не ломала уже созданные контейнеры (миграции).
 * opsLimit = t (число итераций), memLimitKib = m в КиБ, parallelism = p.
 */
export interface Argon2idParams {
  readonly opsLimit: number; // t (спека: 3)
  readonly memLimitKib: number; // m (спека: 64 МиБ = 65536 КиБ; 32 МиБ на слабых)
  readonly parallelism: number; // p (спека: 1)
}

/**
 * Аутентифицированная конфигурация duress-кода (T-526). Код и username здесь отсутствуют:
 * tag — factor-bound verifier (аппаратно привязан при наличии S_hw), payload — шифротекст контакта.
 * Объект включается в AAD основного WRAP, поэтому удаление/подмена на диске ломает обычный unlock.
 */
export interface DuressEnvelope {
  readonly magic: "gc-duress";
  /** v1: length byte + up to 31 chars; v2: zero-padded 32-char ASCII username. */
  readonly version: 1 | 2;
  /** HKDF salt (16 байт), base64. */
  readonly salt: string;
  /** Factor-bound verifier (32 байта), base64. */
  readonly tag: string;
  /** IV AES-256-GCM payload (12 байт), base64. */
  readonly payloadIv: string;
  /** AES-GCM ciphertext фиксированного 32-байтного payload, base64. */
  readonly payload: string;
  /** Не раскрывает контакт, только наличие опционального сетевого сигнала. */
  readonly signal: boolean;
}

/**
 * Заголовок контейнера. Хранится рядом с WRAP в открытом виде (не секрет) — содержит
 * всё, что нужно для повторного вывода KEK из тех же факторов: соли, параметры KDF, класс.
 * Дамп ФС даёт только это + WRAP — по §3.1 бесполезно без обоих факторов.
 */
export interface ContainerHeader {
  readonly magic: "gc-crypto-store";
  readonly version: 1;
  readonly platformClass: PlatformClass;
  /** Параметры Argon2id, применённые к коду приложения при создании (S_user). */
  readonly argon2: Argon2idParams;
  /** Соль Argon2id (16 байт), base64. */
  readonly userSalt: string;
  /** Соль KEK salt16 (§3.1), base64. */
  readonly kekSalt: string;
  /** IV (12 байт) для WRAP = AES-256-GCM(KEK, MK), base64. */
  readonly wrapIv: string;
  /**
   * Признак, что для данной платформы S_hw участвует в KEK. Для web-user-only — false:
   * KEK выводится только из S_user (честно слабейший класс), S_hw = пустой буфер.
   */
  readonly usesHardwareSecret: boolean;
  /** Отсутствует, пока второй код не настроен. Поле аутентифицировано AAD основного WRAP. */
  readonly duress?: DuressEnvelope;
}

/**
 * НЕшифрованные изменяемые метаданные РЯДОМ с контейнером (T-522, §3.4 «холодное состояние»).
 * Сознательно ВНЕ заголовка и ВНЕ AAD: изменение AAD требует пере-шифрования WRAP, а KEK
 * выводится из кода приложения — штамповать каждое открытие без ввода кода невозможно.
 * Отметка не секрет и не влияет на криптографию: подделка на диске может лишь изменить
 * правило удобства (какая «дверь» на входе — код или биометрия); WRAP без обоих факторов
 * всё равно не открывается, а чужая биометрия у вора не совпадёт (§4).
 */
export interface ContainerMeta {
  /** unix-секунды UTC последнего открытия/использования контейнера (§3.4: >7 дней → вход по коду). */
  readonly lastOpenAt?: number;
}

/** Открытый заголовок и аутентифицированная AES-GCM обёртка MK. */
export interface WrappedContainer {
  readonly header: ContainerHeader;
  readonly wrap: string;
  /** Отсутствует у контейнеров, созданных до T-522 — такие читаются как раньше. */
  readonly meta?: ContainerMeta;
}

/**
 * Провайдер аппаратного секрета S_hw (§3.1/§3.2). Абстракция над SecureKey-мостом:
 *  - Android: Keystore/StrongBox HMAC несэкспортируемым ключом;
 *  - iOS: derive от ключа Secure Enclave;
 *  - Desktop: секрет из OS keyring;
 *  - Web-PRF: WebAuthn PRF от passkey.
 * Для web-user-only провайдер не используется (S_hw пустой).
 *
 * `sHw(context)` должен быть детерминирован для данного устройства+ключа: одинаковый
 * context → одинаковый S_hw (иначе KEK не воспроизвести). context — доменная метка контейнера.
 */
export interface HardwareSecretProvider {
  /** Фактический класс источника: контейнер нельзя открыть провайдером другого класса. */
  readonly platformClass: HardwarePlatformClass;
  /** Гарантирует наличие несэкспортируемого ключа (создаёт при первом запуске). */
  ensure(): Promise<void>;
  /** Вычисляет S_hw для данного контекста (обычно HMAC аппаратным ключом). */
  sHw(context: Uint8Array): Promise<Uint8Array>;
}

/**
 * Деривер пользовательского секрета S_user из кода приложения (Argon2id, §3.1).
 * Вынесен интерфейсом, чтобы юнит-тесты могли подставить быстрый детерминированный фейк,
 * а прод — libsodium-WASM (ленивая загрузка, вне основного бандла).
 */
export interface UserSecretDeriver {
  /** S_user = Argon2id(code, salt, params) → 32 байта. */
  derive(code: string, salt: Uint8Array, params: Argon2idParams): Promise<Uint8Array>;
}

/** Дефолтные параметры Argon2id по §3.1: m=64 МиБ, t=3, p=1. */
export const ARGON2_DEFAULT: Argon2idParams = Object.freeze({
  opsLimit: 3,
  memLimitKib: 64 * 1024,
  parallelism: 1,
});

/** Параметры для слабых устройств (§3.1): m=32 МиБ. */
export const ARGON2_WEAK: Argon2idParams = Object.freeze({
  opsLimit: 3,
  memLimitKib: 32 * 1024,
  parallelism: 1,
});
