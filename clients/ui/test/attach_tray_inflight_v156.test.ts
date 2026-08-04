// clients/ui/test/attach_tray_inflight_v156.test.ts — V156: the attachment tray kept accepting edits
// while it was already sending, and none of them reached the send it was making.
//
// The tray stages files, then `flush()` compresses and uploads them one at a time. Uploads are slow —
// that is the whole reason the tray draws a progress bar — so the person is looking at a live, fully
// interactive tray for as long as the send takes. Measured on a real tray (witness-before.txt):
//
//   • ✕ on a file mid-send: the thumbnail disappears, count() drops from 3 to 2 — and the file is
//     still uploaded and still delivered. `flush()` iterates `items`, `remove()` rebinds `items` to a
//     new array, so the loop keeps walking the old one. The person withdrew a file and sent it.
//   • picking another file mid-send: it is appended to the array the loop is walking, so it joins the
//     send already in progress — under the PREVIOUS caption and reply target — and `reset()` then
//     clears it. A file the person staged for the next message went out with the last one.
//   • any repaint mid-send (for example staging another item) rebuilds every thumbnail, so the
//     progress fill is replaced by a fresh element at width "" and the bar jumps back to zero.
//   • pressing Send twice: the second `flush()` returns [] because `uploading` is true, so the caption
//     typed the second time is dropped and the caller's "Загрузка…" never clears.
//
// The contract pinned here: a send owns the batch it started with. Files staged afterwards belong to
// the next send, files already in flight cannot be withdrawn (their controls say so), the progress bar
// is not thrown away by a repaint, and a second Send waits its turn instead of silently doing nothing.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createAttachTray, type AttachTray } from "../src/screens/attach_tray.ts";
import { installDomStub, StubNode } from "./dom_stub.ts";

const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const fakeFile = (name: string): File =>
  ({ name, type: "application/octet-stream", size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) }) as unknown as File;

/** An upload that hangs until the test lets it through, so "mid-send" is a real state. */
class GatedMedia {
  uploads: string[] = [];
  private gates: Array<() => void> = [];
  async upload(_data: Uint8Array, opts: { name: string; onProgress?: (loaded: number, total: number) => void }): Promise<{ file_id: number }> {
    this.uploads.push(opts.name);
    opts.onProgress?.(62, 100); // a real upload reports progress; the bar test needs the product's own path
    await new Promise<void>((resolve) => this.gates.push(resolve));
    return { file_id: this.uploads.length };
  }
  async download(): Promise<Uint8Array> { return new Uint8Array(); }
  /** Let every upload that is currently waiting finish, then drain the microtask queue. */
  async release(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) { this.gates.shift()?.(); await tick(); }
  }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Stage { tray: AttachTray; root: StubNode; media: GatedMedia; urls: { made: number; revoked: number } }

function stage(names: string[]): Stage {
  installDomStub();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as { body?: unknown }).body = new StubNode("body");
  const urls = { made: 0, revoked: 0 };
  g.URL = { createObjectURL: () => `blob:p${(urls.made += 1)}`, revokeObjectURL: () => { urls.revoked += 1; } };
  const media = new GatedMedia();
  let seq = 0;
  const tray = createAttachTray({ i18n, media: media as never, genCmid: () => `cmid-${(seq += 1)}` });
  const root = tray.root as unknown as StubNode;
  tray.add(names.map(fakeFile));
  // The fixtures are generic binary files, so the normal media lane already treats them as files;
  // this test stays focused on queue ownership and progress rather than photo encoding.
  return { tray, root, media, urls };
}

const thumbs = (root: StubNode): StubNode[] => root.findAll((n) => n.hasClass("gc-tray-thumb"));
const rmButtons = (root: StubNode): StubNode[] => root.findAll((n) => n.hasClass("gc-tray-rm"));
const bars = (root: StubNode): StubNode[] => root.findAll((n) => n.hasClass("gc-tray-bar"));
const sentNames = (media: GatedMedia): string => media.uploads.join(", ");

// ---- 1. a send owns the batch it started with ------------------------------------------------------

test("V156: a file withdrawn mid-send is not sent", async () => {
  const { tray, root, media } = stage(["a.bin", "b.bin", "c.bin"]);
  const sending = tray.flush("caption", null);
  await tick();
  assert.deepEqual(media.uploads, ["a.bin"], "the first file is on the wire, the other two are queued");

  rmButtons(root)[1]!.dispatch("click"); // the person changes their mind about b.bin

  await media.release();
  const bodies = await sending;
  assert.ok(
    !media.uploads.includes("b.bin"),
    `b.bin was withdrawn while a.bin was still uploading and went out anyway (uploaded: ${sentNames(media)}). ` +
      "flush() walks `items` while remove() rebinds it, so the loop finishes the array the person edited away.",
  );
  assert.equal(bodies.length, 2, "two files were actually sent, so two bodies");
});

test("V156: the controls of a file already in flight say it cannot be withdrawn", async () => {
  const { tray, root, media } = stage(["a.bin", "b.bin"]);
  const sending = tray.flush("", null);
  await tick();
  const rm = rmButtons(root)[0]!;
  assert.equal(
    rm.disabled,
    true,
    "a control that cannot do its job must not look like it can — and a disabled button is also out " +
      "of the Tab ring, which is the same thing said to a keyboard",
  );
  assert.equal(thumbs(root)[0]!.hasClass("is-sending"), true, "and the thumbnail carries the state for CSS");
  await media.release();
  await sending;
  const after = rmButtons(root);
  assert.equal(after.length, 0, "the sent batch left the tray");
});

// ---- 2. a file staged mid-send belongs to the NEXT send ---------------------------------------------

test("V156: a file staged mid-send is not swept into the send in progress", async () => {
  const { tray, root, media } = stage(["a.bin"]);
  const sending = tray.flush("first caption", null);
  await tick();

  tray.add([fakeFile("late.bin")]);
  await media.release();
  const bodies = await sending;

  assert.deepEqual(
    media.uploads,
    ["a.bin"],
    `late.bin was staged after Send was pressed and joined that send anyway (uploaded: ${sentNames(media)}), ` +
      "carrying the caption of the message before it",
  );
  assert.equal(bodies.length, 1, "one file was sent, so one body");
  assert.equal(tray.count(), 1, "late.bin is still staged, waiting for its own send");
  assert.equal(thumbs(root).length, 1, "…and still on screen");
});

test("V156: only the sent batch releases its preview, the file still staged keeps its own", async () => {
  installDomStub();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as { body?: unknown }).body = new StubNode("body");
  const urls = { made: 0, revoked: 0 };
  g.URL = { createObjectURL: () => `blob:p${(urls.made += 1)}`, revokeObjectURL: () => { urls.revoked += 1; } };
  const media = new GatedMedia();
  const tray = createAttachTray({ i18n, media: media as never, genCmid: () => "cmid" });
  tray.add([{ name: "shot.png", type: "image/png", size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) } as unknown as File]);
  const sending = tray.flush("", null);
  await tick();
  tray.add([{ name: "later.png", type: "image/png", size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) } as unknown as File]);
  await media.release();
  await sending;
  assert.equal(urls.made, 2, "two previews were created");
  assert.equal(urls.revoked, 1, "exactly the sent one was released; revoking the other would blank a live thumbnail");
  tray.destroy();
  assert.equal(urls.revoked, 2, "and unmounting releases what is left");
});

test("V156: while a batch is on the wire the tray reports nothing waiting", async () => {
  const { tray, media } = stage(["a.bin", "b.bin"]);
  const sending = tray.flush("", null);
  await tick();
  assert.equal(
    tray.count(),
    0,
    "count() is what composer.ts asks (`hasStaged`) and what feed_screen.ts branches on to decide " +
      "whether the next Enter is a caption. Reporting the uploading batch as staged handed a message " +
      "typed during the upload to a send with nothing left to attach it to, and it was swallowed",
  );
  tray.add([fakeFile("late.bin")]);
  assert.equal(tray.count(), 1, "a file picked meanwhile IS waiting, and its Enter IS a caption");
  await media.release();
  await sending;
  assert.equal(tray.count(), 1, "still waiting once the send is over");
});

// ---- 3. the progress bar is not thrown away by a repaint -------------------------------------------

test("V156: a repaint mid-send keeps the progress the person is watching", async () => {
  const { tray, root, media } = stage(["a.bin", "b.bin"]);
  const sending = tray.flush("", null);
  await tick();
  const bar = bars(root)[0]!;
  assert.equal(bar.style.getPropertyValue("width"), "62%", "the upload reported 62% and the fill shows it");

  tray.add([fakeFile("late.bin")]); // any staging repaints the tray

  const after = bars(root)[0]!;
  // Identity by `===`, not assert.equal: two StubNodes that differ print their whole subtree, and a
  // diff of six hundred lines is not evidence anybody reads.
  assert.ok(after === bar, "the same fill element, not a fresh one");
  assert.equal(
    after.style.getPropertyValue("width"),
    "62%",
    "paint() rebuilt every thumbnail and handed the item a new empty bar, so a progress fill at 62% " +
      "jumped back to zero while the byte count kept climbing",
  );
  await media.release();
  await sending;
});

// ---- 4. pressing Send twice ------------------------------------------------------------------------

test("V156: a second Send waits its turn instead of silently doing nothing", async () => {
  const { tray, media } = stage(["a.bin"]);
  const first = tray.flush("first", null);
  await tick();
  tray.add([fakeFile("late.bin")]);
  const second = tray.flush("second", null);

  await media.release();
  const firstBodies = await first;
  const secondBodies = await second;

  assert.equal(firstBodies.length, 1, "the first send carries the file that was staged when it started");
  assert.equal(firstBodies[0]!.text, "first", "…with its own caption");
  assert.equal(
    secondBodies.length,
    1,
    "the second Send returned [] because a send was in flight: its caption was dropped and the " +
      "caller's status line was left spinning on a send that had already finished",
  );
  assert.equal(secondBodies[0]!.text, "second", "the second caption belongs to the second send");
  assert.deepEqual(media.uploads, ["a.bin", "late.bin"], "each file went out exactly once");
  assert.equal(tray.count(), 0, "nothing left staged");
});

test("V156: a second Send with nothing new staged still sends nothing", async () => {
  const { tray, media } = stage(["a.bin"]);
  const first = tray.flush("first", null);
  await tick();
  const second = tray.flush("second", null);
  await media.release();
  assert.equal((await first).length, 1);
  assert.deepEqual(await second, [], "there was nothing left to send, and saying so is honest");
});

// ---- 5. the ordinary path is unchanged --------------------------------------------------------------

test("V156: an untouched batch still sends exactly as before", async () => {
  const { tray, media } = stage(["a.bin", "b.bin"]);
  const sending = tray.flush("hello", 42);
  await media.release();
  const bodies = await sending;
  assert.deepEqual(media.uploads, ["a.bin", "b.bin"]);
  assert.equal(bodies.length, 2, "two files sent verbatim are two messages, not an album");
  assert.equal(bodies[0]!.text, "hello", "the caption rides the first body");
  assert.equal(bodies[0]!.reply_to_id, 42, "…and so does the reply target");
  assert.equal(bodies[1]!.text, undefined, "the rest carry neither");
  assert.equal(tray.count(), 0, "the tray is empty afterwards");
});

test("V156: a failed upload keeps the batch staged for a retry", async () => {
  installDomStub();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as { body?: unknown }).body = new StubNode("body");
  g.URL = { createObjectURL: () => "blob:p", revokeObjectURL: () => {} };
  const tray = createAttachTray({
    i18n,
    media: { upload: () => Promise.reject(new Error("offline")), download: () => Promise.resolve(new Uint8Array()) } as never,
    genCmid: () => "cmid",
  });
  const root = tray.root as unknown as StubNode;
  tray.add([fakeFile("a.bin")]);
  await assert.rejects(() => tray.flush("", null), /offline/);
  assert.equal(tray.count(), 1, "the file is still staged so the person can press Send again");
  assert.equal(rmButtons(root)[0]!.disabled, false, "…and it can be withdrawn again, the send is over");
  const retry = tray.flush("", null);
  await assert.rejects(() => retry, /offline/, "a retry is possible: the lock was released, not left set");
});
