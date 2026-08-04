// clients/ui/test/feed_short_window_v118.test.ts — on a short window the conversation must outrank
// the conversation's own chrome.
//
// Evidence (signed superapp APK sha256 c53407eb…, device gc-android-p0, redroid Android, ru-RU,
// route #/chat/17, REAL soft keyboard up, CDP against the device WebView, DE2, 2026-08-01). The
// anatomy probe var/ux-audit/tools/m_shortcol_v118.mjs only reads — a probe that scrolls or re-pins
// answers its own question, which is how the V116 defect first hid itself.
//
//   case                      window     header   pinned   composer   .gc-feed-main   newest bubble
//   320 dp landscape  fs1.0   664 x 112     — ¹     48       60.9         3.1 px       11 px under it
//   320 dp portrait   fs2.0   320 x 393   210.3     48      134.9         0.0 px       14 px under it
//   ¹ hidden by shortscreen.css V114, correctly
//
// This is NOT the V98/V115/V116 pin: both probes report scrollHeight - scrollTop - clientHeight = 0,
// so the scroller is at its end and the box itself reaches under the composer. It is static layout.
// `.gc-feed-list` cannot give the space back either: a border box is never shorter than its own
// padding, and `padding: 14px 10px 20px` therefore floors the messages box at 34 px whatever
// `min-height: 0` says. At 320 dp portrait the pane is 0 px tall and — 393 px matches no media query
// in shortscreen.css — `overflow: visible`, so those 34 px are painted straight over the composer.
//
// Why the threshold is in TypeScript and not in a media query: it has to follow the Android system
// font size, and a media query cannot see it. Measured on the same device at font size 2.0x with
// var/ux-audit/tools/m_mqem_v118.mjs (binary search over `(min-height: N em)`): em resolves to
// 15.99 px while the root font is 32 px. The window is no help by itself either — 320 dp portrait
// with the IME up is 393 px at 1.0x, 1.3x and 2.0x alike, and only 2.0x fails. Their RATIO is the
// one signal that separates the cases, so that is what the rule reads.
//
// Verified on the running artifact before any rebuild (candidate stylesheet injected verbatim plus
// the same predicate installed with its listeners — var/ux-audit/tools/m_cramped_v118.mjs):
// 320 dp landscape 1.0x went from `FAIL … buried by 11px` to
// `ok: IME up (viewport 296->112, -184px), newest message bottom 45 above composer top 51`, with the
// watcher recording the decision it made on the way: 296 px = 18.5 units -> chrome kept,
// 112 px = 7.0 units -> chrome dropped. The full re-run is in var/ux-audit/v118/runs/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");
const css = readFileSync(resolve(here, "../../web/src/shortscreen.css"), "utf8");

test("the threshold is expressed in root-font units, because that is the only font-size-aware signal", () => {
  const fn = src.match(/const windowIsCramped = \(\): boolean => \{[\s\S]{0,900}?\n {2}\};/);
  assert.ok(fn, "the decision must live in one named place, not be inlined at each call site");
  assert.match(src, /const CRAMPED_UNITS = 14;/, "the threshold is a named constant, not a magic number");
  assert.match(fn![0], /CRAMPED_UNITS \* unit/, "the window is compared against N root fonts, not against pixels");
  assert.match(fn![0], /getComputedStyle\(document\.documentElement\)\.fontSize/, "the root font is what Android scales");
  assert.match(fn![0], /typeof getComputedStyle === "function"/, "the DOM test stub has none; it must not crash there");
  assert.match(fn![0], /: 16;/, "an unreadable font size falls back to the browser default, it does not disable the rule");
  assert.match(fn![0], /innerHeight/, "the Android WebView RESIZES the window when the IME opens (measured 801 -> 393)");
  assert.match(fn![0], /visualViewport\?\.height/, "a shell where the IME only overlays moves this one instead");
  assert.match(fn![0], /Math\.min\(\.\.\.heights\)/, "whichever viewport is smaller is the one the user can see");
  assert.match(fn![0], /if \(heights\.length === 0\) return false;/, "a shell with no layout keeps the full chrome");
});

test("the class is the only thing written, and only when the answer changes", () => {
  assert.match(src, /root\.classList\.toggle\("is-cramped", cramped\)/, "one class on the thread root, nothing else");
  const sync = src.match(/const syncCramped = \(\): void => \{[\s\S]{0,400}?\n {2}\};/);
  assert.ok(sync, "the toggle must be a single named function");
  assert.match(sync![0], /if \(cramped === crampedNow\) return;/, "V113b: do not touch the DOM on every frame of a rotation");
  // The predicate reads the window and the root font; the class changes neither. Without that the
  // rule would be a feedback loop — hide the chrome, the box grows, re-decide, show it again.
  assert.doesNotMatch(
    src.match(/const windowIsCramped[\s\S]{0,900}?\n {2}\};/)![0],
    /is-cramped|getBoundingClientRect|clientHeight/,
    "the decision must not read anything the class itself changes",
  );
  const build = src.indexOf("syncCramped(); // decided before insertion");
  assert.ok(build > 0 && build < src.indexOf("backBtn.addEventListener"), "decided before the first paint, not after it");
});

test("the listeners live and die with the screen", () => {
  assert.match(src, /shortWindowView\.addEventListener\?\.\("resize", onWindowResize\)/, "the window resize is the IME signal");
  assert.match(src, /shortWindowView\.visualViewport\?\.addEventListener\?\.\("resize", onWindowResize\)/, "…and the overlay case");
  assert.match(src, /const onWindowResize = \(\): void => \{ if \(!disposed\) syncCramped\(\); \};/, "a torn-down screen must not re-decide");
  const destroy = src.slice(src.indexOf("destroy() {"));
  assert.match(destroy, /shortWindowView\.removeEventListener\?\.\("resize", onWindowResize\)/, "no leak on the window");
  assert.match(destroy, /shortWindowView\.visualViewport\?\.removeEventListener\?\.\("resize", onWindowResize\)/, "no leak on the viewport");
});

test("the stylesheet drops exactly the two optional pieces of chrome, and outranks the layer that sets them", () => {
  const block = css.slice(css.indexOf("V118"));
  assert.match(block, /\.gc-feed\.is-cramped \.gc-feed-header,\s*\n\.gc-feed\.is-cramped \.gc-feed-pinned \{ display: none; \}/,
    "header and pinned bar are the optional chrome; the composer and the messages are not");
  assert.match(block, /\.gc-feed\.is-cramped \.gc-feed-list \{[\s\S]{0,120}padding-block: 4px 6px;/,
    "the 34 px padding floor is the other half of the defect");
  assert.match(block, /scroll-padding-block: 6px;/, "scroll padding must follow the padding, or the pin lands short");
  // Specificity is load-bearing: redesign.css sets `display: flex` on the pinned bar through
  // `:is(.gc-superapp, …) .gc-feed-pinned` (0-2-0) and this sheet loads last, so 0-3-0 is required.
  const rule = block.match(/\.gc-feed\.is-cramped \.gc-feed-pinned/)![0];
  assert.equal(rule.split(".").length - 1, 3, "two classes on the root plus one on the child beats the 0-2-0 layer");
  // The rule must NOT be wrapped in a media query — that is the mistake it exists to correct.
  // Checked by brace balance rather than by proximity, with comments stripped first (this file's
  // comments are full of quoted CSS, braces included).
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const upto = code.slice(0, code.indexOf(".gc-feed.is-cramped"));
  assert.ok(upto.includes("@media"), "the sheet does use media queries, so the check below is meaningful");
  assert.equal(
    (upto.match(/\{/g) ?? []).length - (upto.match(/\}/g) ?? []).length,
    0,
    "the rule sits at top level: a media query cannot see the Android font size (measured: MQ em = 15.99 px at root font 32 px)",
  );
});

// ---- the measured matrix, replayed against the shipped predicate ----
// Every cell of the 18-cell P0-5 matrix with the IME up, and the verdict the artifact gave before
// this change (var/ux-audit/p0-apk-v116/driver.log).
const CRAMPED_UNITS = 14;
const cramped = (windowPx: number, rootPx: number): boolean => windowPx < CRAMPED_UNITS * rootPx;

type Cell = { dp: number; land: boolean; fs: number; rootPx: number; windowPx: number; passed: boolean };
const MATRIX: Cell[] = [
  { dp: 320, land: false, fs: 1.0, rootPx: 16, windowPx: 393, passed: true },
  { dp: 320, land: false, fs: 1.3, rootPx: 20.8, windowPx: 393, passed: true },
  { dp: 320, land: false, fs: 2.0, rootPx: 32, windowPx: 393, passed: false },
  { dp: 320, land: true, fs: 1.0, rootPx: 16, windowPx: 112, passed: false },
  { dp: 320, land: true, fs: 1.3, rootPx: 20.8, windowPx: 112, passed: false },
  { dp: 320, land: true, fs: 2.0, rootPx: 32, windowPx: 112, passed: false },
  { dp: 390, land: false, fs: 1.0, rootPx: 16, windowPx: 513, passed: true },
  { dp: 390, land: false, fs: 1.3, rootPx: 20.8, windowPx: 513, passed: true },
  { dp: 390, land: false, fs: 2.0, rootPx: 32, windowPx: 513, passed: true },
  { dp: 390, land: true, fs: 1.0, rootPx: 16, windowPx: 154, passed: true },
  { dp: 390, land: true, fs: 1.3, rootPx: 20.8, windowPx: 154, passed: true },
  { dp: 390, land: true, fs: 2.0, rootPx: 32, windowPx: 154, passed: true },
  { dp: 430, land: false, fs: 1.0, rootPx: 16, windowPx: 577, passed: true },
  { dp: 430, land: false, fs: 1.3, rootPx: 20.8, windowPx: 577, passed: true },
  { dp: 430, land: false, fs: 2.0, rootPx: 32, windowPx: 577, passed: true },
  { dp: 430, land: true, fs: 1.0, rootPx: 16, windowPx: 176, passed: true },
  { dp: 430, land: true, fs: 1.3, rootPx: 20.8, windowPx: 176, passed: true },
  { dp: 430, land: true, fs: 2.0, rootPx: 32, windowPx: 176, passed: true },
];

test("the threshold catches every measured failure and no passing portrait", () => {
  assert.equal(MATRIX.length, 18, "the matrix is 18 cells; a dropped row must not weaken the guard");
  for (const c of MATRIX.filter((x) => !x.passed)) {
    assert.ok(cramped(c.windowPx, c.rootPx), `${c.dp} dp ${c.land ? "landscape" : "portrait"} ${c.fs}x failed and must engage`);
  }
  // Portrait keeps the header wherever it already worked: hiding it is the visible cost of this rule
  // and must be paid only where the alternative is no conversation at all.
  for (const c of MATRIX.filter((x) => x.passed && !x.land)) {
    assert.ok(!cramped(c.windowPx, c.rootPx), `${c.dp} dp portrait ${c.fs}x passed as shipped and must be left alone`);
  }
  // The band the constant sits in, stated as numbers so a future edit has to argue with them.
  const worstFailing = Math.max(...MATRIX.filter((x) => !x.passed).map((c) => c.windowPx / c.rootPx));
  const bestPassingPortrait = Math.min(...MATRIX.filter((x) => x.passed && !x.land).map((c) => c.windowPx / c.rootPx));
  assert.equal(Math.round(worstFailing * 10) / 10, 12.3, "320 dp portrait at 2.0x — the tightest failure");
  assert.equal(Math.round(bestPassingPortrait * 10) / 10, 16, "390 dp portrait at 2.0x — the nearest case that must not move");
  assert.ok(worstFailing < CRAMPED_UNITS && CRAMPED_UNITS < bestPassingPortrait, "14 lies inside the measured band");
});

test("landscape cells that already passed may engage — they only gain space", () => {
  // At 154 and 176 px the header is already gone (V114's 200 px rule), so all the class adds there is
  // the 48 px pinned bar and 24 px of padding, on a pane that was 46 and 68 px. Nothing is taken away
  // that the window can afford, which is why the rule is allowed to be this simple.
  for (const c of MATRIX.filter((x) => x.land && x.passed)) {
    assert.ok(cramped(c.windowPx, c.rootPx), `${c.dp} dp landscape ${c.fs}x is short by any measure`);
    assert.ok(c.windowPx <= 200, "…and its header was already hidden by V114, so only the pinned bar is new");
  }
});

test("V114's own defect must not come back through this rule", () => {
  // V114 exists because V96 hid the thread header on a 320 dp phone in landscape with NO keyboard —
  // 296 px, and the user lost the back button, the name and the call button while 235 px of messages
  // were painted normally. That state must stay untouched at a normal text size…
  assert.ok(!cramped(296, 16), "320 dp landscape, keyboard closed, 1.0x: 18.5 units — the header stays");
  assert.ok(!cramped(296, 20.8), "…and at 1.3x: 14.2 units — still stays");
  // …and must yield only where the chrome genuinely cannot fit: at 2.0x the header alone is ~210 px
  // of a 296 px window, so keeping it would leave the conversation nothing.
  assert.ok(cramped(296, 32), "320 dp landscape, keyboard closed, 2.0x: 9.3 units — the chrome cannot fit");
});

test("the arithmetic of the defect and of the fix", () => {
  // before: the chrome alone fills the window, and the list cannot shrink into what is left
  assert.equal(Math.round((48 + 60.9) * 10) / 10, 108.9, "landscape: pinned bar + composer of a 112 px window");
  assert.equal(Math.round(112 - 108.9), 3, "…leaving 3 px for the messages");
  assert.equal(14 + 20, 34, "…against a padding floor of 34 px, which is why 11 px ended up under the composer");
  assert.equal(Math.round((210.3 + 48 + 134.9) * 10) / 10, 393.2, "portrait 2.0x: the chrome is the whole 393 px window");
  // after: the pane clears the floor in both, with room for the message itself
  assert.equal(112 - 61, 51, "landscape: dropping the pinned bar leaves 51 px — measured 0..51 on the device");
  assert.equal(51 - (4 + 6), 41, "…of which 41 px are the message, not padding");
  assert.equal(393 - 135, 258, "portrait 2.0x: dropping header and pinned bar leaves 258 px instead of 0");
});
