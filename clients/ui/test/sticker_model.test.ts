import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSticker,
  normalizeStickerLibrary,
  rememberRecent,
  stickerSections,
  stickerSendBody,
} from "../src/screens/sticker_model.ts";

const raw = (id: number, pack = 7, pos = 0) => ({
  id,
  pack_id: pack,
  emoji: "🙂",
  pos,
  file: { id: 100 + id, name: `${id}.webp`, mime: "image/webp", size: 2048 },
});

test("normalizeSticker accepts only physical PNG/WebP sticker files", () => {
  assert.equal(normalizeSticker(raw(1))?.file.mime, "image/webp");
  assert.equal(normalizeSticker({ ...raw(2), file: { ...raw(2).file, mime: "image/svg+xml" } }), null);
  assert.equal(normalizeSticker({ ...raw(3), file: null }), null);
});

test("library drops malformed packs, sorts stickers, deduplicates and caps recents", () => {
  const repeated = Array.from({ length: 35 }, (_, i) => raw((i % 31) + 1, 7, 35 - i));
  const library = normalizeStickerLibrary({
    packs: [
      { id: 7, slug: "starter", title: "Starter", installed: true, stickers: [raw(2, 7, 2), raw(1, 7, 1)] },
      { id: 8, slug: "empty", title: "Empty", stickers: [] },
    ],
  }, { stickers: repeated });
  assert.deepEqual(library.packs[0]!.stickers.map((s) => s.id), [1, 2]);
  assert.equal(library.packs.length, 1);
  assert.equal(library.recent.length, 30);
  assert.equal(new Set(library.recent.map((s) => s.id)).size, 30);
});

test("recent section stays first and a picked sticker becomes newest without duplicates", () => {
  const first = normalizeSticker(raw(1))!;
  const second = normalizeSticker(raw(2))!;
  const recent = rememberRecent([first, second], second);
  assert.deepEqual(recent.map((s) => s.id), [2, 1]);
  const sections = stickerSections({ recent, packs: [] }, "Recent");
  assert.equal(sections[0]!.key, "recent");
});

test("stickerSendBody preserves reply context and rejects unusable ids", () => {
  assert.deepEqual(stickerSendBody(4, "cmid", 9), { sticker_id: 4, client_msg_id: "cmid", reply_to_id: 9 });
  assert.deepEqual(stickerSendBody(4, "cmid", null), { sticker_id: 4, client_msg_id: "cmid" });
  assert.throws(() => stickerSendBody(0, "cmid", null));
});
