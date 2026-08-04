// clients/ui/test/visual_balance_currency_v102.test.ts — V102: the fitted balance lost its currency
// (owner pre-beta P0-5: "клавиатура, safe area, поворот, системный масштаб шрифта и экраны
// 320/390/430 px").
//
// Evidence (signed direct APK app.greenchat versionCode 1000012 on redroid 15, 1080x2400, raw CDP
// against the device WebView, route #/wallet, pristine page after `am force-stop`, 2026-07-31):
//
//   wm density   width   font_scale   .gc-finance-total painted as
//   540          320 dp  2.0          "6 126 775.24…"      <- amount cut, "USD" gone
//   540          320 dp  1.0          "6 120 241.24 USD"   (one row, zoom 0.72 — fine)
//   440          390 dp  2.0          "6 122 023.24 USD"   (one row, zoom 0.48 — fine)
//
// V101 made the amount unbreakable and scales it to a 0.40 floor with an ellipsis as the last
// resort. At 320 dp / font 2.0 the amount needs ~0.34 of its box, so the last resort fired and ate
// the currency: a wallet headline that does not say which currency it is showing.
//
// What is pinned here: the line is built from two segments (amount, currency), each unbreakable on
// its own; the wrap between them is a MEASURED fallback that only fires when even the floor cannot
// fit one row; and the one-row behaviour of every screen that already fits is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fitPlan, FIT_MIN_ZOOM } from "../src/fit_width.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8");
const financeScreen = readFileSync(
  resolve(here, "../src/screens/finance_screen.ts"),
  "utf8",
);
const fitWidth = readFileSync(resolve(here, "../src/fit_width.ts"), "utf8");

function block(selector: string): string {
  const parts = css.split(new RegExp(`(?:^|\\n)${selector}\\s*\\{`));
  assert.ok(parts.length > 1, `${selector} is not declared at all`);
  const tail = parts[parts.length - 1] ?? "";
  return tail.slice(0, tail.indexOf("}"));
}

test("the headline is two segments, so the currency can move instead of vanishing", () => {
  assert.match(financeScreen, /class:\s*"gc-finance-total-amount"/);
  assert.match(financeScreen, /class:\s*"gc-finance-total-cur"/);
  // The old single-string form is what produced "6 126 775.24…".
  assert.doesNotMatch(financeScreen, /gc-finance-total"\s*\},\s*\[\s*`\$\{money/);
});

test("each segment stays unbreakable, so no digit is ever split by the wrap", () => {
  const seg = block("\\.gc-finance-total-amount,\\n\\.gc-finance-total-cur");
  assert.match(seg, /white-space:\s*nowrap/);
  assert.match(seg, /word-break:\s*keep-all/);
  assert.match(seg, /overflow-wrap:\s*normal/);
});

test("the wrapped state breaks only between the segments", () => {
  const wrapped = block("\\.gc-finance-total\\.is-wrapped");
  assert.match(wrapped, /white-space:\s*normal/);
  // A two-row line cannot show an ellipsis; hiding the overflow would cut the second row silently.
  assert.match(wrapped, /overflow:\s*visible/);
});

test("a line that fits on one row is never wrapped (wide screens render as before)", () => {
  assert.deepEqual(fitPlan(180, 254, 120), { factor: 1, wrap: false });
  // 390 dp @2.0, measured: scales to 0.48 on one row, well above the floor.
  const p = fitPlan(525, 252, 400);
  assert.equal(p.wrap, false);
  assert.ok(p.factor > FIT_MIN_ZOOM);
});

test("the wrap fires exactly when even the floor cannot fit the row", () => {
  // 320 dp @2.0, measured: the whole row needs 525 px in a 180 px box (0.34 < 0.40 floor), while
  // the amount alone needs 394 px -> 0.45, above the floor. So: wrap, and a bigger amount.
  const p = fitPlan(525, 180, 394);
  assert.equal(p.wrap, true);
  assert.ok(p.factor > FIT_MIN_ZOOM, `${p.factor} must beat the floor`);
  assert.ok(p.factor * 394 <= 180, "the wrapped amount must still fit its box");
});

test("wrapping is not offered when it cannot help", () => {
  // One segment as wide as the whole line (no currency suffix, or a single huge number): wrapping
  // would change nothing, so the floor + ellipsis path is kept.
  assert.deepEqual(fitPlan(2540, 254, 2540), { factor: FIT_MIN_ZOOM, wrap: false });
  assert.deepEqual(fitPlan(2540, 254, 0), { factor: FIT_MIN_ZOOM, wrap: false });
  // …and a wrap that still cannot fit lands on the floor rather than vanishing.
  assert.equal(fitPlan(3000, 100, 2000).factor, FIT_MIN_ZOOM);
});

test("the fitter re-measures from a clean state, or the second pass lies", () => {
  const fn = fitWidth.slice(fitWidth.indexOf("export function fitSegmentedLine"));
  // A leftover zoom makes scrollWidth incomparable; a leftover wrap reports the ROW width, so an
  // overflowing line would measure as fitting and stay wrapped forever.
  assert.match(fn, /style\.zoom = "1"/);
  assert.match(fn, /remove\("is-wrapped"\)/);
});

test("the fixed-slot tab labels are fitted too, and released on destroy", () => {
  // Measured on the same device pass: `.gc-tab-label` "Archived" was 97 px of text inside a 75 px
  // box (320 dp, system font 2.0) with `overflow: visible`, so the word was painted through the
  // tab's edge and read "Archive". Both tab strips carry the same label element.
  const chatList = readFileSync(
    resolve(here, "../src/screens/chat_list_screen.ts"),
    "utf8",
  );
  const calls = readFileSync(resolve(here, "../src/screens/calls_screen.ts"), "utf8");
  for (const [name, src] of [
    ["chat_list_screen", chatList],
    ["calls_screen", calls],
  ] as const) {
    assert.match(src, /createWidthFitter/, `${name} must fit its tab labels`);
    assert.match(src, /tabFitter\.track\(/, `${name} must track the label`);
    assert.match(src, /tabFitter\.destroy\(\)/, `${name} leaks a resize listener`);
  }
});

test("a target handed in before its screen is mounted is still fitted", () => {
  // The wallet tracks after render; a tab strip is built before the screen is attached, so
  // clientWidth is 0 at track() time and fitZoom correctly refuses to guess. Without a retry the
  // label would stay unfitted until a resize that may never come on a phone.
  assert.match(fitWidth, /requestAnimationFrame/);
  assert.match(fitWidth, /clientWidth === 0/);
});
