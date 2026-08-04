import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/screens/types.ts";
import {
  isImageMime, isVideoMime, isAudioMime, sendKindForMime,
  formatBytes, formatDuration, progressPercent,
  attachmentView, displayFileName, isBlurred, previewMime,
  albumLayout, albumEligible,
  autoDownloadDecision, cacheLimitBytes,
  nextSpeed, normalizeSpeed, speedLabel, PLAYBACK_SPEEDS,
  waveformBars, playedFraction,
  compressionPlan, scaledDimensions,
  viewerItems, viewerIndexOf, stepIndex,
  clampZoom, toggleZoom, MIN_ZOOM, MAX_ZOOM,
} from "../src/screens/media_model.ts";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    chat_id: 10,
    sender: { id: 2, username: "ann", name: "Ann" },
    kind: "photo",
    created_at: 1_700_000_000,
    ...over,
  };
}

// ---- mime classification ----

test("isImageMime: image/* except svg", () => {
  assert.equal(isImageMime("image/png"), true);
  assert.equal(isImageMime("IMAGE/JPEG"), true);
  assert.equal(isImageMime("image/svg+xml"), false); // T-016 XSS guard
  assert.equal(isImageMime("video/mp4"), false);
});

test("isVideoMime / isAudioMime", () => {
  assert.equal(isVideoMime("video/webm"), true);
  assert.equal(isVideoMime("image/png"), false);
  assert.equal(isAudioMime("audio/ogg"), true);
  assert.equal(isAudioMime("video/mp4"), false);
});

test("sendKindForMime: preview kinds unless asFile forces generic", () => {
  assert.equal(sendKindForMime("image/png"), "photo");
  assert.equal(sendKindForMime("video/mp4"), "video");
  assert.equal(sendKindForMime("audio/ogg"), "voice");
  assert.equal(sendKindForMime("application/pdf"), "file");
  assert.equal(sendKindForMime("image/svg+xml"), "file"); // svg is never a preview
  assert.equal(sendKindForMime("image/png", true), "file"); // "send as file"
});

// ---- size / duration / progress ----

test("formatBytes: unit ladder", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
});

test("formatDuration: m:ss and h:mm:ss", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(-3), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(75), "1:15");
  assert.equal(formatDuration(3661), "1:01:01");
});

test("progressPercent: clamped 0..100, 0 on unknown total", () => {
  assert.equal(progressPercent(0, 0), 0);
  assert.equal(progressPercent(50, 100), 50);
  assert.equal(progressPercent(200, 100), 100);
  assert.equal(progressPercent(-5, 100), 0);
});

// ---- attachment descriptor + blur gate ----

test("attachmentView: null when no file, else normalised descriptor", () => {
  assert.equal(attachmentView(msg({ file: null })), null);
  const a = attachmentView(
    msg({
      file: { id: 7, name: "pic.png", mime: "image/png", size: 2048, meta: null },
      media_spoiler: true,
    }),
  );
  assert.ok(a);
  assert.equal(a!.fileId, 7);
  assert.equal(a!.kind, "photo");
  assert.equal(a!.spoiler, true);
  assert.equal(a!.viewOnce, false);
});

test("attachmentView: server-native sticker renders its nested WebP instead of an empty/file bubble", () => {
  const a = attachmentView(msg({
    kind: "sticker",
    file: null,
    sticker: {
      id: 31,
      pack_id: 7,
      emoji: "🙂",
      file: { id: 41, name: "sticker.webp", mime: "image/webp", size: 2048 },
    },
  }));
  assert.ok(a);
  assert.equal(a!.fileId, 41);
  assert.equal(a!.kind, "photo");
  assert.equal(a!.sticker, true);
});

test("displayFileName: blank/path metadata becomes a stable visible safe filename", () => {
  assert.equal(displayFileName({ id: 54, name: "", mime: "application/pdf" }), "file-54.pdf");
  assert.equal(displayFileName({ id: 55, name: "../../reports/акт.xlsx", mime: "application/octet-stream" }), "акт.xlsx");
  assert.equal(displayFileName({ id: 56, name: "\u202Ecod.exe", mime: "application/pdf" }), "cod.exe");
  const a = attachmentView(msg({ file: { id: 57, name: "  ", mime: "text/plain", size: 10, meta: null } }));
  assert.equal(a?.name, "file-57.txt", "the bubble never renders only a byte count");
});

test("previewMime: recovers safe WebP/WebM previews from octet-stream but never previews SVG/TGS", () => {
  assert.equal(previewMime({ name: "generated.WEBP", mime: "application/octet-stream" }), "image/webp");
  assert.equal(previewMime({ name: "animated.webm", mime: "" }), "video/webm");
  assert.equal(previewMime({ name: "unsafe.svg", mime: "application/octet-stream" }), "application/octet-stream");
  assert.equal(previewMime({ name: "telegram.tgs", mime: "application/octet-stream" }), "application/octet-stream");
  assert.equal(previewMime({ name: "photo.webp", mime: "image/jpeg" }), "image/jpeg", "declared safe MIME wins");
});

test("attachmentView: audio+meta → voice with duration/waveform", () => {
  const a = attachmentView(
    msg({
      file: { id: 9, name: "v.ogg", mime: "audio/ogg", size: 1024, meta: { duration: 12, waveform: [0, 128, 255], round: false } },
    }),
  );
  assert.equal(a!.kind, "voice");
  assert.equal(a!.meta.duration, 12);
  assert.deepEqual(a!.meta.waveform, [0, 128, 255]);
});

test("isBlurred: hidden until revealed for spoiler/view_once/sensitive", () => {
  const a = attachmentView(msg({ file: { id: 1, name: "n", mime: "image/png", size: 1, meta: null }, view_once: true }))!;
  assert.equal(isBlurred(a, false), true);
  assert.equal(isBlurred(a, true), false);
  const plain = attachmentView(msg({ file: { id: 2, name: "n", mime: "image/png", size: 1, meta: null } }))!;
  assert.equal(isBlurred(plain, false), false);
});

// ---- album layout ----

test("albumLayout: 1..4 fixed tilings", () => {
  assert.equal(albumLayout(1).columns, 1);
  assert.equal(albumLayout(2).columns, 2);
  assert.equal(albumLayout(2).cells.length, 2);
  assert.deepEqual(albumLayout(3).cells[0], { colSpan: 1, rowSpan: 2 });
  assert.equal(albumLayout(4).cells.length, 4);
});

test("albumLayout: 5+ mosaic fills the last row, clamps to 10", () => {
  const five = albumLayout(5);
  assert.equal(five.columns, 3);
  assert.equal(five.cells.length, 5);
  // remainder 2 → last two cells span 2+1
  assert.equal(five.cells[3]!.colSpan, 2);
  assert.equal(five.cells[4]!.colSpan, 1);
  // remainder 1 → final cell spans the whole row
  assert.equal(albumLayout(7).cells[6]!.colSpan, 3);
  assert.equal(albumLayout(99).cells.length, 10); // clamp
});

test("albumEligible: 2..10 all-previewable → album, else individual", () => {
  assert.equal(albumEligible(["photo", "photo"]), true);
  assert.equal(albumEligible(["photo", "video", "photo"]), true);
  assert.equal(albumEligible(["photo"]), false); // single
  assert.equal(albumEligible(["photo", "voice"]), false); // voice not previewable
  assert.equal(albumEligible(["photo", "file"]), false); // generic file
  assert.equal(albumEligible(new Array(11).fill("photo")), false); // over 10
});

// ---- auto-download decision ----

const AD = {
  policy: "all" as const, network: "wifi" as const, kind: "photo" as const,
  sizeBytes: 1024, dataSaver: false,
};

test("autoDownloadDecision: policy none / network none / blurred never fetch", () => {
  assert.equal(autoDownloadDecision({ ...AD, policy: "none" }), false);
  assert.equal(autoDownloadDecision({ ...AD, network: "none" }), false);
  assert.equal(autoDownloadDecision({ ...AD, blurred: true }), false);
});

test("autoDownloadDecision: wifi policy blocks cellular", () => {
  assert.equal(autoDownloadDecision({ ...AD, policy: "wifi", network: "cellular" }), false);
  assert.equal(autoDownloadDecision({ ...AD, policy: "wifi", network: "wifi" }), true);
});

test("autoDownloadDecision: per-kind cellular ceilings", () => {
  // video on cellular is capped at 0 → never
  assert.equal(autoDownloadDecision({ ...AD, kind: "video", network: "cellular", sizeBytes: 1 }), false);
  // photo under 3MB on cellular → yes; over → no
  assert.equal(autoDownloadDecision({ ...AD, kind: "photo", network: "cellular", sizeBytes: 2 * 1024 * 1024 }), true);
  assert.equal(autoDownloadDecision({ ...AD, kind: "photo", network: "cellular", sizeBytes: 4 * 1024 * 1024 }), false);
});

test("autoDownloadDecision: data-saver halves the cap", () => {
  const near = 8 * 1024 * 1024; // under 12MB wifi photo cap, over the halved 6MB
  assert.equal(autoDownloadDecision({ ...AD, kind: "photo", sizeBytes: near, dataSaver: false }), true);
  assert.equal(autoDownloadDecision({ ...AD, kind: "photo", sizeBytes: near, dataSaver: true }), false);
});

test("cacheLimitBytes: Lite shrinks the LRU budget", () => {
  assert.ok(cacheLimitBytes(true) < cacheLimitBytes(false));
});

// ---- playback speed ----

test("nextSpeed: cycles 1 → 1.5 → 2 → 1", () => {
  assert.equal(nextSpeed(1), 1.5);
  assert.equal(nextSpeed(1.5), 2);
  assert.equal(nextSpeed(2), 1);
  assert.equal(nextSpeed(99), 1); // unknown speed → reset to the start of the cycle
});

test("normalizeSpeed: only allowed speeds, else 1", () => {
  assert.equal(normalizeSpeed(2), 2);
  assert.equal(normalizeSpeed("1.5"), 1.5);
  assert.equal(normalizeSpeed(3), 1);
  assert.equal(normalizeSpeed("x"), 1);
  assert.deepEqual([...PLAYBACK_SPEEDS], [1, 1.5, 2]);
});

test("speedLabel", () => {
  assert.equal(speedLabel(1), "1×");
  assert.equal(speedLabel(1.5), "1.5×");
  assert.equal(speedLabel(2), "2×");
});

// ---- waveform ----

test("waveformBars: resamples to bar count, floors tiny to 0.08, empty → flat 0.15", () => {
  const bars = waveformBars([0, 255, 128], 6);
  assert.equal(bars.length, 6);
  assert.ok(bars.every((b) => b >= 0.08 && b <= 1));
  const flat = waveformBars(undefined, 4);
  assert.deepEqual(flat, [0.15, 0.15, 0.15, 0.15]);
});

test("playedFraction: clamped 0..1", () => {
  assert.equal(playedFraction(0, 10), 0);
  assert.equal(playedFraction(5, 10), 0.5);
  assert.equal(playedFraction(20, 10), 1);
  assert.equal(playedFraction(5, 0), 0);
});

// ---- compression plan ----

test("compressionPlan: original / non-image / tiny → verbatim", () => {
  assert.equal(compressionPlan("original", "image/png", 5_000_000).recompress, false);
  assert.equal(compressionPlan("balanced", "application/pdf", 5_000_000).recompress, false);
  assert.equal(compressionPlan("balanced", "image/png", 1000).recompress, false); // tiny
});

test("compressionPlan: balanced/small recompress large images; png/webp keep alpha via webp", () => {
  const bal = compressionPlan("balanced", "image/jpeg", 5_000_000);
  assert.equal(bal.recompress, true);
  assert.equal(bal.maxDim, 1600);
  assert.equal(bal.mime, "image/jpeg");
  const png = compressionPlan("small", "image/png", 5_000_000);
  assert.equal(png.recompress, true);
  assert.equal(png.mime, "image/webp"); // preserve transparency
  assert.equal(png.maxDim, 1024);
});

test("scaledDimensions: fit longest edge, no upscaling", () => {
  assert.deepEqual(scaledDimensions(3200, 1600, 1600), { width: 1600, height: 800 });
  assert.deepEqual(scaledDimensions(800, 600, 1600), { width: 800, height: 600 }); // no upscale
  assert.deepEqual(scaledDimensions(800, 600, 0), { width: 800, height: 600 }); // disabled
});

// ---- viewer ----

test("viewerItems: photos+videos in order, blurred/files/deleted excluded", () => {
  const list: Message[] = [
    msg({ id: 1, file: { id: 11, name: "a.png", mime: "image/png", size: 1, meta: null } }),
    msg({ id: 2, file: { id: 12, name: "b.pdf", mime: "application/pdf", size: 1, meta: null } }), // file
    msg({ id: 3, file: { id: 13, name: "c.mp4", mime: "video/mp4", size: 1, meta: null } }),
    msg({ id: 4, file: { id: 14, name: "d.png", mime: "image/png", size: 1, meta: null }, media_spoiler: true }), // blurred
    msg({ id: 5, deleted: true }),
  ];
  const items = viewerItems(list);
  assert.deepEqual(items.map((i) => i.fileId), [11, 13]);
  assert.equal(items[0]!.kind, "photo");
  assert.equal(items[1]!.kind, "video");
  assert.equal(viewerIndexOf(items, 13), 1);
  assert.equal(viewerIndexOf(items, 999), -1);
});

test("stepIndex: wrap-around, empty → -1", () => {
  assert.equal(stepIndex(0, 1, 3), 1);
  assert.equal(stepIndex(2, 1, 3), 0); // wrap forward
  assert.equal(stepIndex(0, -1, 3), 2); // wrap back
  assert.equal(stepIndex(0, 1, 0), -1);
});

// ---- zoom ----

test("clampZoom / toggleZoom", () => {
  assert.equal(clampZoom(0.2), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(NaN), MIN_ZOOM);
  assert.equal(clampZoom(2), 2);
  assert.equal(toggleZoom(1), 2); // fit → 2x
  assert.equal(toggleZoom(2), MIN_ZOOM); // zoomed → fit
});
