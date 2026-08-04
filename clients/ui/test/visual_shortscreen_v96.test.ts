// clients/ui/test/visual_shortscreen_v96.test.ts — V96: a window can be WIDE and still be a phone.
//
// Evidence (signed APK versionCode 1000010, emulator 1080x2400 @ dpr 2.75, route #/chat/16, CDP
// against the device WebView, 2026-07-31). Four states were measured, not assumed:
//
//   portrait  keyboard closed  393 x 801   ok
//   portrait  keyboard open    393 x 494   ok
//   landscape keyboard closed  825 x 345   ok   (.gc-composer bottom 334 <= 345)
//   landscape keyboard OPEN    825 x 115   BROKEN: .gc-feed-main measured 0 px high
//
// In the broken state the thread header measured 74 px and the composer 61 px inside a 94 px pane,
// so the message list was squeezed to nothing and .gc-feed overflowed 33 px above the window. The
// cause is that every "this is a phone" rule in the product is keyed on WIDTH alone
// (`@media (max-width: 760px)`), and 825 px is not narrow — so the desktop two-pane shell, its icon
// rail (246 px of items) and the chat-list header (171 px) were all drawn into 115 px.
//
// This test guards the correction structurally: the layer is the final stylesheet allowed to touch
// the responsive shell, is keyed on HEIGHT, its threshold sits strictly between the two measured
// states, and it frees the three surfaces the measurement blamed. Later component-local layers are
// permitted only when the test proves they cannot override that shell. It is deliberately not a pixel
// test — the numbers above are the pixels.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const sheet = read("../../web/src/shortscreen.css");
const main = read("../../web/src/main.ts");

const deliverySheet = read("../../web/src/message_delivery.css");

/** Measured on the device: the window in which the conversation vanished. */
const BROKEN_HEIGHT_PX = 115;
/** Measured on the device: the shortest window that still rendered correctly. */
const GOOD_HEIGHT_PX = 345;
/** Measured on the device, inside the broken window. */
const THREAD_HEADER_PX = 74;
const COMPOSER_PX = 61;

/** Every `@media (max-height: …)` block in the layer, with the threshold each one is keyed on. */
function shortViewportBlocks(css: string): Array<{ threshold: number; body: string }> {
  const out: Array<{ threshold: number; body: string }> = [];
  for (const head of css.matchAll(/@media\s*\(\s*max-height:\s*(\d+)px\s*\)\s*\{/g)) {
    const start = (head.index ?? 0) + head[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    out.push({ threshold: Number(head[1]), body: css.slice(start, i - 1) });
  }
  assert.ok(out.length > 0, "shortscreen.css must be keyed on viewport HEIGHT, which is what the keyboard takes");
  return out;
}

/** The shell block: the one that reshapes the whole short window (rail, panes, stage). */
function shortViewportBlock(css: string): { threshold: number; body: string } {
  const block = shortViewportBlocks(css).find((b) => /\.gc-app-rail/.test(b.body));
  assert.ok(block, "the short-window layer must still reshape the shell in one height-keyed block");
  return block;
}

/** V114: the separate, tighter block that removes the thread header. */
function headerFoldBlock(css: string): { threshold: number; body: string } {
  const block = shortViewportBlocks(css).find((b) => /\.gc-feed-header[^{}]*\{[^{}]*display:\s*none/.test(b.body));
  assert.ok(block, "the thread header must still be removed in the window where it cannot fit");
  return block;
}

test("V96: no stylesheet after the short-window layer may touch the shell it corrects", () => {
  const order = [...main.matchAll(/^import\s+"([^"]+\.css)";/gm)].map((m) => m[1]);
  const shortscreenIndex = order.indexOf("./shortscreen.css");
  assert.notEqual(shortscreenIndex, -1, "main.ts must load the short-viewport layer");
  const deliveryIndex = order.indexOf("./message_delivery.css");
  assert.notEqual(deliveryIndex, -1, "main.ts must load the delivery-geometry layer");
  assert.equal(
    Math.abs(deliveryIndex - shortscreenIndex),
    1,
    "message_delivery.css must stay adjacent to the final short-viewport correction layer",
  );
  assert.deepEqual(
    order.slice(shortscreenIndex + 1),
    deliveryIndex > shortscreenIndex ? ["./message_delivery.css"] : [],
    "no unrelated stylesheet may load after shortscreen.css",
  );

  for (const shellSelector of [
    ".gc-app-rail",
    ".gc-superapp-detail",
    ".gc-superapp-list",
    ".gc-app-stage",
    ".gc-feed-header",
    ".gc-feed-main",
    ".gc-tabbar",
    ".gc-composer",
  ]) {
    assert.equal(
      deliverySheet.includes(shellSelector),
      false,
      `message_delivery.css must stay component-local and cannot override ${shellSelector}`,
    );
  }
});

test("V96: the threshold sits between the window that broke and the window that worked", () => {
  const { threshold } = shortViewportBlock(sheet);
  assert.ok(
    threshold > BROKEN_HEIGHT_PX,
    `must engage in the measured broken window (${BROKEN_HEIGHT_PX}px), threshold was ${threshold}px`,
  );
  assert.ok(
    threshold < GOOD_HEIGHT_PX,
    `must NOT touch landscape without the keyboard (${GOOD_HEIGHT_PX}px), threshold was ${threshold}px`,
  );
});

test("V96: in a short window the conversation owns the screen", () => {
  const { body } = shortViewportBlock(sheet);
  const hidden = (selector: string): boolean =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^{}]*\\{[^{}]*display:\\s*none`).test(body);

  assert.ok(hidden(".gc-app-rail"), "the icon rail asked for 246px inside a 115px window");
  assert.ok(
    hidden(".gc-superapp-detail .gc-superapp-list"),
    "the chat list pane kept its 171px header next to the open conversation",
  );
  assert.equal(
    hidden(".gc-feed-header"),
    false,
    "V114: at this threshold a 320 dp phone in landscape (296px, no keyboard) still needs its header",
  );
  assert.match(body, /\.gc-feed-main\s*\{[^{}]*overflow-y:\s*auto/, "only the message list may scroll");
  assert.match(body, /\.gc-feed-main\s*\{[^{}]*min-height:\s*0/, "a flex child without min-height:0 cannot shrink");
});

/** Measured on the device: the compacted bar the list routes keep in a short window. */
const COMPACT_NAV_PX = 50;

test("V107: outside a conversation the tab bar survives — a phone has no other navigation", () => {
  // Defect measured on the signed APK (versionCode 1000013, display forced to landscape via
  // `settings put system user_rotation 1`, system font size 2x, window 569 x 272 CSS px): V96 hid
  // `.gc-app-rail` for the whole shell, but at `max-width: 760px` that element IS the bottom tab
  // bar. The probe found exactly one nav-ish box on screen — `.gc-shell-nav`, 0 x 0, inside the
  // hidden rail — so «Звонки», «Кошелёк», «Биржа» and «Ещё» were unreachable until the phone was
  // turned upright. Hiding chrome to make room is right; hiding the only way out is not.
  const { body } = shortViewportBlock(sheet);
  const railRules = [...body.matchAll(/([^{}]*\.gc-app-rail[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(railRules.length >= 1, "the short-window layer still speaks about the rail");
  for (const [, selector, decls] of railRules) {
    if (!/display:\s*none/.test(decls)) continue;
    assert.match(
      selector,
      /\.gc-superapp-detail\b/,
      "the bar may only disappear where a conversation owns the screen, never on a list route",
    );
  }
  const kept = new RegExp(
    String.raw`\.gc-superapp:not\(\.gc-superapp-detail\)[^{}]*\{[^{}]*--gc-mobile-nav:\s*calc\(\s*(\d+)px`,
  ).exec(body);
  assert.ok(kept, "the list routes declare their own, smaller bar height instead of losing the bar");
  const compact = Number(kept[1]);
  assert.equal(compact, COMPACT_NAV_PX, "the compacted bar is the height that was measured to fit");
  // 50 - 2 - 2 padding - 1 border-top = 45: the product's own touch floor (visual_touch_target_v97)
  // survives the compaction. Measured on the device, a 48px bar rendered 43px destinations.
  assert.ok(compact - 5 >= 44, "compacting the bar must not push a destination under the 44px hit floor");
  // 115px was the worst window ever measured. A bar that leaves less than a row of list behind it
  // would trade one unusable screen for another, so the arithmetic is pinned here too.
  assert.ok(BROKEN_HEIGHT_PX - compact >= 60, "a full list row still fits above the compacted bar");
  assert.match(
    body,
    /\.gc-superapp:not\(\.gc-superapp-detail\)[^{}]*\.gc-shell-item-label\s*\{[^{}]*display:\s*none/,
    "it fits because the labels go, not because the touch target shrinks below the icon",
  );
  assert.match(
    body,
    /\.gc-superapp:not\(\.gc-superapp-detail\)\s*\{[^{}]*padding-bottom:\s*var\(--gc-mobile-nav\)/,
    "and the content is padded for the fixed bar, or the last row hides under it",
  );
});

test("V96: hiding the header is arithmetic, not taste", () => {
  // 115 - 61 = 54px is everything a message can have. Keeping even a slimmed 40px header would
  // leave 14px, i.e. the same empty thread the device showed. This guard fails the day someone
  // "restores" a compact header here.
  const room = BROKEN_HEIGHT_PX - COMPOSER_PX;
  assert.ok(room < THREAD_HEADER_PX, "the header alone does not fit next to the composer");
  const { body } = headerFoldBlock(sheet);
  assert.equal(
    /\.gc-feed-header\s*\{[^{}]*height:/.test(body),
    false,
    "no height may be handed back to the thread header in a short window",
  );
});

// ── V114 ───────────────────────────────────────────────────────────────────────────────────────
// The two states measured on the signed APK on the dedicated device (gc-android-p0, `wm density
// 540` = 320 dp, ru-RU, route #/chat/17, CDP, 2026-08-01). The keyboard was proven up by AOSP
// (`mInputShown=true`), not assumed from geometry.
/** 320 dp phone on its side, keyboard CLOSED. V96 hid the header here — with 235px of messages. */
const SMALL_PHONE_LANDSCAPE_PX = 296;
/** The same window with the IME up. Here the header genuinely cannot coexist with the composer. */
const SMALL_PHONE_LANDSCAPE_IME_PX = 112;
/** Measured height of the conversation bar (min-height: 56px, default system font). */
const THREAD_HEADER_MIN_PX = 56;

test("V114: the header goes only when the keyboard took the room, not on a small phone", () => {
  const { threshold } = headerFoldBlock(sheet);
  assert.ok(
    threshold >= SMALL_PHONE_LANDSCAPE_IME_PX,
    `the keyboard-open window (${SMALL_PHONE_LANDSCAPE_IME_PX}px) must still fold the header, threshold was ${threshold}px`,
  );
  assert.ok(
    threshold < SMALL_PHONE_LANDSCAPE_PX,
    `a 320dp phone in landscape with no keyboard (${SMALL_PHONE_LANDSCAPE_PX}px) keeps its header, threshold was ${threshold}px`,
  );
  // And the threshold is not merely "between": at it, a message row must survive next to both
  // pieces of chrome, otherwise the fold is arriving too late.
  const room = threshold - COMPOSER_PX - THREAD_HEADER_MIN_PX;
  assert.ok(room >= 35, `at the threshold a message row (35px) must still fit, only ${room}px left`);
});

test("V114: the shell layer keeps its own, looser threshold", () => {
  // The single-column shell, the hidden rail and the bounded panes are right for every short
  // window; only the header needed a tighter rule. Collapsing the two back into one block is the
  // regression this guards.
  const shell = shortViewportBlock(sheet);
  const header = headerFoldBlock(sheet);
  assert.ok(
    shell.threshold > header.threshold,
    "the header must fold in a strictly smaller window than the shell reshapes in",
  );
  assert.ok(
    shell.threshold > SMALL_PHONE_LANDSCAPE_PX,
    "a 320dp landscape phone still gets the one-column shell it was verified with",
  );
});
