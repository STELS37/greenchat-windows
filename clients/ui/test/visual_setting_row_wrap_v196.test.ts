// clients/ui/test/visual_setting_row_wrap_v196.test.ts — V196: a settings row printed its LABEL on
// top of its VALUE at the NORMAL system font.
//
// V142 fixed this collision once, but only behind `[data-gc-text-zoom]`, the attribute
// ui/src/text_zoom.ts publishes when the SYSTEM font is enlarged. The app has a second, independent
// font axis — `--gc-font-scale`, which theme.ts sets from the in-app «Размер текста» (max 1.4) — and
// nothing was gated on it, so the identical defect survived there. It was not exotic: three rows
// already collided at scale 1.0.
//
// Evidence (ephemeral stand on a free port with its own GC_DATA_DIR; Chromium/Playwright, isMobile,
// deviceScaleFactor 2, ru-RU, real sign-in; tabs Общие/Приватность/Соединение = 22 rows; probe
// /tmp/gc-visual-35932/probe_cand3.mjs, 2026-08-04):
//
//   width  font   colliding rows / worst overlap   value px cut   list height
//   320    1.0        3 / 2.7 px                       113          1298
//   360    1.0        0                                 92          1219
//   390    1.0        0                                 78          1191
//   320    1.4       10 / 70.3 px                      454          1916
//   360    1.4        4 / 30.3 px                      321          1744
//   390    1.4        3 / 10.6 px                      223          1657
//
// After the fix, the same probe against the BUILT sheet: 0 collisions at every one of those six
// combinations, 0 orphaned controls, cut 113 → 1 px (320/1.0) and 454 → 93 px (320/1.4).
//
// Cause: `.gc-setting-label { flex: 1; min-width: 0 }`. `min-width: 0` licenses flexbox to shrink the
// label below its min-content width; a long Russian word has no break opportunity and `overflow` is
// visible, so the text is painted OUTSIDE its own box, straight across the value.
//
// This file pins the SHAPE, read out of the cascade rather than out of a comment: it parses
// redesign.css, keeps the rules whose SUBJECT is the class in question, and asks what the last
// declaration in document order says — which is what the browser applies, the rules being of equal
// specificity. So the test survives a renumbering and fails the moment the squeeze comes back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string): string => readFileSync(resolve(here, "../../web/src/", name), "utf8");
const css = read("redesign.css");

interface Rule {
  sel: string;
  decls: string;
  at: string;
}

/** Comments hold prose that mentions these very class names, so they go first. */
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
      if (top && !top.sel.startsWith("@")) out.push({ sel: top.sel, decls: src.slice(top.start, i), at: top.at });
      preludeStart = i + 1;
    }
  }
  return out;
}

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
    else if (depth === 0 && (c === " " || c === "\t" || c === "\n" || c === ">" || c === "+" || c === "~")) last = i + 1;
  }
  return sel.slice(last);
}

/**
 * Every rule that styles `cls` ITSELF — the class must be the SUBJECT of at least one selector in the
 * list, not merely mentioned in an ancestor position. Matching the whole selector string reads a
 * descendant rule as a rule on the ancestor: `.gc-setting-row > .gc-setting-chevron { position:
 * absolute }` would otherwise make the ROW look absolutely positioned.
 */
function rulesFor(src: string, cls: string): Rule[] {
  const token = new RegExp(`\\.${cls}(?![\\w-])`);
  return collectRules(stripComments(src)).filter((r) => selectorList(r.sel).some((one) => token.test(subject(one))));
}

/** What the browser ends up applying: the LAST declaration of `prop` in document order. */
function effective(cls: string, prop: string): { value: string | null; sel: string; at: string } {
  let value: string | null = null;
  let sel = "";
  let at = "";
  for (const r of rulesFor(css, cls)) {
    const m = r.decls.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`));
    if (m) {
      value = m[1].trim();
      sel = r.sel;
      at = r.at;
    }
  }
  return { value, sel, at };
}

/** Position of the LAST rule on `cls` that declares `prop`, in document order (-1 when absent). */
function lastIndexOf(cls: string, prop: string): number {
  const all = rulesFor(css, cls);
  let idx = -1;
  all.forEach((r, i) => {
    if (new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:`).test(r.decls)) idx = i;
  });
  return idx;
}

test("V196: the label may not be squeezed below its longest word, on ANY font axis", () => {
  const min = effective("gc-setting-label", "min-width");
  assert.equal(min.value, "min-content", "min-width: 0 lets a long word paint outside its own box");
  assert.equal(min.at, "", "the floor must not hide inside a @media block — the defect is not width-bound");
  assert.doesNotMatch(
    min.sel,
    /\[data-gc-text-zoom\]/,
    "gating on the SYSTEM font axis is exactly the mistake V142 made: `--gc-font-scale` is a second, " +
      "independent axis and three rows already collide at scale 1.0",
  );
});

test("V196: a label that carries a user-controlled string keeps its right to shrink", () => {
  // styles.css gives `.gc-setting-label:has(> strong)` its own scrollport with `overflow-wrap:
  // anywhere`; flooring THAT one at min-content would let a pasted 400-character token widen the row.
  const min = effective("gc-setting-label", "min-width");
  assert.match(min.sel, /:not\(:has\(>\s*strong\)\)/, "the floor must exempt the `> strong` variant");
});

test("V196: the row may wrap without waiting for the system font to be enlarged", () => {
  const wrap = effective("gc-setting-row", "flex-wrap");
  assert.equal(wrap.value, "wrap");
  assert.equal(wrap.at, "");
  assert.doesNotMatch(wrap.sel, /\[data-gc-text-zoom\]/);
});

test("V196: the value keeps its own width instead of being cut to a 46% column", () => {
  const decls = rulesFor(css, "gc-setting-value")
    .filter((r) => !/\[data-gc-text-zoom\]/.test(r.sel) && r.at === "")
    .map((r) => r.decls)
    .join(";");
  const width = effective("gc-setting-value", "max-width");
  assert.equal(width.value, "100%", "46% is the split that starved the label and forced the overlap");
  assert.match(decls, /flex:\s*0\s+1\s+auto/, "the value must be allowed to shrink, but from its content");
});

test("V196: a value or switch that wrapped to its own line still sits on the RIGHT edge", () => {
  // The base layer's `justify-content: space-between` puts a SOLITARY item at flex-start, so without
  // this the wrapped value would be stranded at the left content edge under its own label.
  assert.equal(effective("gc-setting-value", "margin-inline-start").value, "auto");
  const switches = rulesFor(css, "gc-switch")
    .filter((r) => /\.gc-setting-row\s*>/.test(r.sel) && !/\[data-gc-text-zoom\]/.test(r.sel))
    .map((r) => r.decls)
    .join(";");
  assert.match(switches, /margin-inline-start:\s*auto/, "a wrapped toggle needs the same push");
});

test("V196: `justify-content: flex-end` stays rejected — one row is a lone button", () => {
  // settings_screen.ts builds a `.gc-setting-row` whose only child is the «Проверить обновления»
  // button. Under flex-end that single item would jump to the right edge: a new defect for an old one.
  for (const r of rulesFor(css, "gc-setting-row")) {
    assert.doesNotMatch(r.decls, /justify-content:\s*(flex-)?end|justify-content:\s*right/);
  }
  const markup = readFileSync(resolve(here, "../src/screens/settings_screen.ts"), "utf8");
  assert.match(
    markup,
    /el\("div",\s*\{\s*class:\s*"gc-setting-row"\s*\},\s*\[button\]\)/,
    "the lone-button row is the reason flex-end is banned; if it is gone, re-measure before allowing it",
  );
});

test("V196: the chevron leaves the flow, so it can never be orphaned onto a line of its own", () => {
  const pos = effective("gc-setting-chevron", "position");
  assert.equal(pos.value, "absolute");
  assert.match(effective("gc-setting-chevron", "inset-inline-end").value ?? "", /var\(--gc-setting-bleed/);
});

test("V196: the space the chevron gave up is reserved as row padding, by the same variable", () => {
  const pad = effective("gc-setting-row", "padding-inline-end").value ?? "";
  assert.match(pad, /calc\(\s*var\(--gc-setting-bleed/, "the inset and the reservation must track one variable");
  // The reservation is the chevron's own box plus the row gap. Read both out of the sheet so that
  // resizing the icon fails HERE instead of silently letting the value run under the chevron.
  const icon = collectRules(stripComments(css)).find((r) => /\.gc-setting-chevron\s+\.gc-icon/.test(r.sel));
  const iconW = Number(/width:\s*(\d+)px/.exec(icon?.decls ?? "")?.[1]);
  const gap = Number(/^(\d+)px$/.exec(effective("gc-setting-row", "gap").value ?? "")?.[1]);
  const reserved = Number(/\+\s*(\d+)px/.exec(pad)?.[1]);
  assert.ok(Number.isFinite(iconW) && Number.isFinite(gap), "icon width and row gap must stay readable");
  assert.equal(reserved, iconW + gap, `reservation ${reserved}px must equal chevron ${iconW}px + gap ${gap}px`);
});

test("V196: the reservation is declared AFTER the `padding-inline` shorthand that would erase it", () => {
  // `.gc-setting-list .gc-setting-row { padding-inline: var(--gc-setting-bleed) }` is a shorthand: put
  // the longhand before it and the browser silently drops the reservation, leaving the value to run
  // underneath the chevron. Equal specificity, so document order is the whole guarantee.
  const shorthand = lastIndexOf("gc-setting-row", "padding-inline");
  const longhand = lastIndexOf("gc-setting-row", "padding-inline-end");
  assert.ok(longhand > shorthand, "the padding reservation must come last or it does not exist");
});

test("V196: both halves of the chevron move are behind `:has()`, so they degrade together", () => {
  // A WebView without `:has()` support must keep TODAY's in-flow chevron. If only the positioning
  // survived, the value would run underneath it — a worse defect than the one being fixed.
  const chevron = rulesFor(css, "gc-setting-chevron").filter((r) => /position:\s*absolute/.test(r.decls));
  assert.ok(chevron.length > 0);
  for (const r of chevron) assert.match(r.sel, /:has\(/, "the positioning must be gated on the same :has() as the padding");
  const padRule = rulesFor(css, "gc-setting-row").filter((r) => /padding-inline-end:/.test(r.decls));
  for (const r of padRule) assert.match(r.sel, /:has\(>\s*\.gc-setting-chevron\)/);
});

test("V196: no later layer hands the squeeze back", () => {
  const LAYERS = ["styles.css", "redesign.css", "brand.css", "message_delivery.css", "shortscreen.css"];
  const after = LAYERS.slice(LAYERS.indexOf("redesign.css") + 1);
  for (const layer of after) {
    let src: string;
    try {
      src = read(layer);
    } catch {
      continue;
    }
    for (const r of rulesFor(src, "gc-setting-label")) {
      assert.doesNotMatch(r.decls, /min-width:\s*0/, `${layer} re-enables the label squeeze`);
    }
    for (const r of rulesFor(src, "gc-setting-value")) {
      assert.doesNotMatch(r.decls, /max-width:\s*\d+%/, `${layer} re-imposes a percentage value column`);
    }
  }
});
