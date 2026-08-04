// clients/ui/test/visual_market_row_zoom_v117.test.ts — V117: at an enlarged system font the exchange
// list stopped naming the market it was listing.
//
// On a phone the row is `grid-template-columns: minmax(0, 1fr) auto` and `.gc-market-price` is capped
// at `42vw` — a share of the screen, not of the text. The price track therefore takes a fixed slice
// and the pair track (the pair id and its trading status) absorbs the whole shortfall. Measured on
// the signed direct APK through the device WebView (redroid Android 15, dedicated device
// 127.0.0.1:5556, route #/exchange, ru-RU, 2026-07-31), need/have in px:
//
//   320 dp, font 2.0   «tBTC/tUSDT» 163/61 -> «tB…», «Торги открыты» 170/61, «Сделок…» 187/134
//   393 dp, font 2.0   163/104, 170/104, 187/165        (165 px is exactly the 42vw cap)
//   430 dp, font 2.0   163/125, 170/125, 187/181
//   320 dp, font 1.3   106/74, 111/74                   (the price column still fits at this step)
//   430 dp, font 1.3   nothing clipped
//
// Graded like V116. Any enlarged font lets both columns wrap and drops the vw cap; the LARGEST font
// additionally moves the price to its own grid row, because wrapping alone still leaves the pair
// 61 px on a 320 dp phone. Verified live by injecting exactly these rules — clipped elements before
// -> after: 320/2.0 6 -> 0 (row 107 -> 193 px), 393/2.0 6 -> 0, 430/2.0 6 -> 0, 320/1.3 4 -> 0 (row
// 79 -> 131 px, tracks unchanged). At the default font the row is identical before and after.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Comments are stripped first: this file's own rationale quotes the selectors and declarations it
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
  const afterRule = source.lastIndexOf("}", idx);
  const afterOpen = source.lastIndexOf("{", idx);
  const start = Math.max(afterRule + 1, afterOpen + 1);
  const close = source.indexOf("}", open);
  return {
    selector: source.slice(start, open).trim(),
    body: source.slice(open + 1, close),
  };
}

test("V117: the default exchange row is untouched — two tracks, one line, ellipsis", () => {
  const base = ruleWith(css, "grid-template-columns: minmax(0, 1fr) auto;");
  assert.doesNotMatch(
    base.selector,
    /data-gc-text-zoom/,
    "the two-track phone grid must remain the default layout",
  );
  const cap = ruleWith(css, ".gc-market-price {");
  assert.ok(
    /max-width:\s*42vw/.test(cap.body) || !/max-width/.test(cap.body),
    "the default phone cap is the measured baseline; changing it silently changes the default render",
  );
  const line = ruleWith(css, ".gc-market-pair strong,");
  assert.match(
    line.body,
    /white-space:\s*nowrap/,
    "a device left at the default font must keep the single-line pair id",
  );
});

test("V117: an enlarged system font lets the pair id and its status wrap", () => {
  const zoomed = ruleWith(css, ":is(.gc-market-pair, .gc-market-price) :is(strong, span)");
  assert.match(
    zoomed.selector,
    /:root\[data-gc-text-zoom\]/,
    "the wrap must be selected by the system font, not by the viewport",
  );
  assert.doesNotMatch(
    zoomed.selector,
    /data-gc-text-zoom="large"/,
    "font_scale 1.3 already cut the pair id at 320 dp, so the wrap must not wait for the largest font",
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
    "«tBTC/tUSDT» has no word break a 61 px box can use",
  );
  assert.match(
    zoomed.body,
    /max-width:\s*none/,
    "the 42vw cap is a share of the screen and does not grow with the text",
  );
});

test("V117: at the largest system font the price moves to its own row so the pair id survives", () => {
  const stacked = ruleWith(css, "grid-template-columns: minmax(0, 1fr);");
  assert.match(
    stacked.selector,
    /:root\[data-gc-text-zoom="large"\]/,
    "stacking costs 86 px of height, so it is spent only where wrapping alone failed (61 px column)",
  );
  assert.ok(
    stacked.selector.includes(".gc-market-row"),
    "the stacked layout must apply to the exchange row itself",
  );
  const placed = ruleWith(css, ".gc-market-row > .gc-market-price");
  assert.match(
    placed.selector,
    /:root\[data-gc-text-zoom="large"\]/,
    "the price is re-placed only in the same stacked layout",
  );
  assert.match(
    placed.body,
    /grid-column:\s*1/,
    "with a single track the price must occupy it, not create a phantom second column",
  );
  // The stacked layout was measured on 320/393/430 dp phones; wide screens keep their three-track
  // row, which has room for the state pill the phone layout hides.
  const idx = css.lastIndexOf("grid-template-columns: minmax(0, 1fr);");
  const media = css.lastIndexOf("@media", idx);
  assert.notEqual(media, -1, "the stacked layout must sit inside a breakpoint");
  assert.match(
    css.slice(media, css.indexOf("{", media)),
    /max-width:\s*760px/,
    "only the phone breakpoint defines the two-track row this rule re-flows",
  );
});
