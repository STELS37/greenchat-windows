// clients/ui/test/visual_bot_center_scroll_v147.test.ts — V147: the Bot Center had no scrollport,
// so every owner control past the first screen was unreachable by any gesture.
//
// Evidence (stand `gc-ui-stand`, own GC_DATA_DIR, port 9320, production untouched; Chromium
// reproducing the Android WebView system font the way this project measures it —
// `--enable-text-autosizing` plus `-webkit-text-size-adjust`, mobile context, deviceScaleFactor 2,
// hasTouch; ru-RU, signed in as the stand owner with 8 bots; probe `probes/bots_trial.mjs` of the
// outbox package, 2026-08-03). Every target was swiped at SIX times with a real
// touchStart/touchMove/touchEnd sequence and then hit-tested at its own centre:
//
//   window / font   state          .gc-bot-center   target                       reachable
//   320x568 / 2.0   list, 8 bots   1478 px tall     last row      y 1291…1446    no
//   320x568 / 2.0   bot card       3809 px tall     «Удалить бота» y 3635…3746   no
//   320x568 / 2.0   create form    1524 px tall     «Создать бота» y 1351…1461   no
//   320x568 / 2.0   empty state     963 px tall     «Создать первого бота»       no
//   390x844 / 1.0   list, 8 bots     — 778 px frame last row      y  797… 889    no
//
// Every one of those runs reported «scrollable surfaces: NONE», and every one of them carried a
// positive control in the same browser, same gesture: «Лицензии» on `#/settings` came to the finger
// each time. So «did not move» is the product, not the tool. 8 of 12 cells were unreachable before,
// 0 of 12 after; where nothing was broken the fix moved nothing (identical coordinates, no scroller
// appears).
//
// Cause, and why `overflow: auto` on the same element did not already save it: `.gc-bot-center` was
// `min-height: 100%` with an auto height, so the box GREW to its content and never had an overflow
// of its own to scroll — 3809 px of content in a 3809 px box. The host `section.gc-superapp-view`
// is `overflow: hidden` (styles.css), so the growth was simply cut off. Sibling screens that behave
// (`.gc-settings`, `.gc-import`, `.gc-server`) take `height: 100%; min-height: 0` instead.
//
// This file pins the SHAPE as the cascade actually resolves it, not the presence of a comment: it
// parses bot_center.css, keeps every rule that names the class, and asks what the last declaration
// in document order says (shorthands expanded, since `overflow: auto` is what sets `overflow-y`
// here). It keeps its meaning if the block is renumbered or moved, and it fails the moment someone
// restores the growing box.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string): string => readFileSync(resolve(here, "../../web/src/", name), "utf8");

interface Rule {
  /** Selector list as written. */
  sel: string;
  /** Declarations of that block. */
  decls: string;
  /** `@media …` chain the rule sits under, empty for an unconditional rule. */
  at: string;
}

/** Comments carry prose naming these very classes, so they go first. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace scanner: enough for these sheets (no nesting, no braces inside values). */
function collectRules(src: string): Rule[] {
  const out: Rule[] = [];
  const stack: { sel: string; start: number; at: string }[] = [];
  let preludeStart = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") {
      const sel = src.slice(preludeStart, i).trim();
      const parentAt = stack.map((s) => s.sel).filter((s) => s.startsWith("@")).join(" ");
      stack.push({ sel, start: i + 1, at: parentAt });
      preludeStart = i + 1;
    } else if (c === "}") {
      const top = stack.pop();
      if (top && !top.sel.startsWith("@")) out.push({ sel: top.sel, decls: src.slice(top.start, i), at: top.at });
      preludeStart = i + 1;
    }
  }
  return out;
}

const botRules = collectRules(stripComments(read("bot_center.css")));
const shellRules = collectRules(stripComments(read("styles.css")));

/** Rules whose selector list names `cls` as a whole class token. */
const rulesFor = (rules: Rule[], cls: string): Rule[] =>
  rules.filter((r) => new RegExp(`\\.${cls}(?![\\w-])`).test(r.sel));

/** The two shorthands that decide scrolling here; both are `x y` with `y` defaulting to `x`. */
const SHORTHANDS: Record<string, [string, string]> = {
  overflow: ["overflow-x", "overflow-y"],
  "overscroll-behavior": ["overscroll-behavior-x", "overscroll-behavior-y"],
};

interface Decl {
  value: string;
  /** `@media …` chain of the winning declaration. */
  at: string;
  /** Selector that wrote it — used to prove which element owns the scrollport. */
  sel: string;
}

/**
 * What the browser ends up applying to `.cls`: the LAST declaration of each property in document
 * order, the rules here being of equal specificity. Shorthands are expanded, so `overflow: auto`
 * answers a question about `overflow-y`.
 */
function resolved(rules: Rule[], cls: string): Map<string, Decl> {
  const out = new Map<string, Decl>();
  for (const r of rulesFor(rules, cls)) {
    for (const m of r.decls.matchAll(/(^|[;{])\s*([-a-z]+)\s*:\s*([^;{}]+)/gi)) {
      const prop = m[2].toLowerCase();
      const value = m[3].trim();
      const parts = SHORTHANDS[prop];
      if (parts) {
        const bits = value.split(/\s+/);
        parts.forEach((p, i) => out.set(p, { value: bits[i] ?? bits[0], at: r.at, sel: r.sel }));
      }
      out.set(prop, { value, at: r.at, sel: r.sel });
    }
  }
  return out;
}

const center = resolved(botRules, "gc-bot-center");

test("V147: the Bot Center takes the height of the frame it lives in, instead of growing past it", () => {
  assert.equal(
    center.get("height")?.value,
    "100%",
    "without a definite height the box grows to its content — measured 3809 px of bot card inside a 568 px window",
  );
  assert.equal(
    center.get("min-height")?.value,
    "0",
    "`min-height: 100%` is what made the box grow; it has to retire, or the height above is a no-op",
  );
});

test("V147: therefore its own `overflow` finally has an overflow to scroll", () => {
  // `overflow: auto` was already there before the fix and scrolled nothing: an element exactly as
  // tall as its content has no overflow. The scrollport is the pair — definite height AND auto
  // overflow — so this test reads both, and refuses a percentage min-height that would undo it.
  assert.match(
    center.get("overflow-y")?.value ?? "",
    /auto|scroll/,
    "the Bot Center must be its own scroll container: the host section is overflow: hidden",
  );
  assert.doesNotMatch(
    center.get("min-height")?.value ?? "0",
    /%/,
    "a percentage min-height re-inflates the box to the frame and kills the scrollport again",
  );
  assert.match(
    center.get("overscroll-behavior-y")?.value ?? "",
    /contain/,
    "a swipe past the end must not drag the shell behind it",
  );
});

test("V147: the bottom safe area stays INSIDE the scrollport, so the last row clears the home bar", () => {
  const scroller = center.get("overflow-y");
  const padding = center.get("padding");
  assert.ok(scroller && padding, "both the scroll and the padding must be declared");
  assert.equal(
    padding?.sel,
    scroller?.sel,
    "the padding must sit on the scrolling element itself; on a parent it would clip the last row",
  );
  assert.match(
    padding?.value ?? "",
    /--gc-safe-bottom/,
    "«Удалить бота» is the last row of the tallest state — it has to clear the gesture bar",
  );
  // The phone block narrows the side padding only. If it ever restated `padding`, the safe area
  // would silently vanish exactly on the devices that have one.
  assert.equal(center.get("padding-bottom"), undefined);
  assert.ok(
    center.get("height")?.at === "" && center.get("min-height")?.at === "",
    "the height that creates the scrollport must not live inside a media query",
  );
});

test("V147: the scrollport is unconditional — not gated by width or by the system font size", () => {
  // The same screen loses its buttons at 390 dp with the shipping default font, so a fix that only
  // fired at `[data-gc-text-zoom="large"]` or inside a `@media` range would leave that case dead.
  for (const prop of ["overflow-y", "overscroll-behavior-y"]) {
    assert.equal(
      center.get(prop)?.at ?? "",
      "",
      `the scrollport must not depend on a media query (${prop})`,
    );
  }
  const gated = rulesFor(botRules, "gc-bot-center").some(
    (r) => /(^|[;{])\s*(height|min-height|overflow)\s*:/i.test(r.decls) && r.sel.includes("data-gc-text-zoom"),
  );
  assert.equal(gated, false, "the scrollport must not depend on the system font size");
});

test("V147: the host section really does clip — which is why the child must scroll itself", () => {
  // This is the precondition, not the fix: it holds on plain HEAD and must keep holding. If the
  // shell ever starts scrolling on its own, the reasoning above should be re-measured rather than
  // silently inherited.
  const view = resolved(shellRules, "gc-superapp-view");
  assert.match(
    view.get("overflow-y")?.value ?? "",
    /hidden|clip/,
    "styles.css keeps the superapp view clipping; a screen that overflows it is simply lost",
  );
});
