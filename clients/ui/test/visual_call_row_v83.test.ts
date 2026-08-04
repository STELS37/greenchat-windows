// clients/ui/test/visual_call_row_v83.test.ts — V83 regression guard.
//
// Defect, measured on the running client at 390x844 (probe var/ux-audit/tools/m_rowgrid_v83.mjs plus
// the V71 rhythm probe, 2026-07-30, pointer parked off the page):
//
//   list        row box          disc            name rail   row height
//   chat list   x=0    w=390     54px at x=12    76px        72px
//   call log    x=16   w=314     48px at x=52    104px       69px
//
// One app, two list grids: switching tabs in the bar shifted every name 28px sideways and resized
// every face, and the call rows floated inside a card the chat rows do not have. The 22px direction
// column in front of the avatar was what pushed that rail out. V66 had already made the "human row"
// a token (`--gc-person-disc`, `0 var(--gc-pad) 0 12px`, gap 10, 72px) and applied it to three
// person lists; the log, added later by V74, invented a fourth.
//
// The same screen also printed its own name twice — header `<h1>Звонки` over section `<h2>Недавние
// звонки` — and the V71 rhythm probe measured 147 of 844 points spent before the first call. That
// row now carries the filter a call log is used with: «Все | Пропущенные», the missed counter in the
// tab badge, drawn with the chat list's underline marker because it is the same object.
//
// Textual guard against the sources, like V63–V67: the claim is that the row's geometry is DERIVED
// from the shared tokens, which a rendering assertion cannot distinguish from four literals that
// happen to agree today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const redesign = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const screen = readFileSync(resolve(here, "../src/screens/calls_screen.ts"), "utf8");
const ru = readFileSync(resolve(here, "../src/locales/ru.ts"), "utf8");
const en = readFileSync(resolve(here, "../src/locales/en.ts"), "utf8");
const bare = redesign.replace(/\/\*[\s\S]*?\*\//g, "");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = rules(bare);
const ROW = /\.gc-call-log-row(?![-\w])/;
const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

test("V83: the log row's tracks are the shared boxes, not literals", () => {
  const owners = all.filter(([s, b]) => ROW.test(s) && /grid-template-columns\s*:/.test(b));
  assert.equal(owners.length, 1, "exactly one rule may own the log row's tracks");
  const cols = decl(owners[0]![1], "grid-template-columns")!;
  assert.match(cols, /var\(--gc-person-disc\)/, `the disc column must read the product token: ${cols}`);
  assert.match(cols, /minmax\(0,\s*1fr\)/, "the copy column stays the elastic one");
  assert.doesNotMatch(cols, /22px/, "the direction column is gone — the mark rides in the meta line");
});

test("V83: the log's disc is the same disc as every other person list", () => {
  const rule = all.filter(([s]) => s.includes(".gc-call-log-list") && s.includes(".gc-avatar"));
  assert.ok(rule.length >= 1, "the log must size its disc from the token");
  assert.match(rule[0]![1], /width:\s*var\(--gc-person-disc\)/);
  assert.match(rule[0]![1], /height:\s*var\(--gc-person-disc\)/);
  const literals = rule.filter(([, b]) => /(?:^|;|\s)(?:width|height)\s*:\s*\d/.test(b));
  assert.deepEqual(literals.map(([s]) => s), [], "no literal may restate the disc");
});

test("V83: on a phone the log row takes the chat row's frame", () => {
  const phone = all.filter(([s, b]) => ROW.test(s) && /min-height:\s*72px/.test(b));
  assert.ok(phone.length >= 1, "the phone layer must state the row's frame");
  const body = phone[0]![1];
  assert.match(decl(body, "padding") ?? "", /0\s+var\(--gc-pad\)\s+0\s+12px/, "the chat row's frame, to the number");
  assert.equal(decl(body, "min-height"), "72px", "the chat row's height");
});

// Follow-up defect, measured after the first V83 landing (probe var/ux-audit/tools/m_rowline_v83.mjs):
// the hairline was an `::after` on the ROW, and a row that carries a redial button is only 330 of the
// 390 points wide — so every line in the log stopped 60px short of the screen edge while the chat
// list's ran to it. Two lists, two geometries, one tab apart. The line now belongs to the ENTRY,
// which is always full width, and rides on its leading edge exactly like `.gc-chat-row + …::after`.
test("V83: the rows reach the screen edge and the hairline spans the whole entry", () => {
  const bleed = all.filter(([s, b]) => s.includes(".gc-call-log-list") && /margin-inline:\s*calc\(-1\s*\*\s*var\(--gc-pad\)\)/.test(b));
  assert.ok(bleed.length >= 1, "a list of people takes the page edge; the card was the defect");

  const token = all.filter(([s, b]) => s.includes(".gc-call-log-list") && /--gc-row-divider-inset/.test(b));
  assert.ok(token.length >= 1, "the inset is declared once, on the list");
  assert.match(
    decl(token[0]![1], "--gc-row-divider-inset") ?? "",
    /12px\s*\+\s*var\(--gc-person-disc\)\s*\+\s*10px/,
    "the hairline starts after the disc, derived from the same numbers as the frame",
  );

  const hair = all.filter(([s, b]) => /\.gc-call-log-line/.test(s) && /\+/.test(s) && /::before/.test(s) && /inset-inline:\s*var\(--gc-row-divider-inset\)\s*0/.test(b));
  assert.equal(hair.length, 1, "exactly one rule may draw the divider, and it must sit on the entry");
  const [sel, body] = hair[0]!;
  assert.match(sel, /\.gc-call-log-line[\s\S]*\+/, "it is a BETWEEN-entries line, so the first entry keeps a clean top");
  assert.match(body, /top:\s*0/, "the line rides the leading edge, like the chat list's");
  assert.match(
    body,
    /background:\s*color-mix\(in srgb, var\(--gc-border\) 60%, transparent\)/,
    "and in the chat list's exact ink, so switching tabs does not change the ink",
  );

  const onRow = all.filter(([s, b]) => ROW.test(s) && /::after/.test(s) && /background/.test(b));
  assert.deepEqual(onRow.map(([s]) => s), [], "no hairline may hang off the row: a redial row is 60px short");
});

test("V83: the direction mark is an inline glyph in the meta line, not a column", () => {
  const arrow = all.filter(([s, b]) => /\.gc-call-log-arrow(?![-\w])/.test(s) && /width\s*:/.test(b))[0]!;
  assert.match(decl(arrow[1], "width") ?? "", /^16px$/, "the mark is type-sized, it no longer holds a rail");
  assert.match(
    screen,
    /class:\s*"gc-call-log-arrow"[\s\S]{0,200}?class:\s*"gc-call-log-outcome"/,
    "the glyph must be rendered next to the words it qualifies",
  );
  assert.match(screen, /gc-call-log-meta"\s*\}\s*,\s*meta\)/, "…and both must live in the meta line");
});

test("V83: the screen states its name once and spends that row on a filter", () => {
  assert.doesNotMatch(screen, /calls\.logTitle/, "the section must not repeat the header's own title");
  assert.doesNotMatch(ru, /"calls\.logTitle"/, "the dead key goes with the heading");
  assert.doesNotMatch(en, /"calls\.logTitle"/, "the dead key goes with the heading");
  assert.match(screen, /class:\s*"gc-tabs gc-call-log-tabs",\s*role:\s*"tablist"/, "the row carries a real tablist");
  for (const key of ["calls.logFilterAll", "calls.logFilterMissed", "calls.logNoMissed", "calls.logNoMissedLead"]) {
    assert.ok(ru.includes(`"${key}"`), `${key} missing from ru`);
    assert.ok(en.includes(`"${key}"`), `${key} missing from en`);
  }
});

test("V83: the filter is a real filter, and its counter rides in the tab", () => {
  assert.match(screen, /logFilter\s*===\s*"missed"\s*\?\s*history\.filter\(\(item\)\s*=>\s*isMissedIncoming\(item\)\)/, "«Пропущенные» must select missed incoming calls");
  assert.match(screen, /class:\s*"gc-tab-badge"/, "the missed count rides in the tab badge (V67 measures it with the label)");
  assert.match(screen, /"aria-selected":\s*logFilter === key \? "true" : "false"/, "the accessible state follows the choice");
  assert.match(screen, /calls\.logNoMissed/, "an empty FILTER says something different from an empty LOG");
});
