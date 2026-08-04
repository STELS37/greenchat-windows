// clients/ui/test/visual_more_tile_hint_v173.test.ts — V173: the service tile hint on «Ещё».
//
// Screenshot QA 2026-08-03, route #/more at the default system font: two of the five service tiles
// did not say what they do. `.gc-more-tile-hint` was clamped to two lines, and at a 390 px phone
//
//   ru  "Сервисы внутри GreenChat без установки и внешних аккаунтов"   needs 4 lines, showed 2
//   ru  "Написать команде и посмотреть обращения"                      needs 3 lines, showed 2
//   en  "Services inside GreenChat without installation or external accounts"  needs 4, showed 2
//
// so the user read «Сервисы внутри GreenChat без…» and «Написать команде и посмотреть…». The Support
// tile lost its line into space that was ALREADY empty: CSS grid stretches a row to its tallest
// tile, so a longer hint grows the ROW, never one tile past its neighbour.
//
// Why it survived so long is the interesting half, and it is what this suite is really guarding.
// The clamp had ALREADY been diagnosed once, and repaired twice — in styles.css, for enlarged
// system fonts (`:root[data-gc-text-zoom]`) and for narrow phones (`@media (max-width: 360px)`).
// Both repairs win by SPECIFICITY: their selectors carry a `:root` prefix, so they outweigh the
// redesign.css rule regardless of sheet order. What nobody measured was the ordinary band in
// between — a default font on a screen wider than 360 px, i.e. essentially every phone shipped
// since 2018. Delete the `:root` from either override and it quietly loses to redesign.css, which
// loads later; nothing looks wrong in the diff and the narrow phones regress in silence. Tests 2
// and 3 exist for that specific edit.
//
// What was measured (probe: Playwright Chromium against a built stand, both dictionaries, every
// integer width from 361 to 1400 px, clamp lifted through CSSOM so the probe reads the NEED and not
// the current limit — CSP `style-src 'self'` blocks addStyleTag but does not govern CSSOM):
//
//   locale   worst need   where                                   widths needing 6 / 5 (of 1040)
//   en-US    6 lines      448 px screen, 102 px hint box            91 / 77
//   ru-RU    5 lines      448 px screen, 109 px hint box             0 / 350
//
// The worst case is NOT the narrowest screen: `.gc-more-grid` is `repeat(auto-fit, minmax(...))`,
// so the tile is narrowest wherever auto-fit has just fitted one more column (174 px at 390, 135 px
// at 600). Six lines is therefore the honest bound, and after the fix a sweep of 300..1400 px in
// both locales clipped 0 of 112 renders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { miniAppsText } from "../src/screens/miniapps_strings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const SCOPE = ":is(.gc-superapp, .gc-overlay, .gc-palette-overlay, .gc-msgmenu-layer)";

/** Split a selector list on TOP-LEVEL commas — `:is(a, b, c)` is one selector, not three. */
function selectorList(head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === "(") depth += 1;
    else if (head[i] === ")") depth -= 1;
    else if (head[i] === "," && depth === 0) {
      out.push(head.slice(start, i));
      start = i + 1;
    }
  }
  out.push(head.slice(start));
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

/** Declarations of `<SCOPE> <selector>` at the DEFAULT viewport, merged in document order. */
function ruleOf(css: string, selector: string): Record<string, string> {
  const want = `${SCOPE} ${selector}`;
  const out: Record<string, string> = {};
  let matched = 0;
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    if (!head.startsWith("@") && selectorList(head).includes(want)) {
      matched += 1;
      for (const part of css.slice(open + 1, j - 1).split(";")) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
    }
    i = j;
  }
  assert.ok(matched > 0, `redesign.css no longer styles \`${selector}\` in the app scope`);
  return out;
}

const px = (value: string): number => {
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  assert.ok(m, `expected a px length, got "${value}"`);
  return Number(m![1]);
};

/**
 * Every string that can land in a service tile hint. A SUPERSET on purpose: `app.ts` picks a subset
 * by feature flag, and a budget that covers strings the build may not currently paint errs on the
 * safe side. The Mini Apps tile is the odd one out — it feeds itself the mini-apps PAGE subtitle
 * instead of a purpose-written `more.*Hint`, which is why it is the longest by a factor of two.
 */
function hintStrings(): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  for (const [name, dict] of [["en", en], ["ru", ru]] as const) {
    for (const [key, value] of Object.entries(dict as Record<string, string>)) {
      if (/^more\.[a-zA-Z]+Hint$/.test(key)) out.push({ key: `${name}:${key}`, text: value });
    }
  }
  for (const locale of ["en", "ru"] as const) {
    out.push({ key: `${locale}:miniapps.subtitle`, text: miniAppsText(locale, "subtitle") });
  }
  return out;
}

test("V173: the clamp shows every hint the product ships, at the narrowest tile the grid can make", () => {
  const redesign = strip(read("../../web/src/redesign.css"));
  const hint = ruleOf(redesign, ".gc-more-tile-hint");
  const tile = ruleOf(redesign, ".gc-more-tile");
  const grid = ruleOf(redesign, ".gc-more-grid");

  const clamp = Number(hint["-webkit-line-clamp"]);
  assert.ok(
    Number.isInteger(clamp) && clamp > 0,
    "the hint must stay a BOUNDED box: without a clamp one pathological string stretches the whole " +
      "row, and the grid stretches every tile in it. The bound is the point — its value is what " +
      "this test computes.",
  );

  // ---- the narrowest tile, from the track rather than from a screenshot ---------------------------
  // grid-template-columns: repeat(auto-fit, minmax(min(100%, calc(<n>rem * var(--gc-font-scale, 1))), 1fr))
  // auto-fit packs as many <n>rem columns as fit, so <n>rem IS the floor of the tile's border box.
  const track = /minmax\(\s*min\(\s*100%\s*,\s*calc\(\s*([\d.]+)rem/.exec(grid["grid-template-columns"] ?? "");
  assert.ok(track, `the grid track changed shape: "${grid["grid-template-columns"]}" — recheck this budget`);
  const minTile = Number(track![1]) * 16; // 1rem = 16px at the default root size

  // padding: <block> <inline> <block-end>  → the inline half is what the text loses on each side.
  const padding = tile.padding!.split(/\s+/);
  assert.equal(padding.length, 3, `expected a three-value padding, got "${tile.padding}"`);
  const inline = px(padding[1]!);
  const border = px((tile.border ?? "").split(/\s+/)[0] ?? "0px");
  const box = minTile - 2 * border - 2 * inline;

  // The probe measured exactly this box on a real build: 448 px screen → 3 columns of 132 px →
  // 132 − 2×1 border − 2×14 padding = 102 px. If the arithmetic and the browser ever disagree, it
  // is this line that says so.
  assert.equal(box, 102, `the narrowest hint box is now ${box}px (was 102px when it was measured in a browser)`);

  // ---- how much text fits in it ------------------------------------------------------------------
  // Calibrated, not guessed: the browser packed the 67-character English sentence into exactly 6
  // lines of a 102 px box, and the 57-character Russian one into exactly 5 lines of a 109 px box.
  // 8.5 px per character at the 12 px hint font (0.71 em — the average advance of the mixed
  // Latin/Cyrillic text this product actually ships, not a font metric) reproduces BOTH: 102/8.5 =
  // 12 chars per line → ceil(67/12) = 6; 109/8.5 = 12 → ceil(57/12) = 5. A two-point fit is thin,
  // which is why the assertion below reports the arithmetic instead of just failing: a longer hint
  // does not necessarily break the tile, it breaks the LAST MEASUREMENT, and someone has to look.
  const PX_PER_CHAR = 8.5;
  const perLine = Math.round(box / PX_PER_CHAR);
  assert.ok(perLine > 0, "a hint box with room for no characters");

  const over = hintStrings()
    .map((h) => ({ ...h, need: Math.ceil(h.text.length / perLine) }))
    .filter((h) => h.need > clamp)
    .sort((a, b) => b.need - a.need);

  assert.deepEqual(
    over,
    [],
    `these hints need more than the ${clamp} lines the tile shows at its narrowest (${box}px box, ` +
      `~${perLine} characters per line):\n` +
      over.map((h) => `  ${h.key}: ${h.text.length} chars → ${h.need} lines — "${h.text}"`).join("\n") +
      "\nThis is the defect V173 fixed: a hint that does not fit is not shortened, it is CUT, and the " +
      "tile stops saying what it does. Either shorten the string (the four purpose-written " +
      "`more.*Hint` values are 24..39 characters — the outlier is the Mini Apps tile reusing the " +
      "page subtitle) or re-measure the clamp in a browser and move it here with the numbers.",
  );
});

test("V173: the narrow-phone escape hatch still outweighs the clamp", () => {
  // styles.css lifts the clamp below 361 px, where even six lines are not enough. It only works
  // because of the `:root` prefix: redesign.css is imported AFTER styles.css, so with equal
  // specificity the clamp would win and narrow phones would silently go back to cut sentences.
  const styles = strip(read("../../web/src/styles.css"));
  const media = /@media\s*\(max-width:\s*360px\)\s*\{([\s\S]*?)\n\}/.exec(styles);
  assert.ok(media, "styles.css no longer carries the (max-width: 360px) block that lifts the hint clamp");

  const body = media![1]!;
  const rule = /(:root[\s\S]*?\.gc-more-tile-hint)\s*\{([^}]*)\}/.exec(body);
  assert.ok(
    rule,
    "the ≤360px override of .gc-more-tile-hint lost its `:root` prefix. redesign.css loads later, so " +
      "without the extra specificity the six-line clamp wins and the narrowest phones cut their " +
      "service tiles again — exactly the defect V173 fixed one band higher.",
  );
  assert.match(rule![2]!, /-webkit-line-clamp:\s*none/, "the ≤360px override must remove the bound, not resize it");
  assert.match(rule![1]!, /\.gc-more-tile-hint$/, "the override must still target the hint itself");
});

test("V173: the enlarged-system-font path still lifts the clamp too", () => {
  // The sibling repair, from an earlier cycle. At text zoom the hint font grows but the tile does
  // not, so a bounded box is guaranteed to cut. Same specificity trick, same silent failure mode.
  const styles = strip(read("../../web/src/styles.css"));
  const rule = /:root\[data-gc-text-zoom\][\s\S]{0,200}?\.gc-more-tile-hint\s*\{([^}]*)\}/.exec(styles);
  assert.ok(rule, "styles.css no longer lifts the hint clamp for enlarged system fonts");
  assert.match(rule![1]!, /-webkit-line-clamp:\s*none/, "text zoom must remove the bound");
});

test("V173: every service tile hint exists in both dictionaries", () => {
  // A missing key falls back to the OTHER locale, so the failure mode is silent: a Russian phone
  // printing an English sentence under a Russian label. i18n.test.ts asserts no such parity.
  const keys = [...new Set(
    [...Object.keys(en), ...Object.keys(ru)].filter((k) => /^more\.[a-zA-Z]+Hint$/.test(k)),
  )].sort();
  assert.ok(keys.length >= 4, `only ${keys.length} more.*Hint keys — has the tile list moved?`);
  for (const key of keys) {
    for (const [name, dict] of [["en", en], ["ru", ru]] as const) {
      const value = (dict as Record<string, string>)[key];
      assert.ok(value && value.trim().length > 0, `${name} is missing the service tile hint ${key}`);
    }
  }
  for (const locale of ["en", "ru"] as const) {
    assert.ok(
      miniAppsText(locale, "subtitle").trim().length > 0,
      `${locale} mini-apps subtitle is empty — it is painted as a tile hint on «Ещё»`,
    );
  }
});
