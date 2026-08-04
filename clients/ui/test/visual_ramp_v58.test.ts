// clients/ui/test/visual_ramp_v58.test.ts — V58 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (/tmp/audit58.mjs and /tmp/probe_md.mjs, 2026-07-30). The shell had no geometry ramp and no weight
// ramp at all — it had a pile of hand-typed numbers:
//
//   * 26 distinct border-radius values across the app stylesheets: 2, 4, 6, 9, 10, 11, 12, 13, 14,
//     15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30 px and 999px. Adjacent
//     surfaces differed by one pixel (14 next to 15 next to 16 next to 17), which reads as
//     "assembled by different people" rather than as a design.
//   * 18 distinct numeric font-weights: 400, 500, 550, 560, 600, 620, 650, 680, 700, 720, 750, 760,
//     780, 800, 820, 840, 850, 860. A title was 650 on one screen and 620 on the next.
//   * `--gc-radius-md` was REFERENCED twice and DEFINED nowhere. With no fallback, the whole
//     declaration is invalid and dropped, so `.gc-connector-code` measured `border-radius: 0px` —
//     a square code block among rounded surfaces. Verified by probe before the fix: 0px, and the
//     token resolved to the empty string.
//
// Cure: one radius ramp (4 / 8 / 12 / 17 / 24 / 32 / pill) and one weight ramp
// (400 / 500 / 600 / 700 / 800) declared in tokens.css, every stray value snapped to its nearest
// step, and the phantom token deleted rather than defined. Verified after the fix on the running
// client, counting only VISIBLE elements: weights per screen came from {400, 500, 600, 700, 800}
// and radii from {8, 12, 17, 24, 50%, 999} — 10 distinct weights became 5 and 12 distinct radii
// became 6.
//
// This guard deliberately checks the STYLESHEET TEXT rather than one selector: the defect is not
// located in any single rule, it is the re-appearance of an off-ramp number anywhere. A new
// hand-typed `border-radius: 15px` or `font-weight: 650` fails here, which is the whole point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
  // Comments carry the example values this very guard forbids ("15px", "650"), so they are stripped.
  readFileSync(resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const tokens = read("../src/tokens.css");
const sheets: ReadonlyArray<readonly [string, string]> = [
  ["tokens.css", tokens],
  ["styles.css", read("../../web/src/styles.css")],
  ["redesign.css", read("../../web/src/redesign.css")],
];

test("the radius ramp is declared once, with six steps and a pill", () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["--gc-radius-2xs", "4px"],
    ["--gc-radius-xs", "8px"],
    ["--gc-radius-sm", "12px"],
    ["--gc-radius", "17px"],
    ["--gc-radius-lg", "24px"],
    ["--gc-radius-xl", "32px"],
    ["--gc-radius-pill", "999px"],
  ];
  for (const [name, value] of expected) {
    const re = new RegExp(`${name}\\s*:\\s*${value.replace("px", "px")}\\s*;`);
    assert.match(tokens, re, `${name} must be declared as ${value}`);
  }
});

test("the weight ramp is five roles and nothing between them", () => {
  for (const [name, value] of [
    ["--gc-weight-regular", "400"],
    ["--gc-weight-medium", "500"],
    ["--gc-weight-semibold", "600"],
    ["--gc-weight-bold", "700"],
    ["--gc-weight-heavy", "800"],
  ] as const) {
    assert.match(tokens, new RegExp(`${name}\\s*:\\s*${value}\\s*;`), `${name} must be ${value}`);
  }
});

test("no stylesheet hand-types a font-weight", () => {
  for (const [label, css] of sheets) {
    const hits = [...css.matchAll(/font-weight\s*:\s*(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(
      hits,
      [],
      `${label} hand-types font-weight ${hits.join(", ")}; use var(--gc-weight-*) instead`,
    );
  }
});

test("no stylesheet hand-types a border-radius in pixels", () => {
  for (const [label, css] of sheets) {
    const hits: string[] = [];
    for (const m of css.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;}]+)/g)) {
      const value = m[1]!;
      for (const px of value.matchAll(/\b\d+px\b/g)) hits.push(px[0]);
    }
    assert.deepEqual(
      hits,
      [],
      `${label} hand-types border-radius ${hits.join(", ")}; use var(--gc-radius-*) instead`,
    );
  }
});

test("no stylesheet references a radius or weight token that is never declared", () => {
  const declared = new Set(
    [...tokens.matchAll(/(--gc-(?:radius|weight)[\w-]*)\s*:/g)].map((m) => m[1]!),
  );
  for (const [label, css] of sheets) {
    for (const m of css.matchAll(/var\(\s*(--gc-(?:radius|weight)[\w-]*)/g)) {
      const name = m[1]!;
      assert.ok(
        declared.has(name),
        // This is exactly how `.gc-connector-code` ended up with square corners: a var() naming a
        // token that does not exist makes the whole declaration invalid, and CSS drops it silently.
        `${label} references ${name}, which tokens.css never declares`,
      );
    }
  }
});
