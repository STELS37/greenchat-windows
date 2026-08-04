// crypto_store/primitives.ts — низкоуровневые крипто-операции контейнера (T-519, DS-01).
//
// Все примитивы поверх WebCrypto (crypto.subtle): AES-256-GCM, HKDF-SHA256, HMAC-SHA256.
// WebCrypto доступен и в браузере, и в Node 22 (глобальный `crypto`), поэтому ядро остаётся
// zero-dep и тестируется через `node --test`. Ключевой материал, которым мы владеем напрямую
// (MK, доменные ключи, KEK), держим в Uint8Array — их можно явно обнулить (zeroize) при lock.
// CryptoKey, импортируемые для одной операции, эфемерны и non-extractable.
//
// Источник истины по схеме — DEVICE_SECURITY.md §3.1.

import {
  CanonicalBase64Error,
  decodeCanonicalBase64,
  encodeBase64,
} from "./base64.ts";

/** Возвращает глобальный SubtleCrypto (браузер / Node 22). */
function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error("crypto_store: WebCrypto (crypto.subtle) недоступен в этой среде");
  }
  return c.subtle;
}

/** Криптографически стойкие случайные байты (CSPRNG). */
export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) {
    throw new Error("crypto_store: CSPRNG (crypto.getRandomValues) недоступен");
  }
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

/**
 * Обнуление буфера ключа. Пишем нули на месте — после lock/re-wrap ни один байт
 * открытого ключевого материала не остаётся в RAM (инвариант I-DS-1, §3.4).
 */
export function zeroize(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const b of buffers) {
    if (b) b.fill(0);
  }
}

/** Постоянное по времени сравнение (для тестов/само-проверок; не ветвится по данным). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const enc = new TextEncoder();

/** UTF-8 байты строки (для info-меток HKDF и кода приложения). */
export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

/** Конкатенация байтовых буферов (например, S_hw ∥ S_user). */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * HKDF-SHA256(ikm, salt, info) → `length` байт.
 * Соответствует записи схемы: HKDF-SHA256(IKM, salt, info).
 * Для доменных ключей соль пустая (info несёт домен), для KEK — salt16.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const s = subtle();
  const baseKey = await s.importKey("raw", bufOf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await s.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bufOf(salt), info: bufOf(info) },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** HMAC-SHA256(key, data). Используется фейковым/веб-провайдером S_hw. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  const k = await s.importKey("raw", bufOf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await s.sign("HMAC", k, bufOf(data));
  return new Uint8Array(sig);
}

/**
 * AES-256-GCM шифрование. Возвращает ciphertext с приклеенным тегом (WebCrypto так и отдаёт).
 * iv — 12 байт (стандарт для GCM). aad — опциональные связанные данные.
 */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const s = subtle();
  const k = await s.importKey("raw", bufOf(key), { name: "AES-GCM" }, false, ["encrypt"]);
  const params: AesGcmParams = { name: "AES-GCM", iv: bufOf(iv) };
  if (aad) params.additionalData = bufOf(aad);
  const ct = await s.encrypt(params, k, bufOf(plaintext));
  return new Uint8Array(ct);
}

/**
 * AES-256-GCM расшифровка. При неверном ключе/теге WebCrypto бросает исключение
 * (провал аутентификации GCM) — это и есть «неверный код → отказ» из §3.1.
 */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const s = subtle();
  const k = await s.importKey("raw", bufOf(key), { name: "AES-GCM" }, false, ["decrypt"]);
  const params: AesGcmParams = { name: "AES-GCM", iv: bufOf(iv) };
  if (aad) params.additionalData = bufOf(aad);
  const pt = await s.decrypt(params, k, bufOf(ciphertext));
  return new Uint8Array(pt);
}

/**
 * Отдаёт ArrayBuffer-вид на Uint8Array без копирования, если это возможно, иначе копию.
 * Нужен для строгой типизации WebCrypto (BufferSource) при exactOptionalPropertyTypes.
 */
function bufOf(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) {
    return u.buffer as ArrayBuffer;
  }
  return u.slice().buffer as ArrayBuffer;
}

// ── base64 (без Buffer — работает и в браузере, и в Node) ──────────────────────

export function toBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

export function fromBase64(s: string): Uint8Array {
  try {
    return decodeCanonicalBase64(s);
  } catch (error) {
    if (error instanceof CanonicalBase64Error && error.reason === "noncanonical") {
      throw new Error("crypto_store: неканонический base64 в заголовке контейнера");
    }
    throw new Error("crypto_store: некорректный base64 в заголовке контейнера");
  }
}
