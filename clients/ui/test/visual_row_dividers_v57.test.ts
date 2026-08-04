// clients/ui/test/visual_row_dividers_v57.test.ts — V57 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile (probes /tmp/m_sep.mjs and
// /tmp/m_calls.mjs, 2026-07-30):
//
//   .gc-settings-nav .gc-nav-row       row x=17 w=356   icon x=31 w=32   label x=77  -> text at +60px
//   .gc-calls-section .gc-call-dialog  row x=19 w=352   avatar x=23 w=48   copy x=79  -> text at +60px
//
// Both lists painted their hairline edge to edge (border-top on the settings row, border-bottom on
// the call row), so the line crossed underneath the 32px icon tile and the 48px avatar disc. A rule
// that starts left of the leading media is the visual grammar of a data TABLE: it says "these cells
// belong to one grid". Every phone list of people or settings insets the separator to the start of
// the text, so the line reads as "next item" and the avatar column stays an uninterrupted rail.
//
// The guard is textual against redesign.css because the fix is a set of DECLARATIONS (withdraw the
// full-bleed border, draw an inset pseudo-element instead); only the source can prove the old
// border is actively cleared rather than merely absent from one rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Same scope pattern as the other visual guards: pin the declarations, not the spelling of the scope. */
const APP_SCOPE = String.raw`(?:\.gc-superapp|:is\([^)]*\.gc-superapp[^)]*\))`;

/**
 * The LAST rule of equal specificity is the one that renders, and both of these rows are already
 * styled by earlier layers in this same file (`.gc-nav-row + .gc-nav-row` carries the old
 * full-bleed border at line ~965; `.gc-calls-section .gc-call-dialog` is flattened by V54). A guard
 * that asserted against the first match would be testing the rule that LOSES the cascade and would
 * stay green after the fix is deleted.
 */
const blocksMatching = (selectorPattern: string): string[] => {
  const boundary = new RegExp(`${APP_SCOPE}\\s+${selectorPattern}\\s*(?:,|\\{)`);
  const hits = bare
    .split("}")
    .filter((r) => r.includes("{") && boundary.test(`${r.split("{")[0]!}{`))
    .map((r) => r.split("{").slice(1).join("{"));
  assert.ok(hits.length > 0, `no rule found whose selector list matches /${selectorPattern}/`);
  return hits;
};

/** The declaration that renders is the one in the LAST rule of equal specificity. */
const winning = (selectorPattern: string): string => {
  const hits = blocksMatching(selectorPattern);
  return hits[hits.length - 1]!;
};

/**
 * The cascade resolves per PROPERTY, not per rule: the block that renders `border-bottom` is the
 * last one that actually declares `border-bottom`, and a later rule that only restates the row's
 * padding or grid leaves the withdrawal untouched. Asserting against the last rule outright made
 * this guard fail the moment V66 gave the calls row its frame without mentioning the border — a
 * false alarm — while still passing if some future layer set `border-bottom: 1px` in a rule that
 * happened not to be last. Selecting by property is the guard's own stated intent, done exactly.
 */
const winningProperty = (selectorPattern: string, property: string): string => {
  const declaring = blocksMatching(selectorPattern).filter((block) =>
    new RegExp(`(?:^|[;{\\s])${property}\\s*:`, "m").test(block),
  );
  assert.ok(declaring.length > 0, `no rule declares ${property} for /${selectorPattern}/`);
  return declaring[declaring.length - 1]!;
};

const NAV_ROW = String.raw`\.gc-settings-nav \.gc-nav-row`;
const NAV_PAIR = String.raw`\.gc-settings-nav \.gc-nav-row \+ \.gc-nav-row`;
const CALL_ROW = String.raw`\.gc-calls-section \.gc-call-dialog`;

test("both grouped lists withdraw their full-bleed hairline instead of overpainting it", () => {
  // Leaving the old border in place would double the line: an edge-to-edge rule UNDER the inset
  // one. Each list carried it on a different edge, so each is withdrawn where it was declared:
  // the settings list on the adjacent pair (border-top), the calls list on the row (border-bottom,
  // set by the V54 flattening layer above).
  assert.match(
    winningProperty(NAV_PAIR, "border-top"),
    /border-top:\s*0\s*(;|$)/m,
    "the settings hairline must be cleared",
  );
  assert.match(
    winningProperty(CALL_ROW, "border-bottom"),
    /border-bottom:\s*0\s*(;|$)/m,
    "the calls hairline must be cleared",
  );
});

test("the separator is drawn inset to the start of the text, not from the row edge", () => {
  const block = winning(String.raw`\.gc-settings-nav \.gc-nav-row \+ \.gc-nav-row::after`);
  assert.match(block, /content:\s*""/, "the separator needs a rendered pseudo-element");
  assert.match(block, /position:\s*absolute/, "the separator is positioned against the row");
  assert.match(block, /height:\s*1px/, "a separator thicker than a hairline reads as a table rule");
  // The inset is the whole point of the layer: 0 would put the line back under the avatar column.
  assert.match(block, /inset-inline-start:\s*var\(--gc-row-divider-inset\)/, "the inset must be logical so RTL stays correct without a second rule");
  assert.match(block, /inset-inline-end:\s*0/, "the line still reaches the trailing edge");
});

test("both lists resolve the same inset from one variable, so they cannot drift apart", () => {
  for (const row of [NAV_ROW, CALL_ROW]) {
    const blocks = blocksMatching(row);
    const declaring = blocks.filter((b) => /--gc-row-divider-inset:\s*60px/.test(b));
    assert.equal(declaring.length, 1, `${row} must take the measured 60px text start from exactly one declaration`);
    // Without a containing block the absolutely positioned hairline escapes to the nearest
    // positioned ancestor and draws across the whole card.
    assert.match(declaring[0]!, /position:\s*relative/, `${row} must be the containing block of its separator`);
    const after = blocks.slice(blocks.indexOf(declaring[0]!) + 1);
    for (const b of after) {
      assert.doesNotMatch(b, /position:\s*(static|absolute|fixed|sticky)/, `${row} must not lose its containing block in a later rule`);
    }
  }
});

test("the separator never paints on the first row of a list", () => {
  // Drawn on the row that FOLLOWS another row. A `:not(:last-child)::after` variant would paint a
  // line into the empty bottom of the card whenever the last row is hidden by a filter.
  assert.match(bare, /\.gc-nav-row \+ \.gc-nav-row::after/, "settings separators are adjacent-sibling scoped");
  assert.match(bare, /\.gc-call-dialog \+ \.gc-call-dialog::after/, "call separators are adjacent-sibling scoped");
});
