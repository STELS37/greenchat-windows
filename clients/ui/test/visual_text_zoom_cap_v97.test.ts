// clients/ui/test/visual_text_zoom_cap_v97.test.ts — V97: a cap that the browser refused to apply.
//
// Evidence (emulator redroid 15, 1080x2400 @440dpi, signed direct APK app.greenchat versionCode
// 1000010, CDP against the device WebView, pristine page after `am force-stop`, 2026-07-31):
//
//   settings put system font_scale 2.0
//     .gc-shell-item-label declared `font-size: calc(14px / 2)` = 7px  -> computed 16px, lh 20.8px
//     320 / 390 / 430 dp   every label   19px box vs 21px needed       -> cut top and bottom
//     320 dp               "Exchange"    53px box vs 69px needed       -> "Exch…"
//     wallet tile          "Addresses"   wrapped, second line sliced by the tile edge
//   settings put system font_scale 1.3
//     320 dp               "Exchange"    53px box vs 68px needed       -> "Exch…"
//
// Chromium clamps a computed font size up to `WebSettings.getMinimumFontSize()` (8px by default)
// and applies the system multiplier AFTER that clamp, so 7 -> 8 -> 16: no font-size arithmetic can
// undo the multiplier. `zoom` is applied to the element box instead and is not clamped. Measured
// with the identical probe in the same session at font_scale 2.0, 320 dp: "Exchange" 95x24 in a
// 95x25 box — no vertical cut, no ellipsis, the bar reads "Chats Calls Wallet Exchange More".
//
// The test is structural on purpose: the pixels above are the measurement, this guards the shape
// of the correction so the clamped-arithmetic version cannot come back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { textZoomLevel, TEXT_ZOOM_MEDIUM } from "../src/text_zoom.ts";

const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

/** The declaration block of the last rule whose selector list mentions `sel`. */
function blockFor(sel: string): string {
  const idx = css.lastIndexOf(sel);
  assert.notEqual(idx, -1, `styles.css must still style ${sel}`);
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `${sel} must have a declaration block`);
  return css.slice(open + 1, close);
}

/** Every rule that caps a fixed-size chrome surface against the system font multiplier. */
const CAPPED_SURFACES = [
  ":root[data-gc-text-zoom] .gc-shell-item-label",
  ":root[data-gc-text-zoom] .gc-finance-action-label",
];

test("V97: the cap divides the box, not the font size — the font size is clamped by the engine", () => {
  for (const sel of CAPPED_SURFACES) {
    const body = blockFor(sel);
    assert.match(
      body,
      /zoom:\s*calc\(\s*1\s*\/\s*var\(--gc-sys-text-zoom,\s*1\)\s*\)/,
      `${sel} must undo the system multiplier with zoom`,
    );
    assert.doesNotMatch(
      body,
      /font-size:\s*calc\([^)]*\/\s*var\(--gc-sys-text-zoom/,
      `${sel} must not divide font-size: 14/2 = 7px is clamped back up to 8px and multiplied to 16px`,
    );
  }
});

test("V97: no declared font-size, so the responsive token for the width still wins", () => {
  // The bottom bar label is 12px normally and 11px below 380px. A font-size inside the cap would
  // override both and re-break the 320 dp phone the cap exists for.
  for (const sel of CAPPED_SURFACES) {
    assert.doesNotMatch(blockFor(sel), /font-size:/, `${sel} must leave font-size to the cascade`);
  }
});

test("V97: the bar is capped from the first enlarged step, because 1.3 already truncated it", () => {
  // Measured: at font_scale 1.3 on a 320 dp screen "Exchange" needed 68px in a 53px cell. Gating
  // the bar on `large` (1.4) would have left that device truncated.
  assert.equal(textZoomLevel(1.3), "medium");
  assert.ok(TEXT_ZOOM_MEDIUM <= 1.3);
  const barRule = css.slice(0, css.lastIndexOf(":root[data-gc-text-zoom] .gc-shell-item-label"));
  assert.doesNotMatch(
    barRule.slice(barRule.lastIndexOf("/* P0-5")),
    /\[data-gc-text-zoom="large"\][^{]*\.gc-shell-item-label/,
    "the bottom bar cap must not be gated on the `large` level any more",
  );
});

test("V97: a device at the default font size is untouched", () => {
  // No attribute is published below 1.15, and every capped rule is gated on the attribute.
  assert.equal(textZoomLevel(1), null);
  assert.equal(textZoomLevel(1.14), null);
  for (const sel of CAPPED_SURFACES) {
    assert.ok(css.includes(sel), `${sel} must stay gated on the published attribute`);
  }
});
