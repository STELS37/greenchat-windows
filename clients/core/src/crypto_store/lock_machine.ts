// crypto_store/lock_machine.ts — машина состояний контейнера + автолок (T-522, DS-04).
//
// Реализует DEVICE_SECURITY.md §3.4 ДОСЛОВНО: COLD → UNLOCKED → LOCKED → (WIPED).
//   COLD:     на диске только WRAP+шифротекст, в RAM — ничего. Так выглядит и свежий запуск.
//   UNLOCKED: MK и производные в RAM (CryptoSession, T-519).
//   LOCKED:   = COLD по памяти — MK/доменные ключи обнулены (I-DS-1); сетью управляет shell.
//   WIPED:    WRAP уничтожен (destroyWrap) → криптостирание, терминальное состояние.
//
// Автолок (§13.2, дефолты): фон > N сек (дефолт 30) / экран погас — МГНОВЕННО / кнопка
// мгновенного замка (lock("manual")). «Холодное состояние»: > 7 дней без открытия → следующий
// вход по коду (coldEntryRequired по НЕшифрованной отметке lastOpenAt рядом с контейнером).
// НИКАКИХ периодических «раз в N часов» в дефолте — прямой запрет §3.4; профили — T-525.
//
// ПЛАТФОРМЕННЫЕ СИГНАЛЫ — ТОЛЬКО ИНЖЕКЦИЯ. Ядро не знает про document/visibilitychange/
// screen-события: web/mobile-wiring (T-523) передаёт PlatformSignals и LockClock. Поэтому модуль
// тестируем в Node с фейковыми часами и не тянет DOM в бандл.
//
// СЕТЕВОЙ КОНТРАКТ: эта чистая машина по-прежнему НЕ импортирует ws.ts/sync.ts и сама не
// управляет транспортом. Но shipping-shell T-523 обязан по onLock остановить SyncEngine/WS/Outbox:
// серверные realtime-кадры содержат уже расшифрованный TLS-приложением JSON, а без K_db их нельзя
// безопасно складывать на диск. Durable-события остаются на сервере и после unlock дочитываются по
// курсору/resync; push-payload не содержит текста. Так LOCKED сохраняет I-DS-1 без потери сообщений.
//
// КОНТРАКТ ПОДПИСЧИКОВ (I-DS-1): onLock(cb) зовётся при КАЖДОМ уходе ключей из RAM
// (manual/background/screen_off/wipe/duress). Подписчик ОБЯЗАН синхронно обнулить/выбросить
// все свои плейнтекст-буферы: расшифрованные записи, кэш поиска в RAM, черновики в памяти,
// расшифрованные медиа-чанки, DOM-содержимое чатов. Ключи (MK/доменные) обнуляет сама машина
// через CryptoSession.lock() ДО вызова колбэков — к моменту cb ключей уже нет. Полная
// форензик-проверка инварианта — гейт §10 (T-532).

import { CryptoSession } from "./session.ts";
import {
  containerWithLastOpen,
  destroyWrap,
  isContainerCold,

  unlockContainerOrDuress,
  type KekFactors,

  type DuressAction,
  type WipedContainerTombstone,
} from "./container.ts";
import { parseWrappedContainer } from "./format.ts";
import { type WrappedContainer } from "./types.ts";

/** Состояния §3.4. */
export type LockState = "COLD" | "UNLOCKED" | "LOCKED" | "WIPED";

/**
 * Причины ухода ключей из RAM (T-522/T-526/T-528); duress означает тихое криптостирание,
 * panic — мгновенное явное криптостирание по жесту/кнопке (без подтверждений).
 */
export type LockReason = "manual" | "background" | "screen_off" | "wipe" | "duress" | "panic";

/** Причины перехода в WIPED. */
export type WipeReason = Extract<LockReason, "wipe" | "duress" | "panic">;

/** Причины обычного (не стирающего) лока. */
export type ManualLockReason = Extract<LockReason, "manual" | "background" | "screen_off">;

/** Дефолт автолока по §3.4/§13.2: 30 секунд фона. */
export const BACKGROUND_LOCK_DEFAULT_SECONDS = 30;

/**
 * Инжектируемые часы: unix-секунды для cold-правила и таймер для автолока.
 * Тесты подставляют фейк; прод-дефолт — Date/setTimeout окружения.
 */
export interface LockClock {
  nowSeconds(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function systemClock(): LockClock {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
}

/**
 * Платформенные сигналы жизненного цикла — ИНЖЕКТИРУЕМЫЙ интерфейс (§3.4 «фон/экран погас»).
 * Каждый on* подписывает колбэк и возвращает отписку. Реализация для web
 * (visibilitychange и т.п.) — wiring T-523; мобильные оболочки — свои мосты.
 */
export interface PlatformSignals {
  onBackground(callback: () => void): () => void;
  onForeground(callback: () => void): () => void;
  onScreenOff(callback: () => void): () => void;
}

/**
 * Хранилище контейнера — зона вызывающего. Машина сообщает, ЧТО должно лежать на диске:
 * контейнер с обновлённой отметкой lastOpenAt (после unlock) или tombstone (после wipe).
 */
export type PersistContainer = (
  value: WrappedContainer | WipedContainerTombstone,
) => void | Promise<void>;

export interface LockMachineOptions {
  /** Материал контейнера с диска (T-519). Машина стартует в COLD — ключей в RAM нет. */
  container: WrappedContainer;
  /** Факторы KEK для unlock (T-519). */
  factors: KekFactors;
  /** Куда сохранять контейнер/tombstone. */
  persist: PersistContainer;
  /** Часы (тесты — фейк). Дефолт — системные. */
  clock?: LockClock;
  /** Сигналы платформы (wiring T-523). Без них автолок доступен через notify*-методы. */
  signals?: PlatformSignals;
  /** Секунды фона до автолока. Дефолт 30 (§13.2). 0 = мгновенно при уходе в фон. */
  backgroundLockSeconds?: number;
}

export class InvalidLockTransitionError extends Error {
  constructor(from: LockState, action: string) {
    super(`crypto_store: недопустимый переход из ${from} (${action})`);
    this.name = "InvalidLockTransitionError";
  }
}

/**
 * Машина состояний контейнера. Владеет CryptoSession в UNLOCKED и гарантирует I-DS-1:
 * любой переход из UNLOCKED обнуляет MK/доменные ключи ДО уведомления подписчиков.
 */
export class LockMachine {
  #state: LockState = "COLD";
  #session: CryptoSession | null = null;
  #container: WrappedContainer;
  readonly #factors: KekFactors;
  readonly #persist: PersistContainer;
  readonly #clock: LockClock;
  readonly #backgroundLockSeconds: number;
  readonly #onLock = new Set<(reason: LockReason) => void>();
  readonly #onUnlock = new Set<() => void>();
  #backgroundTimer: unknown = null;
  #unsubscribeSignals: Array<() => void> = [];
  #unlockInFlight = false;
  #epoch = 0;

  constructor(opts: LockMachineOptions) {
    this.#container = parseWrappedContainer(opts.container);
    this.#factors = opts.factors;
    this.#persist = opts.persist;
    this.#clock = opts.clock ?? systemClock();
    const seconds = opts.backgroundLockSeconds ?? BACKGROUND_LOCK_DEFAULT_SECONDS;
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error("crypto_store: backgroundLockSeconds должен быть неотрицательным числом");
    }
    this.#backgroundLockSeconds = seconds;
    if (opts.signals) {
      this.#unsubscribeSignals = [
        opts.signals.onBackground(() => this.notifyBackground()),
        opts.signals.onForeground(() => this.notifyForeground()),
        opts.signals.onScreenOff(() => this.notifyScreenOff()),
      ];
    }
  }

  get state(): LockState {
    return this.#state;
  }

  /** Открытая сессия (ключи) — ТОЛЬКО в UNLOCKED, иначе null: в LOCKED ключей не существует. */
  get session(): CryptoSession | null {
    return this.#state === "UNLOCKED" ? this.#session : null;
  }

  /** Текущий материал контейнера (для persist-слоя/отладки; секрета не содержит). */
  get container(): WrappedContainer {
    return parseWrappedContainer(this.#container);
  }

  /**
   * «Холодное состояние» §3.4: >7 дней без открытия → вход по коду. Читается в COLD до unlock
   * (отметка не шифруется). T-523 использует это, чтобы выбрать дверь: код вместо биометрии.
   */
  coldEntryRequired(coldAfterSeconds?: number): boolean {
    return isContainerCold(this.#container, this.#clock.nowSeconds(), coldAfterSeconds);
  }

  /** Подписка на уход ключей (контракт I-DS-1 в шапке). Возвращает отписку. */
  onLock(callback: (reason: LockReason) => void): () => void {
    this.#onLock.add(callback);
    return () => this.#onLock.delete(callback);
  }

  /** Подписка на появление ключей (после успешного unlock). Возвращает отписку. */
  onUnlock(callback: () => void): () => void {
    this.#onUnlock.add(callback);
    return () => this.#onUnlock.delete(callback);
  }

  /**
   * COLD/LOCKED → UNLOCKED по коду. Неверный код — WrongCodeError, состояние не меняется.
   * Успех: штампует lastOpenAt (unix-секунды) и отдаёт контейнер persist-слою.
   */
  async unlock(code: string): Promise<void> {
    this.#assertCanUnlock("unlock");
    this.#unlockInFlight = true;
    const epoch = this.#epoch;
    let session: CryptoSession | null = null;
    try {
      session = await CryptoSession.unlock({
        code,
        container: this.#container,
        factors: this.#factors,
      });
      await this.#publishUnlockedSession(session, epoch, "unlock");
      session = null; // ownership transferred to the machine
    } finally {
      session?.lock();
      this.#unlockInFlight = false;
    }
  }

  /**
   * T-524: COLD/LOCKED → UNLOCKED from an MK already authenticated by WRAP_bio. Ownership of `mk`
   * always transfers to this call: it is either adopted by CryptoSession or zeroized on every failure.
   */
  /**
   * T-526: тот же вход по коду, но контейнер с duress-конвертом может вернуть тихое действие вместо MK.
   * Один Argon2id выполняется внутри unlockContainerOrDuress; при duress ключи в RAM не появляются.
   */
  async unlockOrDuress(code: string): Promise<DuressAction | null> {
    this.#assertCanUnlock("unlockOrDuress");
    this.#unlockInFlight = true;
    const epoch = this.#epoch;
    let session: CryptoSession | null = null;
    try {
      const result = await unlockContainerOrDuress({
        code,
        container: this.#container,
        factors: this.#factors,
      });
      if (this.#epoch !== epoch || (this.#state !== "COLD" && this.#state !== "LOCKED")) {
        if (result.kind === "unlock") result.mk.fill(0);
        throw new InvalidLockTransitionError(this.#state, "unlockOrDuress (состояние изменилось)");
      }
      if (result.kind === "duress") return result.action;
      session = CryptoSession.adoptMasterKey({
        mk: result.mk,
        container: this.#container,
        factors: this.#factors,
      });
      await this.#publishUnlockedSession(session, epoch, "unlockOrDuress");
      session = null;
      return null;
    } finally {
      session?.lock();
      this.#unlockInFlight = false;
    }
  }

  async unlockWithMasterKey(mk: Uint8Array): Promise<void> {
    try {
      this.#assertCanUnlock("unlockWithMasterKey");
    } catch (error) {
      mk.fill(0);
      throw error;
    }
    this.#unlockInFlight = true;
    const epoch = this.#epoch;
    let session: CryptoSession | null = null;
    let adopted = false;
    try {
      session = CryptoSession.adoptMasterKey({
        mk,
        container: this.#container,
        factors: this.#factors,
      });
      adopted = true;
      await this.#publishUnlockedSession(session, epoch, "unlockWithMasterKey");
      session = null; // ownership transferred to the machine
    } finally {
      if (!adopted) mk.fill(0);
      session?.lock();
      this.#unlockInFlight = false;
    }
  }

  /**
   * UNLOCKED → LOCKED. I-DS-1: CryptoSession.lock() обнуляет MK и доменные ключи ДО колбэков.
   * Сокет при этом НЕ рвётся (контракт в шапке модуля).
   */
  lock(reason: ManualLockReason = "manual"): void {
    if (this.#state !== "UNLOCKED") {
      throw new InvalidLockTransitionError(this.#state, `lock:${reason}`);
    }
    this.#toLocked(reason);
  }

  /** T-523: re-wrap the live MK under a new application code and persist the new container. */
  async changeCode(newCode: string): Promise<WrappedContainer> {
    if (this.#state !== "UNLOCKED" || !this.#session) {
      throw new InvalidLockTransitionError(this.#state, "changeCode");
    }
    const next = await this.#session.changeCode(newCode, this.#container);
    this.#container = parseWrappedContainer(next);
    await this.#persist(this.#container);
    return parseWrappedContainer(this.#container);
  }

  /**
   * COLD/UNLOCKED/LOCKED → WIPED (терминально): destroyWrap → persist tombstone.
   * Из UNLOCKED ключи обнуляются и подписчики получают onLock(reason) ДО стирания.
   * Duress и panic (T-528) вызывают тот же атомарный destroyWrap; свежий UI и сетевой revoke
   * выполняет AppLock/shell. Инвалидация S_hw (SecureKey.invalidate()) остаётся зоной вызывающего.
   */
  async configureDuress(
    currentCode: string,
    duressCode: string,
    trustedUsername?: string | null,
  ): Promise<WrappedContainer> {
    if (this.#state !== "UNLOCKED" || !this.#session) {
      throw new InvalidLockTransitionError(this.#state, "configureDuress");
    }
    const next = await this.#session.configureDuress(currentCode, duressCode, trustedUsername);
    this.#container = parseWrappedContainer(next);
    await this.#persist(this.#container);
    return parseWrappedContainer(this.#container);
  }

  async disableDuress(currentCode: string): Promise<WrappedContainer> {
    if (this.#state !== "UNLOCKED" || !this.#session) {
      throw new InvalidLockTransitionError(this.#state, "disableDuress");
    }
    const next = await this.#session.disableDuress(currentCode);
    this.#container = parseWrappedContainer(next);
    await this.#persist(this.#container);
    return parseWrappedContainer(this.#container);
  }

  async wipe(reason: WipeReason = "wipe"): Promise<void> {
    if (this.#state === "WIPED") {
      throw new InvalidLockTransitionError(this.#state, `wipe:${reason}`);
    }
    if (this.#state === "UNLOCKED") {
      this.#toLocked(reason);
    }
    const tombstone = destroyWrap(this.#container);
    this.#state = "WIPED";
    this.#epoch += 1;
    await this.#persist(tombstone);
  }

  /** Сигнал «приложение ушло в фон»: взводит таймер автолока (дефолт 30 с). */
  notifyBackground(): void {
    if (this.#state !== "UNLOCKED" || this.#backgroundTimer !== null) return;
    if (this.#backgroundLockSeconds === 0) {
      this.#toLocked("background");
      return;
    }
    this.#backgroundTimer = this.#clock.setTimeout(() => {
      this.#backgroundTimer = null;
      if (this.#state === "UNLOCKED") this.#toLocked("background");
    }, this.#backgroundLockSeconds * 1000);
  }

  /** Сигнал «приложение вернулось на передний план»: снимает таймер автолока. */
  notifyForeground(): void {
    this.#clearBackgroundTimer();
  }

  /** Сигнал «экран погас»: мгновенный лок (§3.4/§13.2, без таймера). */
  notifyScreenOff(): void {
    if (this.#state !== "UNLOCKED") return;
    this.#toLocked("screen_off");
  }

  /** Отписка от платформенных сигналов и снятие таймера (например, при закрытии вкладки). */
  dispose(): void {
    for (const unsubscribe of this.#unsubscribeSignals) unsubscribe();
    this.#unsubscribeSignals = [];
    this.#clearBackgroundTimer();
  }

  #assertCanUnlock(action: string): void {
    if (this.#state !== "COLD" && this.#state !== "LOCKED") {
      throw new InvalidLockTransitionError(this.#state, action);
    }
    if (this.#unlockInFlight) {
      throw new Error("crypto_store: unlock уже выполняется");
    }
  }

  async #publishUnlockedSession(
    session: CryptoSession,
    epoch: number,
    action: string,
  ): Promise<void> {
    // Пока ждали KDF/биометрию, состояние могло смениться (например, wipe): ключи не публикуем.
    if (this.#epoch !== epoch || (this.#state !== "COLD" && this.#state !== "LOCKED")) {
      throw new InvalidLockTransitionError(this.#state, `${action} (состояние изменилось)`);
    }
    const stamped = containerWithLastOpen(this.#container, this.#clock.nowSeconds());
    this.#container = stamped;
    this.#session = session;
    this.#state = "UNLOCKED";
    this.#epoch += 1;
    const publishedEpoch = this.#epoch;
    try {
      await this.#persist(stamped);
      if (
        this.#state !== "UNLOCKED" ||
        this.#session !== session ||
        this.#epoch !== publishedEpoch
      ) {
        throw new InvalidLockTransitionError(this.#state, `${action} (заблокировано во время persist)`);
      }
      for (const callback of [...this.#onUnlock]) callback();
    } catch (error) {
      // A failed persistence must never leave an in-memory session authoritative without a matching
      // durable last-open stamp. If another lifecycle event already removed it, this is a no-op.
      if (this.#state === "UNLOCKED" && this.#session === session) {
        this.#toLocked("manual");
      }
      throw error;
    }
  }

  #clearBackgroundTimer(): void {
    if (this.#backgroundTimer !== null) {
      this.#clock.clearTimeout(this.#backgroundTimer);
      this.#backgroundTimer = null;
    }
  }

  /** Единая точка ухода ключей: zeroize (I-DS-1) → состояние → подписчики (ровно один вызов). */
  #toLocked(reason: LockReason): void {
    this.#clearBackgroundTimer();
    const session = this.#session;
    this.#session = null;
    session?.lock();
    this.#state = "LOCKED";
    this.#epoch += 1;
    for (const callback of [...this.#onLock]) callback(reason);
  }
}
