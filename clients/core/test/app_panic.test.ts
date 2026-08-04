// T-528 (DS-10): panic-wipe — мгновенное LOCK + криптостирание WRAP без подтверждений.
//
// РЕПРОДУКЦИЯ-ФИКСАЦИЯ (коммит 1): прежде чем добавлять panic-путь, доказываем, как СЕГОДНЯ
// работает единственный «тихий» wipe — duress (T-526). Факты, которые panic обязан отразить:
//   1) уничтожение = destroyWrap: перезапись WRAP tombstone-ом; persist-слой контроллера
//      АТОМАРНО подменяет tombstone на снапшот «свежая установка» (container:null, дефолты);
//   2) ключи (MK + доменные) обнуляются CryptoSession.lock() ДО любых колбэков (I-DS-1):
//      захваченный буфер K_db становится нулевым, currentDbKey === null;
//   3) наружу не утекает состояние WIPED: наблюдатель видит только state:DISABLED;
//   4) физическое удаление файлов — best-effort ПОСЛЕ авторитетного криптостирания;
//   5) сетевые действия (revoke) — fire-and-forget колбэк ПОСЛЕ локального стирания;
//   6) повторный вход = свежая установка: DISABLED, passthrough, enable() строит новый контейнер.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppLockController,
  normalizeAppLockSnapshot,
  type AppLockSnapshot,
} from "../src/index.ts";
import {
  isWipedTombstone,
  type Argon2idParams,
  type DuressAction,
  type KekFactors,
  type LockClock,
  type UserSecretDeriver,
} from "../src/crypto_store/index.ts";
import { hmacSha256, utf8 } from "../src/crypto_store/primitives.ts";

const CODE = "correct horse battery staple";
const DURESS = "silent river warning phrase";

class CountingUserSecret implements UserSecretDeriver {
  calls = 0;
  async derive(code: string, salt: Uint8Array, _params: Argon2idParams): Promise<Uint8Array> {
    this.calls++;
    return hmacSha256(utf8(code), salt);
  }
}

function factors(user = new CountingUserSecret()): KekFactors & { user: CountingUserSecret } {
  return { user, hw: null };
}

/** Часы с учётом взведённых таймеров: доказательство «без анимаций/отложенных шагов». */
class CountingClock implements LockClock {
  #now = 1_700_000_000;
  timersSet = 0;
  nowSeconds(): number {
    return this.#now;
  }
  setTimeout(callback: () => void, _ms: number): unknown {
    this.timersSet++;
    // Таймеры автолока в этих сценариях не должны срабатывать; никогда не исполняем.
    void callback;
    return this.timersSet;
  }
  clearTimeout(_handle: unknown): void {}
}

function clone(snapshot: AppLockSnapshot): AppLockSnapshot {
  return structuredClone(snapshot);
}

function controllerFixture(initial?: AppLockSnapshot) {
  const f = factors();
  const clock = new CountingClock();
  let saved = initial ? clone(initial) : normalizeAppLockSnapshot();
  let physicalWipes = 0;
  const actions: DuressAction[] = [];
  const events: string[] = [];
  const persistenceHistory: AppLockSnapshot[] = [];
  const duressObservations: Array<{ state: string; dbKeyNull: boolean }> = [];

  const controller = new AppLockController({
    snapshot: saved,
    factors: f,
    platformClass: "web-user-only",
    clock,
    migrateLocalData: async () => {},
    persistence: {
      save(next) {
        saved = clone(next);
        persistenceHistory.push(clone(next));
      },
    },
    wipeLocalData: () => {
      physicalWipes++;
      events.push("physical-wipe");
    },
    onDuress: (action) => {
      actions.push(action);
      events.push("duress-callback");
      duressObservations.push({
        state: controller.state,
        dbKeyNull: controller.currentDbKey === null,
      });
    },
  });
  controller.subscribe((state) => events.push(`state:${state}`));
  return {
    controller,
    factors: f,
    clock,
    snapshot: () => clone(saved),
    physicalWipes: () => physicalWipes,
    actions,
    events,
    persistenceHistory,
    duressObservations,
  };
}

test("T-528 репродукция: duress-путь сегодня — криптостирание, свежая установка, zeroize до колбэков", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);
  await f.controller.configureDuress(CODE, DURESS, "trusted_friend");

  // Захватываем живой K_db: после duress этот же буфер обязан стать нулевым (I-DS-1).
  const dbKey = f.controller.currentDbKey;
  assert.ok(dbKey && dbKey.byteLength === 32, "включённый замок публикует 32-байтовый K_db");
  const dbKeyRef = dbKey;
  assert.ok([...dbKeyRef].some((byte) => byte !== 0));

  f.controller.lock();
  f.events.length = 0;
  await f.controller.unlock(DURESS);

  // (1) Свежая установка вместо WIPED-квитанции: container:null, никакого tombstone в истории.
  assert.equal(f.controller.state, "DISABLED");
  assert.equal(f.controller.passthroughAllowed(), true);
  assert.equal(f.snapshot().container, null);
  assert.equal(
    f.persistenceHistory.some((snapshot) => isWipedTombstone(snapshot.container)),
    false,
    "duress persist атомарно подменяет tombstone свежим снапшотом — квитанция не пишется",
  );

  // (2) Ключи обнулены: тот самый буфер K_db стал нулевым, публичный провайдер закрыт.
  assert.ok([...dbKeyRef].every((byte) => byte === 0), "K_db обнулён zeroize-ом, не потерян");
  assert.equal(f.controller.currentDbKey, null);

  // (3) Наблюдатель не видит WIPED; колбэк duress выполняется ПОСЛЕ стирания, ДО state:DISABLED.
  assert.ok(!f.events.includes("state:WIPED"));
  assert.ok(f.events.indexOf("physical-wipe") < f.events.indexOf("duress-callback"));
  assert.ok(f.events.indexOf("duress-callback") < f.events.indexOf("state:DISABLED"));
  assert.deepEqual(f.duressObservations, [{ state: "DISABLED", dbKeyNull: true }]);

  // (4)+(5) Физический wipe — ровно один; сетевой колбэк получил действие с довер. контактом.
  assert.equal(f.physicalWipes(), 1);
  assert.deepEqual(f.actions, [{ trustedUsername: "trusted_friend" }]);

  // Биометрический fast-path не переживает стирание.
  assert.deepEqual(f.snapshot().biometric, { enabled: false, wrap: null, failures: 0 });

  // (6) Повторный вход: контроллер из сохранённого снапшота выглядит как свежая установка.
  const reentry = controllerFixture(f.snapshot());
  assert.equal(reentry.controller.state, "DISABLED");
  assert.equal(reentry.controller.enabled, false);
  await reentry.controller.enable(CODE);
  assert.equal(reentry.controller.state, "UNLOCKED");
  const fresh = reentry.snapshot().container;
  assert.ok(fresh && !isWipedTombstone(fresh), "enable() после duress строит новый контейнер с нуля");
});

// ───────────────────────── ЯДРО (коммит 2): panic-путь поверх доказанного duress-механизма ─────────────────────────

test("T-528 panic: из UNLOCKED — LOCK + криптостирание, свежая установка, zeroize до колбэков", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);

  const dbKeyRef = f.controller.currentDbKey;
  assert.ok(dbKeyRef && dbKeyRef.byteLength === 32);
  assert.ok([...dbKeyRef].some((byte) => byte !== 0));

  f.events.length = 0;
  await f.controller.panic();

  // Свежая установка, как у duress: container:null, без WIPED-квитанции и без state:WIPED.
  assert.equal(f.controller.state, "DISABLED");
  assert.equal(f.controller.passthroughAllowed(), true);
  assert.equal(f.snapshot().container, null);
  assert.equal(
    f.persistenceHistory.some((snapshot) => isWipedTombstone(snapshot.container)),
    false,
    "panic persist атомарно подменяет tombstone свежим снапшотом — квитанция не пишется",
  );
  assert.ok(!f.events.includes("state:WIPED"), "наблюдатель не видит WIPED при panic");

  // I-DS-1: тот же буфер K_db обнулён синхронно внутри machine.wipe(); провайдер закрыт.
  assert.ok([...dbKeyRef].every((byte) => byte === 0), "K_db обнулён zeroize-ом");
  assert.equal(f.controller.currentDbKey, null);

  // Физическое удаление — best-effort ПОСЛЕ авторитетного криптостирания, ровно один раз.
  assert.equal(f.physicalWipes(), 1);
  assert.deepEqual(f.snapshot().biometric, { enabled: false, wrap: null, failures: 0 });
  // Флаг panic не переживает стирание: свежая установка не выдаёт, что фича была включена.
  assert.equal(f.snapshot().policy.panic, false);

  // Duress-контракт не задет: колбэк duress не вызывался.
  assert.deepEqual(f.actions, []);
});

test("T-528 panic: бюджет <100 мс — ни KDF, ни таймеров, ни подтверждений на пути стирания", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);

  // Инструментированные часы: фиксируем базовые счётчики ПЕРЕД panic.
  const timersBefore = f.clock.timersSet;
  f.factors.user.calls = 0;

  const t0 = performance.now();
  await f.controller.panic();
  const elapsedMs = performance.now() - t0;

  assert.ok(
    elapsedMs < 100,
    `panic обязан уложиться в бюджет <100 мс (замерено ${elapsedMs.toFixed(2)} мс)`,
  );
  assert.equal(f.factors.user.calls, 0, "panic не выполняет ни одного Argon2id/KDF — код не спрашивается");
  assert.equal(f.clock.timersSet, timersBefore, "panic не взводит таймеров — без анимаций и отложенных шагов");
  assert.equal(f.controller.state, "DISABLED");
});

test("T-528 panic: работает и из LOCKED/COLD — стирание не требует разблокировки", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);
  f.controller.lock();
  assert.equal(f.controller.state, "LOCKED");

  f.events.length = 0;
  await f.controller.panic();

  assert.equal(f.controller.state, "DISABLED");
  assert.equal(f.snapshot().container, null);
  assert.equal(
    f.persistenceHistory.some((snapshot) => isWipedTombstone(snapshot.container)),
    false,
  );
  assert.ok(!f.events.includes("state:WIPED"));
  assert.equal(f.physicalWipes(), 1);

  // COLD (свежий контроллер над живым контейнером, ключей в RAM ещё не было).
  const g = controllerFixture();
  await g.controller.enable(CODE);
  const cold = controllerFixture(g.snapshot());
  assert.equal(cold.controller.state, "COLD");
  await cold.controller.panic();
  assert.equal(cold.controller.state, "DISABLED");
  assert.equal(cold.snapshot().container, null);
});

test("T-528 panic: повторный вход = свежая установка; duress-регресс не затронут", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);
  await f.controller.configureDuress(CODE, DURESS, "trusted_friend");
  await f.controller.panic();

  // Повторный вход: контроллер из сохранённого снапшота — как первый запуск приложения.
  const reentry = controllerFixture(f.snapshot());
  assert.equal(reentry.controller.state, "DISABLED");
  assert.equal(reentry.controller.enabled, false);
  assert.deepEqual(reentry.controller.duress, { enabled: false, signal: false });
  await reentry.controller.enable(CODE);
  assert.equal(reentry.controller.state, "UNLOCKED");
  const fresh = reentry.snapshot().container;
  assert.ok(fresh && !isWipedTombstone(fresh), "enable() после panic строит новый контейнер с нуля");

  // Регресс duress на нетронутом контроллере: тихое стирание работает как в T-526.
  const d = controllerFixture();
  await d.controller.enable(CODE);
  await d.controller.configureDuress(CODE, DURESS, null);
  d.controller.lock();
  await d.controller.unlock(DURESS);
  assert.equal(d.controller.state, "DISABLED");
  assert.deepEqual(d.actions, [{ trustedUsername: null }]);
});

test("T-528 panic: onPanic — fire-and-forget ПОСЛЕ локального стирания; ошибки сети не мешают", async () => {
  const f = factors();
  let saved = normalizeAppLockSnapshot();
  const events: string[] = [];
  let dbKeyNullAtPanicCallback: boolean | null = null;

  const controller = new AppLockController({
    snapshot: saved,
    factors: f,
    platformClass: "web-user-only",
    migrateLocalData: async () => {},
    persistence: { save(next) { saved = structuredClone(next); } },
    wipeLocalData: () => { events.push("physical-wipe"); },
    onPanic: () => {
      events.push("panic-callback");
      dbKeyNullAtPanicCallback = controller.currentDbKey === null;
      // Отвергнутый промис сети не должен ронять panic (fire-and-forget).
      return Promise.reject(new Error("offline"));
    },
  });
  controller.subscribe((state) => events.push(`state:${state}`));

  await controller.enable(CODE);
  events.length = 0;
  await controller.panic();

  assert.equal(controller.state, "DISABLED");
  assert.ok(events.indexOf("physical-wipe") < events.indexOf("panic-callback"),
    "сеть строго ПОСЛЕ локального криптостирания");
  assert.ok(events.indexOf("panic-callback") < events.indexOf("state:DISABLED"));
  assert.equal(dbKeyNullAtPanicCallback, true, "к моменту сетевого колбэка ключей уже нет");

  // Без onPanic контроллер также стирает молча (колбэк опционален).
  const bare = controllerFixture();
  await bare.controller.enable(CODE);
  await bare.controller.panic();
  assert.equal(bare.controller.state, "DISABLED");
});

test("T-528 setPanicEnabled: opt-in флаг политики — выключен по умолчанию, переживает lock/unlock", async () => {
  const f = controllerFixture();
  await f.controller.enable(CODE);
  assert.equal(f.controller.policy.panic, false, "дефолт §13.2: жёсткая фича выключена");

  await f.controller.setPanicEnabled(true);
  assert.equal(f.controller.policy.panic, true);
  assert.equal(f.snapshot().policy.panic, true, "флаг персистится");

  f.controller.lock();
  await f.controller.unlock(CODE);
  assert.equal(f.controller.policy.panic, true, "обычный lock/unlock сохраняет настройку");

  await f.controller.setPanicEnabled(false);
  assert.equal(f.snapshot().policy.panic, false);

  // Нормализация мусора из localStorage не включает фичу сама.
  assert.equal(normalizeAppLockSnapshot({ policy: { panic: "yes" } } as never).policy.panic, false);
  assert.equal(normalizeAppLockSnapshot(null).policy.panic, false);
});

test("T-528 panic: недоступен без контейнера (DISABLED) — стирать нечего", async () => {
  const f = controllerFixture();
  await assert.rejects(f.controller.panic(), /disabled/);
});
