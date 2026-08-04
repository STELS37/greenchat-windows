import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import { createComposer } from "../src/screens/composer.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

const i18n = () => createI18n({ locale: "ru", dicts: { ru, en }, fallbackLocale: "en" });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

test("V206: emoji catalogue is lazy but the first trigger still opens a complete accessible panel", async () => {
  installDomStub();
  const composer = createComposer({
    i18n: i18n(),
    members: () => [],
    onSubmit: () => {},
    onDraft: () => {},
  });
  const root = composer.root as unknown as StubNode;
  const button = root.find((node) => node.hasClass("gc-composer-emoji"));
  assert.ok(button);
  assert.equal(root.find((node) => node.hasClass("gc-emoji-panel")), null);
  assert.equal(button!.attrs["aria-controls"], undefined);

  button!.dispatch("click");
  assert.equal(button!.attrs["aria-busy"], "true");
  await settle();

  const panel = root.find((node) => node.hasClass("gc-emoji-panel"));
  assert.ok(panel, "the chunk mounts its panel on the first deliberate open");
  assert.equal(panel!.hidden, false);
  assert.equal(button!.attrs["aria-controls"], panel!.id);
  assert.equal(button!.attrs["aria-expanded"], "true");
  assert.equal(button!.attrs["aria-busy"], undefined);
  composer.destroy();
});

test("V206: composer has no eager runtime import of the emoji catalogue", () => {
  const source = readFileSync(new URL("../src/screens/composer.ts", import.meta.url), "utf8");
  assert.match(source, /import\("\.\/emoji_picker\.ts"\)/);
  assert.doesNotMatch(source, /import\s*\{[^}]*createEmojiPicker[^}]*\}\s*from\s*"\.\/emoji_picker\.ts"/);
});
