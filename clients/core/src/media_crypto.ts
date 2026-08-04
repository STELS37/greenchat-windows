// clients/core — media_crypto: пофайловое шифрование медиа-блобов (T-521, DS-03).
//
// Источник истины — DEVICE_SECURITY.md §3.3 дословно: «Медиа-кэш (media_cache) — пофайловые
// ключи HKDF(K_files, file_id), чанки 1 МиБ». Модуль — чистые функции над теми же WebCrypto-
// примитивами, что и крипто-контейнер T-519 (crypto_store/primitives.ts, READ-ONLY импорт);
// он не знает ни про store, ни про сеть — интеграция живёт в media_cache.ts.
//
// Ключи:
//   K_file = HKDF-SHA256(K_files, соль пустая, info = "gc-file-<file_id>-v1") — 32 байта.
//   Стиль меток тот же, что у доменных ключей T-519 ("gc-<домен>-v1", соль пустая, info несёт
//   идентификатор); file_id канонизируется через String().
//
// Формат шифроблоба (container) v1:
//   [0]      version      — 0x01
//   [1..8]   noncePrefix  — 8 СЛУЧАЙНЫХ байт, свежих на КАЖДУЮ операцию шифрования
//   [9..12]  totalChunks  — u32 BE, число GCM-чанков (>=1: пустой блоб = 1 чанк из 0 байт,
//                           чтобы даже у пустого файла был тег, привязанный к file_id)
//   [13..]   чанки подряд: plaintext режется на куски ровно 1 МиБ; чанк i < total-1 занимает
//            ровно CHUNK+16 байт (WebCrypto приклеивает 16-байтовый GCM-тег), последний —
//            остаток+16.
//
//   Nonce чанка i (12 байт) = noncePrefix ∥ u32BE(i). Уникальность пары (ключ, nonce):
//   ключ пофайловый, префикс — свежий CSPRNG на операцию шифрования (коллизия 2^-64 на пару
//   операций одного файла; файл перешифровывается редко — put/повторный download), счётчик
//   уникален внутри операции. Доказывается тестом.
//
//   AAD чанка i = utf8("gc-media-v1|<file_id>|<i>|<total>"). Следствия (все — тестами):
//   перестановка чанков (index), усечение/дописывание (total), подмена файла (file_id)
//   и подмена версии ломают GCM-тег. Заголовок отдельного тега не имеет: totalChunks входит
//   в AAD каждого чанка, noncePrefix — в nonce, version — в метку AAD, так что любая правка
//   заголовка эквивалентна порче тега.
//
// Что модуль сознательно НЕ скрывает: ДЛИНУ plaintext (она восстанавливается из длины
// контейнера) — по условию задачи длина = допустимые метаданные, скрытие размеров вне scope.

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  randomBytes,
  utf8,
} from "./crypto_store/primitives.ts";

/** Размер plaintext-чанка по §3.3 — ровно 1 МиБ. */
export const MEDIA_CHUNK_BYTES = 1024 * 1024;

const GCM_TAG_BYTES = 16; // WebCrypto AES-GCM: тег приклеен к шифртексту
const GCM_IV_BYTES = 12;
const NONCE_PREFIX_BYTES = 8;
const HEADER_BYTES = 1 + NONCE_PREFIX_BYTES + 4; // version + noncePrefix + totalChunks
const VERSION = 1;
const FILE_KEY_BYTES = 32; // AES-256
// Защитный предел парсера: 2^20 чанков = 1 ТиБ — на порядки больше любого реального медиа,
// но не даёт битому заголовку заказать абсурдную аллокацию.
const MAX_CHUNKS = 1 << 20;

/** Любой отказ модуля (порча, усечение, чужой ключ/файл, битый заголовок). */
export class MediaCryptoError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(`media_crypto: ${message}`);
    this.name = "MediaCryptoError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Пофайловый ключ по §3.3: HKDF-SHA256(K_files, "gc-file-<file_id>-v1"), соль пустая —
 * как у доменных ключей T-519 (info несёт идентификатор). Детерминирован; вызывающий обязан
 * обнулить результат после операции (сам K_files принадлежит сессии — его НЕ трогать).
 */
export async function deriveMediaFileKey(
  kFiles: Uint8Array,
  fileId: number | string,
): Promise<Uint8Array> {
  if (kFiles.length !== FILE_KEY_BYTES) {
    throw new MediaCryptoError(`K_files должен быть ${FILE_KEY_BYTES} байт, получено ${kFiles.length}`);
  }
  return hkdfSha256(kFiles, new Uint8Array(0), utf8(`gc-file-${String(fileId)}-v1`), FILE_KEY_BYTES);
}

function chunkNonce(prefix: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(GCM_IV_BYTES);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(NONCE_PREFIX_BYTES, index, false);
  return nonce;
}

function chunkAad(fileId: number | string, index: number, total: number): Uint8Array {
  return utf8(`gc-media-v1|${String(fileId)}|${index}|${total}`);
}

/**
 * Шифрует блоб пофайловым ключом чанками ровно 1 МиБ (формат v1 в шапке модуля).
 * Пустой plaintext даёт 1 чанк из 0 байт (16-байтовый тег) — контейнер всегда аутентифицирован.
 */
export async function encryptMediaBlob(
  fileKey: Uint8Array,
  fileId: number | string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (fileKey.length !== FILE_KEY_BYTES) {
    throw new MediaCryptoError(`ключ файла должен быть ${FILE_KEY_BYTES} байт`);
  }
  const total = Math.max(1, Math.ceil(plaintext.length / MEDIA_CHUNK_BYTES));
  if (total > MAX_CHUNKS) {
    throw new MediaCryptoError(`блоб слишком велик: ${total} чанков > предел ${MAX_CHUNKS}`);
  }
  const prefix = randomBytes(NONCE_PREFIX_BYTES);
  const out = new Uint8Array(HEADER_BYTES + plaintext.length + total * GCM_TAG_BYTES);
  out[0] = VERSION;
  out.set(prefix, 1);
  new DataView(out.buffer).setUint32(1 + NONCE_PREFIX_BYTES, total, false);

  let inOff = 0;
  let outOff = HEADER_BYTES;
  for (let i = 0; i < total; i++) {
    const end = i === total - 1 ? plaintext.length : inOff + MEDIA_CHUNK_BYTES;
    const ct = await aesGcmEncrypt(
      fileKey,
      chunkNonce(prefix, i),
      plaintext.subarray(inOff, end),
      chunkAad(fileId, i, total),
    );
    out.set(ct, outOff);
    outOff += ct.length;
    inOff = end;
  }
  return out;
}

/**
 * Расшифровывает контейнер v1. ЛЮБОЕ расхождение — усечение, перестановка/подмена чанков,
 * правка заголовка, чужой file_id или ключ — бросает MediaCryptoError (провал GCM-тега или
 * структурная невязка). Вызывающий трактует это как «повреждённый кэш» → честный re-download.
 */
export async function decryptMediaBlob(
  fileKey: Uint8Array,
  fileId: number | string,
  box: Uint8Array,
): Promise<Uint8Array> {
  if (fileKey.length !== FILE_KEY_BYTES) {
    throw new MediaCryptoError(`ключ файла должен быть ${FILE_KEY_BYTES} байт`);
  }
  if (box.length < HEADER_BYTES + GCM_TAG_BYTES) {
    throw new MediaCryptoError("контейнер короче минимального (заголовок + тег)");
  }
  if (box[0] !== VERSION) {
    throw new MediaCryptoError(`неизвестная версия контейнера: ${box[0]}`);
  }
  const prefix = box.subarray(1, 1 + NONCE_PREFIX_BYTES);
  const total = new DataView(box.buffer, box.byteOffset).getUint32(1 + NONCE_PREFIX_BYTES, false);
  if (total < 1 || total > MAX_CHUNKS) {
    throw new MediaCryptoError(`некорректное число чанков в заголовке: ${total}`);
  }
  const body = box.length - HEADER_BYTES;
  const fullChunk = MEDIA_CHUNK_BYTES + GCM_TAG_BYTES;
  const lastLen = body - (total - 1) * fullChunk;
  if (lastLen < GCM_TAG_BYTES || lastLen > fullChunk) {
    throw new MediaCryptoError("длина контейнера не согласована с числом чанков (усечение/дописывание)");
  }

  const out = new Uint8Array(body - total * GCM_TAG_BYTES);
  let outOff = 0;
  for (let i = 0; i < total; i++) {
    const off = HEADER_BYTES + i * fullChunk;
    const len = i === total - 1 ? lastLen : fullChunk;
    let pt: Uint8Array;
    try {
      pt = await aesGcmDecrypt(
        fileKey,
        chunkNonce(prefix, i),
        box.subarray(off, off + len),
        chunkAad(fileId, i, total),
      );
    } catch (e) {
      throw new MediaCryptoError(`аутентификация чанка ${i}/${total} провалена — контейнер повреждён или подменён`, e);
    }
    out.set(pt, outOff);
    outOff += pt.length;
  }
  return out;
}

/** Константы формата — для тестов и media_cache (не внешний API приложения). */
export const MEDIA_CRYPTO_CONSTANTS = {
  VERSION,
  HEADER_BYTES,
  NONCE_PREFIX_BYTES,
  GCM_TAG_BYTES,
  FILE_KEY_BYTES,
} as const;
