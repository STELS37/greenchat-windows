// clients/ui/test/visual_press_feedback_v171.test.ts — V171 regression guard.
//
// Defect, measured on a seeded stand at 390x844 (probes press_pixels.mjs, realpress.mjs,
// selfcheck.mjs, 2026-08-03; 230 element measurements over 14 routes). The probe forces :active on
// the element AND on its ancestors — a real press activates the whole chain — and then judges the
// PIXELS of the control's own rectangle, so a response through any property counts equally:
//
//   1. The filter strip answered nothing. `.gc-chats-header .gc-tab` («All» / «Archived», 46 px
//      tall) and `.gc-call-log-tabs .gc-tab` («All» / «Missed», 44 px) produced a byte-identical
//      screenshot pressed and unpressed. A real mouse press confirmed it: with the cursor parked on
//      the tab BEFORE the reading (so :hover cannot be mistaken for the answer), not one of
//      backgroundColor / opacity / transform / filter / boxShadow / borderColor moved, on the tab
//      itself or anywhere up its ancestor chain.
//   2. `.gc-calls-section .gc-call-dialog` — the row that starts a call — answered the MOUSE only.
//      It owns a `:hover` wash (`--gc-card-hover`); it owns no `:active` rule, and a finger never
//      hovers. V78 did write a press rule for the call screen, but it named `.gc-call-log-row`, the
//      history line; the dialog row next to it in the same screen was never in the selector list.
//   3. The same V78 group names `.gc-settings-link`, which no screen renders — the selector has
//      been dead since it was written.
//
// Pinned here: a press strip answers even when the pressed tab is ALREADY active (its colour cannot
// change, so the answer must not be colour alone), the call dialog answers a finger and not just a
// mouse, the answer is spelled with the palette tokens the sheet already presses with, motion is
// removed for a reader who asked for less of it while the colour answer survives, and every class
// named in a press group is a class the markup actually renders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const redesignRaw = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const redesign = strip(redesignRaw);
const legacy = strip(readFileSync(resolve(here, "../../web/src/styles.css"), "utf8"));

type Rule = [string, string];
const rules = (css: string): Rule[] => {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
// Document order matters: the last declaration wins, so a later rule can undo an earlier one.
const all: Rule[] = [...rules(legacy), ...rules(redesign)];
const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1]!.trim() : null;
};
// A selector list matches only if the SUBJECT — the last compound of some comma-separated part —
// is the one asked about. Otherwise a rule for a descendant leaks into an assertion about the row.
const subjectHas = (sel: string, needle: string): boolean =>
  sel.split(",").some((part) => {
    const last = part.trim().split(/\s+|>/).filter(Boolean).pop() ?? "";
    return last.includes(needle);
  });
const winner = (needle: string, prop: string): string | null => {
  let value: string | null = null;
  for (const [sel, body] of all) if (subjectHas(sel, needle)) {
    const v = decl(body, prop);
    if (v !== null) value = v;
  }
  return value;
};

// ---- 1. the strip answers the finger ----

test("V171: pressing a list filter tab is visible — on both strips", () => {
  for (const strip2 of [".gc-chats-header .gc-tab", ".gc-call-log-tabs .gc-tab"]) {
    const pressed = all.filter(([sel]) => sel.includes(strip2) && sel.includes(":active"));
    assert.equal(pressed.length > 0, true, `no :active rule for ${strip2}`);
    const paints = pressed.some(([, body]) => decl(body, "background") ?? decl(body, "background-color"));
    assert.equal(paints, true, `${strip2}:active changes nothing that paints`);
  }
});

test("V171: the answer survives on the tab that is already active", () => {
  // The active tab is already accent-coloured, so a colour-only press rule would leave the most
  // likely tap — re-tapping the open filter — silent. The press must paint a surface.
  const pressed = all.filter(([sel]) => sel.includes(".gc-tab") && sel.includes(":active"));
  const surface = pressed.filter(([, body]) => decl(body, "background") ?? decl(body, "background-color"));
  assert.equal(surface.length > 0, true, "the press rule paints no surface");
  const notOnlyActiveTab = surface.some(([sel]) => !sel.includes(".is-active"));
  assert.equal(notOnlyActiveTab, true, "the surface rule is scoped away from the plain tab");
  // and nothing later blanks it back out
  const bg = winner(".gc-tab:active", "background");
  assert.notEqual(bg, "none", "a later rule resets the pressed background to none");
});

// ---- 2. the call dialog answers a finger, not only a mouse ----

test("V171: the call dialog row answers a press, not just a hover", () => {
  const hovers = all.filter(([sel]) => sel.includes(".gc-call-dialog") && sel.includes(":hover"));
  assert.equal(hovers.length > 0, true, "premise gone: the dialog row lost its hover rule");
  const presses = all.filter(([sel]) => sel.includes(".gc-call-dialog") && sel.includes(":active"));
  assert.equal(presses.length > 0, true, ".gc-call-dialog has no :active rule — touch gets nothing");
  const paints = presses.some(([, body]) => decl(body, "background") ?? decl(body, "background-color"));
  assert.equal(paints, true, ".gc-call-dialog:active changes nothing that paints");
});

test("V171: the press rule is declared after the hover rule it has to outrank", () => {
  // Equal specificity: whichever comes last in document order wins while the finger is down.
  const idxHover = redesign.lastIndexOf(".gc-call-dialog:hover");
  const idxActive = redesign.lastIndexOf(".gc-call-dialog:active");
  assert.equal(idxActive > idxHover, true, "the :active rule is written before the :hover rule");
});

// ---- 3. the answer uses the palette the sheet already presses with ----

test("V171: the press is spelled in tokens, not in a fresh literal colour", () => {
  const pressed = all.filter(([sel]) => sel.includes(":active") &&
    (sel.includes(".gc-tab") || sel.includes(".gc-call-dialog")));
  let checked = 0;
  for (const [sel, body] of pressed) {
    assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\(/i.test(body), false, `literal colour in ${sel}`);
    // A rule that only moves the row has no colour to spell; only the painting rules are held to
    // the palette.
    if (!/(^|;)\s*(background|background-color|border-color|border-bottom-color|color)\s*:/.test(body)) continue;
    assert.equal(/var\(--gc-/.test(body), true, `no palette token in ${sel}`);
    checked++;
  }
  assert.equal(checked > 0, true, "no painting press rule was checked at all");
});

// ---- 4. motion is optional, the answer is not ----

test("V171: a reader who asked for less motion keeps the colour answer", () => {
  const MQ = "@media (prefers-reduced-motion: reduce)";
  const blocks: string[] = [];
  for (let i = redesign.indexOf(MQ); i >= 0; i = redesign.indexOf(MQ, i + 1)) {
    let depth = 0;
    let end = redesign.indexOf("{", i);
    for (let j = end; j < redesign.length; j++) {
      if (redesign[j] === "{") depth++;
      else if (redesign[j] === "}" && --depth === 0) { end = j; break; }
    }
    blocks.push(redesign.slice(i, end + 1));
  }
  const covering = blocks.filter((b) => b.includes(".gc-call-dialog"));
  assert.equal(covering.length > 0, true, `no ${MQ} block covers the pressed call dialog`);
  assert.match(covering.join("\n"), /transition:\s*none/);
  // The transform belongs to motion and must be gated; the wash is not motion and must not be.
  // Read the raw sheet here: `redesign` has its comments stripped, so the V171 marker is gone.
  const noPref = redesignRaw.slice(redesignRaw.indexOf("V171:"));
  const gated = /@media \(prefers-reduced-motion: no-preference\)[\s\S]*?transform:\s*scale/.test(noPref);
  assert.equal(gated, true, "the press transform is not gated behind no-preference");
});

// ---- 5. a press group may only name classes the markup renders ----

test("V171: every class in a press group is a class some screen renders", () => {
  // Every screen, not a hand-picked three: a press rule for a class nobody renders is a rule that
  // has never once run, and picking the files by hand is how such a rule stays hidden.
  const dir = resolve(here, "../src/screens");
  const screens = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
  const group = all.find(([sel]) => sel.includes(".gc-chat-row:active") && sel.includes(".gc-more-tile:active"));
  assert.notEqual(group, undefined, "premise gone: the V78 press group was renamed");
  const named = [...group![0].matchAll(/\.(gc-[a-z0-9-]+):active/g)].map((m) => m[1]!);
  const dead = named.filter((cls) => !screens.includes(cls));
  assert.deepEqual(dead, [], `press group names classes nothing renders: ${dead.join(", ")}`);
});
