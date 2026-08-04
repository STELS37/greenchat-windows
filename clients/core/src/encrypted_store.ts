// clients/core — EncryptedStore: the record-level encryption seam over any ClientStore
// (T-520, DS-02; DEVICE_SECURITY.md §3.3).
//
// Wraps a lower ClientStore (MemoryStore / IndexedDbStore) so that every record in every
// collection EXCEPT "media" is stored as AES-256-GCM(K_db) ciphertext:
//   - nonce: 12 random bytes per record write (CSPRNG), stored next to the ciphertext;
//   - AAD:   "<collection>|<key>" — moving a ciphertext to another collection or key slot
//            breaks the GCM tag (§3.3 "AAD = имя стора+ключ");
//   - the record key itself stays plaintext: it IS the out-of-line IndexedDB key, which no
//     store-level layer can hide (numeric ids / client_msg_id — structure, not content).
//
// scan() decrypts IN MEMORY and only then applies the secondary-field filter against the
// plaintext — no plaintext index ever reaches the disk. This is exact-semantics: neither
// backend has a real IndexedDB index (both filter JS-side over the full collection), so the
// in-memory filter reproduces the lower stores' algorithm (key order → reverse → filter →
// limit) bit for bit.
//
// The "media" collection is ALWAYS a byte-for-byte passthrough through this layer: media
// blobs get per-file keys HKDF(K_files, file_id) with 1 MiB chunks in media_cache.ts —
// that is T-521 (DS-03), a separate task and zone. Encrypting them here as one giant
// K_db record would be wrong twice (wrong key domain, no chunking).
//
// Keys come from a provider, not a field: K_db is owned by the CryptoSession (T-519) /
// the lock state machine (T-522), which zeroize it on lock. This module never copies key
// bytes into long-lived state; a Uint8Array key is imported into a non-extractable
// CryptoKey per operation (with a WeakMap cache keyed by the provider's own buffer, so a
// session-cached buffer avoids re-import without this layer retaining the raw bytes).
//
// Before the user enables the app lock the wrapper supports an EXPLICIT passthrough mode. T-523
// switches it off through a durable two-phase migration: first WRAP+migration=pending is persisted,
// then every non-media record and media record is sealed and committed in one lower-store transaction.
// Existing envelopes are recognized and preserved, so a crash/retry is idempotent. The legacy plaintext
// read path below remains only as a defensive compatibility/repair seam and is never exposed while LOCKED.
import {
  COLLECTIONS,
  type ClientStore,
  type Collection,
  type ScanQuery,
  type StoreEntry,
  type StoreKey,
  type WriteOp,
} from "./store.ts";

/**
 * K_db provider. Returns the current database domain key (CryptoSession.domainKey("db"),
 * 32 bytes, or an already-imported AES-GCM CryptoKey), or null when locked / no container.
 * Called on EVERY operation so lock/unlock transitions take effect immediately. Contract:
 * after lock() the provider MUST return null — this layer does not detect zeroized buffers.
 */
export type DbKeyProvider = () => CryptoKey | Uint8Array | null;

export interface EncryptedStoreOptions {
  store: ClientStore;
  key: DbKeyProvider;
  /**
   * Explicit opt-in for the pre-DS-04 interim: with no key from the provider, operate as a
   * byte-for-byte passthrough instead of failing. Default false: no key → every data
   * operation throws (the DS-04 LOCKED posture).
   */
  allowPassthrough?: boolean | (() => boolean);
  /** Warning sink for the passthrough notice (default console.warn; test seam). */
  warn?: (message: string) => void;
  /**
   * Legacy plaintext is valid only before the application lock is enabled. By default this follows
   * allowPassthrough; shipping code supplies the live controller predicate explicitly.
   */
  allowPlaintext?: boolean | (() => boolean);
  /** Called at most once when authenticated storage integrity is violated. Never receives plaintext. */
  onIntegrityError?: (error: EncryptedStoreIntegrityError) => void;
}

export class EncryptedStoreIntegrityError extends Error {
  readonly collection: Collection;
  readonly recordKey: StoreKey | null;

  constructor(collection: Collection, recordKey: StoreKey | null, cause?: unknown) {
    const location = recordKey === null ? `"${collection}"` : `"${collection}" at key ${String(recordKey)}`;
    super(`EncryptedStore: integrity check failed in ${location}`, cause === undefined ? undefined : { cause });
    this.name = "EncryptedStoreIntegrityError";
    this.collection = collection;
    this.recordKey = recordKey;
  }
}
const NONCE_LEN = 12; // standard GCM nonce
const MARKER = 1; // envelope format version

// The on-disk shape of an encrypted record. Uint8Array fields survive structuredClone and
// IndexedDB natively. `k` echoes the record key: scan() cannot see slot keys (ClientStore
// returns values only), so the AAD is rebuilt from this echo; get() additionally verifies
// the echo against the requested key, so a ciphertext copied to another slot is rejected
// even though its tag is internally consistent.
interface Envelope {
  __gc_enc: typeof MARKER;
  k: StoreKey;
  iv: Uint8Array;
  ct: Uint8Array; // ciphertext with the GCM tag appended (WebCrypto layout)
}

function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<Envelope>;
  return (
    e.__gc_enc === MARKER &&
    (typeof e.k === "string" || typeof e.k === "number") &&
    e.iv instanceof Uint8Array &&
    e.iv.length === NONCE_LEN &&
    e.ct instanceof Uint8Array
  );
}

function hasEncryptedMarker(v: unknown): boolean {
  return typeof v === "object" && v !== null && Object.prototype.hasOwnProperty.call(v, "__gc_enc");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// WebCrypto helpers (self-contained: browser + Node 22; zero crypto_store imports —
// that directory is a neighbouring task's zone, coupling goes through DbKeyProvider only).

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error("EncryptedStore: WebCrypto (crypto.subtle) is unavailable");
  return c.subtle;
}

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) throw new Error("EncryptedStore: CSPRNG is unavailable");
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

// ArrayBuffer view for strict BufferSource typing (copy only when the view is partial).
function bufOf(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) return u.buffer as ArrayBuffer;
  return u.slice().buffer as ArrayBuffer;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Non-extractable CryptoKey per raw-key buffer. WeakMap: keyed by the PROVIDER's buffer
// identity, holds no raw bytes of its own — when the session drops/zeroizes its buffer the
// entry dies with it. A provider that returns a fresh buffer each call simply re-imports
// (microseconds); one that returns its session-cached buffer (CryptoSession does) hits.
const importedKeys = new WeakMap<Uint8Array, CryptoKey>();

async function asCryptoKey(key: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) return key;
  const hit = importedKeys.get(key);
  if (hit) return hit;
  const ck = await subtle().importKey("raw", bufOf(key), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  importedKeys.set(key, ck);
  return ck;
}

// AAD = "<collection>|<key>" (§3.3), with a one-character type tag so the number 5 and the
// string "5" (distinct IndexedDB keys) can never alias each other's AAD.
function aadOf(collection: Collection, key: StoreKey): Uint8Array {
  const tagged = typeof key === "number" ? `n:${key}` : `s:${key}`;
  return utf8Encoder.encode(`${collection}|${tagged}`);
}

// ---------------------------------------------------------------------------
// Plaintext serialization. The store's contract is structured-clone semantics, so plain
// JSON is not enough: the value graphs ClientStore documents (plain objects, arrays,
// Uint8Array/ArrayBuffer, plus Date and non-finite numbers) must round-trip. A tiny tagged
// encoding covers exactly those; anything structuredClone would also reject (functions) or
// nothing persists today (Map/Set) throws an honest error instead of corrupting silently.

const TAG = "$gc$"; // property name reserved by the codec; real objects using it get escaped

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeValue(v: unknown): unknown {
  if (v === undefined) return { [TAG]: "undef" };
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") {
    return Number.isFinite(v as number) ? v : { [TAG]: "num", v: String(v) };
  }
  if (v instanceof Uint8Array) return { [TAG]: "u8", v: b64encode(v) };
  if (v instanceof ArrayBuffer) return { [TAG]: "ab", v: b64encode(new Uint8Array(v)) };
  if (v instanceof Date) return { [TAG]: "date", v: v.getTime() };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (t === "object") {
    const src = v as Record<string, unknown>;
    const proto = Object.getPrototypeOf(src) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("EncryptedStore: unsupported value type for an encrypted record (plain data only)");
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) out[key] = encodeValue(src[key]);
    return TAG in src ? { [TAG]: "esc", v: out } : out;
  }
  throw new Error(`EncryptedStore: unsupported value type for an encrypted record (${t})`);
}

function decodeValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const rec = v as Record<string, unknown>;
  const tag = rec[TAG];
  if (typeof tag === "string") {
    switch (tag) {
      case "undef":
        return undefined;
      case "num":
        return Number(rec.v);
      case "u8":
        return b64decode(rec.v as string);
      case "ab":
        return bufOf(b64decode(rec.v as string));
      case "date":
        return new Date(rec.v as number);
      case "esc":
        return decodePlainObject(rec.v as Record<string, unknown>);
      default:
        throw new Error(`EncryptedStore: unknown codec tag "${tag}" in a decrypted record`);
    }
  }
  return decodePlainObject(rec);
}

function decodePlainObject(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec)) out[key] = decodeValue(rec[key]);
  return out;
}

function serialize(value: unknown): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(encodeValue(value)));
}

function deserialize(bytes: Uint8Array): unknown {
  return decodeValue(JSON.parse(utf8Decoder.decode(bytes)));
}

// ---------------------------------------------------------------------------

export class EncryptedStore implements ClientStore {
  private readonly lower: ClientStore;
  private readonly keyProvider: DbKeyProvider;
  private readonly allowPassthrough: boolean | (() => boolean);
  private readonly allowPlaintext: boolean | (() => boolean);
  private readonly onIntegrityError: ((error: EncryptedStoreIntegrityError) => void) | undefined;
  private integrityReported = false;

  constructor(opts: EncryptedStoreOptions) {
    this.lower = opts.store;
    this.keyProvider = opts.key;
    this.allowPassthrough = opts.allowPassthrough ?? false;
    this.allowPlaintext = opts.allowPlaintext ?? opts.allowPassthrough ?? false;
    this.onIntegrityError = opts.onIntegrityError;
    if (this.passthroughAllowed()) {
      (opts.warn ?? console.warn)(
        "EncryptedStore: passthrough is enabled — until a K_db session exists (DS-04/05 lock UI) " +
          "records are stored UNENCRYPTED, byte-for-byte the pre-DS-02 behaviour.",
      );
    }
  }

  private passthroughAllowed(): boolean {
    return typeof this.allowPassthrough === "function"
      ? this.allowPassthrough()
      : this.allowPassthrough;
  }

  private plaintextAllowed(): boolean {
    return typeof this.allowPlaintext === "function" ? this.allowPlaintext() : this.allowPlaintext;
  }

  private integrity(collection: Collection, recordKey: StoreKey | null, cause?: unknown): EncryptedStoreIntegrityError {
    const error = cause instanceof EncryptedStoreIntegrityError
      ? cause
      : new EncryptedStoreIntegrityError(collection, recordKey, cause);
    if (!this.integrityReported) {
      this.integrityReported = true;
      try { this.onIntegrityError?.(error); } catch { /* integrity verdict remains authoritative */ }
    }
    return error;
  }

  private plaintextOrThrow<T>(collection: Collection, recordKey: StoreKey | null, value: unknown): T {
    if (hasEncryptedMarker(value) || !this.plaintextAllowed()) {
      throw this.integrity(collection, recordKey);
    }
    return value as T;
  }

  // Current key, or null in (explicitly allowed) passthrough. Throws in the locked posture.
  private currentKey(): CryptoKey | Uint8Array | null {
    const key = this.keyProvider();
    if (key === null && !this.passthroughAllowed()) {
      throw new Error("EncryptedStore: no K_db available and passthrough is not allowed (locked)");
    }
    return key;
  }

  private async seal(
    key: CryptoKey | Uint8Array,
    collection: Collection,
    recordKey: StoreKey,
    value: unknown,
  ): Promise<Envelope> {
    const ck = await asCryptoKey(key);
    const iv = randomBytes(NONCE_LEN);
    const ct = await subtle().encrypt(
      { name: "AES-GCM", iv: bufOf(iv), additionalData: bufOf(aadOf(collection, recordKey)) },
      ck,
      bufOf(serialize(value)),
    );
    return { __gc_enc: MARKER, k: recordKey, iv, ct: new Uint8Array(ct) };
  }

  private async open(
    key: CryptoKey | Uint8Array | null,
    collection: Collection,
    env: Envelope,
  ): Promise<unknown> {
    if (key === null) {
      throw new Error(
        `EncryptedStore: encrypted record in "${collection}" but no K_db is available (locked)`,
      );
    }
    try {
      const ck = await asCryptoKey(key);
      const pt = await subtle().decrypt(
        { name: "AES-GCM", iv: bufOf(env.iv), additionalData: bufOf(aadOf(collection, env.k)) },
        ck,
        bufOf(env.ct),
      );
      return deserialize(new Uint8Array(pt));
    } catch (cause) {
      throw this.integrity(collection, env.k, cause);
    }
  }

  async get<T = unknown>(collection: Collection, key: StoreKey): Promise<T | undefined> {
    if (collection === "media") return this.lower.get<T>(collection, key);
    const current = this.currentKey(); // fail closed while locked, including legacy plaintext rows
    const raw = await this.lower.get(collection, key);
    if (raw === undefined) return undefined;
    if (!isEnvelope(raw)) return this.plaintextOrThrow<T>(collection, key, raw);
    if (raw.k !== key) {
      throw this.integrity(collection, key);
    }
    return (await this.open(current, collection, raw)) as T;
  }

  async put(collection: Collection, key: StoreKey, value: unknown): Promise<void> {
    if (collection === "media") return this.lower.put(collection, key, value);
    const k = this.currentKey();
    if (k === null) return this.lower.put(collection, key, value); // explicit passthrough
    await this.lower.put(collection, key, await this.seal(k, collection, key, value));
  }

  delete(collection: Collection, key: StoreKey): Promise<void> {
    return this.lower.delete(collection, key);
  }

  async entries<T = unknown>(collection: Collection): Promise<Array<StoreEntry<T>>> {
    if (collection === "media") return this.lower.entries<T>(collection);
    const current = this.currentKey();
    const rows = await this.lower.entries(collection);
    const opened: Array<StoreEntry<T>> = [];
    for (const row of rows) {
      if (!isEnvelope(row.value)) {
        opened.push({ key: row.key, value: this.plaintextOrThrow<T>(collection, row.key, row.value) });
        continue;
      }
      if (row.value.k !== row.key) {
        throw this.integrity(collection, row.key);
      }
      opened.push({ key: row.key, value: await this.open(current, collection, row.value) as T });
    }
    return opened;
  }


  /**
   * Prepare (but do not apply) the one-time plaintext→ciphertext rewrite. Every seal happens before
   * ClientStore.batch(), so the caller can commit DB records and media in ONE IndexedDB transaction.
   * Existing envelopes are left untouched, making crash recovery/idempotent retries safe.
   */
  async preparePlaintextMigrationOps(key: CryptoKey | Uint8Array): Promise<WriteOp[]> {
    const ops: WriteOp[] = [];
    for (const collection of COLLECTIONS) {
      if (collection === "media") continue;
      for (const row of await this.lower.entries(collection)) {
        if (isEnvelope(row.value)) {
          if (row.value.k !== row.key) {
            throw new EncryptedStoreIntegrityError(collection, row.key);
          }
          continue;
        }
        if (hasEncryptedMarker(row.value)) {
          throw new EncryptedStoreIntegrityError(collection, row.key);
        }
        ops.push({
          op: "put",
          collection,
          key: row.key,
          value: await this.seal(key, collection, row.key, row.value),
        });
      }
    }
    return ops;
  }

  async assertFullyEncryptedAtRest(): Promise<void> {
    for (const collection of COLLECTIONS) {
      if (collection === "media") continue;
      for (const row of await this.lower.entries(collection)) {
        if (!isEnvelope(row.value) || row.value.k !== row.key) {
          throw new EncryptedStoreIntegrityError(collection, row.key);
        }
      }
    }
  }

  async scan<T = unknown>(collection: Collection, query: ScanQuery = {}): Promise<T[]> {
    if (collection === "media") return this.lower.scan<T>(collection, query);
    // Fetch the whole collection in key order (keys are plaintext, so the lower store's
    // ordering — including reverse — is untouched by encryption), decrypt in memory, THEN
    // filter/limit against the plaintext. Same algorithm both backends run over plaintext
    // records (full pass → filter → limit), so semantics are identical; the only difference
    // is that the secondary-field comparison happens on decrypted values in RAM (§3.3 —
    // no plaintext index on disk).
    const key = this.currentKey();
    const rows = await this.lower.scan(collection, query.reverse ? { reverse: true } : {});
    let vals: unknown[] = [];
    for (const row of rows) {
      vals.push(isEnvelope(row)
        ? await this.open(key, collection, row)
        : this.plaintextOrThrow(collection, null, row));
    }
    if (query.index !== undefined && query.value !== undefined) {
      const idx = query.index;
      const want = query.value;
      vals = vals.filter((v) => isRecord(v) && v[idx] === want);
    }
    if (query.limit !== undefined) vals = vals.slice(0, query.limit);
    return vals as T[];
  }

  async batch(ops: WriteOp[]): Promise<void> {
    const key = this.currentKey();
    if (key === null) return this.lower.batch(ops); // explicit passthrough
    const sealed: WriteOp[] = [];
    for (const op of ops) {
      if (op.op === "put" && op.collection !== "media") {
        sealed.push({ ...op, value: await this.seal(key, op.collection, op.key, op.value) });
      } else {
        sealed.push(op);
      }
    }
    // One lower.batch call — atomicity (all-or-nothing) is preserved untouched.
    return this.lower.batch(sealed);
  }

  clear(collection: Collection): Promise<void> {
    return this.lower.clear(collection);
  }

  close(): Promise<void> {
    return this.lower.close();
  }
}
