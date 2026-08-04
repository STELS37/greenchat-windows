// clients/ui/test/bubble_contrast.test.ts — V33 regression guard.
// Own messages used to be the least readable text in the whole client: the light theme painted white
// on a saturated green gradient, which measured 2.78:1 for the body and 1.42:1 for the timestamp
// against the 4.5:1 that WCAG 1.4.3 requires for text this size. The audit only caught it once the
// conversation screen itself was measured, so the rule is pinned here as arithmetic on the tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");

const channel = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: number[]): number =>
  0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255);
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (value: string): number[] => {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  assert.ok(m, `not a plain hex colour: ${value}`);
  const n = parseInt(m![1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
// rgba(r, g, b, a) laid over an opaque plate.
const over = (value: string, plate: number[]): number[] => {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(value);
  assert.ok(m, `not an rgb(a) colour: ${value}`);
  const a = m![4] === undefined ? 1 : Number(m![4]);
  return [1, 2, 3].map((i) => Number(m![i]) * a + plate[i - 1] * (1 - a));
};

// The file declares the light palette first and the dark palette second; each block redeclares the
// same four bubble tokens, so reading them in order yields [light, dark].
const declarations = (name: string): string[] =>
  [...tokens.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());

const stopsOf = (gradient: string): number[][] =>
  [...gradient.matchAll(/#[0-9a-f]{6}/gi)].map((m) => hex(m[0]));

test("own-message text clears 4.5:1 against every stop of the own-bubble gradient, in both themes", () => {
  const bubbles = declarations("gc-bubble-own");
  const inks = declarations("gc-bubble-own-fg");
  assert.equal(bubbles.length, 2, "expected one own-bubble declaration per theme");
  assert.equal(inks.length, 2);
  for (const [i, gradient] of bubbles.entries()) {
    const stops = stopsOf(gradient);
    assert.ok(stops.length >= 2, "the own bubble is a gradient with at least two stops");
    for (const stop of stops) {
      const ratio = contrast(hex(inks[i]), stop);
      assert.ok(ratio >= 4.5, `theme ${i}: body text on ${gradient} is ${ratio.toFixed(2)}:1, need 4.5`);
    }
  }
});

test("the timestamp inside an own message stays readable on the bubble it sits on", () => {
  const bubbles = declarations("gc-bubble-own");
  const metas = declarations("gc-bubble-own-meta");
  assert.equal(metas.length, 2, "both themes declare an explicit meta colour instead of bare opacity");
  for (const [i, gradient] of bubbles.entries()) {
    for (const stop of stopsOf(gradient)) {
      const ink = metas[i].startsWith("#") ? hex(metas[i]) : over(metas[i], stop);
      const ratio = contrast(ink, stop);
      assert.ok(ratio >= 4.5, `theme ${i}: timestamp is ${ratio.toFixed(2)}:1 on ${gradient}, need 4.5`);
    }
  }
});
