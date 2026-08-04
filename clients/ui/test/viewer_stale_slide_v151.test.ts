// clients/ui/test/viewer_stale_slide_v151.test.ts — V151 regression guard for the full-screen viewer.
//
// Measured 2026-08-03 on openViewer() in clients/ui/src/screens/media.ts. Every slide is fetched by
//     const url = await deps.media.objectUrl(it.fileId, it.mime);
//     curUrl = url; clear(stage); stage.append(<img src=url>);
// with nothing tying that resolution back to the slide that asked for it. Three consequences, all
// reachable by a person paging a gallery on a slow connection:
//
//  1. WRONG PICTURE. Page from a slow photo to a fast one and the slow fetch lands last: the stage
//     shows picture A while the caption underneath still reads "2 / 2 · B".
//  2. LEAKED BLOB. `curUrl` is overwritten by the late arrival, so the URL it replaced is never
//     revoked; closing the viewer mid-fetch leaks the same way (the late assignment happens after
//     close() already revoked). The media cache keeps those bytes pinned for the session.
//  3. A MESSAGE THAT IS NOT TRUE. Any failure prints errors.network — "No connection. The action was
//     queued." Nothing was queued, and a deleted or forbidden file is not a connection problem. The
//     rest of this file has used describeError() since V149; the viewer never got it, and it offers
//     no retry, so the only way out of a transient failure is to close the viewer and reopen it.
//
// Plus one accessibility gap: the overlay declares role="dialog" aria-modal="true" but never moves
// focus into itself and never restores it on close, so a keyboard user stays parked on the page behind.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { Message } from "../src/screens/types.ts";
import type { MediaEnv, MediaPort, UploadedFile, ViewerDeps } from "../src/screens/media.ts";
import { openViewer } from "../src/screens/media.ts";
import { installDomStub, deferred, dispatchDocument, settle, StubNode } from "./dom_stub.ts";

// openViewer mounts its overlay on document.body and listens for Escape on the document, so each
// test starts from a fresh stub: a viewer left behind by a failed assertion would otherwise answer
// the next test's Escape and mount a second overlay into the same body.
let documentStub: { body: StubNode; createElement(tag: string): StubNode; activeElement: unknown };
function freshDom(): void {
  installDomStub();
  documentStub = globalThis.document as unknown as typeof documentStub;
  documentStub.body = documentStub.createElement("body");
}
freshDom();

const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const env: MediaEnv = { policy: () => "all", dataSaver: () => false, network: () => "wifi", speed: () => 1, setSpeed: () => {} };

// A MediaPort whose fetches are held open per file id, so the test decides the arrival ORDER — the
// only thing that distinguishes a correct viewer from this one.
class SlowMedia implements MediaPort {
  pending = new Map<number, { promise: Promise<string>; resolve(v: string): void; reject(e: unknown): void }>();
  revoked: string[] = [];
  objectUrl(fileId: number): Promise<string> {
    const d = deferred<string>();
    this.pending.set(fileId, d);
    return d.promise;
  }
  settleWith(fileId: number, url: string): void { this.pending.get(fileId)!.resolve(url); }
  failWith(fileId: number, err: unknown): void { this.pending.get(fileId)!.reject(err); }
  revoke(url: string): void { this.revoked.push(url); }
  upload(): Promise<UploadedFile> { throw new Error("not used"); }
  setCacheLimit(): void {}
}

const photo = (id: number, name: string): Message => ({
  id, chat_id: 3, file: { id, name, mime: "image/jpeg", size: 1000, meta: null },
});
const deps = (media: MediaPort): ViewerDeps => ({ i18n, media, env });
const overlayOf = (): StubNode => {
  const found = documentStub.body.findAll((n) => n.hasClass("gc-viewer"));
  assert.equal(found.length, 1, "exactly one viewer overlay is mounted");
  return found[0]!;
};
const closeViewer = (): void => {
  for (const o of documentStub.body.findAll((n) => n.hasClass("gc-viewer"))) {
    const btn = o.find((n) => n.hasClass("gc-viewer-close"));
    if (btn) btn.click();
    o.remove();
  }
};
const srcOf = (overlay: StubNode): string => String(overlay.find((n) => n.hasClass("gc-viewer-media"))?.attrs.src ?? "");
const errorTextOf = (overlay: StubNode): string => overlay.find((n) => n.hasClass("gc-viewer-error"))?.textContent ?? "";

// ---------------------------------------------------------------- 1. the right picture
test("V151: a slide that arrives late never replaces the slide the reader paged to", async () => {
  freshDom();
  const media = new SlowMedia();
  const msgs = [photo(11, "first.jpg"), photo(12, "second.jpg")];
  openViewer(msgs, 11, deps(media));
  await settle();

  const overlay = overlayOf();
  overlay.find((n) => n.hasClass("gc-viewer-next"))!.click(); // page forward while slide 1 is still in flight
  await settle();
  media.settleWith(12, "blob:second");
  await settle();
  media.settleWith(11, "blob:first"); // the abandoned fetch finally lands
  await settle();

  assert.equal(srcOf(overlay), "blob:second", "the stage must show the slide the caption names");
  assert.ok(overlay.find((n) => n.hasClass("gc-viewer-caption"))!.textContent.includes("second.jpg"));
  assert.ok(media.revoked.includes("blob:first"), "the abandoned slide's blob must be released, not leaked");
  closeViewer();
});

// ---------------------------------------------------------------- 2. no leaked blob
test("V151: closing the viewer mid-fetch releases the blob that arrives afterwards", async () => {
  freshDom();
  const media = new SlowMedia();
  openViewer([photo(21, "one.jpg")], 21, deps(media));
  await settle();
  dispatchDocument("keydown", { key: "Escape" });
  await settle();
  media.settleWith(21, "blob:late");
  await settle();

  assert.deepEqual(media.revoked, ["blob:late"], "a blob that outlives its viewer must still be revoked");
  assert.equal(documentStub.body.findAll((n) => n.hasClass("gc-viewer")).length, 0, "the overlay is gone");
});

// ---------------------------------------------------------------- 3. an honest failure + retry
test("V151: a failed slide says what actually failed and can be retried in place", async () => {
  freshDom();
  const media = new SlowMedia();
  openViewer([photo(31, "gone.jpg")], 31, deps(media));
  await settle();
  media.failWith(31, Object.assign(new Error("gone"), { name: "ApiError", code: "FILE_NOT_FOUND" }));
  await settle();

  const overlay = overlayOf();
  const text = errorTextOf(overlay);
  assert.notEqual(text, i18n.t("errors.network"), "a missing file is not a connection problem");
  assert.equal(text, i18n.error("FILE_NOT_FOUND"), "the text must come from the error catalogue");

  const retry = overlay.find((n) => n.hasClass("gc-viewer-retry"));
  assert.ok(retry, "a failed slide offers a retry");
  retry.click();
  await settle();
  media.settleWith(31, "blob:retried");
  await settle();
  assert.equal(srcOf(overlay), "blob:retried", "the retry actually re-fetches");
  assert.equal(errorTextOf(overlay), "", "the failure line is cleared once the picture arrives");
  closeViewer();
});

test("V151: a dropped connection still reads as a dropped connection", async () => {
  freshDom();
  const media = new SlowMedia();
  openViewer([photo(41, "net.jpg")], 41, deps(media));
  await settle();
  media.failWith(41, Object.assign(new Error("offline"), { name: "NetworkError" }));
  await settle();
  assert.equal(errorTextOf(overlayOf()), i18n.t("errors.network"));
  closeViewer();
});

// ---------------------------------------------------------------- 4. the modal owns the keyboard
test("V151: an aria-modal dialog takes focus and gives it back", async () => {
  freshDom();
  const media = new SlowMedia();
  const opener = documentStub.createElement("button");
  documentStub.body.append(opener);
  opener.focus();

  openViewer([photo(51, "focus.jpg")], 51, deps(media));
  await settle();
  const overlay = overlayOf();
  assert.ok(
    overlay.findAll((n) => n === documentStub.activeElement).length === 1,
    "focus must move inside the dialog, not stay on the page behind it",
  );

  dispatchDocument("keydown", { key: "Escape" });
  await settle();
  assert.equal(documentStub.activeElement, opener, "focus returns to whatever opened the viewer");
  media.settleWith(51, "blob:focus");
  await settle();
});
