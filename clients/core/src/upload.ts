// clients/core — FileUploader (T-403, CLIENTS.md §5.3, server contract T-016).
//
// M0 ships one compatibility upload path: PUT /v1/files. The payload is already resident as a
// Uint8Array (the composer has read/compressed it), so the request deliberately uses a buffered
// ArrayBuffer body instead of a ReadableStream. Android System WebView and some embedded fetch bridges
// reject request streams locally before opening a socket; the UI then reported "No connection" while
// every ordinary API request worked. A standards-compatible buffered body reaches web, Android, iOS,
// desktop and Node uniformly. Content addressing still makes whole-file retries idempotent: replaying
// the same bytes returns the same owner file row rather than duplicating content.
import { ApiError, NetworkError } from "./errors.ts";
import type { TokenStore } from "./api.ts";

export interface UploadResult {
  file_id: number;
  name: string;
  mime: string;
  size: number;
  sha256?: string;
  dedup: boolean;
  meta: unknown;
}

export interface FileUploaderOptions {
  baseUrl: string;
  tokens: TokenStore;
  clientId: string; // X-GC-Client "<platform>/<semver>"
  // Shared single-flight refresh from ApiClient — reused so a token expiry mid-upload is handled once.
  refresh?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  maxRetries?: number; // idempotent whole-file retries on transient failures (default 3)
}

// V150: media metadata that must reach the RECEIVER before the bytes do. The pixel dimensions let a
// bubble reserve the picture's exact box, so the conversation never jumps when the image decodes.
// The server (T-109 x-media-* headers, extended for width/height) validates them against the mime and
// stores them in files.meta; it owns no image library, so the sender computes them — the canvas that
// re-encodes the photo already knows them exactly.
export interface UploadMeta {
  width?: number;
  height?: number;
  duration?: number;
  waveform?: number[];
  round?: boolean;
}

export interface UploadOptions {
  name?: string;
  mime?: string;
  onProgress?: (loaded: number, total: number) => void;
  chunkSize?: number; // legacy caller compatibility; the cross-WebView buffered transport ignores it
  signal?: AbortSignal;
  meta?: UploadMeta;
}

// Sender-declared media metadata is advisory, never a reason to lose an upload. Each field is
// sanitised independently against the server's T-109 limits: invalid values are omitted, while valid
// siblings (for example `round: true`) still travel. Dimensions are the one atomic pair because one
// edge alone cannot define an aspect ratio.
const MAX_DECLARED_DIMENSION = 65535;
const MAX_MEDIA_DURATION_SEC = 86400;
const MAX_WAVEFORM_SAMPLES = 256;
const MAX_WAVEFORM_VALUE = 255;
function mediaHeaders(meta: UploadMeta | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const { width, height, duration, waveform, round } = meta ?? {};
  const saneDimension = (v: number | undefined): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_DECLARED_DIMENSION;
  if (saneDimension(width) && saneDimension(height)) {
    out["x-media-width"] = String(width);
    out["x-media-height"] = String(height);
  }
  if (
    typeof duration === "number" &&
    Number.isInteger(duration) &&
    duration >= 0 &&
    duration <= MAX_MEDIA_DURATION_SEC
  ) out["x-media-duration"] = String(duration);
  if (
    Array.isArray(waveform) &&
    waveform.length >= 1 &&
    waveform.length <= MAX_WAVEFORM_SAMPLES &&
    waveform.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_WAVEFORM_VALUE)
  ) out["x-media-waveform"] = waveform.join(",");
  if (round === true) out["x-media-round"] = "1";
  return out;
}

const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup(): void;
}

function linkAbortSignals(user: AbortSignal | undefined, session: AbortSignal): LinkedAbortSignal {
  if (!user || user === session) return { signal: session, cleanup() {} };
  const controller = new AbortController();
  const abort = (): void => { if (!controller.signal.aborted) controller.abort(); };
  if (user.aborted || session.aborted) abort();
  else {
    user.addEventListener("abort", abort, { once: true });
    session.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      user.removeEventListener("abort", abort);
      session.removeEventListener("abort", abort);
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException("aborted", "AbortError");
}

export class FileUploader {
  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly clientId: string;
  private readonly refresh: (() => Promise<boolean>) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly maxRetries: number;
  private accountEpoch = 0;
  private epochAbort = new AbortController();

  constructor(opts: FileUploaderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokens;
    this.clientId = opts.clientId;
    this.refresh = opts.refresh;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.randomImpl = opts.randomImpl ?? Math.random;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
  }

  // Invalidate every request/retry/refresh owned by the previous authenticated account. Fetch may have
  // already reached the server and ignore cancellation, so epoch checks also reject a late success.
  reset(): void {
    this.accountEpoch += 1;
    this.epochAbort.abort();
    this.epochAbort = new AbortController();
  }

  private ensureEpoch(epoch: number): void {
    if (epoch !== this.accountEpoch) throw new Error("FileUploader: account reset during upload");
  }

  async upload(data: Uint8Array, opts: UploadOptions = {}): Promise<UploadResult> {
    const name = opts.name ?? "file";
    const mime = opts.mime ?? "application/octet-stream";
    const total = data.byteLength;
    const epoch = this.accountEpoch;
    const linked = linkAbortSignals(opts.signal, this.epochAbort.signal);

    let attempt = 0;
    let refreshedOnce = false;
    try {
      for (;;) {
        this.ensureEpoch(epoch);
        throwIfAborted(linked.signal);
        // The progress callback remains deterministic and honest on every platform: reset the visible
        // attempt to zero, then publish 100% only after the server has accepted the bytes. Embedded
        // WebViews do not expose upload progress for buffered fetch bodies; pretending the browser's
        // eager body read was network progress would show 100% while the request was still offline.
        if (epoch === this.accountEpoch) opts.onProgress?.(0, total);
        try {
          const result = await this.putOnce(name, mime, data, opts.meta, linked.signal);
          this.ensureEpoch(epoch);
          throwIfAborted(linked.signal);
          opts.onProgress?.(total, total);
          return this.normalize(result, name, mime, total);
        } catch (err) {
          // Account invalidation takes precedence over retry/refresh classification. A stale 401 must
          // never rotate credentials for the account that signed in after this upload started.
          this.ensureEpoch(epoch);
          if (linked.signal.aborted) throw err;
          if (
            err instanceof ApiError &&
            err.isTokenExpired &&
            this.refresh &&
            !refreshedOnce
          ) {
            refreshedOnce = true;
            const ok = await this.refresh();
            this.ensureEpoch(epoch);
            throwIfAborted(linked.signal);
            if (ok) continue; // replay without consuming a retry slot
            throw err;
          }
          const transient =
            err instanceof NetworkError ||
            (err instanceof ApiError && (err.httpStatus >= 500 || err.httpStatus === 429));
          if (transient && attempt < this.maxRetries) {
            await this.sleepImpl(this.backoff(attempt));
            this.ensureEpoch(epoch);
            throwIfAborted(linked.signal);
            attempt += 1;
            continue; // idempotent: content-addressed dedup makes a whole-file re-PUT safe
          }
          throw err;
        }
      }
    } finally {
      linked.cleanup();
    }
  }

  private async putOnce(
    name: string,
    mime: string,
    data: Uint8Array,
    meta: UploadMeta | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "x-gc-client": this.clientId,
      "x-file-name": encodeURIComponent(name),
      "content-type": mime,
      ...mediaHeaders(meta),
    };
    if (this.tokens.access) headers["authorization"] = `Bearer ${this.tokens.access}`;

    // Copy to an owned ArrayBuffer. Besides avoiding mutation while fetch is in flight, this body form
    // is accepted by Android WebView's fetch implementation and by native/desktop wrappers that reject
    // ReadableStream request bodies. Do not add `duplex`: it is a stream-only option and is itself a
    // compatibility hazard in embedded engines.
    const body = data.slice().buffer as ArrayBuffer;
    const init: RequestInit = {
      method: "PUT",
      headers,
      body,
      ...(signal ? { signal } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/files`, init);
    } catch (err) {
      // User cancellation and account reset are terminal, never transient whole-file retries.
      if (signal?.aborted) throw err;
      throw new NetworkError("upload network failure", err);
    }
    const text = await res.text();
    let parsed: { ok?: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } };
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError("BAD_RESPONSE", `non-JSON upload response (HTTP ${res.status})`, res.status);
    }
    if (parsed.ok === true && parsed.result) return parsed.result;
    if (parsed.error) throw ApiError.fromWire(parsed.error, res.status);
    throw new ApiError("BAD_RESPONSE", `unexpected upload response (HTTP ${res.status})`, res.status);
  }

  // The dedup response omits name/mime/size/sha256 (the client already knows them) — backfill so the
  // caller always gets a complete descriptor regardless of which server path answered.
  private normalize(r: Record<string, unknown>, name: string, mime: string, size: number): UploadResult {
    return {
      file_id: Number(r.file_id),
      name: typeof r.name === "string" ? r.name : name,
      mime: typeof r.mime === "string" ? r.mime : mime,
      size: typeof r.size === "number" ? r.size : size,
      ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}),
      dedup: r.dedup === true,
      meta: r.meta ?? null,
    };
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    return Math.floor(this.randomImpl() * ceiling);
  }
}
