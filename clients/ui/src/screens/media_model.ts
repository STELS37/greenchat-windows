// clients/ui/src/screens/media_model.ts — pure view-model for media attachments (T-407).
// DOM-free algebra the media/feed screens render from: mime→send-kind, the album grid layout, the
// auto-download decision (network type × user policy × Lite/data-saver × per-type size thresholds),
// client photo-compression plans, playback-speed cycling, voice waveforms and the blur/spoiler gate.
// Every branch here is unit-tested (media_model.test.ts); the DOM lives in media.ts / feed_screen.ts.
import type { Message, MsgFile, MsgStickerFile } from "./types.ts";

// ---------------------------------------------------------------------------
// mime classification + the kind we declare when sending a file.
// ---------------------------------------------------------------------------

export function isImageMime(mime: string): boolean {
  const m = mime.toLowerCase();
  // SVG is served as an octet-stream attachment (T-016 XSS guard) — never previewed as an image.
  return m.startsWith("image/") && !m.includes("svg");
}
export function isVideoMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("video/");
}
export function isAudioMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("audio/");
}

// The server derives the message kind from an explicit `kind` field, validated against the file mime
// (photo→image/*, video→video/*, voice→audio/*, file→any). "Send as file" forces the generic kind so
// an image/video rides as a plain download with no inline preview.
export type SendKind = "photo" | "video" | "voice" | "file";
export function sendKindForMime(mime: string, asFile = false): SendKind {
  if (asFile) return "file";
  if (isImageMime(mime)) return "photo";
  if (isVideoMime(mime)) return "video";
  if (isAudioMime(mime)) return "voice";
  return "file";
}

// ---------------------------------------------------------------------------
// human-readable size / duration.
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  // Bytes and round hundreds print whole; otherwise one decimal with a trailing ".0" trimmed
  // ("1 KB"/"5 MB" not "1.0 KB", but "1.5 KB" kept).
  const s = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${s} ${units[i]}`;
}

// Clock label for a media duration (m:ss, or h:mm:ss past an hour). Negatives/NaN → "0:00".
export function formatDuration(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// Upload/download progress as an integer 0..100 (0 when the total is unknown).
export function progressPercent(loaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const pct = Math.round((loaded / total) * 100);
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

// ---------------------------------------------------------------------------
// attachment descriptor — the normalised shape a bubble/viewer renders from.
// ---------------------------------------------------------------------------

export interface MediaMeta {
  // V150: the sender-declared pixel size of a picture/video. Present ⇒ the tile can reserve the exact
  // box before the bytes arrive, so the conversation never jumps when the image decodes.
  width?: number;
  height?: number;
  duration?: number;
  waveform?: number[];
  round?: boolean;
}

// A declared size is only usable when BOTH edges are plausible: the pair defines the aspect ratio, and
// a hostile or corrupt value must never be able to reserve an absurd hole in the conversation. The
// ceiling mirrors the server's MAX_MEDIA_DIMENSION (65535 px).
const MAX_DECLARED_DIMENSION = 65535;
function declaredSize(raw: Record<string, unknown>): { width: number; height: number } | null {
  const w = raw.width;
  const h = raw.height;
  const sane = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_DECLARED_DIMENSION;
  return sane(w) && sane(h) ? { width: w, height: h } : null;
}

export interface AttachmentView {
  fileId: number;
  name: string;
  mime: string;
  size: number;
  kind: SendKind; // how to RENDER it (photo/video/voice preview vs a file chip)
  meta: MediaMeta;
  spoiler: boolean; // media_spoiler → blur until tapped
  viewOnce: boolean; // view_once → blur + single fetch
  sensitive: boolean; // chat flagged NSFW → blur until tapped
  albumId: string | null;
  sticker: boolean; // physical file came from message.sticker.file, not a generic attachment
}

function readMeta(raw: Record<string, unknown> | null | undefined): MediaMeta {
  if (!raw || typeof raw !== "object") return {};
  const out: MediaMeta = {};
  const size = declaredSize(raw);
  if (size) {
    out.width = size.width;
    out.height = size.height;
  }
  if (typeof raw.duration === "number") out.duration = raw.duration;
  if (Array.isArray(raw.waveform)) out.waveform = raw.waveform.filter((n): n is number => typeof n === "number");
  if (raw.round === true) out.round = true;
  return out;
}

type RenderableFile = MsgFile | MsgStickerFile;

const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const PREVIEW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
};

const FILE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/json": ".json",
  "application/rtf": ".rtf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

// The server normally preserves the sender's filename, but imported/legacy messages can carry an empty
// value or a path. A blank title turns the attachment into the anonymous 54 KB pill shown in V194, so
// derive a stable, safe leaf name before either the bubble or the native file saver sees it.
export function displayFileName(file: Pick<RenderableFile, "id" | "name" | "mime">): string {
  const leaf = file.name.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = [...leaf]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x200b && code <= 0x200f) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2060 && code <= 0x206f);
    })
    .join("")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  let name = clean && clean !== "." && clean !== ".." ? clean : `file-${file.id}`;
  if (!/\.[A-Za-z0-9]{1,12}$/.test(name)) name += FILE_EXTENSION_BY_MIME[file.mime.trim().toLowerCase()] ?? "";
  if (name.length <= 180) return name;
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 && name.length - dot <= 13 ? name.slice(dot) : "";
  return `${name.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}

// Some external clients upload a perfectly valid WebP/WebM with the generic octet-stream MIME. The
// browser then treats it as a file and the receiver sees only a download chip. Infer only a small,
// executable-free preview allowlist from the final extension; SVG/TGS and every unknown format stay
// downloads, preserving the existing XSS boundary.
export function previewMime(file: Pick<RenderableFile, "name" | "mime">): string {
  const declared = file.mime.trim().toLowerCase();
  if (!GENERIC_MIMES.has(declared)) return declared;
  const lower = file.name.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return declared || "application/octet-stream";
  return PREVIEW_MIME_BY_EXTENSION[lower.slice(dot)] ?? (declared || "application/octet-stream");
}

// The render kind for an attachment: a voice note (audio + duration) and a video note (round video)
// are distinguished from a plain image/video by the effective preview mime; anything else is a file.
function renderKind(mime: string): SendKind {
  if (isAudioMime(mime)) return "voice";
  if (isVideoMime(mime)) return "video";
  if (isImageMime(mime)) return "photo";
  return "file";
}

// Extract the attachment descriptor from a message, including server-native stickers whose physical
// PNG/WebP is nested under sticker.file. Privacy flags ride on the message, not the file.
export function attachmentView(msg: Message): AttachmentView | null {
  const nativeSticker = msg.kind === "sticker" && msg.sticker && typeof msg.sticker === "object"
    ? msg.sticker
    : null;
  const file = nativeSticker?.file ?? msg.file;
  if (!file || typeof file.id !== "number") return null;
  const mime = previewMime(file);
  const meta = readMeta(file.meta);
  return {
    fileId: file.id,
    name: displayFileName(file),
    mime,
    size: file.size,
    kind: renderKind(mime),
    meta,
    spoiler: msg.media_spoiler === true,
    viewOnce: msg.view_once === true,
    sensitive: msg.sensitive === true,
    albumId: typeof msg.album_id === "string" ? msg.album_id : null,
    sticker: nativeSticker !== null,
  };
}

// A blurred attachment stays hidden until the viewer taps it. view_once additionally must not be
// pre-fetched (the fetch burns the single view) — the caller keys auto-download off this too.
export function isBlurred(a: AttachmentView, revealed: boolean): boolean {
  return (a.spoiler || a.viewOnce || a.sensitive) && !revealed;
}

// An outgoing selection sends as ONE album (server files[] route → N messages sharing an album_id) only
// when it is 2..10 items that are ALL previewable photo/video; a single item, >10, or any voice/generic
// file falls back to individual sends. Mirrors the server's album eligibility so the client never posts
// a files[] the server would reject.
export function albumEligible(kinds: SendKind[]): boolean {
  return kinds.length >= 2 && kinds.length <= 10 && kinds.every((k) => k === "photo" || k === "video");
}

// ---------------------------------------------------------------------------
// album grid — 1..10 media items rendered as one grid (Telegram parity).
// ---------------------------------------------------------------------------

export interface AlbumCell {
  colSpan: number;
  rowSpan: number;
}
export interface AlbumLayout {
  columns: number;
  cells: AlbumCell[];
}

// A deterministic, dependency-free tiling: 1 → single, 2 → two columns, 3 → one tall + two stacked,
// 4 → 2×2, 5+ → a 3-column mosaic (last row's remainder widened to fill). Good enough parity; the
// exact Telegram aspect-aware packer is not worth the bytes here.
export function albumLayout(count: number): AlbumLayout {
  const n = Math.max(1, Math.min(10, Math.floor(count)));
  if (n === 1) return { columns: 1, cells: [{ colSpan: 1, rowSpan: 1 }] };
  if (n === 2) return { columns: 2, cells: [c(), c()] };
  if (n === 3) return { columns: 2, cells: [{ colSpan: 1, rowSpan: 2 }, c(), c()] };
  if (n === 4) return { columns: 2, cells: [c(), c(), c(), c()] };
  const cells: AlbumCell[] = [];
  for (let i = 0; i < n; i++) cells.push(c());
  const remainder = n % 3;
  if (remainder !== 0) {
    // Widen the final row's cells so N items always fill a clean 3-column grid (2 items → 1.5 span each
    // is not integral, so instead the last cell of a 1-remainder row spans the empty tail).
    if (remainder === 1) cells[n - 1] = { colSpan: 3, rowSpan: 1 };
    else {
      cells[n - 2] = { colSpan: 2, rowSpan: 1 };
      cells[n - 1] = { colSpan: 1, rowSpan: 1 };
    }
  }
  return { columns: 3, cells };
}
function c(): AlbumCell {
  return { colSpan: 1, rowSpan: 1 };
}

// ---------------------------------------------------------------------------
// auto-download — network type × user policy × Lite × per-kind size thresholds.
// ---------------------------------------------------------------------------

export type NetworkType = "wifi" | "cellular" | "none" | "unknown";
export type AutoDownloadPolicy = "all" | "wifi" | "none"; // mirrors the `autodownload` user setting

// Per-kind byte ceilings above which even an allowed network will not auto-fetch (the user taps to
// load). The Lite / data-saver preset roughly halves them; cellular is stricter than Wi-Fi.
const THRESHOLD: Record<SendKind, { wifi: number; cellular: number }> = {
  photo: { wifi: 12 * 1024 * 1024, cellular: 3 * 1024 * 1024 },
  video: { wifi: 50 * 1024 * 1024, cellular: 0 },
  voice: { wifi: 5 * 1024 * 1024, cellular: 2 * 1024 * 1024 },
  file: { wifi: 20 * 1024 * 1024, cellular: 0 },
};

export interface AutoDownloadInput {
  policy: AutoDownloadPolicy;
  network: NetworkType;
  kind: SendKind;
  sizeBytes: number;
  dataSaver: boolean; // Lite preset
  blurred?: boolean; // a spoiler/view-once/sensitive item is never auto-fetched
}

// Decide whether an attachment is fetched eagerly on render (true) or waits for a tap (false).
export function autoDownloadDecision(i: AutoDownloadInput): boolean {
  if (i.blurred) return false; // never pre-fetch hidden media (view_once would burn its single view)
  if (i.policy === "none") return false;
  if (i.network === "none") return false;
  if (i.policy === "wifi" && i.network !== "wifi") return false;
  // "all" on an unknown network is treated as the cellular (stricter) budget.
  const lane: "wifi" | "cellular" = i.network === "wifi" ? "wifi" : "cellular";
  let cap = THRESHOLD[i.kind][lane];
  if (i.dataSaver) cap = Math.floor(cap / 2);
  if (cap <= 0) return false;
  return i.sizeBytes <= cap;
}

// On-device media-cache byte budget: the Lite / data-saver preset shrinks it (MediaCache.setLimit).
export function cacheLimitBytes(dataSaver: boolean): number {
  return dataSaver ? 32 * 1024 * 1024 : 128 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// playback speed — 1× / 1.5× / 2×, remembered by the caller.
// ---------------------------------------------------------------------------

export const PLAYBACK_SPEEDS = [1, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export function nextSpeed(cur: number): PlaybackSpeed {
  const i = PLAYBACK_SPEEDS.indexOf(cur as PlaybackSpeed);
  return PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length] as PlaybackSpeed;
}
export function normalizeSpeed(v: unknown): PlaybackSpeed {
  const n = typeof v === "number" ? v : Number(v);
  return (PLAYBACK_SPEEDS as readonly number[]).includes(n) ? (n as PlaybackSpeed) : 1;
}
export function speedLabel(speed: number): string {
  return `${speed % 1 === 0 ? speed : speed.toFixed(1)}×`;
}

// ---------------------------------------------------------------------------
// voice waveform — normalise stored 0..255 samples to 0..1 bar heights, resampled to a bar count.
// ---------------------------------------------------------------------------

export function waveformBars(waveform: number[] | undefined, bars: number): number[] {
  const src = waveform && waveform.length > 0 ? waveform : [];
  if (src.length === 0) return new Array(Math.max(0, bars)).fill(0.15);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const s = src[Math.floor((i / bars) * src.length)] ?? 0;
    out.push(Math.max(0.08, Math.min(1, s / 255)));
  }
  return out;
}

// The fraction of a waveform that has been played, for the progress fill (0..1).
export function playedFraction(currentSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const f = currentSec / durationSec;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ---------------------------------------------------------------------------
// client photo compression — canvas re-encode plan (quality picker, default "balanced").
// ---------------------------------------------------------------------------

export type CompressionQuality = "original" | "balanced" | "small";

export interface CompressionPlan {
  recompress: boolean;
  maxDim: number; // longest edge cap in px (0 = keep)
  quality: number; // 0..1 encoder quality
  mime: string; // output mime
}

const PLANS: Record<CompressionQuality, { maxDim: number; quality: number }> = {
  original: { maxDim: 0, quality: 1 },
  balanced: { maxDim: 1600, quality: 0.82 },
  small: { maxDim: 1024, quality: 0.7 },
};

// Compression only applies to previewable raster images; "original" (or a non-image / tiny file) is
// sent verbatim. The output is JPEG unless the source is PNG with likely transparency-preserving
// intent — we keep PNG→WEBP for smaller size while preserving alpha.
export function compressionPlan(quality: CompressionQuality, mime: string, sizeBytes: number): CompressionPlan {
  const base = PLANS[quality] ?? PLANS.balanced;
  const previewable = isImageMime(mime);
  const worthIt = sizeBytes > 256 * 1024; // don't burn CPU recompressing already-small images
  if (quality === "original" || !previewable || !worthIt) {
    return { recompress: false, maxDim: 0, quality: 1, mime };
  }
  const alpha = mime.toLowerCase().includes("png") || mime.toLowerCase().includes("webp");
  return {
    recompress: true,
    maxDim: base.maxDim,
    quality: base.quality,
    mime: alpha ? "image/webp" : "image/jpeg",
  };
}

// Fit (w,h) within a longest-edge cap, preserving aspect ratio; maxDim 0 or a smaller image is a no-op.
export function scaledDimensions(w: number, h: number, maxDim: number): { width: number; height: number } {
  if (maxDim <= 0 || (w <= maxDim && h <= maxDim) || w <= 0 || h <= 0) {
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }
  const scale = maxDim / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// ---------------------------------------------------------------------------
// media viewer — the ordered set of photo/video items a swipeable viewer pages through.
// ---------------------------------------------------------------------------

export interface ViewerItem {
  messageId: number;
  fileId: number;
  kind: "photo" | "video";
  name: string;
  mime: string;
}

// Every visible photo/video in the loaded window, in id order — the viewer's swipe sequence. Blurred
// (spoiler/view-once/sensitive) and generic files are excluded; a caption-less video note counts.
export function viewerItems(messages: Message[]): ViewerItem[] {
  const out: ViewerItem[] = [];
  for (const m of messages) {
    if (m.deleted) continue;
    const a = attachmentView(m);
    if (!a || a.sticker || (a.kind !== "photo" && a.kind !== "video")) continue;
    if (a.spoiler || a.viewOnce || a.sensitive) continue;
    out.push({ messageId: m.id, fileId: a.fileId, kind: a.kind, name: a.name, mime: a.mime });
  }
  return out;
}

export function viewerIndexOf(items: ViewerItem[], fileId: number): number {
  return items.findIndex((i) => i.fileId === fileId);
}

// Wrap-around paging for the viewer's prev/next (empty list → -1).
export function stepIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return (((index + delta) % length) + length) % length;
}

// ---------------------------------------------------------------------------
// zoom — pinch/scroll zoom clamp for the photo viewer.
// ---------------------------------------------------------------------------

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return z < MIN_ZOOM ? MIN_ZOOM : z > MAX_ZOOM ? MAX_ZOOM : z;
}
// A double-tap toggles between fit (1×) and a comfortable 2× (or back to fit if already zoomed).
export function toggleZoom(cur: number): number {
  return cur > MIN_ZOOM ? MIN_ZOOM : 2;
}
