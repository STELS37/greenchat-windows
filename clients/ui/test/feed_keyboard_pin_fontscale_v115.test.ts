// clients/ui/test/feed_keyboard_pin_fontscale_v115.test.ts — a large system font must not cost the
// reader the message they opened the chat to read.
//
// Evidence (signed superapp APK, redroid Android, 320 dp portrait, ANDROID SYSTEM FONT SIZE 2.0x,
// route #/chat/17, CDP against the device WebView, DE2, 2026-08-01). Nothing here is inferred:
//
//   keyboard down  .gc-feed-list scrollTop 748, max 1052 -> box scrolled with 57 px still to go,
//                  with no scrolling by the user at all; last bubble bottom 543 vs box bottom 505,
//                  so 38 px of the newest message were already behind the composer
//   keyboard up    viewport 640 -> 393, box clientHeight 333 -> 86, scrollTop stayed 748,
//                  last bubble bottom 543 vs composer top 258 => buried by 285 px
//
// Why it happened: `isAtBottom()` allowed a fixed 48 px of slack. At 1.0x the feed settles within
// that slack, so the reader stays classified as "parked on the newest message" and the keyboard
// re-pin fires. At 2.0x one line of text is ~96 px tall, the resting gap was 57 px, and 57 > 48 —
// so the reader was silently reclassified as "browsing history" and the re-pin was suppressed.
//
// The cause was isolated ON THE DEVICE rather than argued: forcing a genuine bottom (gap 0) and
// raising the very same keyboard left the newest bubble at 238 px against a composer top of 258 px,
// fully visible. The only difference between the failing and the passing run was that classification.
//
// Two rules are pinned here, one per half of the defect:
//   1. the "still at the bottom" slack scales with the root font size, and never drops below the
//      original constant, so 1.0x behaviour is unchanged;
//   2. the pin is re-applied after layout settles, because the height that clipped the last bubble
//      is only known a frame later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");

test("the 'at the bottom' slack scales with the system font size", () => {
  const fn = src.match(/const bottomSlack = \(\): number => \{[\s\S]{0,600}?\n  \};/);
  assert.ok(fn, "the slack must be computed in one named place, not inlined at each call site");
  assert.match(fn![0], /getComputedStyle/, "the only honest source of the effective text size is the computed root style");
  assert.match(fn![0], /documentElement/, "the ROOT font size is what the Android font-size setting scales");
  assert.match(fn![0], /Math\.max\(\s*AT_BOTTOM\s*,/, "the scaled slack must never be SMALLER than the original constant");
  assert.match(fn![0], /typeof getComputedStyle === "function"/, "the DOM test stub has no getComputedStyle; it must not crash there");
  assert.match(fn![0], /Number\.isFinite\(root\)/, "a NaN font size must fall back, not poison the comparison");
});

test("isAtBottom uses the scaled slack, not the raw constant", () => {
  const line = src.match(/const isAtBottom = \(\): boolean => [^\n]+/);
  assert.ok(line, "isAtBottom must still exist as the single classifier");
  assert.match(line![0], /bottomSlack\(\)/, "the classifier must consult the scaled slack");
  assert.doesNotMatch(line![0], /<\s*AT_BOTTOM/, "the fixed 48 px comparison is exactly what buried the message at 2.0x");
});

test("the 2.0x measurement would now classify the reader as parked at the bottom", () => {
  // the numbers read off the device, replayed against the rule the source now encodes
  const rootFontPx = 32; // 16 px * Android font size 2.0
  const AT_BOTTOM = 48;
  const slack = Math.max(AT_BOTTOM, rootFontPx * 3);
  const restingGap = 1138 - 748 - 333; // scrollHeight - scrollTop - clientHeight, keyboard down
  assert.equal(restingGap, 57, "guard the measurement itself, so a typo here cannot silently pass");
  assert.ok(restingGap < slack, `57 px must count as the bottom at 2.0x (slack ${slack})`);
  // and the 1.0x case must be unaffected: the old constant still governs ordinary text
  assert.equal(Math.max(AT_BOTTOM, 16 * 3), 48, "at 1.0x the slack must stay exactly the shipped 48 px");
});

test("the pin is re-applied after layout settles", () => {
  const fn = src.match(/const reassertPin = \(\): void => \{[\s\S]{0,700}?\n  \};/);
  assert.ok(fn, "the late re-pin must exist: at rest 38 px of the newest bubble were still clipped");
  assert.match(fn![0], /requestAnimationFrame/, "the settled height is only knowable on the next frame");
  assert.match(fn![0], /typeof requestAnimationFrame !== "function"/, "the DOM test stub has no rAF; it must no-op there");
  assert.match(fn![0], /!pinnedToBottom/, "a reader who scrolled away in the meantime must NOT be yanked to the end");
  assert.match(fn![0], /disposed/, "a torn-down screen must not touch the DOM a frame later");
  assert.match(
    src,
    /const scrollToBottom = \(\): void => \{[^\n]*reassertPin\(\)/,
    "every existing pin site must get the late correction, not just the keyboard one",
  );
});
