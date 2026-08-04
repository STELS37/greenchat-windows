// clients/ui/test/feed_pin_scroll_intent_v116.test.ts — the app's own relayout must not be mistaken
// for the reader scrolling away.
//
// Evidence (signed superapp APK md5 d59bcfde…, redroid Android, 320 dp portrait, ANDROID SYSTEM FONT
// SIZE 2.0x, cold open of the first conversation, CDP against the device WebView, DE2, 2026-08-01).
//
// Measuring this needed care, because the defect is a race and observing it changes it: a polled
// probe failed 4/5, a probe that re-pinned the box passed 16/16, a two-evaluate minimal probe failed
// 4/14. The numbers below therefore come from a probe that only RECORDS — it installs a scroll
// listener and a ResizeObserver that write nothing at all. Under it, 6 of 16 cold starts failed, and
// every failure had the identical signature:
//
//   good   scrollTop 1368.30  scrollHeight 1611  clientHeight 242  gap  0.70  -> newest msg visible
//   bad    scrollTop 1262.81  scrollHeight 1611  clientHeight 242  gap 106.19 -> clipped 85 px
//
// scrollHeight is identical in both, so nothing is sized wrongly. And 1611 - 348 = 1263: the box is
// parked at the exact bottom of the PRE-shrink layout, i.e. it was pinned correctly and then never
// re-pinned after the box became 242 px tall.
//
// The recorded traces show the whole mechanism. During first layout the box shrinks towards 242 px,
// and the outcome depends only on how the browser delivers that shrink:
//
//   passing  348 -> 300 -> 242; the intermediate gaps are 48.19 and 58.19 px, both inside the V115
//            slack of 96 px, so the pin survives each step and the feed's ResizeObserver re-pins:
//            scrollTop 1262.81 -> 1310.81 -> 1368.30
//   failing  348 -> 242 in ONE step; the gap is 106.19 px, outside the 96 px slack, so the scroll
//            handler clears the pin — and the ResizeObserver fires 1 ms later with the final
//            geometry but is suppressed by the very flag that event just cleared
//
// Widening the slack is not the fix: 96 px WAS the widened slack (V115), 106 > 96, and chasing it
// upward starts swallowing genuine intent.
//
// What the traces refuted, and why this file records it: the first hypothesis was "a scroll event
// arrives with scrollTop unchanged, so it carries no intent". That is true in only 3 of the 6 traced
// failures. In the other 3 scrollTop really did change — 1353.78 -> 1262.81 — but that move was the
// browser clamping the offset when scrollHeight shrank 1773 -> 1611, not the reader. Shipping the
// scrollTop-based rule would have fixed half the failures and looked like a fix for all of them.
//
// What all six failures DO share is that the classifying event arrives with the box geometry already
// changed. Hence the rule pinned here: a scroll event on a box that just changed size or content is
// the app's relayout echoed back, and leaves the reader's flag untouched.
//
// Device verification of the rule, without a rebuild (var/ux-audit/tools/m_feed_rule_eval_v116.mjs):
// 40 further cold starts were recorded and replayed through BOTH rules. The shipped rule was
// simulated too and its prediction compared against what the device actually did, so the model
// itself is falsifiable rather than assumed — 40/40 agreement. On those runs the shipped rule lost
// the pin 11 times and every one of them clipped; this rule lost it 0 times. A replay is only valid
// up to the last resize: past the point where the two rules act differently, the recorded trace no
// longer describes the events the device would have produced. The definitive check is still a run
// of the rebuilt APK, which is blocked on the toolchain lock refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");
const handler = src.match(/listBox\.addEventListener\("scroll", \(\) => \{[\s\S]*?\n {2}\}\);/);

test("the pin is only re-answered by a scroll event on a stable box", () => {
  assert.ok(handler, "the feed must keep exactly one scroll handler on the list box");
  const body = handler![0];
  const seed = src.indexOf("let lastSh = listBox.scrollHeight;");
  assert.ok(seed > 0 && seed < src.indexOf(body), "the geometry baseline must be seeded before the handler is live");
  assert.match(src, /let lastCh = listBox\.clientHeight;/, "both dimensions matter: sh moved in 3 failures, ch in all 6");
  assert.match(body, /const relaidOut = sh !== lastSh \|\| ch !== lastCh;/, "either dimension changing disqualifies the event");
  assert.match(body, /if \(!relaidOut\) pinnedToBottom = isAtBottom\(\);/, "a relaid-out box leaves the reader's flag alone");
  assert.match(body, /lastSh = sh;[\s\S]{0,40}lastCh = ch;/, "the baseline must advance, or every later event looks relaid-out");
  // scrollTop is read once and never used to decide intent — that hypothesis was measured and refuted
  assert.doesNotMatch(body, /lastScrollTop/, "the scrollTop-movement rule covered only 3 of 6 failures");
});

test("pagination still runs on every scroll event, including relayout ones", () => {
  // A relayout can genuinely expose an edge; refusing to fetch there would strand the feed with no
  // history. Only the CLASSIFICATION is gated, never the loading.
  const body = handler![0];
  const gated = body.match(/if \(!relaidOut\)[^\n]*/)![0];
  assert.doesNotMatch(gated, /loadOlder|loadNewer/, "loading must not be trapped inside the intent gate");
  assert.match(body, /if \(top < NEAR_EDGE\) void loadOlder\(\);/, "older messages still load at the top edge");
  assert.match(body, /if \(sh - top - ch < NEAR_EDGE\) void loadNewer\(\);/, "newer messages still load at the bottom edge");
});

test("the ResizeObserver re-pin keeps its guard — the fix belongs in the classifier", () => {
  // Deleting `pinnedToBottom` from the observer would also "fix" the 85 px clip, and would yank a
  // reader who is genuinely reading history back to the newest message on every relayout.
  const obs = src.match(/new RO\(\(\) => \{[\s\S]{0,200}?\}\)/);
  assert.ok(obs, "the box must still be observed for size changes");
  assert.match(obs![0], /pinnedToBottom/, "the re-pin must stay conditional on the reader's intent");
  assert.match(obs![0], /!disposed/, "a torn-down screen must not scroll a frame later");
});

// ---- the recorded device traces, replayed against both rules ----
// Scroll events exactly as the passive probe logged them; `st` values are the raw fractional ones.
type Ev = { top: number; sh: number; ch: number };
const SLACK = 96; // Math.max(48, 3 * 32px root font) at Android font size 2.0

const replay = (init: { sh: number; ch: number }, events: Ev[], rule: "v115" | "v116"): boolean => {
  let pinned = true;
  let lastSh = init.sh;
  let lastCh = init.ch;
  for (const e of events) {
    const relaidOut = e.sh !== lastSh || e.ch !== lastCh;
    lastSh = e.sh;
    lastCh = e.ch;
    if (rule === "v115" || !relaidOut) pinned = e.sh - e.top - e.ch < SLACK;
  }
  return pinned;
};

const FRESH = { sh: 0, ch: 0 }; // the box is empty when the handler is registered
// failure 1 of 2 kinds — the box shrinks 348 -> 242 and scrollTop is left alone
const FAIL_STILL: Ev[] = [
  { top: 1262.8148193359375, sh: 1611, ch: 348 },
  { top: 1262.8148193359375, sh: 1611, ch: 242 },
];
// failure 2 of 2 kinds — scrollHeight shrinks 1773 -> 1611 and the BROWSER clamps scrollTop down
const FAIL_CLAMPED: Ev[] = [
  { top: 1353.77783203125, sh: 1773, ch: 419 },
  { top: 1262.8148193359375, sh: 1611, ch: 242 },
];
// the two shapes that already worked, which must keep working byte-for-byte
const PASS_LADDER: Ev[] = [
  { top: 1262.8148193359375, sh: 1611, ch: 300 },
  { top: 1310.8148193359375, sh: 1611, ch: 242 },
  { top: 1368.2962646484375, sh: 1611, ch: 242 },
];
const PASS_DIRECT: Ev[] = [
  { top: 1353.77783203125, sh: 1773, ch: 419 },
  { top: 1368.2962646484375, sh: 1611, ch: 242 },
];

test("the measurements themselves are guarded, so a typo cannot silently pass", () => {
  assert.equal(Math.max(48, 3 * 32), SLACK, "the V115 slack at font size 2.0");
  assert.equal(1611 - 348, 1263, "the bad rest position is the exact bottom of the pre-shrink layout");
  const bad = 1611 - 1262.8148193359375 - 242;
  const good = 1611 - 1368.2962646484375 - 242;
  assert.equal(Math.round(bad), 106, "the resting gap of a failed run");
  assert.equal(Math.round(good), 1, "the resting gap of a good run");
  assert.ok(bad > SLACK, "106 > 96 is precisely why the pin was cleared");
  assert.ok(good < SLACK, "a pinned box rests flush against the end");
  for (const step of [1611 - 1262.8148193359375 - 300, 1611 - 1310.8148193359375 - 242]) {
    assert.ok(step < SLACK, `an intermediate gap of ${Math.round(step)} px stays pinned — this is why it is intermittent`);
  }
});

test("the rule flips the verdict on exactly the failing traces and nothing else", () => {
  assert.equal(replay(FRESH, FAIL_STILL, "v115"), false, "shipped code loses the pin on the one-step shrink");
  assert.equal(replay(FRESH, FAIL_STILL, "v116"), true, "…and V116 keeps it, so the ResizeObserver re-pin can run");
  assert.equal(replay(FRESH, FAIL_CLAMPED, "v115"), false, "shipped code loses the pin on the browser's own clamp");
  assert.equal(replay(FRESH, FAIL_CLAMPED, "v116"), true, "…and V116 keeps it — the scrollTop rule would NOT have");
  for (const [name, trace] of [["ladder", PASS_LADDER], ["direct", PASS_DIRECT]] as const) {
    assert.equal(replay(FRESH, trace, "v115"), true, `${name}: this shape already worked`);
    assert.equal(replay(FRESH, trace, "v116"), true, `${name}: and must keep working unchanged`);
  }
});

test("a reader who genuinely scrolls is still obeyed", () => {
  const settled = { sh: 1611, ch: 242 };
  assert.equal(replay(settled, [{ top: 400, sh: 1611, ch: 242 }], "v116"), false, "scrolling up on a stable box means 'browsing history'");
  assert.equal(
    replay(settled, [{ top: 400, sh: 1611, ch: 242 }, { top: 1368.2962646484375, sh: 1611, ch: 242 }], "v116"),
    true,
    "and scrolling back to the end re-arms the pin",
  );
  // the one-event blind spot is bounded: scrolling is a stream, so the next stable event classifies
  assert.equal(
    replay(settled, [{ top: 400, sh: 1700, ch: 242 }, { top: 390, sh: 1700, ch: 242 }], "v116"),
    false,
    "a reader scrolling while a new message arrives is still recognised on the very next event",
  );
});

test("the evidence stays next to the rule it justifies", () => {
  assert.match(src, /V116/, "the change must be traceable from the source");
  assert.match(src, /clipped\s+(\/\/\s+)?85 px/, "the user-visible cost stays written down");
  assert.match(src, /1611 - 348 = 1263/, "the arithmetic that proves it was a stale pin, not a sizing bug");
  assert.match(src, /only 2 of the 5 failures|only 3 of the 6 failures/, "the refuted hypothesis stays recorded");
});
