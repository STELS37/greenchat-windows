// crypto_store/argon2.ts — S_user через Argon2id (libsodium-WASM), ленивая загрузка (T-519, DS-01).
//
// Реализует S_user из §3.1: Argon2id(код приложения; m=64 МиБ (32 на слабых), t=3, p=1),
// параметры берутся из заголовка контейнера. Реализация — libsodium-wrappers-sumo (Argon2id
// есть только в sumo-сборке).
//
// БЮДЖЕТ (§13.1): WASM libsodium НЕ должен попадать в основной веб-бандл. Поэтому импорт
// динамический (`await import(...)`) — esbuild/браузер грузят WASM отдельным чанком ТОЛЬКО при
// первом выводе S_user (т.е. при разблокировке кодом). Холодный старт без разблокировки WASM
// не тянет вовсе. Ленивый модуль кэшируется между вызовами (загрузка WASM — однократна).

import { type Argon2idParams, type UserSecretDeriver } from "./types.ts";
import { assertArgon2idParams } from "./policy.ts";

const SUSER_LEN = 32;

/** Минимальная форма libsodium, которую мы используем (чтобы не тянуть типы в бандл статически). */
export interface SodiumLike {
  ready: Promise<void>;
  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash(
    keyLength: number,
    password: Uint8Array | string,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
    outputFormat?: null,
  ): Uint8Array;
}

type SodiumModule = SodiumLike | { default?: SodiumLike };
export type SodiumImporter = () => Promise<SodiumModule>;
export type SodiumLoader = () => Promise<SodiumLike>;

/**
 * Создаёт retryable single-flight загрузчик. Успех кэшируется, а отказ import/ready сбрасывает
 * кэш: временный сбой не должен навсегда ломать разблокировку до перезагрузки вкладки.
 */
export function createSodiumLoader(importSodium: SodiumImporter): SodiumLoader {
  let pending: Promise<SodiumLike> | null = null;
  return () => {
    if (pending) return pending;
    const attempt = importSodium().then(async (mod) => {
      // libsodium экспортирует объект как default (ESM) либо как сам модуль (CJS-interop).
      const sodium = ((mod as { default?: SodiumLike }).default ?? mod) as SodiumLike;
      await sodium.ready;
      return sodium;
    });
    let guarded!: Promise<SodiumLike>;
    guarded = attempt.catch((error: unknown) => {
      if (pending === guarded) pending = null;
      throw error;
    });
    pending = guarded;
    return guarded;
  };
}

/**
 * Ленивая загрузка libsodium-WASM. Динамический импорт не входит в статический граф основного
 * бандла; успешный результат кэшируется и WASM инициализируется один раз за жизнь вкладки.
 */
const loadSodium = createSodiumLoader(() => import("libsodium-wrappers-sumo"));

/**
 * Прод-деривер S_user на Argon2id (libsodium-WASM). memLimit libsodium — в БАЙТАХ,
 * поэтому переводим memLimitKib * 1024. Соль должна быть crypto_pwhash_SALTBYTES (16).
 */
export class Argon2idUserSecret implements UserSecretDeriver {
  async derive(code: string, salt: Uint8Array, params: Argon2idParams): Promise<Uint8Array> {
    assertArgon2idParams(params);
    if (salt.length !== 16) {
      throw new Error(`crypto_store: соль Argon2id должна быть 16 байт, получено ${salt.length}`);
    }
    const sodium = await loadSodium();
    if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
      throw new Error(
        `crypto_store: соль Argon2id должна быть ${sodium.crypto_pwhash_SALTBYTES} байт, ` +
          `получено ${salt.length}`,
      );
    }
    return sodium.crypto_pwhash(
      SUSER_LEN,
      code,
      salt,
      params.opsLimit,
      params.memLimitKib * 1024,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
      null,
    );
  }
}

/**
 * Фабрика по умолчанию. Держим отдельной функцией, чтобы вызывающий код (и тесты) явно решали,
 * когда тянуть WASM — сам импорт-модуля этого файла ещё не грузит libsodium (это делает derive()).
 */
export function argon2idUserSecret(): UserSecretDeriver {
  return new Argon2idUserSecret();
}
