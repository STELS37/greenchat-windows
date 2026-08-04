// clients/ui/test/visual_row_grid_v61.test.ts — V61 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (probe var/ux-audit/tools/m_row_v61.mjs, 2026-07-30):
//
//   list padding   7px 7px 18px            row box at x=7
//   row border     1px solid transparent   +1
//   row padding    0 16px                  +16   avatar disc at x=24
//   .gc-chat-open  padding 1px 6px         +6    text column at x=96
//
//   -> leading frame 24px to the avatar, trailing frame 30px to the timestamp (asymmetric by the
//      6px nobody chose: `.gc-chat-open` is a <button> and styles.css clears its background,
//      border, colour and font but never its UA padding)
//   -> text column x=96 w=264 on a 390px screen = 67.7%; 3 of 4 previews clipped, the longest
//      asking 350px for 236
//
// Reference (Telegram for Android master, DialogCell.java / Theme.java, read 2026-07-30):
// avatarStart 11dp, avatar 52dp, messagePaddingStart 72dp, time inset dp(15), cell 70dp,
// name 17dp, time 12dp, unread counter 13dp. After the fix: avatar 12, text 76, width 298 (76.4%),
// trailing 16, pitch 72, time 12px, counter 13px.
//
// The guard is textual against redesign.css because the fix is a set of DECLARATIONS that must
// actively withdraw earlier ones (the list's lateral padding, the transparent border, the inter-row
// margin, the UA button padding). Only the source can prove they are cleared rather than merely
// absent from one rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

const APP_SCOPE = String.raw`(?:\.gc-superapp|:is\([^)]*\.gc-superapp[^)]*\))`;

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

const ROW = String.raw`\.gc-chat-row`;
const LIST = String.raw`\.gc-chat-list`;
const OPEN = String.raw`\.gc-chat-open`;

test("the row is the only box that owns the horizontal inset", () => {
  // Four boxes contributed to one inset before this layer. Three of them are withdrawn here.
  assert.match(winning(LIST), /padding-inline:\s*0\s*(;|$)/m, "the list must stop adding a lateral inset of its own");
  const row = winning(ROW);
  assert.match(row, /border:\s*0\s*(;|$)/m, "the 1px transparent border silently widened the frame");
  assert.match(row, /margin-block:\s*0\s*(;|$)/m, "a 2px gap between rows is neither spacing nor a separator");
  assert.match(winning(OPEN), /padding:\s*0\s*(;|$)/m, "the <button> UA padding positioned the text column");
});

test("the frame is 12px leading / 16px trailing, so the disc and the text are optically equal", () => {
  // One shorthand, in one direction: `padding-inline: <start> <end>`. Two separate declarations
  // would let a later edit move one side and leave the other, which is how 24/30 happened.
  assert.match(
    winning(ROW),
    /padding-inline:\s*12px\s+16px\s*(;|$)/m,
    "the leading frame holds a circle and the trailing frame holds text; the reference splits them 11dp/15dp",
  );
  assert.match(winning(ROW), /gap:\s*10px\s*(;|$)/m, "12 + 54 avatar + 10 gap = the 76px text column start");
});

test("the separator inset is the text column start, from one declaration", () => {
  const declaring = blocksMatching(ROW).filter((b) => /--gc-row-divider-inset:\s*76px/.test(b));
  assert.equal(declaring.length, 1, "the chat list must take its separator inset from exactly one declaration");
  assert.match(declaring[0]!, /position:\s*relative/, "the row must be the containing block of its own hairline");

  // ::before is taken twice on this row already (the withdrawn V57 divider sets content: none, and
  // .is-active paints the accent rail), so the hairline has to live on ::after.
  const line = winning(String.raw`\.gc-chat-row \+ \.gc-chat-row::after`);
  assert.match(line, /content:\s*""/, "the separator needs a rendered pseudo-element");
  assert.match(line, /height:\s*1px/, "anything thicker than a hairline reads as a table rule");
  assert.match(line, /inset-inline-start:\s*var\(--gc-row-divider-inset\)/, "the inset must be logical so RTL stays correct");
  assert.match(line, /inset-inline-end:\s*0/, "the line still reaches the trailing edge");
});

test("a full-bleed row does not pretend to have corners", () => {
  assert.match(winning(ROW), /border-radius:\s*0\s*(;|$)/m, "the 17px pill was only ever visible on hover, a state a phone has not got");
});

test("the unread counter is not typographically smaller than the timestamp", () => {
  // Measured before: time 13px, counter 11px — the least important element in the row two ramp
  // steps above the one the user is looking for. Reference: 12dp and 13dp.
  assert.match(winning(String.raw`\.gc-chat-row \.gc-row-time`), /font-size:\s*var\(--gc-fs-12\)/, "the timestamp takes the 12px step");
  assert.match(winning(String.raw`\.gc-chat-row \.gc-badge`), /font-size:\s*var\(--gc-fs-13\)/, "the counter takes the 13px step");
});
