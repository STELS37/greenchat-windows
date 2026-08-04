// clients/ui/test/visual_empty_stage_v70.test.ts — V70 regression guard.
//
// Defect, measured on the running client at 390x844 (probes var/ux-audit/tools/m_empty_v70.mjs and
// m_body_v70.mjs, 2026-07-30, pointer parked off the page), identical on /wallet, /exchange, /cards:
//
//   .gc-finance-body      390 x 642.8  y=135.3  display block, padding 10/16/24 → 608.8px free
//   .gc-finance-empty     358 x 260    y=145.3  min-height 260px, white, r24, shadow-sm, 1px border
//   blank below the card  348.8px                                              → 57% of the free area
//
// Two faults, one cause: the empty view was built as a stand-alone CARD with a fixed 260px stage, so it
// (1) floated to wherever the flow put it — the top — leaving more than half the phone blank, and
// (2) wrapped "there is nothing here" in the same plate, border and shadow this product uses for real
// content, which reads as a content card that failed to load rather than as a state.
//
// Reference: the empty view is added to the list's own frame with MATCH_PARENT and centred gravity and
// draws straight on the page background — Telegram for Android mounts EmptyTextProgressView / the
// sticker+text stub that way, so "У вас нет звонков" sits in the middle of the free space with no plate.
//
// Textual guard, like V63–V69: a rendered assertion cannot see the difference between "centred because
// the rule says so" and "centred because today's copy happens to be two lines long", and the routes
// that show this state depend on /v1/config. The claim being frozen is about the rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const legacy = strip(readFileSync(resolve(here, "../../web/src/styles.css"), "utf8"));
const redesign = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));
const financeScreen = readFileSync(resolve(here, "../src/screens/finance_screen.ts"), "utf8");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = [...rules(legacy), ...rules(redesign)];
// V85: the block moved from the screen-local `.gc-finance-empty` to the shared `.gc-state`
// (state_view.ts), so every V70 claim below is now frozen on the shared class. The claims themselves
// are unchanged.
const EMPTY = /\.gc-state(?![-\w])/;
const stage = all.filter(([s, b]) => EMPTY.test(s) && /:only-child/.test(s) && /min-height\s*:\s*100%/.test(b));

test("V70: an empty view that is the whole screen owns the whole free area", () => {
  assert.equal(stage.length, 1, "exactly one rule may turn the empty view into the screen's stage");
  const [selector] = stage[0]!;
  // The rule must be POSITIONAL: only the empty view that is the entire content of a scroll body.
  assert.match(selector, /\.gc-finance-body/, "the finance routes' scroll body");
  assert.match(selector, /\.gc-calls-body/, "and the calls route's, which shares the component");
  assert.match(selector, /:only-child/, "only when nothing else is in that body");
});

test("V70: the stage is not a card — a state must not look like content", () => {
  const [, body] = stage[0]!;
  assert.match(body, /border:\s*0/, "no frame around 'there is nothing here'");
  assert.match(body, /background:\s*none/, "the page background shows through");
  assert.match(body, /box-shadow:\s*none/, "no elevation: nothing is floating above anything");
});

test("V70: the message is centred in the area it now owns", () => {
  // Centring is the component's own, older decision; the stage only makes the area big enough for it
  // to be visible. Guard it here so a later layer cannot silently drop it and leave a top-aligned
  // message on a full-height transparent stage — the worst of both states.
  const centred = all.filter(([s, b]) =>
    EMPTY.test(s) && !/:only-child/.test(s)
    && /flex-direction:\s*column/.test(b) && /justify-content:\s*center/.test(b) && /align-items:\s*center/.test(b));
  assert.ok(centred.length >= 1, "the empty view centres its icon, title and text on both axes");
});

test("V70: a nested empty view keeps its in-card behaviour", () => {
  // .gc-calls-section / .gc-finance-section already are cards, so a state placed inside one must not
  // reserve the stand-alone stage. V85 states this positionally instead of per-section: a state that
  // has siblings is not the screen, so it drops the stage. That rule must exist and the stage rule
  // must not reach into a section.
  const nested = all.filter(([s, b]) =>
    EMPTY.test(s) && /:not\(:only-child\)/.test(s) && /min-height:\s*0/.test(b));
  assert.ok(nested.length >= 1, "an empty view that is not alone still has no stand-alone stage");
  assert.ok(!/\.gc-(calls|finance)-section/.test(stage[0]![0]!), "the stage rule does not touch nested empty views");
});

test("V70: the screen really renders the empty view as the body's only child", () => {
  // :only-child is only correct because both mount sites clear the body first. If a future change
  // appends a sibling, this guard fails and the stage rule must be revisited rather than silently lost.
  // V85 split the two paths: the contour-off path still mounts `emptyState`, while the failure path
  // mounts `failureState` so an unreachable server and a refused request stop looking alike. Both
  // still clear the body first, which is the only reason `:only-child` is correct.
  const mounts = [...financeScreen.matchAll(/clear\(body\);(?:\s*\/\/[^\n]*)*\s*\n\s*body\.append\(\s*\n?\s*(?:emptyState|failureState|featureOff)/g)];
  assert.ok(mounts.length >= 2, "both the error path and the contour-off path clear the body first");
});
