// clients/ui/test/visual_miniapp_tabs_wrap_v197.test.ts — V197: on «Мини-приложения» the tab
// «Мои приложения» printed itself past the right edge of the screen.
//
// Evidence (ephemeral stand, own GC_DATA_DIR, port 38987; Chromium mobile context,
// deviceScaleFactor 2, ru-RU, signed in, route `#/miniapps`; probes `mtabs.mjs` and `mcand.mjs`,
// 2026-08-04). The nav is 300 px wide at a 320 dp viewport:
//
//   width  font   «Каталог»   «Мои приложения»   sum    tab box past nav   text past screen
//   320    1.0    141.5       144.5              286.0  0                  0
//   320    1.2    120.4       166.2              286.6  0                  0
//   320    1.4    134.5       187.9              322.4  31.4 px            3.4 px
//
// `flex: 1 1 50%` promised each tab a half it could not keep: a flex item's automatic minimum
// size is its min-content width, and «приложения» plus 2x18 px of padding measures 187.9 px at
// font 1.4 — 37.9 px past the 150 px half. The pair then overflowed the pill that paints their
// background and the viewport cut the label. Identical numbers with `data-gc-text-zoom="large"`,
// so the trigger is the in-app scale, not the system font.
//
// The fix lets the line break instead of overflow (`flex-wrap: wrap` + a content-sized basis) and
// trims the padding so fewer pairs need to break at all. This file pins that SHAPE, read out of
// the cascade rather than out of a comment, so it survives renumbering and fails the moment
// someone puts a percentage basis or an ellipsis back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/miniapps.css"), "utf8");
const markup = readFileSync(resolve(here, "../src/screens/miniapps_screen.ts"), "utf8");

interface Rule {
  /** Selector list as written. */
  sel: string;
  /** Declarations of that block. */
  decls: string;
  /** `@media …` chain the rule sits under, empty for an unconditional rule. */
  at: string;
}

/** Comments hold prose that mentions these very class names and properties, so they go first. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace scanner: enough for this sheet (no nesting, no strings with braces). */
function collectRules(src: string): Rule[] {
  const out: Rule[] = [];
  const stack: { sel: string; start: number; at: string }[] = [];
  let preludeStart = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") {
      const sel = src.slice(preludeStart, i).trim();
      const parentAt = stack.map((s) => s.sel).filter((s) => s.startsWith("@")).join(" ");
      stack.push({ sel, start: i + 1, at: parentAt });
      preludeStart = i + 1;
    } else if (c === "}") {
      const top = stack.pop();
      if (top && !top.sel.startsWith("@")) {
        out.push({ sel: top.sel, decls: src.slice(top.start, i), at: top.at });
      }
      preludeStart = i + 1;
    }
  }
  return out;
}

const rules = collectRules(stripComments(css));

/** Split a selector list on its TOP-LEVEL commas — commas inside `:is(...)` are not separators. */
function selectorList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  out.push(sel.slice(start));
  return out;
}

/** The compound the rule actually styles: everything after the last top-level combinator. */
function subject(sel: string): string {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && (c === " " || c === "\t" || c === "\n" || c === ">" || c === "+" || c === "~")) {
      last = i + 1;
    }
  }
  return sel.slice(last);
}

/** Every rule that styles `cls` ITSELF — the class must be the subject, not an ancestor. */
const rulesFor = (cls: string): Rule[] => {
  const token = new RegExp(`\\.${cls}(?![\\w-])`);
  return rules.filter((r) => selectorList(r.sel).some((one) => token.test(subject(one))));
};

/** What the browser ends up applying: the LAST declaration of `prop` in document order. */
function effective(cls: string, prop: string, at?: RegExp): { value: string | null; at: string } {
  let value: string | null = null;
  let where = "";
  for (const r of rulesFor(cls)) {
    if (at && !at.test(r.at)) continue;
    const m = r.decls.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`));
    if (m) {
      value = m[1].trim();
      where = r.at;
    }
  }
  return { value, at: where };
}

/** The phone-sized branch, where the tabs stretch instead of hugging their labels. */
const NARROW = /max-width:\s*700px/;

test("V197: the tab strip may break its line instead of overflowing", () => {
  const { value, at } = effective("gc-miniapp-tabs", "flex-wrap", NARROW);
  assert.equal(
    value,
    "wrap",
    "without `flex-wrap: wrap` the two tabs sum 322.4 px into a 300 px nav and spill off-screen",
  );
  assert.match(at, NARROW, "the wrap belongs to the phone-sized branch that stretches the tabs");
});

test("V197: the tab basis is content-sized, never a percentage it cannot honour", () => {
  const { value } = effective("gc-miniapp-tab", "flex", NARROW);
  assert.ok(value, "the phone-sized branch must still size the tabs");
  assert.match(
    value ?? "",
    /^1\s+1\s+auto$/,
    "a percentage basis is a promise flexbox breaks: the automatic minimum size is min-content, " +
      "so `1 1 50%` still measured 187.9 px inside a 150 px half (font 1.4, 320 dp)",
  );
  assert.doesNotMatch(
    value ?? "",
    /%/,
    "a percentage basis stops the line from breaking, which is the whole overflow",
  );
});

test("V197: the trimmed padding is what keeps the pair on one line", () => {
  const { value } = effective("gc-miniapp-tab", "padding", NARROW);
  assert.ok(value, "the phone-sized branch must set its own padding");
  const inline = Number(/^0\s+(\d+)px$/.exec(value ?? "")?.[1] ?? NaN);
  assert.ok(
    Number.isFinite(inline) && inline <= 12,
    `each 1 px of inline padding costs 2 px of line budget; measured at 320 dp the label needs ` +
      `all of it (found "${value}")`,
  );
});

test("V197: the label is never truncated to fake a fit", () => {
  // Measured alternative: `min-width: 0` + ellipsis clipped 9.5-69.3 px of the label across
  // 320-430 dp, so the tab read «Мои прило…» — a switch whose name is unreadable.
  for (const [prop, bad] of [["text-overflow", /ellipsis/], ["white-space", /nowrap/]] as const) {
    const { value } = effective("gc-miniapp-tab", prop);
    if (value) assert.doesNotMatch(value, bad, `.gc-miniapp-tab must not ${prop}: ${value}`);
  }
});

test("V197: the fix holds at every font size, not only the system zoom", () => {
  // The stand measured the same 31.4 px overflow with and without `data-gc-text-zoom="large"`:
  // the in-app `--gc-font-scale` is enough to trigger it, so a zoom-gated fix would miss it.
  for (const cls of ["gc-miniapp-tabs", "gc-miniapp-tab"]) {
    const gated = rulesFor(cls).some(
      (r) => /flex/.test(r.decls) && r.sel.includes("data-gc-text-zoom"),
    );
    assert.equal(gated, false, `.${cls} must not owe its layout to the system font attribute`);
  }
});

test("V197: the strip is still the two-tab switcher these numbers were measured on", () => {
  const tabs = markup.match(/class:\s*`gc-miniapp-tab\$\{/g) ?? [];
  assert.equal(
    tabs.length,
    2,
    "the budget above is for two tabs on one line; a third one changes the arithmetic — re-measure",
  );
  assert.match(
    markup,
    /class:\s*"gc-miniapp-tabs"[\s\S]{0,120}\[catalogTab,\s*mineTab\]/,
    "both tabs must still be children of the wrapping nav, or the wrap has nothing to break",
  );
});
