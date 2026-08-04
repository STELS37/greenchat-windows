import { test } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import { createComposer } from "../src/screens/composer.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { StickerPicker } from "../src/screens/sticker_picker.ts";
import { readFileSync } from "node:fs";

const i18n = () => createI18n({ locale: "ru", dicts: { ru, en }, fallbackLocale: "en" });

test("composer owns a sticker trigger, mirrors open state and preserves reply context for sticker sends", () => {
  installDomStub();
  const root = document.createElement("div") as unknown as HTMLElement;
  root.id = "stickers";
  let opened = false;
  let toggles = 0;
  let destroyed = 0;
  const listeners = new Set<(open: boolean) => void>();
  const stickers: StickerPicker = {
    root,
    open: () => { opened = true; for (const h of listeners) h(true); },
    close: () => { opened = false; for (const h of listeners) h(false); },
    toggle: () => { toggles += 1; opened = !opened; for (const h of listeners) h(opened); },
    isOpen: () => opened,
    reload: async () => {},
    subscribeOpenChange: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    destroy: () => { destroyed += 1; },
  };
  const composer = createComposer({
    i18n: i18n(),
    members: () => [],
    onSubmit: () => {},
    onDraft: () => {},
    stickers,
  });
  const node = composer.root as unknown as StubNode;
  const button = node.find((n) => n.hasClass("gc-composer-sticker"));
  assert.ok(button);
  assert.equal(button!.attrs["aria-controls"], "stickers");
  button!.dispatch("click");
  assert.equal(toggles, 1);
  assert.equal(button!.attrs["aria-expanded"], "true");
  composer.startReply(44, "Иван");
  assert.equal(composer.replyTarget(), 44);
  composer.reset();
  assert.equal(composer.replyTarget(), null);
  composer.destroy();
  assert.equal(destroyed, 1);
});


test("feed routes a sticker pick through the native endpoint and keeps reply context", () => {
  const source = readFileSync(new URL("../src/screens/feed_screen.ts", import.meta.url), "utf8");
  assert.match(source, /createStickerPicker\([\s\S]*?composer\.replyTarget\(\)/);
  assert.match(source, /`\/v1\/chats\/\$\{chatId\}\/sticker`/);
  assert.match(source, /stickerSendBody\(stickerId, genCmid\(\), replyToId\)/);
});
