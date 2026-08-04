// clients/ui/test/visual_chat_row_rhythm_v143.test.ts — V143: at the largest system font a chat row's
// content (87 px) no longer fits the row's pinned box (72 px).
//
// Measured on the signed artifact in the device WebView (redroid 15, `settings put system font_scale`,
// viewport forced through Emulation.setDeviceMetricsOverride), widths 320/360/393/412:
//
//   font 2.0, conversation list -> gap name->its own preview 5 px, gap preview->NEXT name 0 px.
//                                  Proximity is inverted: a preview reads as belonging to the chat
//                                  BELOW it, and the hairline separator is the only thing between two
//                                  different conversations.
//   font 2.0, "New chat" overlay -> those rows are not virtualised, nothing overrides the 72 px, and
//                                  two people's rows overlap by 14 px (textGap -14, overflow 7 px).
//   font 1.3 -> 14 px between rows vs 5 px inside a row, 0 overflow. Correct already; the gate must
//               therefore be "large" (>= 1.4) and not "any enlarged font".
//   font 1.0 -> 25 px between rows vs 7 px inside a row.
//
// `box-sizing: border-box` is global, so padding on a FIXED height would have shrunk the content box
// and made the overflow worse; the row must be allowed to grow (`height: auto` + `min-height`). The
// list virtualiser re-measures the row with `height:auto` (chatRowHeight -> refreshItemHeight), so it
// follows to 103 px by itself — checked on the device (inline height 103 px), not assumed.
//
// After the fix: list 16 px between rows vs 5 px inside; overlay textGap +16 and 0 overflow; zero-cost
// control 183 boxes x {320, 393} x {font 1.0, font 1.3} = 0 boxes moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../web/src/redesign.css", import.meta.url), "utf8");

/** The declaration block that follows the FIRST mention of `sel`. */
function blockFor(source: string, sel: string): string {
  const idx = source.indexOf(sel);
  assert.ok(idx > 0, `selector not found: ${sel}`);
  const open = source.indexOf("{", idx);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

const SCOPE =
  '[data-gc-text-zoom="large"] :is(.gc-superapp, .gc-overlay, .gc-palette-overlay, .gc-msgmenu-layer)';

test("V143: at the largest system font a chat row may grow past the designed 72px", () => {
  const row = blockFor(css, `${SCOPE} .gc-chat-row {`);
  assert.match(row, /height:\s*auto/);
  assert.match(row, /min-height:\s*72px/);
});

test("V143: the grown row separates neighbours with real vertical space", () => {
  const row = blockFor(css, `${SCOPE} .gc-chat-row {`);
  assert.match(row, /padding-block:\s*\d+px/);
});

test("V143: padding is never applied to a still-pinned height", () => {
  // border-box is global: padding on `height: 72px` would shrink the content box and deepen the
  // overflow instead of curing it. The two declarations must live in the same block.
  const row = blockFor(css, `${SCOPE} .gc-chat-row {`);
  assert.ok(/padding-block/.test(row) && /height:\s*auto/.test(row), `padding without height:auto: ${row}`);
});

test("V143: the base rule still pins 72px for everyone else", () => {
  const base = blockFor(css, ":is(.gc-superapp, .gc-overlay, .gc-palette-overlay, .gc-msgmenu-layer) .gc-chat-row {");
  assert.match(base, /height:\s*72px/);
});

test("V143: the rule cannot reach fonts that do not need it", () => {
  // text_zoom.ts publishes `large` only from factor 1.4; at 1.0 the attribute is absent and at 1.3 it
  // is `medium`, where the measurement showed the row is still correct.
  for (const line of css.split("\n")) {
    if (!line.includes(".gc-chat-row") || !line.includes("min-height: 72px")) continue;
    assert.ok(line.startsWith('[data-gc-text-zoom="large"]'), `ungated V143 rule: ${line}`);
  }
});
