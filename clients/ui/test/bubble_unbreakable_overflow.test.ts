// clients/ui/test/bubble_unbreakable_overflow.test.ts — one message can never pan the whole conversation.
//
// WHAT THIS PINS. Measured 2026-08-04 in Chromium on a throwaway stand, with a message whose text has
// no break opportunity at all — 120 conjoining Hangul L-jamo, which UAX #29 GB6 makes a SINGLE grapheme
// cluster, and CSS may never break inside a grapheme cluster:
//
//   inside a 200px box:  word-break normal / break-all / keep-all -> 1789px;  overflow-wrap anywhere -> 1789px
//
// i.e. the wrapping properties the sheet already declares do not move it by one pixel. They are not
// useless — the strings people really send do wrap (400 latin "A" and a 320-char URL both measured 0px
// of overflow in a 273px bubble) — they simply cannot help here. With nothing containing the paint, the
// text ran out of the bubble across the wallpaper and past the edge of the phone, and since the feed is
// an `overflow: auto` scroller, that single message made the ENTIRE conversation scroll sideways for
// everyone in it:
//
//   390x844 -> feed panned 1541px    320x568 -> 1611px    390x844 at font scale 1.4 -> 2257px
//   after `overflow-x: auto`: 0px in all three, with every other bubble byte-identical in width,
//   height and pinned timestamp
//
// Containment is `auto`, not `hidden`, on purpose: the overflowing text stays reachable by scrolling
// that one bubble. A messenger may clip a message visually, never destroy it. These assertions read the
// shipped sheet, because the defect is entirely a CSS one and no DOM stub can observe painted text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "");
const styles = strip(readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8"));

const bubbleBodyRules = (css: string): string[] =>
  [...css.matchAll(/(^|[},;\s])\.gc-bubble-body\s*\{([^}]*)\}/g)].map((match) => match[2]);

test("a message with no break opportunity is contained instead of painting over the chat", () => {
  const rules = bubbleBodyRules(styles);
  assert.ok(rules.length > 0, "the base sheet must still own the message body rule");
  const declarations = rules.join(" ");

  assert.match(declarations, /overflow-wrap:\s*anywhere/,
    "ordinary long words must keep wrapping — containment is the fallback, not the primary answer");
  assert.match(declarations, /overflow-x:\s*auto/,
    "without this one unbreakable grapheme cluster pans the whole feed sideways (measured 1541-2257px)");
  assert.doesNotMatch(declarations, /overflow-x:\s*hidden/,
    "hidden would silently destroy the tail of a message; auto keeps it reachable");
});

test("the horizontal swipe of one bubble does not chain into the feed or the back gesture", () => {
  const declarations = bubbleBodyRules(styles).join(" ");
  assert.match(declarations, /overscroll-behavior-x:\s*contain/,
    "a bubble that scrolls sideways must not hand the gesture to the feed underneath it");
});

test("no later layer hands the message body back to overflow: visible", () => {
  for (const sheet of ["styles.css", "redesign.css", "brand.css", "message_delivery.css", "shortscreen.css"]) {
    const css = strip(readFileSync(new URL(`../../web/src/${sheet}`, import.meta.url), "utf8"));
    for (const declarations of bubbleBodyRules(css)) {
      assert.doesNotMatch(declarations, /overflow(-x)?:\s*visible/,
        `${sheet} re-opens the message body, which restores the sideways pan`);
    }
  }
});
