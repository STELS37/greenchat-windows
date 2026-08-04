// clients/ui/test/visual_tabstrip_v104.test.ts — V104: a narrow phone starved the filter strips.
//
// Evidence (signed direct APK app.greenchat installed on the emulator, redroid 15, `wm density 540`
// = 320 dp page, DEFAULT system font, route #/calls, CDP against the device WebView, 2026-07-31):
//
//   .gc-call-log            280 px   (page 320 - 2 x 16 gutter... minus the section's own 20)
//   .gc-tabs.gc-call-log-tabs   190 px  max-width 190px, i.e. capped, not measured
//   .gc-tab                  91 px   x2, `flex: 1`
//   .gc-tab-label «Все»      50 px content / 50 needed   zoom 1
//   .gc-tab-label «Пропущенные» 88 px content / 95 needed  zoom 0.81  -> 6 px through the edge
//
// Two visible defects from one cause: the second filter label was drawn ~19 % smaller than the
// first (the width fitter did what it could), still painted through its tab, and the strip's
// underline — the thing that tells you WHICH filter is on — stopped at 64 % of the row.
//
// The cause was a breakpoint, not a measurement: `@media (max-width: 380px) { .gc-superapp .gc-tabs
// { max-width: 190px } }` hit EVERY strip in the shell. The cap belongs to the settings header,
// where five tabs share one row with a back button and a title and must scroll inside themselves.
// The chat-list and call-log strips own a whole row and are drawn as an underline (V67), so on the
// same 320 dp phone the same tab becomes 144 px wide with 124 px of content: 95 px of Russian fits
// unscaled with 29 px to spare.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

/** Measured on the device, 320 dp page. */
const PAGE_PX = 320;
const GUTTER_PX = 16;
const TAB_PAD_PX = 10;
const WIDEST_LABEL_PX = 95; // «Пропущенные» at --gc-fs-15, default system font
const OLD_CAP_PX = 190;

/** Every rule body keyed on a narrow-phone width, with the selector it applies to. */
function narrowPhoneRules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const head = /@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{/g;
  for (let m = head.exec(css); m; m = head.exec(css)) {
    if (Number(m[1]) > 480) continue; // 760 is "not a desktop"; this test is about narrow phones
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    const block = css.slice(start, i - 1);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    for (let r = rule.exec(block); r; r = rule.exec(block)) {
      out.push({ selector: r[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: r[2] });
    }
  }
  return out;
}

test("V104: no narrow-phone rule caps the width of every tab strip in the shell", () => {
  const capped = narrowPhoneRules().filter((r) => /max-width\s*:\s*\d+px/.test(r.body) && /\.gc-tabs/.test(r.selector));
  assert.ok(capped.length > 0, "the settings-header cap is still expected to exist");
  for (const r of capped) {
    assert.ok(
      r.selector.includes(".gc-settings-header"),
      `a pixel cap on tab strips must name the strip it was measured for; found it on "${r.selector}", ` +
        "which also starves the chat-list and call-log filters",
    );
  }
});

test("V104: the filter strips are never the capped component", () => {
  for (const r of narrowPhoneRules()) {
    if (!/max-width\s*:\s*\d+px/.test(r.body)) continue;
    assert.ok(
      !/\.gc-call-log-tabs|\.gc-chats-header\s+\.gc-tabs/.test(r.selector),
      `underline filter strips own their row; "${r.selector}" caps them`,
    );
  }
});

test("V104: given the whole row, the widest Russian filter label fits unscaled", () => {
  const row = PAGE_PX - 2 * GUTTER_PX; // 288
  const perTab = row / 2; // two filters, `flex: 1`
  const content = perTab - 2 * TAB_PAD_PX;
  assert.ok(
    content >= WIDEST_LABEL_PX,
    `«Пропущенные» needs ${WIDEST_LABEL_PX}px and a full-row tab offers ${content}px`,
  );
  const cappedContent = OLD_CAP_PX / 2 - 2 * TAB_PAD_PX;
  assert.ok(
    cappedContent < WIDEST_LABEL_PX,
    "sanity: the old cap really was the thing that made the label overflow",
  );
});
