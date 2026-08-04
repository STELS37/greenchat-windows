// clients/ui/test/visual_screen_title_zoom_v109.test.ts — V109: at the largest system font the
// screen titles were cut mid-word by a single-line ellipsis that the enlarged font made unsatisfiable.
//
// Evidence (emulator redroid Android 15, `wm density 540` = 320 dp, `settings put system font_scale
// 2.0`, ru-RU, signed direct APK, CDP against the device WebView, probe /tmp/m_settitle_v109.mjs,
// 2026-07-31). Title box is 232 px wide, font-size 40 px, `white-space: nowrap`:
//
//   #/settings/privacy    "Приватность"        needs 244  ->  rendered "Приватност…"
//   #/settings/security   "Безопасность"       needs 261  ->  rendered "Безопаснос…"
//   #/settings/links      "Подключения"        needs 261  ->  rendered "Подключен…"
//   #/settings/diagnostic "Диагностика"        needs 242  ->  rendered "Диагностик…"
//   #/connect             "Адрес сервера"      needs > 232 ->  rendered "Адрес серв…"
//   #/import              "Импорт из Telegram" needs > 232 ->  rendered "Импорт из T…"
//
// The ellipsis is there to protect the DEFAULT bar, where a title never needs a second line. It is
// not load-bearing at this size: the header is a flex row with `align-items: center` and no fixed
// height beyond `min-height`, so it simply grows. Verified live by injecting exactly this rule on
// the device (probe /tmp/m_titlefix_v109.mjs): every one of the eight settings sections plus
// «Адрес сервера» and «Импорт из Telegram» went from clipped to FULL, header 56 -> 100.9 px, and the
// four short titles («Профиль», «Общие», «Помощь», «Лицензии») kept their 56 px single-line bar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../../web/src/styles.css", import.meta.url),
  "utf8",
);
const redesign = readFileSync(
  new URL("../../web/src/redesign.css", import.meta.url),
  "utf8",
);

const TITLES = [
  ".gc-settings-title",
  ".gc-import-title",
  ".gc-server-title",
] as const;

/** The declaration block that follows the LAST mention of `sel` in `source`. */
function lastBlockFor(source: string, sel: string): string {
  const idx = source.lastIndexOf(sel);
  assert.notEqual(idx, -1, `stylesheet must still style ${sel}`);
  const open = source.indexOf("{", idx);
  const close = source.indexOf("}", open);
  assert.ok(
    open !== -1 && close !== -1,
    `${sel} must have a declaration block`,
  );
  return source.slice(open + 1, close);
}

test("V109: the default bar keeps its one-line ellipsis", () => {
  for (const sel of TITLES) {
    const idx = redesign.indexOf(sel);
    assert.notEqual(idx, -1, `redesign.css must still style ${sel}`);
    const open = redesign.indexOf("{", idx);
    const base = redesign.slice(open + 1, redesign.indexOf("}", open));
    assert.match(
      base,
      /white-space:\s*nowrap/,
      `the untouched (font_scale 1) ${sel} must still stay on one line`,
    );
    assert.match(
      base,
      /text-overflow:\s*ellipsis/,
      `the untouched (font_scale 1) ${sel} must still end in an ellipsis`,
    );
  }
});

test("V109: an enlarged system font wraps the title instead of cutting the word", () => {
  const zoomed = lastBlockFor(css, ".gc-server-title");
  assert.match(
    zoomed,
    /white-space:\s*normal/,
    "the enlarged-font rule must let the title use a second line",
  );
  assert.match(
    zoomed,
    /overflow:\s*visible/,
    "a hidden overflow keeps swallowing the tail even once wrapping is allowed",
  );
  assert.match(
    zoomed,
    /text-overflow:\s*clip/,
    "the ellipsis must stop replacing the end of the word",
  );
  assert.match(
    zoomed,
    /overflow-wrap:\s*anywhere/,
    "a single long word («Безопасность» at 261 px in a 232 px box) must still break",
  );
});

test("V109: the fix covers every measured screen title and is scoped to the system font", () => {
  const idx = css.lastIndexOf(".gc-server-title");
  const ruleStart = css.lastIndexOf(":root", idx);
  const selector = css.slice(ruleStart, css.indexOf("{", idx));
  assert.match(
    selector,
    /:root\[data-gc-text-zoom\]/,
    "a device left at the default font size must render exactly as before",
  );
  for (const sel of TITLES) {
    assert.ok(
      selector.includes(sel),
      `the enlarged-font rule must cover the measured ${sel}`,
    );
  }
});
