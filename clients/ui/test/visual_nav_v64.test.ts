// clients/ui/test/visual_nav_v64.test.ts — V64 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (probes var/ux-audit/tools/m_navbox_v64.mjs + m_navstate_v64.mjs, 2026-07-30):
//
//   .gc-shell-nav        358 x 53   grid-template-columns: 70.8 70.8 70.8 70.8 70.8  (5 columns)
//   rendered items       3          Чаты, Звонки, Ещё
//   .gc-shell-item-icon  27 x 26 inactive  ->  38 x 27 active
//   glyph inside         19 x 19    (declared 20px on one layer, 19px on another)
//   .gc-shell-item-label 11px weight 700
//
// 1. Three destinations were laid into five columns, so the tabs filled 212 of 358px and 41% of the
//    bar was dead space on the right: the row sat left of centre under a full-width pill. Nobody
//    chose that — the rule is commented «Navigation is always five first-level destinations in V4»
//    and written as a literal `repeat(5, minmax(0, 1fr))`. It stopped being true when /wallet and
//    /exchange became `requires: "payments"` and payments shipped off, i.e. the count is a RUNTIME
//    value (visibleDestinations()) that CSS held a stale copy of. The single hand-written escape
//    hatch, `:has(.gc-shell-item:nth-child(2):last-child)`, covered exactly two items, so of the
//    five reachable counts only 2 and 5 were ever right.
// 2. The indicator changed shape on touch, 27x26 -> 38x27, nudging the label under it by half a
//    pixel on every tab switch. The box was declared four times with four sets of numbers
//    (31x31, 29x27 / active 42, active 42x28, 27x26 / active 38x27) and no surviving pair was
//    proportional to the glyph inside it.
// 3. The smallest text in the shell carried the heaviest weight in the shell: 11px at 700.
//
// Reference (material-components-android master, read 2026-07-30):
//   BottomNavigationMenuView.onMeasure: `maxAvailable = width / (visibleCount == 0 ? 1 : visibleCount)`
//     — the bar divides itself by the number of VISIBLE items; a hardcoded count does not exist.
//   m3_bottom_nav_item_active_indicator_width 64dp / _height 32dp: one indicator size used in BOTH
//     states — selection animates its colour, never its box.
//   design_bottom_navigation_icon_size / mtrl_navigation_item_icon_size 24dp = 0.75 of that height.
//   design_bottom_navigation_text_size 12sp; active-indicator-to-label padding 4dp.
//
// The guard is textual against the source, like V63's: the fix is that ONE declaration derived from
// ONE token owns the bar's boxes. A rendering assertion would still pass on a build where four
// separate literals happen to agree today and drift apart tomorrow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

const mediaBodies = (condition: RegExp): string[] => {
  const out: string[] = [];
  const at = /@media([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(bare))) {
    if (!condition.test(m[1]!)) continue;
    let depth = 1;
    let i = at.lastIndex;
    for (; i < bare.length && depth > 0; i += 1) {
      if (bare[i] === "{") depth += 1;
      else if (bare[i] === "}") depth -= 1;
    }
    out.push(bare.slice(at.lastIndex, i - 1));
  }
  return out;
};

const phoneRules: Array<[string, string]> = mediaBodies(/max-width:\s*760px/).flatMap((body) =>
  body
    .split("}")
    .filter((r) => r.includes("{"))
    .map((r) => {
      const cut = r.indexOf("{");
      return [r.slice(0, cut).trim(), r.slice(cut + 1)] as [string, string];
    }),
);

const covers = (selector: string, name: string): boolean =>
  new RegExp(`\\${name}(?![\\w-])`).test(selector);

test("the active indicator's height is a token, declared once", () => {
  assert.match(
    tokens,
    /--gc-nav-pill-h:\s*32px\s*;/,
    "the indicator is the bar's unit of measure — it must be a named decision, not four literals",
  );
});

test("the bar has one column per visible destination, counted by the browser", () => {
  const laying = phoneRules.filter(([s, d]) => covers(s, ".gc-shell-nav") && /grid-auto-flow:\s*column/.test(d));
  assert.equal(laying.length, 1, "one layout decision, one declaration");
  const [, decl] = laying[0]!;
  assert.match(decl, /grid-template-columns:\s*none\s*(;|$)/m, "the five-column literal must be withdrawn, not overridden per count");
  assert.match(
    decl,
    /grid-auto-columns:\s*minmax\(0,\s*1fr\)\s*(;|$)/m,
    "equal implicit columns are how the count stays a runtime value, as in the reference's width/visibleCount",
  );
  assert.ok(
    !/repeat\(\s*5/.test(decl),
    "a hardcoded destination count is exactly the defect: /wallet and /exchange are conditional on payments",
  );
});

test("the indicator is one box, identical in both states", () => {
  const boxes = phoneRules.filter(([, d]) => /height:\s*var\(--gc-nav-pill-h\)\s*(;|$)/m.test(d));
  assert.equal(boxes.length, 1, "a second box declaration is how 27x26 -> 38x27 happened");
  const [selector, decl] = boxes[0]!;
  assert.ok(covers(selector, ".gc-shell-item-icon"), "the rule must own the indicator itself");
  assert.match(
    selector,
    /\.gc-shell-item\.is-active\s+\.gc-shell-item-icon/,
    "the active state must be named in the SAME rule, so it cannot be given a different box later",
  );
  // 64dp = 2 x 32dp in the reference; the cap keeps a 320px phone with all five destinations
  // enabled shrinking the pill instead of overflowing the bar (measured: 52.8x32, no overflow).
  assert.match(
    decl,
    /width:\s*min\(calc\(var\(--gc-nav-pill-h\)\s*\*\s*2\),\s*100%\)\s*(;|$)/m,
    "the indicator's width must be derived from its height and capped by its column",
  );
  assert.match(decl, /border-radius:\s*calc\(var\(--gc-nav-pill-h\)\s*\/\s*2\)/, "a pill's radius is half its height");
});

test("the glyph is one size, derived from the indicator", () => {
  const glyphs = phoneRules.filter(([s]) => /\.gc-shell-item-icon\s+\.gc-icon/.test(s));
  assert.equal(glyphs.length, 1, "19px on one layer and 20px on another is two answers to one question");
  const [, decl] = glyphs[0]!;
  for (const axis of ["width", "height"]) {
    assert.match(
      decl,
      new RegExp(`${axis}:\\s*calc\\(var\\(--gc-nav-pill-h\\)\\s*\\*\\s*0\\.75\\)\\s*(;|$)`, "m"),
      `the glyph's ${axis} must stay 0.75 of the indicator height, as 24dp is of 32dp`,
    );
  }
});

test("the smallest label in the shell no longer carries the heaviest weight", () => {
  const labels = phoneRules.filter(([s]) => covers(s, ".gc-shell-item-label"));
  const sized = labels.find(([, d]) => /font-size:\s*var\(--gc-fs-12\)/.test(d));
  assert.ok(sized, "the reference label is 12sp; 11px was the shell's smallest text");
  assert.match(
    sized![1],
    /font-weight:\s*var\(--gc-weight-medium\)\s*(;|$)/m,
    "weight 700 on an 11px label is the heaviest weight in the shell on its smallest text",
  );
  assert.ok(
    !labels.some(([, d]) => /font-weight:\s*(var\(--gc-weight-(bold|heavy)\)|[78]00)/.test(d)),
    "no later layer may restore the bold label",
  );
});

test("the item stops competing with the band for the vertical budget", () => {
  // 32 (pill) + 4 (gap) + 13.2 (12px label at 1.1) = 49.2 inside the 53px item band, centred.
  const gapped = phoneRules.filter(([s, d]) => covers(s, ".gc-shell-item") && /gap:\s*4px\s*(;|$)/m.test(d));
  assert.equal(gapped.length, 1, "the indicator-to-label gap must be stated once, from the reference's 4dp");
  assert.match(
    gapped[0]![1],
    /padding-block:\s*0\s*(;|$)/m,
    "the item's own vertical padding must yield to the band, or the 3px it kept re-centres the pill",
  );
});
