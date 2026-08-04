// clients/ui/test/visual_thread_states_v89.test.ts — V89 regression guard.
//
// Measured on a FRESH device (no local history cache) at 390x844, probe
// var/ux-audit/tools/m_thread_v89b.mjs, 2026-07-30. Opening a conversation while the history read
// was slow / empty / aborted / 500 produced:
//
//   slow  → a blank 727px page, 0 skeletons — the most-used screen looked broken while it worked;
//   []    → `.gc-feed-empty`: y=384 h=44 w=306 radius 999px rgba(255,255,255,.82) — a toast-shaped
//           capsule floating in the middle of an empty page, serving as the empty state;
//   dead  → THE SAME capsule saying «Пока нет сообщений. Поздоровайтесь!» plus a red line claiming
//           the action was queued. Nothing was queued (reading history is a read) and the chat was
//           not empty — the client had simply received no answer;
//   500   → the same false "empty", a generic toast, and no retry anywhere.
//
// V76 gave the chat list, the calls list and the settings card this vocabulary. This layer gives it
// to the thread: one stage that owns the list's space and shows exactly one of silhouette / empty /
// offline / error, and read failures that never borrow the write-side "queued" wording.
//
// After (same probe): empty → «Здесь пока пусто»; dead → «История не загрузилась» + Повторить;
// 500 → «Не удалось загрузить» + Повторить; slow → 11 visible skeleton nodes, bottom-aligned.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const feed = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");
const css = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));

test("V89: the conversation no longer uses the floating capsule as its empty state", () => {
  assert.ok(!feed.includes('class: "gc-feed-empty"'), "`.gc-feed-empty` is gone from the thread");
  assert.ok(feed.includes('class: "gc-feed-stage"'), "the thread renders a stage instead");
  assert.match(css, /\.gc-feed-stage\s*\{[^}]*flex:\s*1/, "the stage claims the list's free space");
  assert.match(
    css,
    /\.gc-feed-stage\[data-mode="loading"\]\s*\{[^}]*justify-content:\s*flex-end/,
    "the silhouette rests on the composer, as real messages do",
  );
});

test("V89: 'no messages' and 'no answer' are different states", () => {
  assert.match(feed, /let readPhase: "loading" \| "ready" \| "failed"/, "the thread tracks why it is empty");
  // The empty copy may only be reached after the server actually answered.
  const stage = feed.slice(feed.indexOf("const renderStage"), feed.indexOf("// ---- rendering ----"));
  assert.ok(stage.includes('readPhase === "loading"'), "loading is decided before anything is claimed");
  assert.ok(stage.includes('readPhase === "failed"'), "a failed read paints the failure, not the emptiness");
  assert.ok(
    stage.indexOf("state.threadEmptyTitle") > stage.indexOf('readPhase === "failed"'),
    "the empty wording is the LAST branch — it can never win over a failure",
  );
  assert.ok(stage.includes("common.retry"), "a failed read offers the one move that helps");
});

test("V89: a failed history READ never claims the action was queued", () => {
  const load = feed.slice(feed.indexOf("const loadNewest"), feed.indexOf("const loadNewer"));
  assert.ok(!/showStatus\(describeError/.test(load), "read paths dropped the write-side wording");
  assert.ok(/showStatus\(failureLine/.test(load), "a stale refresh says exactly that instead");
  assert.match(load, /readPhase = "failed"/, "with nothing on screen the stage carries the failure");
  assert.match(load, /readPhase = "ready"/, "a successful read unlocks the empty wording");
});

test("V89: the silhouette is painted before the first read, not after it", () => {
  const boot = feed.indexOf("// ---- boot ----");
  const firstLoad = feed.indexOf("loadNewest()", boot);
  const stageCall = feed.indexOf("renderStage();", boot);
  assert.ok(firstLoad > 0, "boot starts the newest-history read");
  assert.ok(stageCall > 0 && stageCall < firstLoad, "renderStage() runs before the network does");
});

test("V89: the silhouette has the shape of a dialogue and honours reduced motion", () => {
  assert.match(css, /\.gc-skeleton-msg\.is-out\s*\{[^}]*justify-content:\s*flex-end/, "two sides, not one column");
  assert.match(css, /\.gc-skeleton-bubble\s*\{[^}]*border-radius:\s*var\(--gc-radius\)/, "bubble corner, from the ramp");
  assert.match(
    css,
    /prefers-reduced-motion: reduce\s*\)\s*\{\s*\.gc-skeleton-bubble\s*\{\s*animation:\s*none/,
    "the shimmer stops when the system asks for less motion",
  );
});

test("V89: both dictionaries carry the new thread wording", () => {
  for (const key of ["state.threadEmptyTitle", "state.threadEmptyBody", "state.threadOfflineTitle"]) {
    assert.ok(key in ru, `ru is missing ${key}`);
    assert.ok(key in en, `en is missing ${key}`);
  }
  assert.ok(!/Поздоровайтесь/.test(ru["state.threadEmptyBody"]!), "the empty copy no longer commands a greeting");
});
