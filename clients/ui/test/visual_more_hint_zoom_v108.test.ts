// clients/ui/test/visual_more_hint_zoom_v108.test.ts — V108: the services hints on "Ещё" were cut
// in half by a two-line clamp the enlarged system font made impossible to satisfy.
//
// Evidence (emulator redroid Android 15, `wm density 540` = 320 dp, `settings put system font_scale
// 2.0`, ru-RU, signed direct APK, CDP against the device WebView, 2026-07-31):
//
//   span.gc-more-tile-hint  box 250x65  needs 97 (3 lines)  clamp=2  overflow=hidden  lh=32.4px
//     "Написать команде и посмотреть обращения"  ->  rendered "Написать команде и посмотреть обраще…"
//   span.gc-more-tile-hint  box 198x65  needs 97 (3 lines)
//     "Адрес узла и проверка соединения"         ->  last word lost
//
// The clamp is not load-bearing at this size: V100 already collapses the grid to ONE column when the
// system font is enlarged, its rows are `auto`, and the two neighbouring tiles measured 188 px and
// 172 px tall — equal height is not preserved anyway. Lifting the clamp only while the system font
// is enlarged leaves the default layout byte-identical. Verified live by injecting exactly this rule
// on the device: /more went from two clipped hints to `clean`.
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

/** The declaration block of the last rule whose selector list mentions `sel`. */
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

test("V108/V173: the default layout keeps the clamp BOUNDED (the value moved to V173)", () => {
  // This test used to demand the literal `2`, and that literal was wrong. V108 measured font_scale
  // 2.0 and V112 measured 320 dp; both then asserted that the ordinary phone — 390 dp, font_scale 1
  // — "renders exactly as before", which nobody had measured. It did not render acceptably: at 390
  // dp the hint box is 144 px and the Mini Apps sentence needs four lines, so two of the five
  // service tiles printed «Сервисы внутри GreenChat без…» and «Написать команде и посмотреть…».
  // V173 measured the whole band the clamp actually governs (361..1400 px, both dictionaries, one
  // pixel at a time) and moved the bound to six, so the VALUE now lives in
  // visual_more_tile_hint_v173.test.ts, where it is recomputed from the grid track and the shipped
  // strings instead of being frozen as a digit.
  //
  // What V108 still owns is the invariant it was really protecting, and which V173 does not repeat:
  // the default layout must keep a BOUND at all. Without one, a single long hint stretches its grid
  // row, and `align-items: stretch` stretches every tile in that row with it.
  const hintIdx = redesign.indexOf(".gc-more-tile-hint");
  assert.notEqual(
    hintIdx,
    -1,
    "redesign.css must still style .gc-more-tile-hint",
  );
  const open = redesign.indexOf("{", hintIdx);
  const base = redesign.slice(open + 1, redesign.indexOf("}", open));
  const clamp = /-webkit-line-clamp:\s*([^;]+);/.exec(base);
  assert.ok(clamp, "the untouched (font_scale 1) tile hint must still declare a line clamp");
  assert.match(
    clamp![1]!.trim(),
    /^\d+$/,
    "the default clamp must stay a finite number of lines — `none` here would let one hint " +
      "stretch its whole grid row. V173 owns which number it is.",
  );
});

test("V108: an enlarged system font lifts the clamp instead of cutting the sentence", () => {
  const zoomed = lastBlockFor(css, ".gc-more-tile-hint");
  assert.match(
    zoomed,
    /-webkit-line-clamp:\s*none/,
    "the enlarged-font rule must lift the clamp",
  );
  assert.match(
    zoomed,
    /display:\s*block/,
    "-webkit-box keeps clamping; the box must become a normal block",
  );
});

test("V108/V112: every lift of the clamp is scoped, so a default phone renders exactly as before", () => {
  // V112 added a SECOND lift: the same sentence was measured cut at 320 dp with the system font
  // untouched (105 px hint box, four lines needed, two given), so the clamp is lifted below 360 px
  // as well. The invariant V108 pinned is therefore stated over ALL lifts rather than over the last
  // rule in the file: each one must be scoped either to the measured system-font attribute or to a
  // narrow-viewport media query. A 390 dp phone at font_scale 1 must match neither — and that is
  // still the claim being tested here, but note what V173 later found: matching neither is not the
  // same as being CORRECT. The default phone matched neither and was cut all the same, because the
  // number it fell through to had never been measured. Scoping is a containment property, not a
  // fitness one; V173 supplies the fitness half.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ""); // prose mentions the class too
  const rules = [
    ...bare.matchAll(/([^{}]*\.gc-more-tile-hint[^{}]*)\{([^}]*)\}/g),
  ];
  const lifts = rules.filter((r) => /-webkit-line-clamp:\s*none/.test(r[2]));
  assert.ok(
    lifts.length >= 1,
    "styles.css must still lift the clamp somewhere",
  );
  for (const lift of lifts) {
    const selector = lift[1];
    const context = bare.slice(
      Math.max(0, (lift.index ?? 0) - 200),
      lift.index ?? 0,
    );
    const scoped =
      /\[data-gc-text-zoom\]/.test(selector) ||
      /@media\s*\(max-width:\s*3[0-5]\d px\)|@media\s*\(max-width:\s*360px\)/.test(
        context,
      );
    assert.ok(
      scoped,
      `an unscoped clamp lift would change the default phone: ${selector.trim().slice(0, 120)}`,
    );
  }
});
