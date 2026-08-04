// clients/ui/test/visual_nested_cards_v54.test.ts — V54 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (var/ux-audit/tools/probe_nested_cards.mjs, 2026-07-30): the Calls tab painted two concentric
// white panels. `.gc-calls-section` is a card (370 px wide, 20 px radius, --gc-shadow-sm) and the
// list it contains, `.gc-call-dialog-list`, painted its OWN card in the base sheet (border +
// 21 px radius + --gc-card + the identical shadow), 9 px inside it. A card holding a slightly
// smaller card with the same fill and the same shadow is the single most recognisable "form from
// the 2000s" artefact left in the shell.
//
// The redesign layer already flattened the ROWS (`.gc-call-dialog` -> no background, no radius,
// hairline bottom border), but it only set `gap: 0` on the LIST, so the frame survived. The fix
// strips the frame from the list as well. Verified after the fix: the detector reports 0 nested
// pairs on chats / thread / calls / more / more-detail, and the Calls tab shows one card with
// hairline-separated rows.
//
// The guard is textual against redesign.css on purpose: the defect was a MISSING declaration, and
// only the source can prove a declaration is present in the flattening rule rather than merely
// absent from one rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The app scope of this layer, as a pattern rather than a literal. V55 widened every descendant
 * selector from `.gc-superapp x` to `:is(.gc-superapp, .gc-overlay, ...) x`, because body-level
 * sheets live outside `.gc-superapp` and were silently falling back to the legacy skin. A guard
 * must pin the DECLARATIONS; pinning the spelling of the scope only breaks unrelated tests every
 * time a new surface joins it. `.gc-superapp` still has to be in the list — that is what proves the
 * rule reaches the authenticated shell at all.
 */
const APP_SCOPE = String.raw`(?:\.gc-superapp|:is\([^)]*\.gc-superapp[^)]*\))`;

/**
 * Declaration block of the rule whose selector list contains the app scope followed by `needle` as
 * a COMPLETE selector. The boundary check is not cosmetic: `.gc-call-dialog` is a prefix of
 * `.gc-call-dialog-list`, so a plain substring search silently returns the list rule and the row
 * assertions test the wrong block.
 */
const blockContaining = (needle: string): string => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = new RegExp(`${APP_SCOPE}\\s+${escaped}\\s*(?:,|\\{)`);
  const rules = bare.split("}");
  // `split("{")[0]` drops the brace, so the LAST selector of a list would have no terminator left to
  // match; it is put back before the boundary test.
  const hit = rules.find((r) => r.includes("{") && boundary.test(`${r.split("{")[0]!}{`));
  assert.ok(hit, `no rule found whose selector list contains "${needle}"`);
  return hit!.split("{").slice(1).join("{");
};

const FLATTENED_LISTS = [
  ".gc-calls-section .gc-call-dialog-list",
  ".gc-finance-section .gc-finance-list",
  ".gc-finance-section .gc-market-list",
];

test("a grouped list inside a section card paints no card of its own", () => {
  for (const sel of FLATTENED_LISTS) {
    const block = blockContaining(sel);
    // Each of these four is one half of the double frame. Dropping any one of them brings the
    // visible second panel back: background and border draw the fill and the outline, radius makes
    // the corner read as a separate object, shadow lifts it off the card underneath.
    assert.match(block, /(^|;)\s*border:\s*0\s*(;|$)/m, `${sel} must clear its border`);
    assert.match(block, /border-radius:\s*0\s*(;|$)/, `${sel} must clear its corner radius`);
    assert.match(block, /background:\s*none\s*(;|$)/, `${sel} must clear its background fill`);
    assert.match(block, /box-shadow:\s*none\s*(;|$)/, `${sel} must clear its shadow`);
  }
});

test("the rows inside those lists stay flat and keep exactly one hairline separator", () => {
  const block = blockContaining(".gc-calls-section .gc-call-dialog");
  assert.match(block, /border-radius:\s*0/, "a flattened row must not round its own corners");
  assert.match(block, /background:\s*none/, "a flattened row must not paint its own surface");
  assert.match(block, /border-bottom:\s*1px solid/, "rows are separated by a hairline, not by gaps");
});

test("the base sheet still owns the stand-alone card, so the list is usable outside a section", () => {
  // The flattening is deliberately scoped to `.gc-superapp .gc-*-section`. If someone ever deletes
  // the base card instead of overriding it, a list rendered on a bare page background would lose
  // its frame entirely — the opposite defect. This asserts the base definition survives.
  const base = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(base, /\.gc-call-dialog-list\s*\{[^}]*background:\s*var\(--gc-card\)/, "the stand-alone card definition must stay in styles.css");
});
