// clients/ui/test/visual_balance_fit_v101.test.ts — V101: the wallet headline balance was broken
// between two digits (owner pre-beta P0-5: "клавиатура, safe area, поворот, системный масштаб
// шрифта и экраны 320/390/430 px").
//
// Evidence (signed direct APK app.greenchat versionCode 1000011 — the artifact the update manifest
// actually serves — on redroid 15, 1080x2400, raw CDP against the device WebView, route #/wallet,
// pristine page after `am force-stop`; each visual line reconstructed character by character from
// Range rects, so the breaks below are read off the screen, not inferred, 2026-07-31):
//
//   wm density   width   font_scale   .gc-finance-total painted as
//   540          320 dp  1.0          "5 880 859.2" / "4 USD"
//   540          320 dp  1.3          "5 881 45"    / "3.24 USD"
//   540          320 dp  1.5          "5 882 0" / "47.24" / "USD"
//   540          320 dp  2.0          "5 882" / "641.2" / "4 USD"
//   440          390 dp  1.5          "5 883 829." / "24 USD"
//   440          390 dp  2.0          "5 883 8" / "29.24" / "USD"
//   402          430 dp  2.0          "5 885 61" / "1.24 USD"
//
// At 320 dp it happened with NO accessibility setting touched. The cause was `overflow-wrap:
// anywhere` on a fixed 34px headline: the amount is one visual word, so the browser was licensed to
// break it anywhere once it outgrew its box.
//
// What is pinned here: the amount is unbreakable in CSS, and the fitter that replaces the break is
// arithmetically incapable of leaving an overflow — it floors, it never rounds up, it refuses to
// scale on an unmeasured element, and it never grows text that already fits (a wallet on a wide
// screen must render byte-identically to before this existed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fitZoom, FIT_MIN_ZOOM } from "../src/fit_width.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8");
const financeScreen = readFileSync(
  resolve(here, "../src/screens/finance_screen.ts"),
  "utf8",
);

/** The last declaration for a selector is the one that ships (equal specificity, source order). */
function lastBlock(selector: string): string {
  const parts = css.split(new RegExp(`(?:^|\\n)${selector}\\s*\\{`));
  assert.ok(parts.length > 1, `${selector} is not declared at all`);
  const tail = parts[parts.length - 1] ?? "";
  return tail.slice(0, tail.indexOf("}"));
}

test("the headline balance may not break between two digits", () => {
  const block = lastBlock("\\.gc-finance-total");
  assert.match(block, /white-space:\s*nowrap/);
  assert.match(block, /overflow-wrap:\s*normal/);
  assert.match(block, /word-break:\s*keep-all/);
  // The measured defect was literally `overflow-wrap: anywhere` winning the cascade.
  assert.doesNotMatch(block, /overflow-wrap:\s*anywhere/);
  // Last resort when even the floor cannot fit the amount: an ellipsis, not a sliced digit.
  assert.match(block, /text-overflow:\s*ellipsis/);
});

test("a fitted line can never overflow: the factor is floored, never rounded up", () => {
  // 254 px box, 300 px of digits (the measured 390 dp @1.5 case, rounded): 0.846… must not become
  // 0.85, which would still paint 255 px into a 254 px box.
  const z = fitZoom(300, 254);
  assert.ok(z * 300 <= 254, `${z} * 300 = ${z * 300} must fit in 254`);
  assert.equal(z, 0.84);
});

test("text that already fits is never touched, so a wide screen renders as before", () => {
  assert.equal(fitZoom(180, 254), 1);
  assert.equal(fitZoom(254, 254), 1);
});

test("an element with no box is not scaled on a guess", () => {
  assert.equal(fitZoom(300, 0), 1);
  assert.equal(fitZoom(0, 254), 1);
  assert.equal(fitZoom(Number.NaN, 254), 1);
  assert.equal(fitZoom(300, Number.NaN), 1);
});

test("the shrink stops at a readable floor instead of vanishing", () => {
  // A pathological amount: 10x the box. Without a floor the headline would render at 3px.
  assert.equal(fitZoom(2540, 254), FIT_MIN_ZOOM);
  assert.ok(FIT_MIN_ZOOM >= 0.35 && FIT_MIN_ZOOM <= 0.6);
  // The system-font worst case measured on the device (2.0 at 320 dp) must still be inside range.
  assert.ok(fitZoom(400, 180) > FIT_MIN_ZOOM);
});

test("the column holding the balance is allowed to shrink below the amount", () => {
  // Second half of the same defect, measured on the same signed APK (1000011, 390 dp, font 2.0):
  // making the amount unbreakable moved its min-content width from "one digit" to "the whole
  // string", and a flex item defaults to `min-width: auto` — so instead of wrapping, the column
  // grew to 525 px and pushed the balance 191 px past the card, off a 391 px screen. A/B on the
  // device: with the rule injected the same line measured 252 px and sat inside the card. Without
  // this declaration the nowrap rules above turn a wrapped number into a cut-off one.
  const block = lastBlock("\\.gc-finance-summary-top > \\*");
  assert.match(block, /min-width:\s*0/);
});

test("the wallet actually wires the fitter, and releases it on destroy", () => {
  assert.match(financeScreen, /createWidthFitter/);
  assert.match(financeScreen, /fitter\.track\(totalLine\)/);
  // A screen that keeps a resize listener after destroy leaks one per wallet visit.
  const destroy = financeScreen.slice(financeScreen.lastIndexOf("destroy() {"));
  assert.match(destroy, /fitter\.destroy\(\)/);
});
