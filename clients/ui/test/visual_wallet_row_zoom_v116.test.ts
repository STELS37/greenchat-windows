// clients/ui/test/visual_wallet_row_zoom_v116.test.ts — V116: at an enlarged system font the wallet
// row stopped saying what the operation was and when it happened.
//
// The row is a grid: `38px minmax(0, 1fr) auto`. The third track is the amount and takes whatever the
// number needs; the middle track carries the title and the timestamp and absorbs the whole shortfall.
// Measured on the signed direct APK through the device WebView (redroid Android 15, dedicated device
// 127.0.0.1:5556 pinned to HEAD by var/ux-audit/tools/build_guard.sh, route #/wallet, ru-RU,
// 2026-07-31) with «0.000167 tBTC» in the amount column (175 px at font_scale 2.0):
//
//   320 dp, font 2.0   title box  17 px, needs  93   time box  17 px, needs 156
//   393 dp, font 2.0   title box  91 px, needs  93   time box  91 px, needs 156 (capped 35vw=137.6)
//   430 dp, font 2.0   title box 128 px, needs 128   time box 128 px, needs 156
//   320 dp, font 1.3   title box  79 px, needs  79   time box  79 px, needs 101
//
// The fix is graded because two different sizes fail differently: any enlarged font lets the middle
// column wrap, and the LARGEST font additionally moves the amount to its own grid row (at 320 dp the
// column is 17 px, where wrapping alone produced a 640 px stack of single characters). Verified live
// by injecting exactly these rules: every clipped element went to FULL; row 107 -> 195 px at 2.0 on
// 320/393/430 dp, 79 -> 102 px for the single clipped row at 1.3, and byte-identical geometry at the
// default font.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Comments are stripped first: this file's own rationale quotes the selectors and the declarations it
// asserts on, and a scan that reads prose would pass on a stylesheet that lost the rule.
const css = readFileSync(
  new URL("../../web/src/styles.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The last rule whose selector mentions `needle`, split into selector and declarations. */
function ruleWith(source: string, needle: string): { selector: string; body: string } {
  const idx = source.lastIndexOf(needle);
  assert.notEqual(idx, -1, `stylesheet must still contain ${needle}`);
  const open = source.indexOf("{", idx);
  assert.notEqual(open, -1, `${needle} must have a declaration block`);
  const afterComment = source.lastIndexOf("*/", idx);
  const afterRule = source.lastIndexOf("}", idx);
  const start = Math.max(afterComment === -1 ? 0 : afterComment + 2, afterRule + 1);
  const close = source.indexOf("}", open);
  return {
    selector: source.slice(start, open).trim(),
    body: source.slice(open + 1, close),
  };
}

test("V116: the default wallet row is untouched — one line, ellipsis, amount in its own track", () => {
  const base = ruleWith(css, ".gc-finance-row-main span,");
  assert.match(
    base.body,
    /white-space:\s*nowrap/,
    "a device left at the default font must keep the single-line secondary line",
  );
  assert.match(
    base.body,
    /text-overflow:\s*ellipsis/,
    "a device left at the default font must keep the ellipsis",
  );
  const grid = ruleWith(css, "grid-template-columns: 38px minmax(0, 1fr) auto");
  assert.doesNotMatch(
    grid.selector,
    /data-gc-text-zoom/,
    "the three-track grid must remain the default phone layout",
  );
});

test("V116: an enlarged system font lets the operation title and its timestamp wrap", () => {
  const zoomed = ruleWith(css, ".gc-finance-row-main > span");
  assert.match(
    zoomed.selector,
    /:root\[data-gc-text-zoom\]/,
    "the wrap must be selected by the system font, not by the viewport",
  );
  assert.doesNotMatch(
    zoomed.selector,
    /data-gc-text-zoom="large"/,
    "font_scale 1.3 already cut the timestamp, so the wrap must not wait for the largest font",
  );
  assert.match(zoomed.body, /white-space:\s*normal/, "the line must be allowed to wrap");
  assert.match(
    zoomed.body,
    /overflow:\s*visible/,
    "a hidden overflow keeps swallowing the tail once wrapping is allowed",
  );
  assert.match(
    zoomed.body,
    /text-overflow:\s*clip/,
    "the ellipsis must stop replacing the end of the text",
  );
  assert.match(
    zoomed.body,
    /overflow-wrap:\s*anywhere/,
    "«31 июл., 15:22» in a 79 px column has no usable word break",
  );
  assert.match(
    zoomed.body,
    /max-width:\s*none/,
    "the 35vw cap is a share of the screen and does not grow with the text",
  );
});

test("V116: at the largest system font the amount moves to its own row so the middle column survives", () => {
  const stacked = ruleWith(css, "grid-template-columns: 38px minmax(0, 1fr);");
  assert.match(
    stacked.selector,
    /:root\[data-gc-text-zoom="large"\]/,
    "stacking costs 88 px of height, so it is spent only where wrapping alone failed (17 px column)",
  );
  assert.ok(
    stacked.selector.includes(".gc-finance-row"),
    "the stacked layout must apply to the wallet row itself",
  );
  const placed = ruleWith(css, ".gc-finance-row > .gc-finance-row-value");
  assert.match(
    placed.selector,
    /:root\[data-gc-text-zoom="large"\]/,
    "the amount is re-placed only in the same stacked layout",
  );
  assert.match(
    placed.body,
    /grid-column:\s*2/,
    "the amount must land under the title, in the wide track — not next to the icon",
  );
});
