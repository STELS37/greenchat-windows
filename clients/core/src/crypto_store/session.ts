// crypto_store/session.ts — жизненный цикл открытого контейнера (T-519, DS-01).
//
// Тонкая обёртка над container.ts, которая держит MK и кэш доменных ключей в RAM ТОЛЬКО
// в состоянии UNLOCKED и гарантированно обнуляет их при lock() (инвариант I-DS-1, §3.4).
// Это НЕ машина состояний автолока (DS-04) и НЕ EncryptedStore (DS-02) — только безопасное
// владение ключами и чистый API поверх иерархии.

import { timingSafeEqual, zeroize } from "./primitives.ts";

import {
  createBiometricWrap,
  type BiometricWrap,
} from "./biometric_wrap.ts";
import {
  createContainer,
  createDuressEnvelope,
  deriveDomainKey,
  DuressCodeConflictError,
  matchesDuressCode,
  rewrapContainer,
  unlockContainer,
  type KekFactors,
} from "./container.ts";
import { parseWrappedContainer } from "./format.ts";
import {
  type Argon2idParams,
  type HardwareSecretProvider,
  type KeyDomain,
  type PlatformClass,
  type WrappedContainer,
} from "./types.ts";

/**
 * Открытая сессия контейнера. Владеет MK и лениво-кэшированными доменными ключами.
 * После lock() все буферы обнулены и сессия непригодна — любой доступ бросает исключение.
 */
export class CryptoSession {
  #mk: Uint8Array | null;
  readonly #domainCache = new Map<KeyDomain, Uint8Array>();
  readonly #domainPending = new Map<KeyDomain, Promise<Uint8Array>>();
  #container: WrappedContainer;
  readonly #factors: KekFactors;
  #generation = 0;
  #changeTail: Promise<void> = Promise.resolve();

  private constructor(mk: Uint8Array, container: WrappedContainer, factors: KekFactors) {
    this.#mk = mk;
    this.#container = parseWrappedContainer(container);
    this.#factors = factors;
  }

  /** Создать новый контейнер и сразу открыть сессию (состояние UNLOCKED). */
  static async create(opts: {
    code: string;
    platformClass: PlatformClass;
    factors: KekFactors;
    argon2?: Argon2idParams;
  }): Promise<CryptoSession> {
    const { container, mk } = await createContainer(opts);
    return new CryptoSession(mk, container, opts.factors);
  }

  /** Открыть существующий контейнер по коду (COLD → UNLOCKED). Бросает WrongCodeError. */
  static async unlock(opts: {
    code: string;
    container: WrappedContainer;
    factors: KekFactors;
  }): Promise<CryptoSession> {
    const container = parseWrappedContainer(opts.container);
    const mk = await unlockContainer({ ...opts, container });
    return new CryptoSession(mk, container, opts.factors);
  }

  /**
   * Opens a session from an already authenticated MK (T-524 biometric fast path).
   * Ownership of `mk` transfers to the session on success; lock() will zeroize it.
   */
  static adoptMasterKey(opts: {
    mk: Uint8Array;
    container: WrappedContainer;
    factors: KekFactors;
  }): CryptoSession {
    if (opts.mk.byteLength !== 32) {
      throw new Error("crypto_store: biometric MK must be 32 bytes");
    }
    return new CryptoSession(opts.mk, parseWrappedContainer(opts.container), opts.factors);
  }

  /** Текущий материал контейнера на диск (открытый заголовок + WRAP). */
  get container(): WrappedContainer {
    return parseWrappedContainer(this.#container);
  }

  /** true, пока сессия не заблокирована. */
  get isUnlocked(): boolean {
    return this.#mk !== null;
  }

  #requireMk(): Uint8Array {
    if (this.#mk === null) {
      throw new Error("crypto_store: сессия заблокирована (LOCKED) — ключи обнулены");
    }
    return this.#mk;
  }

  #lockedError(): Error {
    return new Error("crypto_store: операция отменена — сессия заблокирована (LOCKED)");
  }

  /**
   * Доменный ключ (§3.1). Кэшируется на время сессии; при lock() кэш обнуляется.
   * Возвращает буфер, которым владеет сессия — вызывающий НЕ должен его мутировать/обнулять.
   */
  async domainKey(domain: KeyDomain): Promise<Uint8Array> {
    const mk = this.#requireMk();
    const cached = this.#domainCache.get(domain);
    if (cached) return cached;
    const inFlight = this.#domainPending.get(domain);
    if (inFlight) return inFlight;

    const generation = this.#generation;


    let pending: Promise<Uint8Array>;
    pending = deriveDomainKey(mk, domain)
      .then((key) => {
        if (this.#generation !== generation || this.#mk !== mk) {
          zeroize(key);
          throw this.#lockedError();
        }
        this.#domainCache.set(domain, key);
        return key;
      })
      .finally(() => {
        if (this.#domainPending.get(domain) === pending) {
          this.#domainPending.delete(domain);
        }
      });
    this.#domainPending.set(domain, pending);
    return pending;
  }

  /**
   * Creates WRAP_bio from the live MK without exposing MK outside this session. If lock() races
   * with the biometric prompt, the generation check rejects the result after MK was zeroized.
   */
  async createBiometricWrap(provider: HardwareSecretProvider): Promise<BiometricWrap> {
    const mk = this.#requireMk();
    const generation = this.#generation;
    const wrap = await createBiometricWrap(mk, provider, this.#container);
    if (this.#generation !== generation || this.#mk !== mk) {
      throw this.#lockedError();
    }
    return wrap;
  }

  /**
   * Сменить код: пере-обёртка MK (§3.1). MK не меняется, доменные ключи остаются валидны.
   * Обновляет container (новые соль KEK и IV). Требует UNLOCKED.
   */
  async changeCode(newCode: string, currentContainer?: WrappedContainer): Promise<WrappedContainer> {
    this.#requireMk();
    const generation = this.#generation;
    const source = currentContainer === undefined ? this.#container : parseWrappedContainer(currentContainer);
    // The machine may have advanced only unencrypted meta.lastOpenAt. Header/wrap must still identify
    // this exact live session; accepting a foreign container here would cross-bind MK across accounts.
    if (
      source.wrap !== this.#container.wrap ||
      JSON.stringify(source.header) !== JSON.stringify(this.#container.header)
    ) {
      throw new Error("crypto_store: changeCode container does not match the live session");
    }
    const operation = this.#changeTail.then(async () => {
      const mk = this.#requireMk();
      if (this.#generation !== generation) throw this.#lockedError();
      const conflictsWithDuress = await matchesDuressCode({
        code: newCode,
        container: source,
        factors: this.#factors,
      });
      if (this.#generation !== generation || this.#mk !== mk) throw this.#lockedError();
      if (conflictsWithDuress) throw new DuressCodeConflictError();
      const next = await rewrapContainer({
        mk,
        newCode,
        container: source,
        factors: this.#factors,
      });
      if (this.#generation !== generation || this.#mk !== mk) {
        throw this.#lockedError();
      }
      this.#container = next;
      return parseWrappedContainer(next);
    });
    this.#changeTail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  /**
   * Перевод в LOCKED: обнуляет MK и все доменные ключи (I-DS-1). Идемпотентно.
   * После вызова сессия непригодна; повторное открытие — через CryptoSession.unlock().
   */
  /** Настроить/заменить второй код, не меняя MK и доменные ключи. */
  async configureDuress(
    currentCode: string,
    duressCode: string,
    trustedUsername?: string | null,
  ): Promise<WrappedContainer> {
    if (currentCode === duressCode) {
      throw new Error("crypto_store: основной и duress-код должны различаться");
    }
    return this.#mutateAuthenticatedHeader(currentCode, async (mk, source) => {
      const envelope = await createDuressEnvelope({
        code: duressCode,
        container: source,
        factors: this.#factors,
        ...(trustedUsername !== undefined ? { trustedUsername } : {}),
      });
      return rewrapContainer({
        mk,
        newCode: currentCode,
        container: source,
        factors: this.#factors,
        duress: envelope,
      });
    });
  }

  /** Отключить второй код только после подтверждения основного кода. */
  async disableDuress(currentCode: string): Promise<WrappedContainer> {
    return this.#mutateAuthenticatedHeader(currentCode, (mk, source) =>
      rewrapContainer({
        mk,
        newCode: currentCode,
        container: source,
        factors: this.#factors,
        duress: null,
      }));
  }

  async #mutateAuthenticatedHeader(
    currentCode: string,
    mutate: (mk: Uint8Array, source: WrappedContainer) => Promise<WrappedContainer>,
  ): Promise<WrappedContainer> {
    this.#requireMk();
    const generation = this.#generation;
    const operation = this.#changeTail.then(async () => {
      const mk = this.#requireMk();
      const source = this.#container;
      if (this.#generation !== generation) throw this.#lockedError();
      const verified = await unlockContainer({
        code: currentCode,
        container: source,
        factors: this.#factors,
      });
      try {
        if (!timingSafeEqual(verified, mk)) {
          throw new Error("crypto_store: основной код открыл другой MK");
        }
      } finally {
        zeroize(verified);
      }
      const next = await mutate(mk, source);
      if (this.#generation !== generation || this.#mk !== mk) throw this.#lockedError();
      this.#container = parseWrappedContainer(next);
      return parseWrappedContainer(next);
    });
    this.#changeTail = operation.then(() => {}, () => {});
    return operation;
  }

  lock(): void {
    this.#generation += 1;
    for (const key of this.#domainCache.values()) zeroize(key);
    this.#domainCache.clear();
    this.#domainPending.clear();
    if (this.#mk) {
      zeroize(this.#mk);
      this.#mk = null;
    }
  }
}
