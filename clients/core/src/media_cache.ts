// clients/core — MediaCache: LRU blob cache over the ClientStore (T-403, CLIENTS.md §5.3).
//
// Downloaded attachments (avatars, photos, voice) are cached in the store's "media" collection so a
// re-open renders instantly and offline. Eviction is least-recently-used against a byte budget
// (configurable; the Lite / data-saver preset lowers it — §5.3). Download goes through the M0 file
// endpoint GET /v1/files/:id, which is auth'd, nosniff and Range-aware; here we fetch the whole blob
// (raw bytes, not the JSON envelope), so this uses fetch directly rather than ApiClient.
//
// T-521 (DS-03, DEVICE_SECURITY.md §3.3): when a crypto session is wired in (`session` option),
// blobs are sealed with per-file keys HKDF(K_files, file_id) in 1 MiB chunks (media_crypto.ts)
// BEFORE they touch the store, and opened in memory on get. The neighbouring EncryptedStore
// (T-520) deliberately passes the "media" collection through untouched — media encryption is
// owned entirely here, under K_files, not K_db. Without a session (web has no lock UI until
// DS-04/05) the cache is a byte-for-byte passthrough, exactly the pre-T-521 behaviour. The real
// mime travels INSIDE the sealed envelope; on disk an encrypted record exposes only the container
// byte length and the LRU last-access stamp (plaintext length is derivable from the container
// length — hiding sizes is explicitly out of scope for T-521).
import { ApiError, NetworkError } from "./errors.ts";
import type { TokenStore } from "./api.ts";
import type { ClientStore, WriteOp } from "./store.ts";
import {
  decryptMediaBlob,
  deriveMediaFileKey,
  encryptMediaBlob,
  MediaCryptoError,
} from "./media_crypto.ts";
import { zeroize } from "./crypto_store/primitives.ts";

export interface MediaBlob {
  id: number; // file_id (store key)
  bytes: Uint8Array;
  mime: string;
  size: number;
  at: number; // last-access ms — the LRU recency key
}

export interface MediaCacheAccessOptions {
  // T-529 cloud-only chat: bypass every disk read/write; bytes live only in the returned RAM object.
  persist?: boolean;
}

// What actually sits in the "media" collection. Passthrough records ARE MediaBlob (enc absent,
// bytes = plaintext — pre-T-521 shape, so existing caches parse unchanged). Sealed records carry
// the media_crypto v1 container in `bytes`, a constant opaque mime, and enc: 1. The invariant
// size === bytes.byteLength holds for both, so size()/evictToLimit stay shape-blind.
interface StoredMediaRecord extends MediaBlob {
  enc?: 1;
}

function isStoredMediaRecord(value: unknown): value is StoredMediaRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<StoredMediaRecord>;
  return (
    typeof row.id === "number" && Number.isSafeInteger(row.id) &&
    row.bytes instanceof Uint8Array &&
    typeof row.mime === "string" &&
    typeof row.size === "number" && Number.isFinite(row.size) &&
    typeof row.at === "number" && Number.isFinite(row.at) &&
    (row.enc === undefined || row.enc === 1)
  );
}

const SEALED_MIME = "application/octet-stream";

// The slice of a crypto_store CryptoSession the cache needs (structural — no hard dependency on
// T-519 session internals beyond the two members; a locked session refuses domainKey()).
export interface MediaKeyProvider {
  readonly isUnlocked: boolean;
  domainKey(domain: "files"): Promise<Uint8Array>;
}

export interface MediaCacheOptions {
  baseUrl: string;
  tokens: TokenStore;
  clientId: string;
  store: ClientStore;
  // Byte budget for the on-device media cache. Default 128 MiB; Lite mode calls setLimit() lower.
  limitBytes?: number;
  refresh?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  // T-521: source of K_files. Absent → passthrough (no lock UI yet). Present but LOCKED → the
  // cache never writes plaintext to disk: blobs are served from the network RAM-only.
  session?: MediaKeyProvider;

  // T-523: explicit compatibility mode before the user enables the app lock. May be dynamic.
  allowPassthrough?: boolean | (() => boolean);
}

const DEFAULT_LIMIT = 128 * 1024 * 1024;

export class MediaCache {
  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly clientId: string;
  private readonly store: ClientStore;
  private limitBytes: number;
  private readonly refresh: (() => Promise<boolean>) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly session: MediaKeyProvider | undefined;

  private readonly allowPassthrough: boolean | (() => boolean);
  // Coalesce concurrent gets of the same file into one download. Keys include the account epoch so a
  // new session can never reuse authenticated bytes promised to the previous account.
  private readonly inflight = new Map<string, Promise<MediaBlob>>();
  private accountEpoch = 0;
  private epochAbort = new AbortController();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private resetBarrier: Promise<void> = Promise.resolve();
  private resetFailure: unknown = null;

  constructor(opts: MediaCacheOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokens;
    this.clientId = opts.clientId;
    this.store = opts.store;
    this.limitBytes = opts.limitBytes ?? DEFAULT_LIMIT;
    this.refresh = opts.refresh;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.session = opts.session;

    this.allowPassthrough = opts.allowPassthrough ?? (opts.session === undefined);

  }

  // Account/session switch barrier. Abort old downloads, wait for every operation which already owns
  // old-account state, then repeat the bounded physical cleanup because an IndexedDB transaction may
  // commit after Session's first wipe. New-account operations wait behind resetBarrier.
  reset(): Promise<void> {
    const epoch = ++this.accountEpoch;
    this.epochAbort.abort();
    this.epochAbort = new AbortController();
    this.inflight.clear();
    this.resetFailure = null;
    const previousBarrier = this.resetBarrier;
    const pending = [...this.activeOperations];
    const operation = (async () => {
      await previousBarrier;
      await Promise.allSettled(pending);
      if (epoch !== this.accountEpoch) return;
      try {
        await this.store.clear("media");
      } catch (error) {
        if (epoch === this.accountEpoch) this.resetFailure = error;
        throw error;
      }
    })();
    this.resetBarrier = operation.catch(() => undefined);
    return operation;
  }

  private async operationContext(): Promise<{ epoch: number; signal: AbortSignal }> {
    await this.resetBarrier;
    if (this.resetFailure !== null) throw this.resetFailure;
    return { epoch: this.accountEpoch, signal: this.epochAbort.signal };
  }

  private ensureEpoch(epoch: number): void {
    if (epoch !== this.accountEpoch) throw new Error("MediaCache: account reset during operation");
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => { this.activeOperations.delete(tracked); });
    this.activeOperations.add(tracked);
    return tracked;
  }

  // Lite / data-saver preset lowers the budget; immediately evict down to the new limit.
  async setLimit(bytes: number): Promise<void> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      this.ensureEpoch(epoch);
      this.limitBytes = bytes;
      await this.evictToLimit(epoch);
      this.ensureEpoch(epoch);
    })());
  }

  private passthroughAllowed(): boolean {
    return typeof this.allowPassthrough === "function"
      ? this.allowPassthrough()
      : this.allowPassthrough;
  }

  // Sealing is on only while the session can actually derive K_files.
  private cryptoActive(): boolean {
    return this.session !== undefined && this.session.isUnlocked;
  }

  // Cached bytes if present (touch LRU), else download once, store, evict, and return.
  async get(fileId: number, opts: MediaCacheAccessOptions = {}): Promise<MediaBlob> {
    const { epoch, signal } = await this.operationContext();
    return this.trackOperation((async () => {
      this.ensureEpoch(epoch);
      const persist = opts.persist !== false;
      // Strict cloud-only semantics: do not even read a pre-existing disk cache for this request.
      if (!persist) {
        const key = `${epoch}:${fileId}:ram`;
        const existing = this.inflight.get(key);
        if (existing) return existing;
        const pending = this.download(fileId, false, epoch, signal).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
        return pending;
      }
      const hit = await this.store.get<StoredMediaRecord>("media", fileId);
      this.ensureEpoch(epoch);
      if (hit) {
        if (hit.enc === 1) {
          if (this.cryptoActive()) {
            try {
              const blob = await this.unseal(hit);
              this.ensureEpoch(epoch);
              hit.at = this.now();
              await this.store.put("media", fileId, hit); // touch; ciphertext unchanged
              this.ensureEpoch(epoch);
              blob.at = hit.at;
              return blob;
            } catch (e) {
              if (!(e instanceof MediaCryptoError)) throw e;
              // Corrupted/forged container: honest re-download — drop the record and fall through
              // to the network path, exactly like a cache miss.
              this.ensureEpoch(epoch);
              await this.store.delete("media", fileId);
              this.ensureEpoch(epoch);
            }
          }
          // Sealed record without a usable key: can't serve it — fall through to the network.
          // LOCKED session: persist() below refuses the disk write, so the sealed record survives
          // until unlock and the blob is served RAM-only. No session wired at all: the passthrough
          // contract applies and the re-download overwrites the record in plain form.
        } else if (this.cryptoActive()) {
          // Plain record from the passthrough era while the session is open: serve it and use the
          // LRU touch we'd write anyway to migrate it into a sealed record.
          const sealed = await this.seal(fileId, hit.bytes, hit.mime);
          this.ensureEpoch(epoch);
          await this.store.put("media", fileId, sealed);
          this.ensureEpoch(epoch);
          return { id: fileId, bytes: hit.bytes, mime: hit.mime, size: hit.bytes.byteLength, at: sealed.at };
        } else {
          hit.at = this.now();
          await this.store.put("media", fileId, hit);
          this.ensureEpoch(epoch);
          return hit;
        }
      }
      const key = `${epoch}:${fileId}:disk`;
      const existing = this.inflight.get(key);
      if (existing) return existing;
      const pending = this.download(fileId, true, epoch, signal).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
      return pending;
    })());
  }

  // Cache bytes we already have in memory (e.g. a just-uploaded local file) without a round-trip.
  async put(fileId: number, bytes: Uint8Array, mime: string, opts: MediaCacheAccessOptions = {}): Promise<void> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      const stored = await this.persist(fileId, bytes, mime, opts.persist !== false, epoch);
      if (stored) await this.evictToLimit(epoch);
      this.ensureEpoch(epoch);
    })());
  }

  async has(fileId: number): Promise<boolean> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      const found = (await this.store.get<StoredMediaRecord>("media", fileId)) !== undefined;
      this.ensureEpoch(epoch);
      return found;
    })());
  }

  async evict(fileId: number): Promise<void> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      this.ensureEpoch(epoch);
      await this.store.delete("media", fileId);
      this.ensureEpoch(epoch);
    })());
  }

  // Total cached bytes across the media collection.
  async size(): Promise<number> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      const all = await this.store.scan<StoredMediaRecord>("media");
      this.ensureEpoch(epoch);
      return all.reduce((sum, b) => sum + (b.size || 0), 0);
    })());
  }

  /** Prepare media rewrites for the SAME atomic lower-store batch as DB-record migration. */
  async preparePlaintextMigrationOps(kFiles: Uint8Array): Promise<WriteOp[]> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      const ops: WriteOp[] = [];
      const entries = await this.store.entries("media");
      this.ensureEpoch(epoch);
      for (const entry of entries) {
        if (typeof entry.key !== "number" || !Number.isSafeInteger(entry.key)) {
          throw new Error("MediaCache: migration found a non-numeric media key");
        }
        if (!isStoredMediaRecord(entry.value) || entry.value.id !== entry.key) {
          throw new Error(`MediaCache: migration found a malformed media record at ${String(entry.key)}`);
        }
        if (entry.value.enc === 1) continue;
        const value = await this.sealWithFilesKey(kFiles, entry.key, entry.value.bytes, entry.value.mime);
        this.ensureEpoch(epoch);
        ops.push({ op: "put", collection: "media", key: entry.key, value });
      }
      return ops;
    })());
  }

  async assertFullyEncryptedAtRest(): Promise<void> {
    const { epoch } = await this.operationContext();
    return this.trackOperation((async () => {
      const entries = await this.store.entries("media");
      this.ensureEpoch(epoch);
      for (const entry of entries) {
        if (
          typeof entry.key !== "number" ||
          !isStoredMediaRecord(entry.value) ||
          entry.value.id !== entry.key ||
          entry.value.enc !== 1
        ) {
          throw new Error(`MediaCache: plaintext/malformed media remains at ${String(entry.key)}`);
        }
      }
    })());
  }

  // Write a blob to the "media" collection in the mode the session dictates. Returns false when
  // the disk write was refused (session wired but LOCKED — no plaintext AND no fresh state on
  // disk while locked; I-DS-1 discipline even before the DS-04 lock machine lands).
  private async persist(
    fileId: number,
    bytes: Uint8Array,
    mime: string,
    allowDisk = true,
    epoch = this.accountEpoch,
  ): Promise<boolean> {
    this.ensureEpoch(epoch);
    if (!allowDisk) return false;
    if (this.session && !this.session.isUnlocked && !this.passthroughAllowed()) return false;
    if (this.cryptoActive()) {
      const sealed = await this.seal(fileId, bytes, mime);
      this.ensureEpoch(epoch);
      await this.store.put("media", fileId, sealed);
    } else {
      const blob: MediaBlob = { id: fileId, bytes, mime, size: bytes.byteLength, at: this.now() };
      this.ensureEpoch(epoch);
      await this.store.put("media", fileId, blob);
    }
    this.ensureEpoch(epoch);
    return true;
  }

  // plaintext (+ real mime, enveloped) → media_crypto v1 container under HKDF(K_files, file_id).
  private async seal(fileId: number, bytes: Uint8Array, mime: string): Promise<StoredMediaRecord> {
    const kFiles = await this.session!.domainKey("files"); // session-owned — never zeroized here
    return this.sealWithFilesKey(kFiles, fileId, bytes, mime);
  }

  private async sealWithFilesKey(
    kFiles: Uint8Array,
    fileId: number,
    bytes: Uint8Array,
    mime: string,
  ): Promise<StoredMediaRecord> {
    const fileKey = await deriveMediaFileKey(kFiles, fileId);
    const envelope = sealEnvelope(mime, bytes);
    try {
      const box = await encryptMediaBlob(fileKey, fileId, envelope);
      return { id: fileId, bytes: box, mime: SEALED_MIME, size: box.byteLength, at: this.now(), enc: 1 };
    } finally {
      zeroize(fileKey, envelope);
    }
  }

  // container → plaintext MediaBlob, in memory only. Throws MediaCryptoError on any mismatch.
  private async unseal(rec: StoredMediaRecord): Promise<MediaBlob> {
    const kFiles = await this.session!.domainKey("files");
    const fileKey = await deriveMediaFileKey(kFiles, rec.id);
    try {
      const envelope = await decryptMediaBlob(fileKey, rec.id, rec.bytes);
      const { mime, data } = openEnvelope(envelope);
      return { id: rec.id, bytes: data, mime, size: data.byteLength, at: rec.at };
    } finally {
      zeroize(fileKey);
    }
  }

  private async download(
    fileId: number,
    persist: boolean,
    epoch: number,
    signal: AbortSignal,
  ): Promise<MediaBlob> {
    let refreshedOnce = false;
    for (;;) {
      this.ensureEpoch(epoch);
      const headers: Record<string, string> = { "x-gc-client": this.clientId };
      if (this.tokens.access) headers["authorization"] = `Bearer ${this.tokens.access}`;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/files/${fileId}`, { method: "GET", headers, signal });
      } catch (err) {
        this.ensureEpoch(epoch);
        throw new NetworkError("media download network failure", err);
      }
      this.ensureEpoch(epoch);
      if (res.status === 401 && this.refresh && !refreshedOnce) {
        refreshedOnce = true;
        // Drain the body so the connection can be reused, then retry once after a refresh.
        await res.arrayBuffer().catch(() => undefined);
        this.ensureEpoch(epoch);
        const ok = await this.refresh();
        this.ensureEpoch(epoch);
        if (ok) continue;
        throw new ApiError("TOKEN_EXPIRED", "session expired during media download", 401);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.ensureEpoch(epoch);
        let code = "BAD_RESPONSE";
        try {
          const j = JSON.parse(text) as { error?: { code?: string } };
          if (j.error?.code) code = j.error.code;
        } catch {
          /* raw non-JSON error body */
        }
        throw new ApiError(code, `media download failed (HTTP ${res.status})`, res.status);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      this.ensureEpoch(epoch);
      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const blob: MediaBlob = { id: fileId, bytes: buf, mime, size: buf.byteLength, at: this.now() };
      // The authenticated network response is the source of truth; the local LRU is only an
      // optimisation. Android WebViews can temporarily reject an IndexedDB write (quota pressure,
      // interrupted schema transaction, OEM storage cleanup). Discarding already-downloaded bytes in
      // that case made a valid photo spin and fall back to the download chip even though the server
      // returned HTTP 200. Keep the plaintext in RAM for this render and let a later request retry the
      // cache. An account reset is different: ensureEpoch() rethrows it so old-account bytes can never
      // cross the session boundary.
      try {
        const stored = await this.persist(fileId, buf, mime, persist, epoch);
        if (stored) await this.evictToLimit(epoch);
      } catch {
        this.ensureEpoch(epoch);
      }
      this.ensureEpoch(epoch);
      return blob;
    }
  }

  // Drop least-recently-used blobs until the cache fits its byte budget. A single oversized blob
  // (> limit) is kept — evicting it would not help and would break the item that needs it.
  private async evictToLimit(epoch = this.accountEpoch): Promise<void> {
    this.ensureEpoch(epoch);
    let all = await this.store.scan<StoredMediaRecord>("media");
    this.ensureEpoch(epoch);
    let total = all.reduce((sum, b) => sum + (b.size || 0), 0);
    if (total <= this.limitBytes) return;
    all = all.sort((a, b) => a.at - b.at); // oldest first
    for (const b of all) {
      this.ensureEpoch(epoch);
      if (total <= this.limitBytes) break;
      if (all.length <= 1) break;
      await this.store.delete("media", b.id);
      this.ensureEpoch(epoch);
      total -= b.size || 0;
    }
  }
}

// ── sealed envelope: the real mime rides inside the ciphertext ─────────────────────────────────
// [u16 BE mimeLen][mime utf8][payload]. Keeps the on-disk record's mime field constant so the
// content type never leaks as store metadata.

function sealEnvelope(mime: string, data: Uint8Array): Uint8Array {
  const m = new TextEncoder().encode(mime);
  if (m.length > 0xffff) throw new MediaCryptoError("mime длиннее 65535 байт");
  const out = new Uint8Array(2 + m.length + data.length);
  new DataView(out.buffer).setUint16(0, m.length, false);
  out.set(m, 2);
  out.set(data, 2 + m.length);
  return out;
}

function openEnvelope(envelope: Uint8Array): { mime: string; data: Uint8Array } {
  if (envelope.length < 2) throw new MediaCryptoError("шифроконверт короче префикса mime");
  const mimeLen = new DataView(envelope.buffer, envelope.byteOffset).getUint16(0, false);
  if (2 + mimeLen > envelope.length) throw new MediaCryptoError("mime-префикс выходит за шифроконверт");
  const mime = new TextDecoder().decode(envelope.subarray(2, 2 + mimeLen));
  // Copy the payload out: the envelope buffer is zeroized by the caller's cleanup path in seal();
  // on unseal the slice below is the caller-owned plaintext.
  const data = envelope.slice(2 + mimeLen);
  return { mime, data };
}
