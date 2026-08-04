// clients/ui/test/visual_scale_v10.test.ts — V10 regression guards for the "this looks like 2005" pass.
//
// The owner verdict was that the client reads as an old desktop program rather than a modern messenger.
// Three of the causes are pure arithmetic on the stylesheets, so they are pinned here instead of being
// re-discovered by eye on the next redesign:
//
//  1. Avatar discs looked muddy. The previous palette was hand-picked and its gradients fell up to 2.5x
//     in relative luminance inside one 54px circle (#b58709 -> #79570a, #e16d00 -> #ac400e), which is
//     what turns "a person's colour" into a dark olive blob. The palette is now generated in OkLCh at a
//     fixed white-initial contrast, so every disc has to satisfy three numbers at once: readable
//     initials, a shallow gradient, and enough perceptual distance from the other seven discs.
//  2. Type had no scale. 90 hand-picked rem multipliers produced 22 distinct sizes and fractional
//     pixels (a chat-list title measured 16.32px, its preview 13.44px), which the rasteriser snaps —
//     the reason the lists read slightly soft. Sizes must come from the --gc-fs-* ramp.
//  3. Message text ran at a 1.48 leading, ~0.17 looser than mainstream messengers, which is what made
//     the feed look sparse and the bubbles oversized for their content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const redesign = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");

const srgb = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lin = ([r, g, b]: number[]): number[] => [srgb(r / 255), srgb(g / 255), srgb(b / 255)];
const luminance = (rgb: number[]): number => {
  const [r, g, b] = lin(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastWhite = (rgb: number[]): number => 1.05 / (luminance(rgb) + 0.05);
const hex = (value: string): number[] => {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
// CIELab via D65, enough for a perceptual "are these two discs the same colour?" distance.
const lab = (rgb: number[]): number[] => {
  const [r, g, b] = lin(rgb);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const dist = (a: number[], b: number[]): number =>
  Math.hypot(lab(a)[0] - lab(b)[0], lab(a)[1] - lab(b)[1], lab(a)[2] - lab(b)[2]);

const tones = (): { tone: number; light: number[]; dark: number[] }[] => {
  const out: { tone: number; light: number[]; dark: number[] }[] = [];
  // V88: the palette selector lost its `.gc-avatar` prefix on purpose — it declares a token, and the
  // call screen needs the same eight colours on a different element. The guard is unchanged: exactly
  // eight declarations, nowhere twice.
  const re = /(?:^|\n)\[data-tone="(\d)"\]\s*\{\s*--gc-tone-bg:\s*linear-gradient\(([^)]*)\)/g;
  for (const m of redesign.matchAll(re)) {
    const stops = [...m[2].matchAll(/#[0-9a-f]{6}/gi)].map((s) => hex(s[0]));
    assert.equal(stops.length, 2, `tone ${m[1]} must declare exactly two stops`);
    out.push({ tone: Number(m[1]), light: stops[0]!, dark: stops[1]! });
  }
  return out;
};

test("the peer palette is declared exactly once, for all eight tones", () => {
  const list = tones();
  assert.equal(list.length, 8, `expected 8 tone rules, found ${list.length} (a duplicated palette means two competing definitions)`);
  assert.deepEqual(list.map((t) => t.tone), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("white initials stay legible on every disc, and no disc is a dark blob", () => {
  for (const { tone, light, dark } of tones()) {
    // The LIGHTEST stop is the readable-worst-case: glyphs cross the whole circle.
    const lightRatio = contrastWhite(light);
    assert.ok(
      lightRatio >= 3.0 && lightRatio <= 3.6,
      `tone ${tone}: light stop is ${lightRatio.toFixed(2)}:1 vs white — need >= 3.0 (WCAG large bold) and <= 3.6 so the disc stays a colour, not a dark plate`,
    );
    const darkRatio = contrastWhite(dark);
    assert.ok(darkRatio >= lightRatio, `tone ${tone}: the second stop must be the darker one`);
    // Gradient depth: the old palette fell 2.5x in luminance inside a single 54px disc.
    const fall = (luminance(light) + 0.05) / (luminance(dark) + 0.05);
    assert.ok(fall <= 1.7, `tone ${tone}: gradient falls ${fall.toFixed(2)}x in luminance, need <= 1.7 or the disc reads muddy`);
  }
});

test("no two peers share a colour a human would confuse", () => {
  const list = tones();
  let worst = Infinity;
  let pair = "";
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = dist(list[i]!.light, list[j]!.light);
      if (d < worst) {
        worst = d;
        pair = `${list[i]!.tone} vs ${list[j]!.tone}`;
      }
    }
  }
  assert.ok(worst >= 20, `closest discs (${pair}) are only ${worst.toFixed(1)} CIELab apart; need >= 20 to read as different people`);
});

test("the type ramp exists in tokens and is whole pixels at scale 1", () => {
  const steps = [...tokens.matchAll(/--gc-fs-(\d+):\s*calc\((\d+)px \* var\(--gc-font-scale\)\)/g)];
  assert.ok(steps.length >= 8, `expected a --gc-fs-* ramp in tokens.css, found ${steps.length} steps`);
  for (const s of steps) {
    assert.equal(s[1], s[2], `step --gc-fs-${s[1]} must resolve to ${s[1]}px, declares ${s[2]}px`);
  }
  const px = steps.map((s) => Number(s[2]));
  assert.deepEqual([...px].sort((a, b) => a - b), px, "the ramp must be declared in ascending order");
});

test("the redesign layer sizes text from the ramp, never from a fractional rem", () => {
  // Only the V10 section is policed: the earlier layers are frozen history and are migrated by screen,
  // not in bulk. A new rule inside V10 that invents its own size is the regression this catches.
  const v10 = redesign.slice(redesign.indexOf('V10 — the "this looks like 2005" pass'));
  const strays = [...v10.matchAll(/font-size:\s*([\d.]+)rem/g)].map((m) => m[1]);
  assert.deepEqual(strays, [], `V10 rules must use var(--gc-fs-*), found raw rem sizes: ${strays.join(", ")}`);
  assert.ok(/--gc-fs-16/.test(v10), "the message body must be set from the ramp");
});

test("message leading is messenger-dense, not document-loose", () => {
  const v10 = redesign.slice(redesign.indexOf('V10 — the "this looks like 2005" pass'));
  // The scope is matched as a pattern, not as a literal: V55 widened `.gc-superapp x` to
  // `:is(.gc-superapp, .gc-overlay, ...) x` so body-level sheets inherit the same skin. What this
  // guard is about is the leading number, which must not drift back towards document typography.
  const m =
    /(?:\.gc-superapp|:is\([^)]*\.gc-superapp[^)]*\))\s+\.gc-bubble-body\s*\{[^}]*line-height:\s*([\d.]+)/.exec(
      v10,
    );
  assert.ok(m, "the bubble body must declare an explicit line-height");
  const leading = Number(m![1]);
  assert.ok(
    leading >= 1.25 && leading <= 1.35,
    `bubble leading is ${leading}; mainstream messengers sit at ~1.31, and the pre-V10 client shipped 1.48 (sparse, oversized bubbles)`,
  );
});
