// T-521 (DS-03) — media_crypto: пофайловые ключи HKDF(K_files, file_id), чанки 1 МиБ
// (DEVICE_SECURITY.md §3.3). Чистые юнит-тесты формата v1 — без store и без сети.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_CHUNK_BYTES,
  MEDIA_CRYPTO_CONSTANTS,
  MediaCryptoError,
  decryptMediaBlob,
  deriveMediaFileKey,
  encryptMediaBlob,
} from "../src/media_crypto.ts";

const { HEADER_BYTES, NONCE_PREFIX_BYTES, GCM_TAG_BYTES, FILE_KEY_BYTES } = MEDIA_CRYPTO_CONSTANTS;

// Детерминированный K_files (в проде — HKDF(MK,"gc-files-v1") из crypto_store; здесь важен
// только контракт «32 байта»).
function kFiles(seed = 1): Uint8Array {
  const k = new Uint8Array(FILE_KEY_BYTES);
  for (let i = 0; i < k.length; i++) k[i] = (i * 31 + seed * 7) & 0xff;
  return k;
}

// Детерминированные псевдослучайные байты (LCG) — как в upload.test.ts.
function bytes(n: number, seed = 7): Uint8Array {
  const a = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    a[i] = x & 0xff;
  }
  return a;
}

async function roundTrip(n: number, fileId: number | string = 42): Promise<void> {
  const key = await deriveMediaFileKey(kFiles(), fileId);
  const pt = bytes(n, n + 3);
  const box = await encryptMediaBlob(key, fileId, pt);
  const expectedChunks = Math.max(1, Math.ceil(n / MEDIA_CHUNK_BYTES));
  assert.equal(
    box.length,
    HEADER_BYTES + n + expectedChunks * GCM_TAG_BYTES,
    `размер контейнера для ${n} байт`,
  );
  const back = await decryptMediaBlob(key, fileId, box);
  assert.equal(back.length, n);
  assert.deepEqual(back, pt, `round-trip ${n} байт`);
}

test("media_crypto: round-trip 0 Б / <1 МиБ / ровно 1 МиБ / 2.5 МиБ", async () => {
  await roundTrip(0);
  await roundTrip(3);
  await roundTrip(700 * 1024);
  await roundTrip(MEDIA_CHUNK_BYTES); // ровно граница — один чанк
  await roundTrip(MEDIA_CHUNK_BYTES + 1); // граница+1 — два чанка
  await roundTrip(Math.floor(2.5 * MEDIA_CHUNK_BYTES)); // 3 чанка, последний неполный
});

test("media_crypto: per-file ключи различны при одном K_files и детерминированы", async () => {
  const base = kFiles();
  const k1 = await deriveMediaFileKey(base, 1);
  const k2 = await deriveMediaFileKey(base, 2);
  const k1again = await deriveMediaFileKey(base, 1);
  assert.notDeepEqual([...k1], [...k2], "разные file_id → разные ключи");
  assert.deepEqual([...k1], [...k1again], "один file_id → один ключ (детерминизм HKDF)");
  // Канонизация идентификатора: число и его строковое представление — один ключ (String(id)).
  const kStr = await deriveMediaFileKey(base, "1");
  assert.deepEqual([...k1], [...kStr]);
  // Чужой ключ не открывает контейнер.
  const pt = bytes(1024);
  const box = await encryptMediaBlob(k1, 1, pt);
  await assert.rejects(decryptMediaBlob(k2, 1, box), MediaCryptoError);
});

test("media_crypto: nonce-префикс свеж на каждую операцию (уникальность nonce)", async () => {
  const key = await deriveMediaFileKey(kFiles(), 7);
  const pt = bytes(64);
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const box = await encryptMediaBlob(key, 7, pt);
    const prefix = [...box.subarray(1, 1 + NONCE_PREFIX_BYTES)].join(",");
    assert.ok(!seen.has(prefix), "повторный nonce-префикс между операциями");
    seen.add(prefix);
  }
  // Внутри операции счётчик чанков делает nonce уникальным по построению; между операциями
  // уникальность держит 64-битный CSPRNG-префикс — что и проверено выше.
});

test("media_crypto: перестановка чанков местами → отказ (AAD несёт index)", async () => {
  const key = await deriveMediaFileKey(kFiles(), 11);
  const pt = bytes(2 * MEDIA_CHUNK_BYTES); // ровно 2 полных чанка
  const box = await encryptMediaBlob(key, 11, pt);
  const full = MEDIA_CHUNK_BYTES + GCM_TAG_BYTES;
  const swapped = box.slice();
  swapped.set(box.subarray(HEADER_BYTES + full, HEADER_BYTES + 2 * full), HEADER_BYTES);
  swapped.set(box.subarray(HEADER_BYTES, HEADER_BYTES + full), HEADER_BYTES + full);
  await assert.rejects(decryptMediaBlob(key, 11, swapped), MediaCryptoError);
});

test("media_crypto: усечение до целого числа чанков → отказ (AAD несёт total)", async () => {
  const key = await deriveMediaFileKey(kFiles(), 12);
  const pt = bytes(2 * MEDIA_CHUNK_BYTES);
  const box = await encryptMediaBlob(key, 12, pt);
  // «Аккуратное» усечение: выкинуть второй чанк и поправить totalChunks в заголовке так,
  // чтобы структурная проверка длины прошла — упасть обязан GCM-тег (total в AAD).
  const cut = box.slice(0, HEADER_BYTES + MEDIA_CHUNK_BYTES + GCM_TAG_BYTES);
  new DataView(cut.buffer).setUint32(1 + NONCE_PREFIX_BYTES, 1, false);
  await assert.rejects(decryptMediaBlob(key, 12, cut), MediaCryptoError);
  // Грубое усечение (хвост отрезан без правки заголовка) ловится структурной проверкой.
  await assert.rejects(decryptMediaBlob(key, 12, box.subarray(0, box.length - 5)), MediaCryptoError);
});

test("media_crypto: контейнер не открывается под чужим file_id (AAD несёт file_id)", async () => {
  const base = kFiles();
  const key = await deriveMediaFileKey(base, 21);
  const box = await encryptMediaBlob(key, 21, bytes(100));
  // Тот же ключ, другой заявленный file_id → другой AAD → отказ.
  await assert.rejects(decryptMediaBlob(key, 22, box), MediaCryptoError);
});

test("media_crypto: порча байта тела или заголовка → отказ", async () => {
  const key = await deriveMediaFileKey(kFiles(), 30);
  const box = await encryptMediaBlob(key, 30, bytes(1000));
  for (const pos of [0, 1, HEADER_BYTES, box.length - 1]) {
    const bad = box.slice();
    bad[pos] = bad[pos]! ^ 0x01;
    await assert.rejects(decryptMediaBlob(key, 30, bad), MediaCryptoError, `позиция ${pos}`);
  }
  // Пустой/огрызочный вход.
  await assert.rejects(decryptMediaBlob(key, 30, new Uint8Array(0)), MediaCryptoError);
  await assert.rejects(decryptMediaBlob(key, 30, new Uint8Array(5)), MediaCryptoError);
});

test("media_crypto: K_files неверной длины отклоняется", async () => {
  await assert.rejects(deriveMediaFileKey(new Uint8Array(16), 1), MediaCryptoError);
  await assert.rejects(encryptMediaBlob(new Uint8Array(16), 1, bytes(8)), MediaCryptoError);
  await assert.rejects(decryptMediaBlob(new Uint8Array(16), 1, bytes(64)), MediaCryptoError);
});

test("media_crypto: микро-бенч p50 encrypt/decrypt 1 МиБ (бюджеты §13.1)", async () => {
  const key = await deriveMediaFileKey(kFiles(), 99);
  const pt = bytes(MEDIA_CHUNK_BYTES, 5);
  const encTimes: number[] = [];
  const decTimes: number[] = [];
  const N = 21;
  for (let i = 0; i < N; i++) {
    let t0 = performance.now();
    const box = await encryptMediaBlob(key, 99, pt);
    encTimes.push(performance.now() - t0);
    t0 = performance.now();
    await decryptMediaBlob(key, 99, box);
    decTimes.push(performance.now() - t0);
  }
  const p50 = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  const encP50 = p50(encTimes);
  const decP50 = p50(decTimes);
  // Числа уходят в отчёт линии; порог здесь — грубая страховка от катастрофического регресса
  // (аппаратный AES через WebCrypto даёт единицы миллисекунд; кадр 60 fps = 16.7 мс).
  console.log(`media_crypto bench: encrypt 1MiB p50=${encP50.toFixed(2)}ms, decrypt 1MiB p50=${decP50.toFixed(2)}ms (N=${N})`);
  assert.ok(encP50 < 100, `encrypt p50 ${encP50}ms подозрительно велик`);
  assert.ok(decP50 < 100, `decrypt p50 ${decP50}ms подозрительно велик`);
});
