// V193 — long messages must not be squeezed between four 44dp actions on a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import { createComposer } from "../src/screens/composer.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { StickerPicker } from "../src/screens/sticker_picker.ts";

const i18n = () => createI18n({ locale: "ru", dicts: { ru, en }, fallbackLocale: "en" });

function stickerPicker(): StickerPicker {
  const root = document.createElement("div") as unknown as HTMLElement;
  root.id = "composer-stickers";
  return {
    root,
    open() {}, close() {}, toggle() {}, isOpen: () => false, reload: async () => {},
    subscribeOpenChange: () => () => {}, destroy() {},
  };
}

test("composer switches to the full-width writing layout only after text wraps", () => {
  installDomStub();
  const composer = createComposer({
    i18n: i18n(),
    members: () => [],
    onSubmit: () => {},
    onDraft: () => {},
    onAttach: () => {},
    stickers: stickerPicker(),
  });
  const root = composer.root as unknown as StubNode;
  const wrap = root.find((node) => node.hasClass("gc-composer-inputwrap"));
  const input = root.find((node) => node.tag === "textarea");
  assert.ok(wrap && input);

  input!.clientHeight = 44;
  input!.scrollHeight = 132;
  input!.value = "Длинный текст, который уже занимает несколько строк";
  input!.dispatch("input");
  assert.equal(wrap!.hasClass("is-expanded"), true);
  assert.equal(input!.style.height, "132px");

  input!.clientHeight = 44;
  input!.scrollHeight = 44;
  input!.value = "Окей";
  input!.dispatch("input");
  assert.equal(wrap!.hasClass("is-expanded"), false);
  assert.equal(input!.style.height, "44px");
  composer.destroy();
});

test("the final cascade gives wrapped text the full pill and parks tools in a bottom rail", () => {
  const css = readFileSync(new URL("../../web/src/composer_expanded.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
  const expandedAt = main.indexOf('import "./composer_expanded.css"');
  const deliveryAt = main.indexOf('import "./message_delivery.css"');
  const shortAt = main.indexOf('import "./shortscreen.css"');
  assert.ok(expandedAt > main.indexOf('import "./redesign.css"'));
  assert.ok(deliveryAt > expandedAt, "message delivery remains the penultimate invariant sheet");
  assert.ok(shortAt > deliveryAt, "shortscreen remains the final emergency viewport authority");

  assert.match(css, /\.gc-composer-inputwrap\.is-expanded\s+\.gc-composer-input[\s\S]*?width:\s*100%/);
  assert.match(css, /padding:\s*10px 12px calc\(var\(--gc-touch-target\) \+ 6px\)/);
  assert.match(css, /\.gc-composer-inputwrap\.is-expanded\s+\.gc-composer-emoji[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.gc-composer-inputwrap\.is-expanded\s+\.gc-composer-attach[\s\S]*?position:\s*absolute/);
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /::-webkit-scrollbar[\s\S]*?width:\s*3px/);
});
