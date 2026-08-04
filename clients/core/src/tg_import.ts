// clients/core — Telegram export parser + import driver (T-417, "переезд").
//
// Two pure, dependency-free pieces the shells wire together:
//   1. parseTelegramExport() — normalise Telegram's official single-chat export (result.json) into a
//      flat, batch-ready message list plus the set of media paths it references. Runs off the main
//      thread inside a Web Worker (clients/web) because a big export is megabytes of JSON.
//   2. runTelegramImport() — the driver: upload each referenced media file through the ordinary file
//      path (so the server's T-119 quota is charged there), then POST the conversation to
//      /v1/import/telegram in batches of ≤ 500 messages, reporting progress. All I/O is injected
//      (readMedia / upload / sendBatch), so the driver is unit-testable with no DOM and no network.
//
// The export shape is documented at https://core.telegram.org/import-export. Fields we read:
//   • top-level `name`            → chat title (→ archive «Импорт: <name>»)
//   • messages[].type             → only "message" rows are conversation; "service" rows are skipped
//   • messages[].date_unixtime    → unix seconds (string); falls back to Date.parse(date)
//   • messages[].from             → author display name → carried in imported_from
//   • messages[].text             → string OR array of (string | {type,text}) fragments → flattened
//   • messages[].photo            → image path (jpeg)
//   • messages[].file+mime_type   → any attachment; media_type distinguishes voice/video/sticker
// A media value that is a "(File not included …)" placeholder (export without media) is treated as no
// attachment — the text/caption is still imported.

// The maximum messages the server accepts in one /v1/import/telegram call.
export const TG_IMPORT_BATCH_SIZE = 500;

// The maximum SERIALISED size of one batch, in UTF-8 bytes. The server buffers a JSON body up to
// cfg.maxJsonBytes = 1 MiB and refuses anything larger with 413 PAYLOAD_TOO_LARGE, so the count cap
// alone was not enough: 500 messages of ordinary Russian prose (2 bytes per Cyrillic character) can
// serialise to well over a megabyte, and a chat of 4096-character messages reaches ~2.4 MB. Measured
// on a live server: 500 x 1010 characters = 1,040,471 bytes imported fine; 500 x 1200 characters =
// 1,230,471 bytes was refused. A long-form chat is a perfectly normal export, so the driver — not the
// user — has to keep each batch inside the ceiling.
//
// The budget is deliberately below 1 MiB: it is measured on the messages array only, while the wire
// body also carries import_id/title/done and the array's own punctuation. The remainder is ample for
// a 128-character title plus a 128-character import_id.
export const TG_IMPORT_BATCH_BYTES = 900 * 1024;

// One normalised message, ready to be mapped into a server batch. `seq` is the message's stable index
// in the raw export (unique + deterministic across re-parses → the (import_id, seq) idempotency key).
export interface TgMessage {
  seq: number;
  from: string | null;
  date: number; // unix seconds, or 0 when unparseable (the server clamps 0 → import time)
  text: string;
  mediaPath: string | null; // export-relative path, e.g. "photos/photo_1@01.jpg"; null = text only
  mediaMime: string | null; // best-effort mime for the attachment; null when no media
}

export interface TgParsed {
  title: string;
  messages: TgMessage[];
  mediaPaths: string[]; // distinct, in first-seen order — the driver uploads each once
}

// ---- text flattening ------------------------------------------------------------------------

type TgTextFragment = string | { type?: unknown; text?: unknown };

// Telegram stores message text either as a plain string or as an array of runs (plain strings and
// {type,text} entities). Concatenate the visible text of every run; ignore entity types (we import
// plain text — the server stems + indexes it for search).
export function flattenTgText(text: unknown): string {
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return "";
  let out = "";
  for (const part of text as TgTextFragment[]) {
    if (typeof part === "string") out += part;
    else if (part && typeof part === "object" && typeof part.text === "string") out += part.text;
  }
  return out;
}

// ---- mime helpers ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
};

// Guess a mime from a file name's extension; octet-stream when unknown. The SERVER is authoritative on
// kind (it derives photo/video/voice/file from the stored mime), so this only needs to be close enough
// for the common cases; anything unknown lands as a generic file.
export function guessMimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

// A Telegram export that was taken WITHOUT "download media" substitutes a human sentence for the path,
// e.g. "(File not included. Change data exporting settings to download.)". Such a value is a message,
// not a relative path — a real path never starts with "(".
function isRealMediaPath(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.startsWith("(");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Parse a unix timestamp from `date_unixtime` (string seconds), falling back to Date.parse(`date`).
function parseDate(raw: Record<string, unknown>): number {
  const unix = raw.date_unixtime;
  if (typeof unix === "string" && /^\d+$/.test(unix)) return parseInt(unix, 10);
  if (typeof unix === "number" && Number.isFinite(unix)) return Math.floor(unix);
  const iso = raw.date;
  if (typeof iso === "string") {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

// Resolve the attachment (path + mime) of one message row, or {null,null} when there is none / the
// media was not included in the export. `photo` wins (always a jpeg); otherwise `file` with its
// declared mime_type (or an extension guess).
function parseMedia(raw: Record<string, unknown>): { path: string | null; mime: string | null } {
  if (isRealMediaPath(raw.photo)) return { path: raw.photo, mime: "image/jpeg" };
  if (isRealMediaPath(raw.file)) {
    const declared = str(raw.mime_type);
    return { path: raw.file, mime: declared ?? guessMimeFromName(raw.file) };
  }
  return { path: null, mime: null };
}

// Normalise a whole export object into a batch-ready list. Throws on a shape that is clearly not a
// Telegram export so the UI can show a helpful error rather than importing garbage.
export function parseTelegramExport(root: unknown): TgParsed {
  if (!root || typeof root !== "object")
    throw new Error("not a Telegram export (expected a JSON object)");
  const obj = root as Record<string, unknown>;
  const rawMessages = obj.messages;
  if (!Array.isArray(rawMessages))
    throw new Error("not a Telegram export (missing messages[])");

  const title = (str(obj.name) ?? "Telegram").slice(0, 128);
  const messages: TgMessage[] = [];
  const seen = new Set<string>();
  const mediaPaths: string[] = [];

  for (let i = 0; i < rawMessages.length; i++) {
    const row = rawMessages[i];
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    // Only conversation rows. "service" rows (joins, title changes, calls…) are export chrome.
    if (m.type !== undefined && m.type !== "message") continue;

    const { path, mime } = parseMedia(m);
    if (path && !seen.has(path)) {
      seen.add(path);
      mediaPaths.push(path);
    }
    messages.push({
      seq: i, // stable raw index → deterministic idempotency key
      from: str(m.from),
      date: parseDate(m),
      text: flattenTgText(m.text),
      mediaPath: path,
      mediaMime: mime,
    });
  }

  return { title, messages, mediaPaths };
}

// ---- batching -------------------------------------------------------------------------------

// Split a list into chunks of at most `size`. Pure; used to honour the ≤ 500 messages/batch cap.
export function batchMessages<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("batch size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// UTF-8 byte length of a string. The server counts BYTES off the socket, so a length in JavaScript
// characters would under-count every non-Latin export by half. TextEncoder exists in every browser
// and in Node ≥ 11; the fallback keeps the module usable in an exotic shell without one.
function utf8Bytes(value: string): number {
  const Encoder = (globalThis as { TextEncoder?: new () => { encode(input: string): { length: number } } })
    .TextEncoder;
  if (Encoder) return new Encoder().encode(value).length;
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Split a list honouring BOTH caps: at most `size` items and at most `maxBytes` of serialised
// payload per chunk. An item that alone exceeds the byte budget still gets its own chunk — dropping
// a message silently would be worse than letting the server judge it (the import cap on one message
// is 4096 characters, so this is unreachable in practice; it exists so the loop cannot spin).
export function batchMessagesBySize<T>(
  items: T[],
  size: number,
  maxBytes: number,
  sizeOf: (item: T) => number,
): T[][] {
  if (size <= 0) throw new Error("batch size must be positive");
  if (maxBytes <= 0) throw new Error("batch byte budget must be positive");
  const out: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = sizeOf(item) + 1; // + the comma/bracket this element adds to the array
    if (current.length > 0 && (current.length >= size || used + cost > maxBytes)) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

// ---- import driver --------------------------------------------------------------------------

export interface TgImportBatchMessage {
  seq: number;
  from: string | null;
  date: number;
  text: string;
  file_id: number | null;
}

export interface TgImportBatch {
  import_id: string;
  title: string;
  messages: TgImportBatchMessage[];
  done: boolean;
}

// The server's /v1/import/telegram response.
export interface TgImportResult {
  chat_id: number;
  imported: number;
  skipped: number;
  message_count: number;
  file_count: number;
  done: boolean;
  summary: string;
}

export type TgImportProgress =
  | { phase: "media"; done: number; total: number }
  | { phase: "batch"; done: number; total: number; result: TgImportResult }
  | { phase: "done"; result: TgImportResult };

export interface TgImportPorts {
  // A stable id tying every batch of THIS import together (idempotency + resume). Caller-generated.
  importId: string;
  // Read a referenced media file's bytes + real name + mime, or null when it cannot be found (a
  // partial export / a path we could not resolve). A null media makes its message text-only.
  readMedia(path: string): Promise<{ bytes: Uint8Array; name: string; mime: string } | null>;
  // Upload bytes through the ordinary file path (PUT /v1/files) and return the new file_id.
  upload(bytes: Uint8Array, name: string, mime: string, signal?: AbortSignal): Promise<number>;
  // POST one batch to /v1/import/telegram.
  sendBatch(payload: TgImportBatch): Promise<TgImportResult>;
  onProgress?: (p: TgImportProgress) => void;
}

function throwIfImportAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const err = new Error("Telegram import cancelled");
  err.name = "AbortError";
  throw err;
}

// Drive a parsed export into the server: upload media first (charging the quota there), then stream
// the conversation in ≤ 500-message batches, mapping each message's media path to its uploaded
// file_id. Returns the final (cumulative) server result carrying the «N сообщений, M файлов» summary.
export async function runTelegramImport(
  parsed: TgParsed,
  ports: TgImportPorts,
  opts: { batchSize?: number; batchBytes?: number; signal?: AbortSignal } = {},
): Promise<TgImportResult> {
  const batchSize = opts.batchSize ?? TG_IMPORT_BATCH_SIZE;
  const batchBytes = opts.batchBytes ?? TG_IMPORT_BATCH_BYTES;
  const signal = opts.signal;
  throwIfImportAborted(signal);

  // 1) Upload every distinct media file once, building a path → file_id map. A media that cannot be
  //    read is skipped (its message imports as text only) — a partial export must not abort the move.
  const fileIds = new Map<string, number>();
  const totalMedia = parsed.mediaPaths.length;
  let mediaDone = 0;
  for (const path of parsed.mediaPaths) {
    throwIfImportAborted(signal);
    const blob = await ports.readMedia(path);
    throwIfImportAborted(signal);
    if (blob) {
      const id = await ports.upload(blob.bytes, blob.name, blob.mime, signal);
      throwIfImportAborted(signal);
      fileIds.set(path, id);
    }
    mediaDone++;
    throwIfImportAborted(signal);
    ports.onProgress?.({ phase: "media", done: mediaDone, total: totalMedia });
  }

  // 2) Stream the conversation. Map to the wire shape FIRST so the batcher can weigh exactly what
  //    will be serialised, then split by message count AND serialised size (the server refuses a body
  //    over 1 MiB, which a long-form Russian chat reaches long before the 500-message cap). Always
  //    send at least one (done) batch so an empty export still materialises the archive and a summary.
  const wire: TgImportBatchMessage[] = parsed.messages.map((m) => ({
    seq: m.seq,
    from: m.from,
    date: m.date,
    text: m.text,
    file_id: m.mediaPath ? (fileIds.get(m.mediaPath) ?? null) : null,
  }));
  const chunks = batchMessagesBySize(wire, batchSize, batchBytes, (m) =>
    utf8Bytes(JSON.stringify(m)),
  );
  if (chunks.length === 0) chunks.push([]);

  let last: TgImportResult | null = null;
  for (let i = 0; i < chunks.length; i++) {
    throwIfImportAborted(signal);
    const isLast = i === chunks.length - 1;
    const messages: TgImportBatchMessage[] = chunks[i]!;
    last = await ports.sendBatch({
      import_id: ports.importId,
      title: parsed.title,
      messages,
      done: isLast,
    });
    throwIfImportAborted(signal);
    ports.onProgress?.({ phase: "batch", done: i + 1, total: chunks.length, result: last });
  }

  // chunks always has ≥ 1 element, so `last` is set here.
  throwIfImportAborted(signal);
  const result = last as TgImportResult;
  ports.onProgress?.({ phase: "done", result });
  return result;
}
