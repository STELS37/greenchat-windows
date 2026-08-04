// T-522 (DS-04): машина состояний COLD→UNLOCKED→LOCKED→WIPED + автолок + I-DS-1.
// Стиль T-519-тестов: фейковые S_hw/S_user-провайдеры (HMAC), реальный контейнер, zeroize-проверки.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_LOCK_DEFAULT_SECONDS,
  COLD_AFTER_SECONDS,
  CryptoSession,
  InvalidLockTransitionError,
  LockMachine,
  WrongCodeError,
  containerWithLastOpen,
  createContainer,
  destroyWrap,
  isContainerCold,
  isWipedTombstone,
  parseWrappedContainer,
  timingSafeEqual,
  unlockContainer,
  zeroize,
  type Argon2idParams,
  type KekFactors,
  type LockClock,
  type LockReason,
  type PlatformSignals,
  type UserSecretDeriver,
  type WipedContainerTombstone,
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
    sHw: async (context) => hmacSha256(utf8("lock-device"), context),
  },
};

/** Фейковые часы: ручное unix-время + очередь таймеров, срабатывающих по advance(). */
class FakeClock implements LockClock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  constructor(nowSeconds = 1_700_000_000) {
    this.#now = nowSeconds;
  }

  nowSeconds(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms / 1000, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Продвигает время на seconds и запускает созревшие таймеры в порядке срабатывания. */
  advance(seconds: number): void {
    this.#now += seconds;
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.at <= this.#now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }
}

/** Ручные платформенные сигналы (то, что T-523 повесит на visibilitychange и т.п.). */
class FakeSignals implements PlatformSignals {
  #background = new Set<() => void>();
  #foreground = new Set<() => void>();
  #screenOff = new Set<() => void>();

  onBackground(callback: () => void): () => void {
    this.#background.add(callback);
    return () => this.#background.delete(callback);
  }
  onForeground(callback: () => void): () => void {
    this.#foreground.add(callback);
    return () => this.#foreground.delete(callback);
  }
  onScreenOff(callback: () => void): () => void {
    this.#screenOff.add(callback);
    return () => this.#screenOff.delete(callback);
  }

  background(): void {
    for (const cb of this.#background) cb();
  }
  foreground(): void {
    for (const cb of this.#foreground) cb();
  }
  screenOff(): void {
    for (const cb of this.#screenOff) cb();
  }
}

const CODE = "correct horse battery staple";

async function machineFixture(opts?: {
  backgroundLockSeconds?: number;
  signals?: PlatformSignals;
  nowSeconds?: number;
}): Promise<{
  machine: LockMachine;
  clock: FakeClock;
  container: WrappedContainer;
  mk: Uint8Array;
  persisted: Array<WrappedContainer | WipedContainerTombstone>;
}> {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });
  const clock = new FakeClock(opts?.nowSeconds);
  const persisted: Array<WrappedContainer | WipedContainerTombstone> = [];
  const machine = new LockMachine({
    container: created.container,
    factors: testFactors,
    persist: (value) => {
      persisted.push(value);
    },
    clock,
    ...(opts?.signals ? { signals: opts.signals } : {}),
    ...(opts?.backgroundLockSeconds !== undefined
      ? { backgroundLockSeconds: opts.backgroundLockSeconds }
      : {}),
  });
  return { machine, clock, container: created.container, mk: created.mk, persisted };
}

test("lock_machine: полный цикл COLD → UNLOCKED → LOCKED → UNLOCKED с реальным контейнером", async () => {
  const f = await machineFixture();
  assert.equal(f.machine.state, "COLD");
  assert.equal(f.machine.session, null);

  await assert.rejects(f.machine.unlock("wrong code"), WrongCodeError);
  assert.equal(f.machine.state, "COLD", "неверный код не меняет состояние");

  await f.machine.unlock(CODE);
  assert.equal(f.machine.state, "UNLOCKED");
  const db = await f.machine.session!.domainKey("db");
  assert.equal(db.byteLength, 32);

  f.machine.lock();
  assert.equal(f.machine.state, "LOCKED");
  assert.equal(f.machine.session, null, "в LOCKED session → null: ключей не существует");

  // Машина жива: unlock после LOCKED восстанавливает доступ, доменный ключ детерминирован.
  await f.machine.unlock(CODE);
  assert.equal(f.machine.state, "UNLOCKED");
  const dbAgain = await f.machine.session!.domainKey("db");
  assert.equal(dbAgain.byteLength, 32);
  f.machine.lock();
  zeroize(f.mk);
});

test("lock_machine: запрещённые переходы отклоняются с InvalidLockTransitionError", async () => {
  const f = await machineFixture();

  // COLD: лочить нечего.
  assert.throws(() => f.machine.lock(), InvalidLockTransitionError);

  await f.machine.unlock(CODE);
  // UNLOCKED: повторный unlock недопустим.
  await assert.rejects(f.machine.unlock(CODE), InvalidLockTransitionError);

  f.machine.lock();
  // LOCKED: повторный lock недопустим.
  assert.throws(() => f.machine.lock("manual"), InvalidLockTransitionError);

  await f.machine.wipe();
  assert.equal(f.machine.state, "WIPED");
  // WIPED терминально: ни unlock, ни lock, ни повторный wipe.
  await assert.rejects(f.machine.unlock(CODE), InvalidLockTransitionError);
  assert.throws(() => f.machine.lock(), InvalidLockTransitionError);
  await assert.rejects(f.machine.wipe(), InvalidLockTransitionError);
  zeroize(f.mk);
});

test("lock_machine: I-DS-1 — переход в LOCKED обнуляет MK и выданные доменные буферы", async () => {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });
  const clock = new FakeClock();
  const machine = new LockMachine({
    container: created.container,
    factors: testFactors,
    persist: () => {},
    clock,
  });
  await machine.unlock(CODE);
  const session = machine.session!;
  const db = await session.domainKey("db");
  const files = await session.domainKey("files");
  const dbCopy = db.slice();

  machine.lock();

  assert.ok(db.every((byte) => byte === 0), "доменный ключ db обнулён");
  assert.ok(files.every((byte) => byte === 0), "доменный ключ files обнулён");
  assert.ok(!dbCopy.every((byte) => byte === 0), "до lock ключ был ненулевым");
  assert.equal(session.isUnlocked, false);
  // Захваченная ссылка на сессию после lock бесполезна: ключи не выдаются.
  await assert.rejects(session.domainKey("db"), /LOCKED|заблокирована/);
  zeroize(created.mk, dbCopy);
});

test("lock_machine: автолок 30 с фона (дефолт), возврат на передний план отменяет таймер", async () => {
  const signals = new FakeSignals();
  const f = await machineFixture({ signals });
  await f.machine.unlock(CODE);
  assert.equal(
    BACKGROUND_LOCK_DEFAULT_SECONDS,
    30,
    "дефолт автолока — 30 с (§13.2); менять = регресс спеки",
  );

  // Возврат до истечения таймера — лока нет.
  signals.background();
  f.clock.advance(29);
  signals.foreground();
  f.clock.advance(600);
  assert.equal(f.machine.state, "UNLOCKED", "foreground до 30 с отменяет автолок");
  assert.equal(f.clock.pendingTimers, 0, "таймер снят, не висит");

  // Фон на полные 30 с — лок.
  const reasons: LockReason[] = [];
  f.machine.onLock((reason) => reasons.push(reason));
  signals.background();
  f.clock.advance(30);
  assert.equal(f.machine.state, "LOCKED");
  assert.deepEqual(reasons, ["background"]);
  zeroize(f.mk);
});

test("lock_machine: конфигурируемый интервал автолока и мгновенный лок при 0", async () => {
  const five = await machineFixture({ backgroundLockSeconds: 5 });
  await five.machine.unlock(CODE);
  five.machine.notifyBackground();
  five.clock.advance(4);
  assert.equal(five.machine.state, "UNLOCKED");
  five.clock.advance(1);
  assert.equal(five.machine.state, "LOCKED");
  zeroize(five.mk);

  const instant = await machineFixture({ backgroundLockSeconds: 0 });
  await instant.machine.unlock(CODE);
  instant.machine.notifyBackground();
  assert.equal(instant.machine.state, "LOCKED", "0 секунд = лок сразу при уходе в фон");
  zeroize(instant.mk);
});

test("lock_machine: экран погас — мгновенный лок без таймера", async () => {
  const signals = new FakeSignals();
  const f = await machineFixture({ signals });
  await f.machine.unlock(CODE);
  const reasons: LockReason[] = [];
  f.machine.onLock((reason) => reasons.push(reason));

  signals.screenOff();

  assert.equal(f.machine.state, "LOCKED");
  assert.deepEqual(reasons, ["screen_off"]);
  // Повторный сигнал в LOCKED — no-op, не ошибка (экран может гаснуть многократно).
  signals.screenOff();
  assert.deepEqual(reasons, ["screen_off"]);
  zeroize(f.mk);
});

test("lock_machine: onLock/onUnlock зовутся ровно по разу на переход, отписка работает", async () => {
  const f = await machineFixture();
  const lockCalls: LockReason[] = [];
  let unlockCalls = 0;
  const offLock = f.machine.onLock((reason) => lockCalls.push(reason));
  f.machine.onUnlock(() => {
    unlockCalls += 1;
  });

  await f.machine.unlock(CODE);
  assert.equal(unlockCalls, 1);
  f.machine.lock();
  assert.deepEqual(lockCalls, ["manual"]);

  await f.machine.unlock(CODE);
  assert.equal(unlockCalls, 2);
  offLock();
  f.machine.lock("manual");
  assert.deepEqual(lockCalls, ["manual"], "после отписки колбэк не зовётся");
  zeroize(f.mk);
});

test("lock_machine: LOCKED не рвёт машину — контейнер доступен, wipe из LOCKED работает", async () => {
  // Контракт §3.4 «сокет жив»: машина не знает о сети; здесь фиксируем её часть контракта —
  // в LOCKED объект жив (state/container/coldEntryRequired читаются), но ключей НЕТ.
  const f = await machineFixture();
  await f.machine.unlock(CODE);
  f.machine.lock();

  assert.equal(f.machine.state, "LOCKED");
  assert.equal(f.machine.session, null);
  assert.equal(parseWrappedContainer(f.machine.container).header.platformClass, "max");
  assert.equal(typeof f.machine.coldEntryRequired(), "boolean");
  await f.machine.wipe();
  assert.equal(f.machine.state, "WIPED");
  zeroize(f.mk);
});

test("lock_machine: WIPED уничтожает WRAP — persist получает tombstone, unlock невозможен навсегда", async () => {
  const f = await machineFixture();
  await f.machine.unlock(CODE);
  const reasons: LockReason[] = [];
  f.machine.onLock((reason) => reasons.push(reason));

  await f.machine.wipe();

  assert.equal(f.machine.state, "WIPED");
  assert.deepEqual(reasons, ["wipe"], "из UNLOCKED wipe сперва увёл ключи (onLock ровно раз)");
  const last = f.persisted.at(-1)!;
  assert.ok(isWipedTombstone(last), "на диск ушёл tombstone");
  assert.ok(!("wrap" in last), "в tombstone нет ни байта WRAP");
  assert.ok(!("header" in last), "в tombstone нет солей/заголовка");
  await assert.rejects(f.machine.unlock(CODE), InvalidLockTransitionError);
  zeroize(f.mk);
});

test("lock_machine: duress-причина проходит как wipe (обработчик — T-526)", async () => {
  const f = await machineFixture();
  await f.machine.unlock(CODE);
  const reasons: LockReason[] = [];
  f.machine.onLock((reason) => reasons.push(reason));
  await f.machine.wipe("duress");
  assert.equal(f.machine.state, "WIPED");
  assert.deepEqual(reasons, ["duress"]);
  zeroize(f.mk);
});

test("lock_machine: cold-правило — 7 дней без открытия требуют код, unlock штампует lastOpenAt", async () => {
  const now = 1_700_000_000;
  const f = await machineFixture({ nowSeconds: now });

  // Свежий контейнер T-519 без meta: давность неизвестна → честно холодный.
  assert.equal(f.machine.coldEntryRequired(), true);

  await f.machine.unlock(CODE);
  const stamped = f.persisted.at(-1) as WrappedContainer;
  assert.equal(stamped.meta?.lastOpenAt, now, "unlock записал unix-секунды открытия");
  assert.equal(f.machine.coldEntryRequired(), false);

  // 7 дней ровно — ещё тёплый (правило «>7 дней»), секундой позже — холодный.
  f.machine.lock();
  f.clock.advance(COLD_AFTER_SECONDS);
  assert.equal(f.machine.coldEntryRequired(), false);
  f.clock.advance(1);
  assert.equal(f.machine.coldEntryRequired(), true);

  // Холодный вход по коду снова открывает контейнер и обновляет отметку.
  await f.machine.unlock(CODE);
  assert.equal(f.machine.coldEntryRequired(), false);
  const restamped = f.persisted.at(-1) as WrappedContainer;
  assert.equal(restamped.meta?.lastOpenAt, now + COLD_AFTER_SECONDS + 1);
  zeroize(f.mk);
});

test("format: старый контейнер T-519 без meta читается как раньше, с meta — совместимо", async () => {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });

  // Байт-в-байт формат T-519 (без поля meta) проходит парсер и unlock.
  const legacyJson = JSON.stringify(created.container);
  assert.ok(!legacyJson.includes("meta"), "контейнер T-519 не содержит meta");
  const legacy = parseWrappedContainer(JSON.parse(legacyJson));
  assert.ok(!("meta" in legacy), "нормализованная копия не добавляет поле");
  const mk = await unlockContainer({ code: CODE, container: legacy, factors: testFactors });
  assert.ok(timingSafeEqual(mk, created.mk));

  // Расширенный контейнер (T-522) тоже валиден и открывается тем же кодом.
  const stamped = containerWithLastOpen(created.container, 1_700_000_000);
  assert.equal(stamped.meta?.lastOpenAt, 1_700_000_000);
  const mk2 = await unlockContainer({
    code: CODE,
    container: JSON.parse(JSON.stringify(stamped)),
    factors: testFactors,
  });
  assert.ok(timingSafeEqual(mk2, created.mk));

  // Неизвестные поля в meta и мусорный lastOpenAt отклоняются как повреждённый формат.
  assert.throws(
    () => parseWrappedContainer({ ...stamped, meta: { lastOpenAt: 1, unexpected: true } }),
    /meta/,
  );
  assert.throws(() => parseWrappedContainer({ ...stamped, meta: { lastOpenAt: -5 } }), /meta/);
  assert.throws(() => parseWrappedContainer({ ...stamped, meta: { lastOpenAt: 1.5 } }), /meta/);
  zeroize(created.mk, mk, mk2);
});

test("container: isContainerCold честен на границе и на контейнере без отметки", async () => {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });
  const now = 1_700_000_000;
  assert.equal(isContainerCold(created.container, now), true, "без отметки — холодный");
  const stamped = containerWithLastOpen(created.container, now);
  assert.equal(isContainerCold(stamped, now + COLD_AFTER_SECONDS), false, "ровно 7 дней — тёплый");
  assert.equal(isContainerCold(stamped, now + COLD_AFTER_SECONDS + 1), true, "> 7 дней — холодный");
  zeroize(created.mk);
});

test("container: rewrap (смена кода) сохраняет meta — смена кода не считается открытием", async () => {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });
  const stamped = containerWithLastOpen(created.container, 1_700_000_000);
  const session = await CryptoSession.unlock({
    code: CODE,
    container: stamped,
    factors: testFactors,
  });
  const next = await session.changeCode("new phrase for tests");
  assert.equal(next.meta?.lastOpenAt, 1_700_000_000, "lastOpenAt пережил пере-обёртку");
  session.lock();
  zeroize(created.mk);
});

test("container: destroyWrap принимает только настоящий контейнер и не мутирует вход", async () => {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });
  const before = JSON.stringify(created.container);
  const tombstone = destroyWrap(created.container);
  assert.ok(isWipedTombstone(tombstone));
  assert.equal(JSON.stringify(created.container), before, "вход не тронут — persist решает вызывающий");
  assert.equal(isWipedTombstone(created.container), false);
  assert.throws(() => destroyWrap(tombstone as unknown as WrappedContainer), /контейнер|формат/i);
  zeroize(created.mk);
});

test("lock_machine: wipe во время unlock не даёт опубликовать ключи (гонка KDF)", async () => {
  const created = await createContainer({ code: CODE, platformClass: "max", factors: testFactors });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const base = new TestUserSecret();
  const gatedFactors: KekFactors = {
    ...testFactors,
    user: {
      derive: async (code, salt, params) => {
        started();
        await gate;
        return base.derive(code, salt, params);
      },
    },
  };
  const machine = new LockMachine({
    container: created.container,
    factors: gatedFactors,
    persist: () => {},
    clock: new FakeClock(),
  });
  const pending = machine.unlock(CODE);
  await didStart;
  await machine.wipe();
  release();

  await assert.rejects(pending, InvalidLockTransitionError);
  assert.equal(machine.state, "WIPED");
  assert.equal(machine.session, null);
  zeroize(created.mk);
});

test("lock_machine: dispose снимает подписки на сигналы и таймер", async () => {
  const signals = new FakeSignals();
  const f = await machineFixture({ signals });
  await f.machine.unlock(CODE);
  f.machine.notifyBackground();
  assert.equal(f.clock.pendingTimers, 1);

  f.machine.dispose();

  assert.equal(f.clock.pendingTimers, 0, "таймер автолока снят");
  signals.screenOff();
  signals.background();
  assert.equal(f.machine.state, "UNLOCKED", "после dispose сигналы платформы не лочат");
  f.machine.lock();
  zeroize(f.mk);
});
