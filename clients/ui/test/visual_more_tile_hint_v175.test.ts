// clients/ui/test/visual_more_tile_hint_v175.test.ts — V175: the service tiles on «Ещё» cut their
// own sentence in half on an ordinary phone.
//
// Measured on an ephemeral stand (Playwright Chromium, 390x844, dSF 2, isMobile, ru-RU, DEFAULT
// system font — i.e. not the enlarged-font case V108/V112 already fixed). Inside a tile the hint box
// is 144 px wide, the line is 16.2 px and redesign.css clamps it to 2 lines, so the budget is 32.4 px:
//
//   tile       hint                                                  needs    cut    renders
//   import     «Перенести чаты из Telegram»                          2 lines   0 px  whole
//   bots       «Создание, команды и интеграции ботов»                2 lines   0 px  whole
//   miniapps   «Сервисы внутри GreenChat без установки и внешних…»   4 lines  33 px  «…GreenChat без»
//   support    «Написать команде и посмотреть обращения»             3 lines  17 px  «…и посмотреть»
//   server     «Адрес узла и проверка соединения»                    1 line    0 px  whole (V73c card)
//
// Sweeping BOTH dictionaries through that same box: all ten English hints fit in two lines, nine of
// the ten Russian ones fit.
//
// The clamp itself belongs to a separate package (V173, state/outbox/2026-08-03-more-tile-hint-
// clipped), which swept 361..1400 px in both locales and raised the bound from two to six. That
// repair returns the text but pays for it in height — measured on the same stand, the second row
// grows 156 -> 188 px and the screen gets 33 px longer. Its own README names the borrowed page
// subtitle as the real cause and deliberately leaves it alone; this suite covers that remainder.
// The two compose: with both applied the clamp is 6 while every shipped hint still renders two
// lines, so the grid keeps its original geometry (row tops 192/357/523) and the raised bound stays
// insurance against a future string rather than layout. What is left is a copy problem with one
// structural cause:
//
//   miniapps was the only hub item with no `more.*Hint` key of its own. app.ts handed it
//   miniAppsText(locale, "subtitle") — the mini-apps PAGE subtitle, 58 Cyrillic characters written
//   for a full-width header, not for a 144 px tile.
//
// The fix is a hint of its own, plus four characters off the support hint («посмотреть» → «увидеть»).
// Re-measured after the change: every tile cut = 0 px, every hint 2 lines (server 1), tile heights
// 156/156/156/156/76 and row tops 192/357/523 — byte-identical to before. The layout did not move;
// only the lost words came back.
//
// Character count is NOT a usable budget here, and no test should invent one: in the same box
// «Написать команде и увидеть обращения» (36 chars) renders two lines while «Сервисы GreenChat без
// установки и аккаунтов» (36 chars) renders three — Cyrillic width depends on which letters. What is
// checkable without a browser is the SHAPE this defect had, so that is what this suite pins.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { miniAppsText } from "../src/screens/miniapps_strings.ts";

const app = readFileSync(new URL("../src/screens/app.ts", import.meta.url), "utf8");
const miniappsScreen = readFileSync(
  new URL("../src/screens/miniapps_screen.ts", import.meta.url),
  "utf8",
);

/** The «Ещё» service catalogue literal — the array every hub tile is built from. */
function hubCatalogue(): string {
  const start = app.indexOf("const catalogue:");
  assert.notEqual(start, -1, "app.ts must still declare the «Ещё» service catalogue");
  const open = app.indexOf("[", app.indexOf("=", start));
  let depth = 0;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === "[") depth += 1;
    else if (app[i] === "]") {
      depth -= 1;
      if (depth === 0) return app.slice(open, i + 1);
    }
  }
  assert.fail("the service catalogue literal must be balanced");
}

test("V175: the mini-apps tile has a hint of its own, in both dictionaries", () => {
  // i18n.test.ts asserts NO en/ru parity and a missing key silently falls back to the other locale,
  // so «Мини-приложения / Open without installs» would ship to a Russian phone without a red test.
  for (const [name, dict] of [["ru", ru], ["en", en]] as const) {
    const hint = (dict as Record<string, string>)["more.miniappsHint"];
    assert.ok(
      typeof hint === "string" && hint.length > 0,
      `${name}.ts must carry more.miniappsHint — without it the tile falls back to the other locale`,
    );
  }
});

test("V175: every «Ещё» hub hint comes from the more.*Hint family", () => {
  // This is the defect's actual shape: ten tiles, ten hints, nine of them written for the tile box
  // and one borrowed from a page header. A future destination that reuses a page string here would
  // reintroduce exactly the same truncation, in a place no CSS test can see.
  const catalogue = hubCatalogue();
  const hints = [...catalogue.matchAll(/\bhint:\s*([^\n,]+)/g)].map((m) => m[1].trim());
  assert.ok(hints.length >= 9, `expected the hub to still describe its tiles, got ${hints.length}`);
  for (const expr of hints) {
    assert.match(
      expr,
      /^i18n\.t\("more\.[A-Za-z]+Hint"\)$/,
      `a hub tile hint must be a tile-sized more.*Hint string, not a borrowed page string: ${expr}`,
    );
  }
});

test("V175: every more.*Hint the hub uses exists in both dictionaries", () => {
  const catalogue = hubCatalogue();
  const keys = [...new Set([...catalogue.matchAll(/\bhint:\s*i18n\.t\("(more\.[A-Za-z]+Hint)"\)/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 9, `expected at least nine hub hints, got ${keys.length}`);
  const missing = keys.filter(
    (key) =>
      !(key in (ru as Record<string, string>)) || !(key in (en as Record<string, string>)),
  );
  assert.deepEqual(missing, [], "these hub hints exist in only one locale and would silently fall back");
});

test("V175: the mini-apps PAGE keeps its own long subtitle", () => {
  // The page header is full-width and has room for the whole sentence; the tile is 144 px and does
  // not. Shortening the page to fix the tile would have been the wrong repair, so the page string is
  // pinned as materially longer than the tile string it used to lend out.
  assert.match(
    miniappsScreen,
    /gc-miniapp-page-subtitle[\s\S]{0,80}t\("subtitle"\)/,
    "the mini-apps screen must still render its own subtitle",
  );
  assert.doesNotMatch(
    hubCatalogue(),
    /miniAppsText\(\s*i18n\.locale\s*,\s*"subtitle"\s*\)/,
    "the hub must not borrow the page subtitle as a tile hint again",
  );
  for (const locale of ["ru", "en"] as const) {
    const page = miniAppsText(locale, "subtitle");
    const tile = (locale === "ru" ? ru : en)["more.miniappsHint"] as string;
    assert.ok(
      page.length > tile.length + 10,
      `${locale}: the page subtitle (${page.length}) must stay the long form, the tile hint (${tile.length}) the short one`,
    );
  }
});

test("V175: the two Russian strings that were measured are the ones that ship", () => {
  // These are measurements, not wording preferences: both were rendered in the real tile box with the
  // clamp lifted and counted. Changing either one is a re-measurement — the probe lives in
  // state/outbox/2026-08-03-more-tile-hint-v175/probes/hint_fit.mjs.
  assert.equal(
    (ru as Record<string, string>)["more.miniappsHint"],
    "Без установки и внешних аккаунтов",
    "measured 2 lines in the 144 px tile box",
  );
  assert.equal(
    (ru as Record<string, string>)["more.supportHint"],
    "Написать команде и увидеть обращения",
    "«посмотреть» needed a third line the tile does not have; «увидеть» fits",
  );
});
