// clients/ui/src/screens/media.ts — the DOM layer for media attachments (T-407). All string/number
// decisions live in the pure media_model (unit-tested); this file only touches the DOM: it renders a
// bubble attachment (photo/video/voice/file), the blur/spoiler gate, the album grid, an in-feed voice
// player, and the full-screen swipeable/zoomable viewer, plus client-side canvas photo compression and
// the upload path. It stays decoupled from clients/core through the structural MediaPort — the web
// shell wires that from FileUploader + MediaCache; the UI never imports core.
import type { I18n } from "../i18n.ts";
import type { Message } from "./types.ts";
import { el, clear } from "../dom.ts";
import { icon } from "../icons.ts";
import { describeError } from "./api.ts";
import {
  attachmentView, isBlurred, formatBytes, formatDuration,
  albumLayout, autoDownloadDecision,
  nextSpeed, speedLabel, waveformBars, playedFraction,
  compressionPlan, scaledDimensions,
  viewerItems, viewerIndexOf, stepIndex, clampZoom, toggleZoom,
  type AttachmentView, type SendKind, type NetworkType, type AutoDownloadPolicy,
  type PlaybackSpeed, type CompressionQuality, type ViewerItem,
} from "./media_model.ts";

// --------------------------------------------------------------------------- ports
// The uploaded-file descriptor the server echoes (FileUploader.UploadResult is structurally assignable).
export interface UploadedFile {
  file_id: number;
  name: string;
  mime: string;
  size: number;
  meta: unknown;
}

// The transport the media DOM needs. FileUploader + MediaCache from clients/core satisfy this; keeping
// it structural means media.ts never imports core (same discipline as ApiLike).
export interface MediaPort {
  upload(
    data: Uint8Array,
    opts: {
      name: string;
      mime: string;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
      // Sender-declared media metadata reaches the receiver before the bytes. Dimensions reserve the
      // layout; duration/waveform power note players; `round` marks a Telegram-style video note.
      meta?: {
        width?: number;
        height?: number;
        duration?: number;
        waveform?: number[];
        round?: boolean;
      };
    },
  ): Promise<UploadedFile>;
  // Resolve a server file id to a displayable blob object URL (fetched + cached by MediaCache). The
  // caller revokes it via revoke() when the node is torn down.
  objectUrl(fileId: number, mime?: string, persist?: boolean): Promise<string>;
  // Native shells save decrypted cached bytes through their OS file service and open the installed
  // viewer. Optional keeps the web/PWA path on the ordinary browser download fallback.
  openFile?(fileId: number, options: { name: string; mime: string }): Promise<{ saved: boolean; opened: boolean } | void>;
  revoke(url: string): void;
  // Shrink/grow the on-device media LRU budget (Lite / data-saver preset). Best-effort.
  setCacheLimit(bytes: number): void;
}

// Live environment the render decisions read: the user's auto-download policy + Lite preset, the
// detected network type, and the remembered playback speed.
export interface MediaEnv {
  policy(): AutoDownloadPolicy;
  dataSaver(): boolean;
  network(): NetworkType;
  speed(): PlaybackSpeed;
  setSpeed(s: PlaybackSpeed): void;
}

export interface AttachmentDeps {
  i18n: I18n;
  media: MediaPort;
  env: MediaEnv;
  // Open the full-screen viewer over the whole loaded window, starting at this file (photo/video only).
  onOpenViewer: (fileId: number) => void;
}

// --------------------------------------------------------------------------- network detection
// Read the platform's effective connection type. navigator.connection is non-standard (not in lib.dom),
// so it is accessed defensively; absent → "unknown" (auto-download then uses the stricter cellular lane).
interface NetInfo { type?: string; effectiveType?: string; saveData?: boolean }
export function networkType(): NetworkType {
  const nav = navigator as unknown as { onLine?: boolean; connection?: NetInfo };
  if (nav.onLine === false) return "none";
  const c = nav.connection;
  if (!c) return "unknown";
  const t = (c.type ?? "").toLowerCase();
  if (t === "wifi" || t === "ethernet") return "wifi";
  if (t === "cellular") return "cellular";
  // Fall back to effectiveType: 4g on a saveData-off link is treated as wifi-class, slower as cellular.
  const et = (c.effectiveType ?? "").toLowerCase();
  if (et === "4g" && c.saveData !== true) return "wifi";
  if (et) return "cellular";
  return "unknown";
}
// True when the platform is asking for reduced data use (Save-Data header equivalent).
export function platformDataSaver(): boolean {
  const nav = navigator as unknown as { connection?: NetInfo };
  return nav.connection?.saveData === true;
}

// --------------------------------------------------------------------------- client photo compression
export interface PreparedFile {
  data: Uint8Array;
  name: string;
  mime: string;
  sendKind: SendKind;
}

// What the send path hands the uploader: the bytes plus, when this path actually decoded the image,
// its exact pixel size (V150). The receiver reserves the bubble's box from those two numbers, so the
// conversation does not jump when the picture decodes. A file sent verbatim reports no size — nothing
// here decodes it, and a guessed dimension is worse than none.
export interface EncodedImage {
  data: Uint8Array;
  name: string;
  mime: string;
  width?: number;
  height?: number;
}

// Re-encode a raster image through a canvas per the chosen quality plan; non-images / "original" / a
// recompression that didn't shrink the file are sent verbatim. Never throws — any failure falls back to
// the original bytes so a send is never blocked by a codec quirk.
export async function compressImage(file: File, quality: CompressionQuality): Promise<EncodedImage> {
  const original = async (): Promise<EncodedImage> => ({
    data: new Uint8Array(await file.arrayBuffer()),
    name: file.name,
    mime: file.type || "application/octet-stream",
  });
  const plan = compressionPlan(quality, file.type || "", file.size);
  if (!plan.recompress) return original();
  try {
    const bmp = await createImageBitmap(file);
    // Read the source size BEFORE close(): the spec zeroes an ImageBitmap's width/height on close, and
    // the verbatim fallback below still needs them (those bytes are the source picture, unscaled).
    const source = { width: bmp.width, height: bmp.height };
    const dim = scaledDimensions(source.width, source.height, plan.maxDim);
    const canvas = document.createElement("canvas");
    canvas.width = dim.width;
    canvas.height = dim.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bmp.close(); return original(); }
    ctx.drawImage(bmp, 0, 0, dim.width, dim.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, plan.mime, plan.quality));
    if (!blob || blob.size >= file.size) return { ...(await original()), ...source };
    const ext = plan.mime === "image/webp" ? "webp" : "jpg";
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return { data: new Uint8Array(await blob.arrayBuffer()), name: `${base}.${ext}`, mime: plan.mime, width: dim.width, height: dim.height };
  } catch {
    return original();
  }
}

// --------------------------------------------------------------------------- attachment rendering
// Render a single message's attachment, or null when it carries none. The returned node manages its own
// object-URL lifetime through a small cleanup registry attached to the element (revoked on removal via
// the caller clearing the list — MediaCache also caps total bytes, so a leaked URL is bounded).
export function renderAttachment(msg: Message, deps: AttachmentDeps): HTMLElement | null {
  const a = attachmentView(msg);
  if (!a) return null;
  const wrap = el("div", { class: "gc-media" });
  paintAttachment(wrap, a, false, deps);
  return wrap;
}

function paintAttachment(wrap: HTMLElement, a: AttachmentView, revealed: boolean, deps: AttachmentDeps): void {
  clear(wrap);
  if (isBlurred(a, revealed)) {
    wrap.append(blurGate(a, deps, () => paintAttachment(wrap, a, true, deps)));
    return;
  }
  if (a.kind === "photo") wrap.append(photoTile(a, deps));
  else if (a.kind === "video") wrap.append(videoTile(a, deps));
  else if (a.kind === "voice") wrap.append(voicePlayer(a, deps));
  else wrap.append(fileChip(a, deps));
}

// The spoiler / view-once / sensitive cover: a blurred box the viewer taps to reveal. view_once is never
// pre-fetched (the fetch burns the single server view), so it always waits behind this gate.
function blurGate(a: AttachmentView, deps: AttachmentDeps, onReveal: () => void): HTMLElement {
  const label = a.viewOnce ? deps.i18n.t("media.viewOnce") : a.sensitive ? deps.i18n.t("media.sensitive") : deps.i18n.t("media.spoiler");
  const box = el("button", { type: "button", class: "gc-media-blur", title: label }, [
    el("span", { class: "gc-media-blur-icon" }, [a.viewOnce ? "1" : "👁"]),
    el("span", { class: "gc-media-blur-label" }, [label]),
  ]);
  box.addEventListener("click", onReveal);
  return box;
}

// Decide whether to fetch eagerly or wait for a tap, then either show the image or a "tap to load" chip.
function shouldAutoLoad(a: AttachmentView, deps: AttachmentDeps): boolean {
  return autoDownloadDecision({
    policy: deps.env.policy(),
    network: deps.env.network(),
    kind: a.kind,
    sizeBytes: a.size,
    dataSaver: deps.env.dataSaver(),
    blurred: false,
  });
}

// V150 — reserve the tile's final box from the sender-declared dimensions, BEFORE the bytes arrive.
// Without it `.gc-media-photo` is a 40px placeholder that grows to the picture's real height on decode
// and shoves the rest of the conversation down, under the reader's finger. The exact px→CSS arithmetic
// (the 360px single-tile height cap, the bubble width) stays in the stylesheet: this writes only the
// two numbers it needs, through the CSSOM because CSP style-src 'self' forbids a style="" attribute.
// A round video note is already a fixed circle — reserving anything there would only fight its rule.
function reserveBox(tile: HTMLElement, a: AttachmentView): void {
  const { width, height } = a.meta;
  if (!width || !height || a.meta.round === true) return;
  tile.style.setProperty("--gc-media-w", String(width));
  tile.style.setProperty("--gc-media-h", String(height));
  tile.classList.add("is-sized");
}

function photoTile(a: AttachmentView, deps: AttachmentDeps): HTMLElement {
  const tile = el("button", { type: "button", class: "gc-media-photo", title: a.name });
  reserveBox(tile, a);
  const open = (): void => deps.onOpenViewer(a.fileId);
  if (shouldAutoLoad(a, deps)) {
    void loadImageInto(tile, a, deps, open);
  } else {
    tile.append(loadChip(a, () => void loadImageInto(tile, a, deps, open)));
  }
  return tile;
}

async function loadImageInto(tile: HTMLElement, a: AttachmentView, deps: AttachmentDeps, onOpen: () => void): Promise<void> {
  clear(tile);
  tile.append(el("span", { class: "gc-media-spinner" }));
  try {
    const url = await deps.media.objectUrl(a.fileId, a.mime);
    // Wire the listeners BEFORE assigning src: a data/cached-blob decode can complete before the next
    // line runs, and if src were set first (inside el()) that "load" would fire into the void and the
    // tile would spin forever. The settled guard + the complete check cover a synchronous decode.
    const img = el("img", { class: "gc-media-img", alt: a.name }) as HTMLImageElement;
    let settled = false;
    const done = (): void => { if (settled) return; settled = true; tileDone(tile, img, onOpen); };
    const fail = (): void => {
      if (settled) return; settled = true;
      deps.media.revoke(url); clear(tile); tile.append(loadChip(a, () => void loadImageInto(tile, a, deps, onOpen)));
    };
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", fail, { once: true });
    registerCleanup(tile, () => deps.media.revoke(url));
    img.src = url;
    if (img.complete && img.naturalWidth > 0) done();
  } catch {
    clear(tile);
    tile.append(loadChip(a, () => void loadImageInto(tile, a, deps, onOpen)));
  }
}
function tileDone(tile: HTMLElement, node: HTMLElement, onOpen: () => void): void {
  clear(tile);
  tile.append(node);
  tile.addEventListener("click", onOpen);
}

function videoTile(a: AttachmentView, deps: AttachmentDeps): HTMLElement {
  const tile = el("button", { type: "button", class: `gc-media-video${a.meta.round ? " is-round" : ""}`, title: a.name });
  reserveBox(tile, a);
  tile.append(loadChip(a, () => void loadVideoInto(tile, a, deps)));
  if (shouldAutoLoad(a, deps)) void loadVideoInto(tile, a, deps);
  return tile;
}

async function loadVideoInto(tile: HTMLElement, a: AttachmentView, deps: AttachmentDeps): Promise<void> {
  clear(tile);
  tile.append(el("span", { class: "gc-media-spinner" }));
  try {
    const url = await deps.media.objectUrl(a.fileId, a.mime);
    const video = el("video", { class: "gc-media-videoel", src: url, controls: true, preload: "metadata", playsinline: true }) as HTMLVideoElement;
    video.playbackRate = deps.env.speed();
    const speed = speedButton(deps, (s) => { video.playbackRate = s; });
    clear(tile);
    tile.append(video, speed);
    registerCleanup(tile, () => deps.media.revoke(url));
  } catch {
    clear(tile);
    tile.append(loadChip(a, () => void loadVideoInto(tile, a, deps)));
  }
}

// --------------------------------------------------------------------------- failure affordances
// V149. A photo or a video that cannot be fetched degrades to a visible "tap to load" chip and the
// viewer prints errors.network, but voice and file used to swallow the identical failure ("leave in
// the idle state" / "leave the chip as-is"). On a dropped connection the control then did nothing
// observable: no busy state while the blob was fetched, no message when it failed, and no way to tell
// "still loading" from "failed" — so the user tapped again and started one more parallel fetch.
// These three helpers give both kinds what the tiles already have: working, failed, retry.

// The control is working. aria-busy is removed rather than set to "false" so assistive technology
// hears one state change, not a permanent busy region.
function setBusy(btn: HTMLElement, busy: boolean): void {
  btn.classList.toggle("is-busy", busy);
  if (busy) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
}

// The control failed / recovered. A failed control keeps its position and size and only changes what
// it promises: "download" becomes "retry", so the next tap is an obvious second attempt.
function markFailed(btn: HTMLElement, failed: boolean, idleLabel: string, i18n: I18n): void {
  btn.classList.toggle("is-error", failed);
  const label = failed ? i18n.t("common.retry") : idleLabel;
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

// One failure line per attachment, announced politely. describeError() maps a dropped connection to
// errors.network and a server code to its catalogue entry, so the text is never invented here.
function showFailure(host: HTMLElement, err: unknown, deps: AttachmentDeps): void {
  clearFailure(host);
  host.append(el("span", { class: "gc-media-error", role: "status", "aria-live": "polite" }, [
    describeError(err, deps.i18n),
  ]));
}
function clearFailure(host: HTMLElement): void {
  for (const node of Array.from(host.querySelectorAll(".gc-media-error"))) node.remove();
}

// A voice / audio note: play-pause, a resampled waveform whose played fraction fills, a running clock and
// the remembered speed toggle. The audio element is created lazily on first play (fetch = user intent).
function voicePlayer(a: AttachmentView, deps: AttachmentDeps): HTMLElement {
  const total = typeof a.meta.duration === "number" ? a.meta.duration : 0;
  const BARS = 40;
  const heights = waveformBars(a.meta.waveform, BARS);
  const bars = heights.map(() => el("span", { class: "gc-wave-bar" }));
  bars.forEach((b, i) => { (b as HTMLElement).style.height = `${Math.round(heights[i]! * 100)}%`; });
  const waveEl = el("div", { class: "gc-wave" }, bars);
  const playBtn = el("button", {
    type: "button", class: "gc-voice-play",
    title: deps.i18n.t("media.play"), "aria-label": deps.i18n.t("media.play"),
  }, [icon("play", "gc-icon gc-voice-glyph")]);
  // A transport control must swap its glyph, not its text node: paint() re-renders the SVG.
  const paintPlay = (playing: boolean): void => {
    clear(playBtn);
    playBtn.append(icon(playing ? "pause" : "play", "gc-icon gc-voice-glyph"));
    const label = deps.i18n.t(playing ? "media.pause" : "media.play");
    playBtn.title = label;
    playBtn.setAttribute("aria-label", label);
    playBtn.classList.toggle("is-playing", playing);
    // Repainting the transport is what a working player does, so it also drops the failed state; the
    // catch below repaints first and marks the failure after (V149).
    playBtn.classList.remove("is-error");
  };
  const clock = el("span", { class: "gc-voice-clock" }, [formatDuration(total)]);
  const speed = speedButton(deps, (s) => { if (audio) audio.playbackRate = s; });
  const row = el("div", { class: "gc-voice" }, [playBtn, waveEl, clock, speed]);

  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  const paintProgress = (cur: number): void => {
    const f = playedFraction(cur, total || (audio?.duration ?? 0));
    const lit = Math.round(f * BARS);
    bars.forEach((b, i) => (b as HTMLElement).classList.toggle("is-played", i < lit));
    clock.textContent = formatDuration(cur);
  };
  const ensureAudio = async (): Promise<void> => {
    if (audio) return;
    url = await deps.media.objectUrl(a.fileId, a.mime);
    audio = new Audio(url);
    audio.playbackRate = deps.env.speed();
    audio.addEventListener("timeupdate", () => paintProgress(audio!.currentTime));
    audio.addEventListener("ended", () => { paintPlay(false); paintProgress(0); });
    registerCleanup(row, () => { audio?.pause(); if (url) deps.media.revoke(url); });
  };
  // One tap = one fetch. Without this an impatient second tap during a slow fetch started a second
  // download of the same file (measured, V149), and both would have built their own <audio>.
  let inFlight = false;
  playBtn.addEventListener("click", async () => {
    if (inFlight) return;
    inFlight = true;
    // Only the first tap pays for bytes; a pause/resume must not flash a spinner.
    const fetching = !audio;
    if (fetching) setBusy(playBtn, true);
    try {
      await ensureAudio();
      if (!audio) return;
      if (audio.paused) { await audio.play(); paintPlay(true); }
      else { audio.pause(); paintPlay(false); }
      clearFailure(row);
    } catch (err) {
      // A dropped connection, a codec the platform will not decode, or an autoplay block. All three
      // used to leave the row looking untouched; say which one happened and offer the retry.
      paintPlay(false);
      showFailure(row, err, deps);
      markFailed(playBtn, true, deps.i18n.t("media.play"), deps.i18n);
    } finally {
      inFlight = false;
      if (fetching) setBusy(playBtn, false);
    }
  });
  return row;
}

// A generic file: Telegram-style full-card activation with a dedicated trailing action. Mobile shells
// save/open through the OS; browsers retain the blob download fallback. The whole card is reachable by
// touch and keyboard, not only the small circle shown in V194.
function fileChip(a: AttachmentView, deps: AttachmentDeps): HTMLElement {
  const dl = el("button", {
    type: "button", class: "gc-file-dl",
    title: deps.i18n.t("media.download"), "aria-label": deps.i18n.t("media.download"),
  }, [icon("download")]);
  const meta = el("div", { class: "gc-file-meta" }, [
    el("span", { class: "gc-file-name", title: a.name }, [a.name]),
    el("span", { class: "gc-file-size" }, [formatBytes(a.size)]),
  ]);
  const card = el("div", {
    class: "gc-file", role: "button", tabindex: "0", title: a.name,
    "aria-label": `${a.name}, ${formatBytes(a.size)}`,
  }, [
    el("span", { class: "gc-file-icon" }, [icon("file")]),
    meta,
    dl,
  ]);
  let inFlight = false;
  const activate = (): void => {
    if (inFlight) return;
    inFlight = true;
    void downloadFile(a, deps, dl, meta, card).finally(() => { inFlight = false; });
  };
  dl.addEventListener("click", (e) => { e.stopPropagation(); activate(); });
  card.addEventListener("click", activate);
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate();
  });
  return card;
}

async function downloadFile(
  a: AttachmentView,
  deps: AttachmentDeps,
  btn: HTMLElement,
  host: HTMLElement,
  card?: HTMLElement,
): Promise<void> {
  clearFailure(host);
  clear(btn);
  btn.append(el("span", { class: "gc-spinner-dot" }));
  setBusy(btn, true);
  card?.classList.add("is-loading");
  let failure: unknown = null;
  try {
    if (deps.media.openFile) {
      const result = await deps.media.openFile(a.fileId, { name: a.name, mime: a.mime });
      card?.classList.toggle("is-ready", result?.saved === true);
    } else {
      const url = await deps.media.objectUrl(a.fileId, a.mime);
      const link = el("a", { href: url, download: a.name }) as HTMLAnchorElement;
      document.body.append(link);
      link.click();
      link.remove();
      // Give the browser a tick to start the download before releasing the blob URL.
      setTimeout(() => deps.media.revoke(url), 4000);
    }
  } catch (err) {
    failure = err ?? new Error("download failed");
  }
  clear(btn);
  setBusy(btn, false);
  card?.classList.remove("is-loading");
  btn.append(icon(failure ? "refresh" : "download"));
  markFailed(btn, failure !== null, deps.i18n.t("media.download"), deps.i18n);
  card?.classList.toggle("is-error", failure !== null);
  if (failure !== null) showFailure(host, failure, deps);
}

// A "tap to load N" chip shown when auto-download declined (network/policy/size).
function loadChip(a: AttachmentView, onLoad: () => void): HTMLElement {
  const chip = el("span", { class: "gc-media-load" }, [
    el("span", { class: "gc-media-load-icon" }, [icon("download")]),
    el("span", {}, [formatBytes(a.size)]),
  ]);
  chip.addEventListener("click", (e) => { e.stopPropagation(); onLoad(); });
  return chip;
}

// The 1× / 1.5× / 2× cycle button; remembers the choice through the env and applies it to the player.
function speedButton(deps: AttachmentDeps, apply: (s: PlaybackSpeed) => void): HTMLElement {
  const btn = el("button", { type: "button", class: "gc-speed-btn", title: deps.i18n.t("media.speed") }, [speedLabel(deps.env.speed())]);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = nextSpeed(deps.env.speed());
    deps.env.setSpeed(s);
    btn.textContent = speedLabel(s);
    apply(s);
  });
  return btn;
}

// --------------------------------------------------------------------------- album grid
// Render a run of same-album messages (2..10 photos/videos) as one Telegram-style grid. Each cell reuses
// the single-attachment renderer, so blur gates and auto-download still apply per item.
export function renderAlbumGroup(msgs: Message[], deps: AttachmentDeps): HTMLElement {
  const layout = albumLayout(msgs.length);
  const grid = el("div", { class: "gc-album" });
  (grid as HTMLElement).style.gridTemplateColumns = `repeat(${layout.columns}, 1fr)`;
  msgs.forEach((m, i) => {
    const cell = layout.cells[i] ?? { colSpan: 1, rowSpan: 1 };
    const node = renderAttachment(m, deps) ?? el("div", { class: "gc-media" });
    (node as HTMLElement).style.gridColumn = `span ${cell.colSpan}`;
    (node as HTMLElement).style.gridRow = `span ${cell.rowSpan}`;
    node.classList.add("gc-album-cell");
    grid.append(node);
  });
  return grid;
}

// --------------------------------------------------------------------------- object-URL cleanup registry
const CLEANUP = new WeakMap<HTMLElement, Array<() => void>>();
function registerCleanup(node: HTMLElement, fn: () => void): void {
  const list = CLEANUP.get(node) ?? [];
  list.push(fn);
  CLEANUP.set(node, list);
}
// Run and clear any registered blob-URL revocations under a subtree (call before discarding feed DOM).
export function cleanupMedia(root: HTMLElement): void {
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const n of nodes) {
    const list = CLEANUP.get(n);
    if (list) { for (const fn of list) { try { fn(); } catch { /* best-effort */ } } CLEANUP.delete(n); }
  }
}

// --------------------------------------------------------------------------- full-screen viewer
export interface ViewerDeps {
  i18n: I18n;
  media: MediaPort;
  env: MediaEnv;
}

// Open a full-screen, swipeable, zoomable viewer over the given photo/video set, starting at startFileId.
// Closes on Esc / backdrop click / the ✕ button; ← → (and swipe) page; wheel + double-click zoom photos.
export function openViewer(all: Message[], startFileId: number, deps: ViewerDeps): void {
  const items = viewerItems(all);
  if (items.length === 0) return;
  let index = viewerIndexOf(items, startFileId);
  if (index < 0) index = 0;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let curUrl: string | null = null;
  // V151. Paging is faster than fetching, so more than one slide can be in flight at once and they do
  // not have to come back in order. `generation` stamps each request: only the newest one is allowed to
  // write into the stage or to own `curUrl`, and anything older is released the moment it arrives.
  // Without it a slow first picture landing after a fast second one drew A under a caption that read B
  // and orphaned B's blob URL — the cache then held those bytes for the rest of the session.
  let generation = 0;
  let closed = false;
  // Where focus was when the viewer opened, so an aria-modal dialog can hand it back on close.
  const opener = (document.activeElement ?? null) as HTMLElement | null;

  const stage = el("div", { class: "gc-viewer-stage" });
  const caption = el("div", { class: "gc-viewer-caption" });
  const prevBtn = el("button", { type: "button", class: "gc-viewer-nav gc-viewer-prev", title: deps.i18n.t("media.prev") }, ["‹"]);
  const nextBtn = el("button", { type: "button", class: "gc-viewer-nav gc-viewer-next", title: deps.i18n.t("media.next") }, ["›"]);
  const closeBtn = el("button", {
    type: "button", class: "gc-viewer-close",
    title: deps.i18n.t("common.close"), "aria-label": deps.i18n.t("common.close"),
  }, [icon("close")]);
  const overlay = el("div", { class: "gc-viewer", role: "dialog", "aria-modal": true }, [closeBtn, prevBtn, stage, nextBtn, caption]);

  const revoke = (): void => { if (curUrl) { deps.media.revoke(curUrl); curUrl = null; } };
  const applyTransform = (node: HTMLElement): void => { node.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; };

  const show = async (): Promise<void> => {
    const gen = ++generation;
    revoke();
    zoom = 1; panX = 0; panY = 0;
    clear(stage);
    stage.append(el("span", { class: "gc-media-spinner gc-viewer-spinner" }));
    const it: ViewerItem | undefined = items[index];
    if (!it) return;
    caption.textContent = `${index + 1} / ${items.length} · ${it.name}`;
    prevBtn.hidden = nextBtn.hidden = items.length < 2;
    try {
      const url = await deps.media.objectUrl(it.fileId, it.mime);
      // Abandoned while it was fetching: the reader paged on, or closed the viewer. Release the bytes
      // here — this is the only reference to them — and leave the current slide alone.
      if (gen !== generation || closed) { deps.media.revoke(url); return; }
      curUrl = url;
      clear(stage);
      if (it.kind === "video") {
        const v = el("video", { class: "gc-viewer-media", src: url, controls: true, autoplay: true, playsinline: true }) as HTMLVideoElement;
        v.playbackRate = deps.env.speed();
        stage.append(v);
      } else {
        const img = el("img", { class: "gc-viewer-media", src: url, alt: it.name }) as HTMLImageElement;
        img.addEventListener("wheel", (e) => { e.preventDefault(); zoom = clampZoom(zoom + (e.deltaY < 0 ? 0.25 : -0.25)); if (zoom === 1) { panX = 0; panY = 0; } applyTransform(img); }, { passive: false });
        img.addEventListener("dblclick", () => { zoom = toggleZoom(zoom); panX = 0; panY = 0; applyTransform(img); });
        enableDrag(img, () => zoom, (dx, dy) => { if (zoom > 1) { panX += dx; panY += dy; applyTransform(img); } });
        stage.append(img);
      }
    } catch (err) {
      if (gen !== generation || closed) return;
      clear(stage);
      // V151. This used to print errors.network — "no connection, the action was queued" — for every
      // failure, including a file that is gone or forbidden, and nothing is ever queued here. Say what
      // actually happened (describeError maps a dropped connection to the offline text and a server
      // code to its catalogue entry) and offer the retry in place: without it a transient failure
      // could only be escaped by closing the viewer and opening it again.
      const retry = el("button", { type: "button", class: "gc-viewer-retry" }, [deps.i18n.t("common.retry")]);
      retry.addEventListener("click", (e) => { e.stopPropagation(); void show(); });
      stage.append(el("div", { class: "gc-viewer-failure" }, [
        el("p", { class: "gc-viewer-error", role: "status", "aria-live": "polite" }, [describeError(err, deps.i18n)]),
        retry,
      ]));
      retry.focus();
    }
  };

  const step = (delta: number): void => { index = stepIndex(index, delta, items.length); void show(); };
  const close = (): void => {
    if (closed) return;
    closed = true;
    revoke();
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    // Hand the keyboard back where it came from; a dialog that closes into nowhere leaves the reader
    // tabbing from the top of the page.
    opener?.focus?.();
  };
  // The overlay is aria-modal, so the keyboard must stay inside it: Tab cycles the viewer's own
  // controls instead of walking the conversation behind the backdrop.
  //
  // Deliberately NOT a11y.ts createFocusTrap, which every other modal in this client uses since V152:
  // the viewer binds its keys on `document` because Escape and the arrow keys must page the album no
  // matter what holds the caret, and the shared trap listens on its container. Same contract, one
  // extra reason — if this ever needs changing, change both, or move this to the shared helper.
  const trapTab = (e: KeyboardEvent): void => {
    const focusable = Array.from(overlay.querySelectorAll("button")).filter((b) => !(b as HTMLButtonElement).hidden);
    if (focusable.length === 0) return;
    e.preventDefault();
    const at = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const next = focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
    (next as HTMLButtonElement | undefined)?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Tab") trapTab(e);
  };

  prevBtn.addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
  nextBtn.addEventListener("click", (e) => { e.stopPropagation(); step(1); });
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target === stage) close(); });
  // Horizontal swipe on the stage pages when not zoomed.
  enableSwipe(stage, (dir) => { if (zoom === 1) step(dir); });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  closeBtn.focus?.(); // move the keyboard into the dialog it just opened
  void show();
}

// Pointer drag helper (panning a zoomed image). Reports frame deltas; the caller decides what to move.
function enableDrag(node: HTMLElement, zoomOf: () => number, onMove: (dx: number, dy: number) => void): void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  node.addEventListener("pointerdown", (e) => { if (zoomOf() <= 1) return; dragging = true; lastX = e.clientX; lastY = e.clientY; node.setPointerCapture(e.pointerId); });
  node.addEventListener("pointermove", (e) => { if (!dragging) return; onMove(e.clientX - lastX, e.clientY - lastY); lastX = e.clientX; lastY = e.clientY; });
  const end = (): void => { dragging = false; };
  node.addEventListener("pointerup", end);
  node.addEventListener("pointercancel", end);
}

// Horizontal swipe detector: fires -1 (swipe right → previous) or +1 (swipe left → next) past a threshold.
function enableSwipe(node: HTMLElement, onSwipe: (dir: number) => void): void {
  let startX = 0;
  let startY = 0;
  let active = false;
  node.addEventListener("pointerdown", (e) => { active = true; startX = e.clientX; startY = e.clientY; });
  node.addEventListener("pointerup", (e) => {
    if (!active) return;
    active = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
  });
}
