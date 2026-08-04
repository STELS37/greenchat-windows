// clients/ui/test/visual_person_row_v66.test.ts — V66 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile (probes
// var/ux-audit/tools/m_person_v66.mjs, m_cols_v66.mjs, m_section_v66.mjs, 2026-07-30, pointer parked
// off the list because `.gc-call-dialog:hover` translates a row 2px and poisons every x):
//
//   list          row box        disc          text rail   name         subtitle   row height
//   chat list     x=0   w=390    54px  x=12     76px       17px / 600   15px       72px
//   calls list    x=25  w=340    48px  x=29     85px       15px / 700   12px       72px
//
// The same people, opened by the same tap, at the same row height — and not one shared number.
// None of the calls numbers was chosen:
//   1. the 48px disc is `.gc-superapp .gc-avatar` (styles.css:3367, 0,2,0) leaking into a list that
//      never opted in, over `.gc-call-avatar`'s own 42/39px;
//   2. the row grid was `44px minmax(0,1fr) 36px` while the boxes inside were 48px and 34px, so the
//      declared 12px gutter rendered as 8px and 2px of dead space sat at the trailing edge;
//   3. the rail was the container chain, not a decision: body pad 16 + card border 1 + card pad 8.
//
// Reference (Telegram for Android master, read 2026-07-30): CallLogActivity.java:463 does not define
// a row — it holds a ProfileSearchCell, the people-search cell, in `callCellStyle`:
//   height dp(56) vs the dialog cell's dp(70); avatar dp(44) radius dp(22) vs dp(52) radius dp(23);
//   name dp(15) vs dp(17); status dp(13) vs dp(16);
//   nameLeft = statusLeft = dp(AndroidUtilities.leftBaseline) = 72dp in BOTH;
//   width = MeasureSpec.getSize(widthMeasureSpec) — full bleed, with no card in between.
// The reference varies a person row's density but never its rail and never its container.
//
// The guard is textual against the source, like V63/V64/V65: the point of the fix is that ONE token
// owns the disc and the row's tracks are derived from it. A rendering assertion would still pass on a
// build where four separate literals happen to agree today and drift apart tomorrow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const redesign = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const legacy = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8");
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");
const bare = redesign.replace(/\/\*[\s\S]*?\*\//g, "");
const bareTokens = tokens.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level or nested rule in the sheet, as [selector, body] pairs. */
const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = rules(bare);
const matching = (test_: (selector: string) => boolean): Array<[string, string]> =>
  all.filter(([selector]) => test_(selector));

test("V66: the person disc is one token, declared once", () => {
  const declarations = bareTokens.match(/--gc-person-disc\s*:\s*([^;]+);/g) ?? [];
  assert.equal(declarations.length, 1, "the disc must have exactly one owner in tokens.css");
  assert.match(declarations[0]!, /54px/, "the token keeps the measured chat-list disc");
});

test("V66: no person list restates the disc as a literal", () => {
  const personList = /\.gc-(chat-list|forward-list|palette-list|call-dialog-list)\b/;
  const offenders = matching((s) => personList.test(s) && /\.gc-avatar\b/.test(s))
    .filter(([, body]) => /(?:^|;|\s)(?:width|height)\s*:\s*\d/.test(body));
  assert.deepEqual(offenders.map(([s]) => s), [], "a person list's disc must come from the token");
  // …and every one of them does read the token, so the rules are not merely silent about it.
  const users = matching((s) => personList.test(s) && /\.gc-avatar\b/.test(s))
    .filter(([, body]) => /width:\s*var\(--gc-person-disc\)/.test(body));
  assert.ok(users.length >= 3, `expected the disc token in every person list, saw ${users.length}`);
});

test("V66: the calls list is one of them", () => {
  const rule = matching((s) => s.includes(".gc-call-dialog-list") && s.includes(".gc-avatar"));
  assert.ok(rule.length >= 1, "the calls list must size its disc from the token");
  assert.match(rule[0]![1], /width:\s*var\(--gc-person-disc\)/);
  assert.match(rule[0]![1], /height:\s*var\(--gc-person-disc\)/);
});

/**
 * The rules that style the calls row itself — not `.gc-call-dialog-list`, not `-copy`, not a hover
 * or sibling variant. `\b` is deliberately not used: it also matches before the `-` of those names.
 */
const callsRow = matching(
  (s) => /\.gc-calls-section\s+\.gc-call-dialog(?![-\w])(?![^,]*[:+~])/.test(s),
);
/**
 * The sheet layers several rules onto this row on purpose (V45 stripped its card, V57 gave it the
 * divider inset, V66 gives it the chat row's frame), so «one owner» is a claim about the geometry,
 * not about the selector: exactly one rule may decide the row's tracks.
 */
const gridOwners = callsRow.filter(([, body]) => /grid-template-columns\s*:/.test(body));

test("V66: the calls row's side tracks are the boxes that stand in them", () => {
  assert.equal(gridOwners.length, 1, "exactly one rule may own the calls row's tracks");
  const body = gridOwners[0]![1];
  const cols = /grid-template-columns:\s*([^;]+);/.exec(body);
  assert.ok(cols, "the row must state its tracks");
  // Both side tracks are the boxes themselves — tokens, not literals kept in sync by hand.
  assert.match(
    cols![1]!,
    /^var\(--gc-person-disc\)\s+minmax\(0,\s*1fr\)\s+var\(--gc-touch-target\)$/,
    "the tracks must be the disc token and the tap-target token",
  );
});

test("V66: the trailing action has one size, and it is the product's tap target", () => {
  // The 34px box that shipped was not chosen either: styles.css declared this class twice at the
  // same specificity and depth (38px, then 34px), so line order picked the thumb target.
  const bareLegacy = legacy.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = rules(bareLegacy).filter(([s]) => /^\.gc-call-open-icon$/.test(s));
  assert.equal(declarations.length, 1, "the trailing action must be declared exactly once");
  for (const prop of ["width", "height"]) {
    assert.match(
      declarations[0]![1],
      new RegExp(`${prop}:\\s*var\\(--gc-touch-target\\)`),
      `its ${prop} is the tap target, not a literal`,
    );
  }
  // The glyph is derived at the reference's ratio (Telegram: a 24dp glyph in a 48dp box), so a
  // change to the tap target moves the glyph with it.
  const glyph = rules(bareLegacy).filter(([s]) => /^\.gc-call-open-icon \.gc-icon$/.test(s));
  assert.equal(glyph.length, 1, "the glyph must be declared exactly once");
  assert.match(glyph[0]![1], /width:\s*calc\(var\(--gc-touch-target\)\s*\/\s*2\)/);
});

test("V66: the calls row takes the chat row's frame, gap and height", () => {
  const [, body] = gridOwners[0]!;
  assert.match(body, /padding:\s*0\s+var\(--gc-pad\)\s+0\s+12px/, "12px leading / page edge trailing, as V61/V62");
  assert.match(body, /gap:\s*10px/, "the chat row's gap");
  assert.match(body, /min-height:\s*72px/, "the chat row's height");
  // The divider inset is the text rail, derived from the same three numbers, never a literal.
  const inset = /--gc-row-divider-inset:\s*([^;]+);/.exec(body);
  assert.ok(inset, "the row must own its divider inset");
  assert.match(inset![1]!, /calc\(\s*12px\s*\+\s*var\(--gc-person-disc\)\s*\+\s*10px\s*\)/);
});

test("V66: a scrolling list of people is not hosted in a card", () => {
  const section = matching((s) => /\.gc-calls-section$/.test(s));
  assert.ok(section.length >= 1, "the calls section must be flattened on a phone");
  const body = section.map(([, b]) => b).join(";");
  for (const flat of [/border:\s*0/, /box-shadow:\s*none/, /background:\s*transparent/, /padding-inline:\s*0/]) {
    assert.match(body, flat, `the card chrome must go: ${flat}`);
  }
  // The rows reach the screen edge, the heading does not — so this layer never restates --gc-pad,
  // which V62 pins to a single declaration inside the phone breakpoint.
  const list = matching((s) => /\.gc-calls-section\s+\.gc-call-dialog-list\b/.test(s));
  assert.ok(list.length >= 1, "the row list must be withdrawn from the section's page edge");
  assert.match(
    list.map(([, b]) => b).join(";"),
    /margin-inline:\s*calc\(-1 \* var\(--gc-pad\)\)/,
    "the rows reach the page edge",
  );
  assert.ok(
    !/padding-inline:\s*var\(--gc-pad\)/.test(body),
    "the heading keeps the edge the page already gives it, with no second declaration",
  );
});

test("V66: the calls row's type is the chat row's two steps", () => {
  const name = matching((s) => s.includes(".gc-call-dialog-copy strong"));
  assert.ok(name.length >= 1);
  assert.match(name.at(-1)![1], /font-size:\s*var\(--gc-fs-17\)/);
  assert.match(name.at(-1)![1], /font-weight:\s*var\(--gc-weight-semibold\)/);
  const sub = matching((s) => s.includes(".gc-call-dialog-copy span"));
  assert.ok(sub.length >= 1);
  assert.match(sub.at(-1)![1], /font-size:\s*var\(--gc-fs-15\)/);
});
