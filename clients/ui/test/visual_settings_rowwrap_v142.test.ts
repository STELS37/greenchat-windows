// clients/ui/test/visual_settings_rowwrap_v142.test.ts — V142: at an enlarged system font the label
// of a settings row was painted ON TOP of that row's value.
//
// Measured on the signed artifact in the device WebView (redroid 15, `settings put system font_scale
// 1.3` and `2.0`, viewport forced through Emulation.setDeviceMetricsOverride; probe
// var/ux-audit/tools/m_rowgap_v142.mjs, evidence var/ux-audit/v142-rowgap/, 2026-08-02):
//
//   font 2.0, width 320 -> 8 overlapping label/neighbour pairs (Общие 4, Приватность 3, Диагностика 1)
//   font 2.0, width 360/393/412 -> 4 / 4 / 3
//   font 1.3, width 320 -> «чувствительнСкрывать»: glyphs over glyphs, 15-35 px
//   font 1.0, any width -> 0. The defect does not exist at the normal system font.
//
// The label box is 93.3 px at EVERY font size (the value keeps `max-width: 46%`), so an unbreakable
// Russian word is painted outside its own box and across the value. The fix lets the row wrap and
// hands the label the whole first line. It is gated on `[data-gc-text-zoom]`, which ui/src/text_zoom.ts
// publishes only for an enlarged SYSTEM font — hence the zero-cost control at font 1.0: 4 widths x 8
// sections = 32 combinations, 0 boxes moved. After the fix the same probe reports 0 overlaps at 1.3
// and 2.0 on all four widths.
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
  "[data-gc-text-zoom] :is(.gc-superapp, .gc-overlay, .gc-palette-overlay, .gc-msgmenu-layer)";

test("V142: an enlarged system font lets the settings row wrap", () => {
  const row = blockFor(css, `${SCOPE} .gc-setting-row {`);
  assert.match(row, /flex-wrap:\s*wrap/);
  assert.match(row, /row-gap:/);
});

test("V142: the label owns the whole first line, so it cannot overlap the value", () => {
  const label = blockFor(css, `${SCOPE} .gc-setting-label {`);
  assert.match(label, /flex-basis:\s*100%/);
});

test("V142: the value may use the second line in full and wrap instead of being overprinted", () => {
  const value = blockFor(css, `${SCOPE} .gc-setting-value {`);
  assert.match(value, /max-width:\s*none/);
  assert.match(value, /white-space:\s*normal/);
});

test("V142: the switch stays on the right edge once the row wraps", () => {
  // The control is a `span.gc-switch`; `input.gc-toggle` alone does not match it.
  const sw = blockFor(css, `${SCOPE} .gc-setting-row > :is(.gc-switch, input.gc-toggle) {`);
  assert.match(sw, /margin-left:\s*auto/);
});

test("V142: the rule cannot reach a device at the normal system font", () => {
  // `data-gc-text-zoom` is published by ui/src/text_zoom.ts only above the normal font size, so the
  // zero-cost control is structural, not just measured: every V142 selector carries the gate.
  const lines = css.split("\n").filter((l) => l.includes(".gc-setting-row") || l.includes(".gc-setting-label"));
  for (const line of lines) {
    if (!line.includes("flex-wrap: wrap") && !line.includes("flex-basis: 100%")) continue;
    assert.ok(line.startsWith("[data-gc-text-zoom]"), `ungated V142 rule: ${line}`);
  }
});
