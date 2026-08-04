import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");

const uiIndex = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("V206: locale catalogues are dynamic chunks, not startup-barrel imports", () => {
  const uiImport = main.match(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\.\/\.\.\/ui\/src\/index\.ts";/u)?.[1] ?? "";
  assert.doesNotMatch(uiImport, /\b(?:ru|en)\b/u, "the UI barrel must not pull either catalogue into startup JS");

  assert.doesNotMatch(uiIndex, /export \{ (?:ru|en) \} from "\.\/locales\/(?:ru|en)\.ts";/u);
  assert.match(main, /import\("\.\.\/\.\.\/ui\/src\/locales\/ru\.ts"\)/u);
  assert.match(main, /import\("\.\.\/\.\.\/ui\/src\/locales\/en\.ts"\)/u);
  assert.match(main, /const localeLoads = new Map<Locale, Promise<Dict>>\(\)/u);
});

test("V206: the selected language is complete before boot and switching awaits its chunk", () => {
  assert.match(main, /async function boot\(\): Promise<void>/u);
  assert.match(main, /dicts\[initialLocale\] = await loadUiLocale\(initialLocale\)/u);
  assert.match(main, /const setLangPref = async \(pref: LangPref\): Promise<void>/u);
  assert.match(main, /await ensureLocale\(next\);[\s\S]*i18n\.setLocale\(next\)/u);
  assert.match(main, /app\.start\(\);[\s\S]*setTimeout\(\(\) => \{ void ensureLocale\(alternateLocale\)/u);
  assert.doesNotMatch(main, /createI18n\(\{\s*locale:[^}]*dicts:\s*\{\s*ru,\s*en\s*\}/u);
});
