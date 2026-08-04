// V190 — Telegram-like attachment semantics: no manual quality matrix. Ordinary media mode chooses
// the balanced photo path automatically; one explicit "send as file" control preserves original bytes
// and sends the staged batch as generic files.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createAttachTray } from "../src/screens/attach_tray.ts";
import { installDomStub, StubNode } from "./dom_stub.ts";

const i18n = createI18n({ locale: "en", dicts: { en, ru } });
const traySource = readFileSync(new URL("../src/screens/attach_tray.ts", import.meta.url), "utf8");

interface UploadRecord {
  bytes: number[];
  name: string;
  mime: string;
}

function photo(name: string, bytes: number[]): File {
  const data = Uint8Array.from(bytes);
  return {
    name,
    type: "image/png",
    size: data.byteLength,
    arrayBuffer: () => Promise.resolve(data.slice().buffer),
  } as unknown as File;
}

function stage(): { root: StubNode; add(files: File[]): void; flush(): Promise<Array<Record<string, unknown>>>; uploads: UploadRecord[] } {
  installDomStub();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as { body?: unknown }).body = new StubNode("body");
  g.URL = { createObjectURL: () => "blob:preview", revokeObjectURL: () => undefined };

  const uploads: UploadRecord[] = [];
  let fileId = 0;
  let cmid = 0;
  const tray = createAttachTray({
    i18n,
    media: {
      async upload(data: Uint8Array, opts: { name: string; mime: string }): Promise<{ file_id: number }> {
        uploads.push({ bytes: [...data], name: opts.name, mime: opts.mime });
        return { file_id: ++fileId };
      },
    } as never,
    genCmid: () => `v190-${++cmid}`,
  });
  return {
    root: tray.root as unknown as StubNode,
    add: (files) => tray.add(files),
    flush: () => tray.flush("", null),
    uploads,
  };
}

test("V190: the tray exposes one file-mode choice and no quality selector", () => {
  const { root } = stage();
  assert.equal(root.findAll((node) => node.tag === "select").length, 0, "there is no quality dropdown");
  assert.equal(root.findAll((node) => node.hasClass("gc-tray-quality")).length, 0);
  assert.equal(root.findAll((node) => node.hasClass("gc-tray-asfile")).length, 0, "no per-thumbnail mode puzzle");
  const modes = root.findAll((node) => node.hasClass("gc-tray-file-mode"));
  assert.equal(modes.length, 1, "one batch-level Telegram-style file choice");
  assert.equal(modes[0]!.getAttribute("aria-pressed"), "false", "photo/media mode is the default");
});

test("V190: default photo mode is automatic; file mode sends exact original bytes", async () => {
  const { root, add, flush, uploads } = stage();
  const mode = root.findAll((node) => node.hasClass("gc-tray-file-mode"))[0]!;

  add([photo("photo.png", [1, 2, 3, 4])]);
  const photoBodies = await flush();
  assert.equal(photoBodies.length, 1);
  assert.equal(photoBodies[0]!.kind, "photo", "ordinary send is a displayable photo, not a document");
  assert.deepEqual(uploads[0]!.bytes, [1, 2, 3, 4]);
  assert.equal(mode.getAttribute("aria-pressed"), "false", "empty tray returns to ordinary photo mode");

  add([photo("original.png", [9, 8, 7, 6])]);
  mode.dispatch("click");
  assert.equal(mode.getAttribute("aria-pressed"), "true");
  const fileBodies = await flush();
  assert.equal(fileBodies.length, 1);
  assert.equal(fileBodies[0]!.kind, "file", "explicit file mode produces a document/file message");
  assert.deepEqual(uploads[1], {
    bytes: [9, 8, 7, 6],
    name: "original.png",
    mime: "image/png",
  }, "file mode preserves the original bytes, name and MIME");
  assert.equal(mode.getAttribute("aria-pressed"), "false", "the next attachment starts in photo mode again");
});

test("V190: implementation pins the balanced photo preset instead of reading a user quality value", () => {
  assert.match(traySource, /compressImage\(it\.file, "balanced"\)/);
  assert.doesNotMatch(traySource, /gc-tray-quality|qualitySel|CompressionQuality\[\]/);
});
