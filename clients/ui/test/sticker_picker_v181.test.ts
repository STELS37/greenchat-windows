import { test } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import { createStickerPicker } from "../src/screens/sticker_picker.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const i18n = () => createI18n({ locale: "ru", dicts: { ru, en }, fallbackLocale: "en" });
const sticker = (id: number, pack = 7) => ({
  id,
  pack_id: pack,
  emoji: "🙂",
  pos: id,
  file: { id: id + 100, name: `${id}.webp`, mime: "image/webp", size: 2048 },
});

test("picker loads installed/recent endpoints, resolves protected blobs and sends a selected sticker", async () => {
  installDomStub();
  const paths: string[] = [];
  const picked: number[] = [];
  const resolved: number[] = [];
  const revoked: string[] = [];
  const picker = createStickerPicker({
    i18n: i18n(),
    api: { get: async <T>(path: string) => {
      paths.push(path);
      return (path.endsWith("/my")
        ? { packs: [{ id: 7, slug: "starter", title: "Starter", installed: true, stickers: [sticker(1), sticker(2)] }] }
        : { stickers: [sticker(2)] }) as T;
    } },
    media: {
      objectUrl: async (id) => { resolved.push(id); return `blob:${id}`; },
      revoke: (url) => revoked.push(url),
    },
    onPick: async (item) => { picked.push(item.id); },
  });

  picker.open();
  await tick();
  await tick();
  const root = picker.root as unknown as StubNode;
  assert.deepEqual(paths.sort(), ["/v1/stickers/my", "/v1/stickers/recent"]);
  assert.ok(root.findAll((n) => n.hasClass("gc-sticker-tab")).length >= 2);
  const cells = root.findAll((n) => n.hasClass("gc-sticker-cell"));
  assert.equal(cells.length, 1, "recent tab is selected first");
  assert.deepEqual(resolved, [102]);
  cells[0]!.dispatch("click");
  await tick();
  assert.deepEqual(picked, [2]);
  assert.equal(picker.isOpen(), false);
  assert.ok(revoked.includes("blob:102"));
});

test("failed library request exposes retry and recovers without recreating the composer", async () => {
  installDomStub();
  let calls = 0;
  const picker = createStickerPicker({
    i18n: i18n(),
    api: { get: async <T>(path: string) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error("offline"), { name: "NetworkError" });
      return (path.endsWith("/my") ? { packs: [] } : { stickers: [] }) as T;
    } },
    media: { objectUrl: async () => "blob:x", revoke: () => {} },
    onPick: () => {},
  });
  picker.open();
  await tick();
  const root = picker.root as unknown as StubNode;
  const retry = root.find((n) => n.hasClass("gc-sticker-retry"));
  assert.ok(retry);
  retry!.dispatch("click");
  await tick();
  await tick();
  assert.equal(calls, 4);
  assert.match(root.textContent, /Пока нет наборов стикеров/);
});
