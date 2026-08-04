// clients/ui/test/visual_settings_hscroll_v141.test.ts — V141: at the Android system font size 2.0
// two settings sections scrolled SIDEWAYS inside `.gc-settings-panel` and cut their own text.
//
// Measured on the signed artifact in the device WebView (redroid 15, `settings put system
// font_scale 2.0`, viewport forced through Emulation.setDeviceMetricsOverride; probe
// var/ux-audit/tools/m_hscroll_v140.mjs, evidence var/ux-audit/v140-hscroll/, 2026-08-02):
//
//   width   section        scrollWidth - clientWidth   worst element past the pane's content edge
//   320     Помощь                 72                  «Написать в поддержку»  +74 px
//   320     Безопасность           30                  .gc-safety-section      +30 px
//   360     Помощь                 32                  «Написать в поддержку»  +34 px
//   393/412 both                    0                  —
//
// The pane is `overflow-x: auto`, so the window never scrolls: the overflow is silent and the user
// reads «Написат…», «Обнови…», «активн…». Two causes: a `nowrap` flex row whose button cannot
// shrink, and a grid item that cannot go below the min-content of ONE long word («Заблокированные»,
// 295 px against a 292 px track at zoom 2). After the fix the same probe reports 0 for all eight
// sections at 320/360/393/412, and at font 1.0 and 1.3 every box in both panes is unchanged.
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

test("V141: the fixed rows may wrap once the system text is large", () => {
  const wrap = blockFor(
    css,
    '[data-gc-text-zoom="large"] :is(.gc-support-actions-head, .gc-status-head)',
  );
  assert.match(wrap, /flex-wrap:\s*wrap/);
  // A wrapped row must not leave the button hanging alone on the right: `.gc-status-refresh` is
  // `margin-left: auto` in styles.css, which right-aligns it on its own line (seen on the device,
  // evidence/fixA-320-help.png).
  assert.match(
    blockFor(css, '[data-gc-text-zoom="large"] .gc-status-head {'),
    /justify-content:\s*space-between/,
  );
  assert.match(
    blockFor(css, '[data-gc-text-zoom="large"] .gc-status-refresh'),
    /margin-left:\s*0/,
  );
  assert.match(
    blockFor(css, '[data-gc-text-zoom="large"] .gc-status-rows > div'),
    /flex-wrap:\s*wrap/,
  );
});

test("V141: nothing wraps at the ordinary system font size", () => {
  // The wrapping rules are gated on the LARGE level only. At 1.3 («medium») the base layout still
  // fits — measured, report-f13base.json: 8 sections, 0 overflow — so wrapping there would move the
  // button to its own row for nothing.
  for (const sel of [
    ":is(.gc-support-actions-head, .gc-status-head)",
    ".gc-status-head {",
    ".gc-status-refresh",
    ".gc-status-rows > div",
  ]) {
    const idx = css.indexOf(sel);
    assert.ok(idx > 0, `selector not found: ${sel}`);
    const line = css.slice(css.lastIndexOf("\n", idx) + 1, idx + sel.length);
    assert.ok(
      line.includes('[data-gc-text-zoom="large"]'),
      `the wrap rule for ${sel} must be gated on the large text-zoom level: ${line}`,
    );
  }
});

test("V141: the min-content floor is removed unconditionally", () => {
  // `min-width: auto` on a grid item is what turned one long word into a horizontally scrolling
  // card. Removing that floor is a no-op at zoom 1 — verified on the device, 0 boxes changed at
  // 320 and 393 dp — so it is not gated: the same word overflows on a narrow screen at any zoom.
  const floor = blockFor(css, ".gc-safety,\n.gc-safety-section,\n.gc-safety-section > *");
  assert.match(floor, /min-width:\s*0/);
  const heads = blockFor(css, ".gc-safety-section :is(h2, h3)");
  assert.match(heads, /overflow-wrap:\s*anywhere/);
  const rows = blockFor(css, ".gc-status-rows :is(dt, dd)");
  assert.match(rows, /min-width:\s*0/);
  assert.match(rows, /overflow-wrap:\s*anywhere/);
});
