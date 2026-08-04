// clients/ui/test/media_layout_shift_v150.test.ts — V150 regression guard.
//
// Measured 2026-08-03. A photo bubble reserves NO space for its image: `.gc-media-photo` is a plain
// block with `min-height: 40px`, and loadImageInto() swaps a 26px spinner for the decoded <img>. So
// every picture in the conversation grows its tile from ~40px to its real height the moment the bytes
// arrive, and everything below it jumps — under the reader's finger while they are scrolling or
// reaching for a button. That is the classic layout shift, and it is unnecessary here: the server has
// accepted `width`/`height` in files.meta since T-123 ("the client generates width/height … itself"),
// and compressImage() already computes the exact output dimensions through scaledDimensions() before
// the upload — and then throws them away, because neither the uploader nor the read model carries them.
//
// This file asserts the whole chain the picture travels: prepare → upload → files.meta → render.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { Message } from "../src/screens/types.ts";
import type { AttachmentDeps, MediaEnv, MediaPort, UploadedFile } from "../src/screens/media.ts";
import { renderAttachment, compressImage } from "../src/screens/media.ts";
import { attachmentView } from "../src/screens/media_model.ts";
import { createAttachTray } from "../src/screens/attach_tray.ts";
import { installDomStub, deferred, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

// ---------------------------------------------------------------- harness
// A MediaPort that records what it was asked to upload and can hold a blob fetch open, so the tile can
// be inspected in the state the reader actually sees first: requested, not yet decoded.
class RecordingMedia implements MediaPort {
  uploads: Array<{ size: number; opts: Record<string, unknown> }> = [];
  pending = deferred<string>();
  hold = false;

  upload(data: Uint8Array, opts: Record<string, unknown>): Promise<UploadedFile> {
    this.uploads.push({ size: data.byteLength, opts });
    return Promise.resolve({ file_id: 501, name: String(opts.name ?? ""), mime: String(opts.mime ?? ""), size: data.byteLength, meta: null });
  }
  objectUrl(fileId: number): Promise<string> {
    if (this.hold) { this.pending = deferred<string>(); return this.pending.promise; }
    return Promise.resolve(`blob:file-${fileId}`);
  }
  revoke(): void {}
  setCacheLimit(): void {}
}

const env: MediaEnv = { policy: () => "all", dataSaver: () => false, network: () => "wifi", speed: () => 1, setSpeed: () => {} };
const deps = (media: MediaPort): AttachmentDeps => ({ i18n, media, env, onOpenViewer: () => {} });

const photo = (meta: Record<string, unknown> | null): Message => ({
  id: 11, chat_id: 3,
  file: { id: 501, name: "beach.jpg", mime: "image/jpeg", size: 240_000, meta },
});
const video = (meta: Record<string, unknown> | null): Message => ({
  id: 12, chat_id: 3,
  file: { id: 502, name: "clip.mp4", mime: "video/mp4", size: 900_000, meta },
});
const tileOf = (root: StubNode, cls: string): StubNode => {
  const found = root.findAll((n) => n.hasClass(cls));
  assert.equal(found.length, 1, `expected exactly one .${cls}`);
  return found[0]!;
};

// ---------------------------------------------------------------- 1. the read model
test("V150: the read model carries the sender-declared picture size", () => {
  const a = attachmentView(photo({ width: 1600, height: 1200 }))!;
  assert.equal(a.meta.width, 1600);
  assert.equal(a.meta.height, 1200);
});

test("V150: an implausible declared size is dropped rather than reserved", () => {
  for (const meta of [{ width: 0, height: 10 }, { width: -4, height: 3 }, { width: 1.5, height: 2 }, { width: 1e9, height: 10 }, { width: 800 }]) {
    const a = attachmentView(photo(meta))!;
    assert.equal(a.meta.width, undefined, `width survived ${JSON.stringify(meta)}`);
    assert.equal(a.meta.height, undefined, `height survived ${JSON.stringify(meta)}`);
  }
});

// ---------------------------------------------------------------- 2. the reserved box
test("V150: a photo tile reserves its final box BEFORE the bytes arrive", async () => {
  const media = new RecordingMedia();
  media.hold = true;
  const node = renderAttachment(photo({ width: 1600, height: 1200 }), deps(media)) as unknown as StubNode;
  await settle();

  const tile = tileOf(node, "gc-media-photo");
  assert.ok(tile.find((n) => n.hasClass("gc-media-spinner")), "the tile is still loading");
  assert.equal(tile.hasClass("is-sized"), true, "a tile with known dimensions must reserve its box");
  assert.equal(tile.style.getPropertyValue("--gc-media-w"), "1600");
  assert.equal(tile.style.getPropertyValue("--gc-media-h"), "1200");
});

// A cached blob decodes synchronously: media.ts checks `img.complete && img.naturalWidth > 0` right
// after assigning src exactly for that case. Give <img> nodes those two properties so the test walks
// the mounted-image path instead of waiting for a "load" event the stub never fires.
function stubDecodedImages(): () => void {
  const doc = globalThis.document as unknown as { createElement(tag: string): unknown };
  const saved = doc.createElement;
  doc.createElement = (tag: string): unknown => {
    const node = (saved as (t: string) => unknown).call(doc, tag);
    if (tag === "img") Object.assign(node as object, { complete: true, naturalWidth: 1 });
    return node;
  };
  return () => { doc.createElement = saved; };
}

test("V150: the reserved box survives the decode — the image lands in the space already held", async () => {
  const media = new RecordingMedia();
  const restore = stubDecodedImages();
  const node = renderAttachment(photo({ width: 1600, height: 1200 }), deps(media)) as unknown as StubNode;
  await settle();
  restore();
  const tile = tileOf(node, "gc-media-photo");
  const img = tile.find((n) => n.hasClass("gc-media-img"));
  assert.ok(img, "the image is mounted");
  assert.equal(tile.hasClass("is-sized"), true, "the reservation must not be dropped on load");
  assert.equal(tile.style.getPropertyValue("--gc-media-w"), "1600");
});

test("V150: a picture with no declared size keeps the old free-height tile", async () => {
  const media = new RecordingMedia();
  media.hold = true;
  const node = renderAttachment(photo(null), deps(media)) as unknown as StubNode;
  await settle();
  const tile = tileOf(node, "gc-media-photo");
  assert.equal(tile.hasClass("is-sized"), false);
  assert.equal(tile.style.getPropertyValue("--gc-media-w"), "");
});

test("V150: a video tile reserves its box too, but a round video note stays a circle", async () => {
  const media = new RecordingMedia();
  const plain = renderAttachment(video({ width: 1280, height: 720 }), deps(media)) as unknown as StubNode;
  await settle();
  const tile = tileOf(plain, "gc-media-video");
  assert.equal(tile.hasClass("is-sized"), true);
  assert.equal(tile.style.getPropertyValue("--gc-media-w"), "1280");

  const round = renderAttachment(video({ width: 480, height: 480, round: true }), deps(media)) as unknown as StubNode;
  await settle();
  const circle = tileOf(round, "gc-media-video");
  assert.equal(circle.hasClass("is-round"), true);
  assert.equal(circle.hasClass("is-sized"), false, "a круж circle is already square — no reservation needed");
});

// ---------------------------------------------------------------- 3. the send path
// compressImage() decodes the bitmap and scales it; the dimensions it produces are the ones the
// receiver needs. Stub only what that path touches: createImageBitmap, a canvas, and a Blob.
function stubImagePipeline(bitmap: { width: number; height: number }, outBytes: number): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedBitmap = g.createImageBitmap;
  const doc = g.document as { createElement(tag: string): unknown };
  const savedCreate = doc.createElement;
  g.createImageBitmap = () => Promise.resolve({ ...bitmap, close(): void {} });
  doc.createElement = (tag: string): unknown => {
    if (tag !== "canvas") return (savedCreate as (t: string) => unknown).call(doc, tag);
    return {
      width: 0, height: 0,
      getContext: () => ({ drawImage(): void {} }),
      toBlob: (cb: (b: unknown) => void) => cb({ size: outBytes, arrayBuffer: () => Promise.resolve(new ArrayBuffer(outBytes)) }),
    };
  };
  return () => { g.createImageBitmap = savedBitmap; doc.createElement = savedCreate; };
}
const fakeFile = (name: string, type: string, size: number): File =>
  ({ name, type, size, arrayBuffer: () => Promise.resolve(new ArrayBuffer(size)) }) as unknown as File;

test("V150: compressImage reports the dimensions it just encoded", async () => {
  const restore = stubImagePipeline({ width: 3200, height: 2400 }, 120_000);
  try {
    const prepared = await compressImage(fakeFile("beach.jpg", "image/jpeg", 900_000), "balanced");
    assert.equal(prepared.width, 1600, "balanced caps the longest edge at 1600");
    assert.equal(prepared.height, 1200);
  } finally { restore(); }
});

test("V150: the attach tray sends those dimensions with the upload", async () => {
  const g = globalThis as unknown as { URL: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void } };
  const savedUrl = g.URL;
  g.URL = { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} } as typeof g.URL;
  const restore = stubImagePipeline({ width: 3200, height: 2400 }, 120_000);
  const media = new RecordingMedia();
  try {
    const tray = createAttachTray({ i18n, media, genCmid: () => "cmid-1" });
    tray.add([fakeFile("beach.jpg", "image/jpeg", 900_000)]);
    await tray.flush("", null);
    assert.equal(media.uploads.length, 1);
    assert.deepEqual(media.uploads[0]!.opts.meta, { width: 1600, height: 1200 });
  } finally { restore(); g.URL = savedUrl; }
});
