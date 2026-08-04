// clients/ui/test/feed_keyboard_pin_v98.test.ts — the soft keyboard must not push the newest message
// out of sight.
//
// Measured on a real device (redroid Android, 393x873 dp, LatinIME, signed superapp APK, 2026-07-31):
// opening a conversation and tapping the composer raised the keyboard, which shrank the visual
// viewport from 801 to 494 CSS px. The feed's own scroller kept `scrollTop = 0` while its content
// stayed 410 px tall inside a 377 px box, so 33 px of the last bubble ("Договорились 👍") were clipped
// behind the composer. The user had to scroll by hand to read the message they had opened the chat to
// answer — on every single reply.
//
// The rule pinned here: while the reader is parked on the newest message, any shrink of the list box
// re-pins the view to the bottom; while the reader is scrolled up in history, a shrink must NOT move
// them. The box is watched (ResizeObserver), not `visualViewport`, so the media tray, the reply banner
// and a growing multi-line composer are covered by the same rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");

test("the feed watches its own box for shrink, and re-pins only when the reader was at the bottom", () => {
  assert.match(src, /ResizeObserver/, "the shrink has to be observed; nothing else reports it");
  const wiring = src.match(/const boxResize[\s\S]{0,220}?boxResize\?\.observe\((\w+)\)/);
  assert.ok(wiring, "the observer must be built and attached in one place");
  assert.equal(wiring![1], "listBox", "the LIST BOX is the thing that shrinks, not the window");
  assert.match(
    wiring![0],
    /pinnedToBottom\s*\)\s*scrollToBottom\(\)/,
    "re-pinning is conditional: a reader scrolled up into history must never be yanked to the end",
  );
  assert.match(wiring![0], /!disposed/, "a torn-down screen must not scroll a detached box");
});

test("the pin flag is the reader's own intent: refreshed on every scroll, asserted on every jump to the end", () => {
  // Matched on effects, not on the literal body: V116 gated this assignment on the box geometry
  // having stayed put (see feed_pin_scroll_intent_v116.test.ts), because the app's own relayout fires
  // a scroll event too and that event says nothing about the reader. The rule this test exists for is
  // that the SCROLL EVENT is what maintains the flag and that it derives it from `isAtBottom()` —
  // both still asserted, now inside the handler's own body.
  const onScroll = src.match(/listBox\.addEventListener\("scroll", \(\) => \{[\s\S]*?\n {2}\}\);/);
  assert.ok(onScroll, "the feed must keep exactly one scroll handler on the list box");
  assert.match(
    onScroll![0],
    /pinnedToBottom = isAtBottom\(\);/,
    "scrolling is the only signal of intent, so it must be the thing that sets the flag",
  );
  // Matched on effects, not on the literal body: V115 appended a late re-assert to the same function
  // (see feed_keyboard_pin_fontscale_v115.test.ts). The rule this test exists for is the two effects
  // below, so it is stated as those two effects and stays honest when the body grows again.
  const jump = src.match(/const scrollToBottom = \(\): void => \{[\s\S]*?\};/);
  assert.ok(jump, "the jump to the end must stay a single named function");
  assert.match(jump![0], /listBox\.scrollTop = listBox\.scrollHeight/, "it must actually go to the end");
  assert.match(
    jump![0],
    /pinnedToBottom = true/,
    "an explicit jump to the end re-arms the pin; otherwise sending a message would unpin the sender",
  );
  const declIdx = src.indexOf("let pinnedToBottom = true;");
  assert.ok(declIdx > 0 && declIdx < src.indexOf("const scrollToBottom"), "declared before first use");
});

test("the observer is feature-detected and disconnected, so no environment and no teardown leaks", () => {
  assert.match(
    src,
    /const RO = \(globalThis as \{[\s\S]{0,200}?\}\)\.ResizeObserver;/,
    "feature-detected off globalThis exactly like virtual_list.ts — the DOM test stub has none",
  );
  assert.match(src, /typeof RO === "function"/, "no ResizeObserver means no observer, not a crash");
  const destroy = src.slice(src.indexOf("destroy() {"));
  assert.match(destroy, /boxResize\?\.disconnect\(\)/, "the observer must die with the screen");
});
