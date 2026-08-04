// clients/ui/test/feed_presence_v7.test.ts — V7 regression guards for two measured conversation defects.
//
// 1. Presence was never rendered. The server has always broadcast `presence.update {user_id, online,
//    last_seen}` and served `last_seen` on the public profile (blurred to the string "recently" when
//    privacy hides it), yet no client screen consumed either — so a 1:1 header showed the constant
//    "личный чат" where every messenger shows "в сети" / "был(а) в 12:30". presenceLabel() is that line.
// 2. The conversation canvas hid its own bubbles. Measured on the running client, an incoming white
//    bubble scored ΔE2000 4.96 against the #edf4f0 wallpaper (≈5 is where two colours stop being
//    distinguishable at a glance) and the light stop of the own bubble measured 1.002:1 in luminance.
//    Both are pinned here as arithmetic over tokens.css so a future palette edit cannot regress them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import { presenceLabel } from "../src/screens/feed_model.ts";

const i18n = () => createI18n({ locale: "en", dicts: { ru, en } });
const NOW = 1_700_000_000; // 2023-11-14T22:13:20Z

test("presenceLabel: online wins over any timestamp", () => {
  const i = i18n();
  assert.equal(presenceLabel({ online: true, lastSeen: NOW - 90_000 }, NOW, i), i.t("chat.online"));
  assert.equal(presenceLabel({ online: true, lastSeen: null }, NOW, i), i.t("chat.online"));
});

test("presenceLabel: an unknown timestamp yields no line at all (the kind label stays)", () => {
  assert.equal(presenceLabel({ online: false, lastSeen: null }, NOW, i18n()), null);
});

test("presenceLabel: a privacy-blurred timestamp renders the blurred wording verbatim", () => {
  const i = i18n();
  assert.equal(presenceLabel({ online: false, lastSeen: "recently" }, NOW, i), i.t("chat.lastSeenRecently"));
});

test("presenceLabel: buckets by age — just now, minutes, today, yesterday, older", () => {
  const i = i18n();
  assert.equal(presenceLabel({ online: false, lastSeen: NOW - 5 }, NOW, i), i.t("chat.lastSeenJustNow"));
  assert.equal(
    presenceLabel({ online: false, lastSeen: NOW - 300 }, NOW, i),
    i.t("chat.lastSeenMinutes", { count: "5" }),
  );
  // Same calendar day, more than an hour ago -> a clock time.
  const today = presenceLabel({ online: false, lastSeen: NOW - 7200 }, NOW, i);
  assert.ok(today && today !== i.t("chat.lastSeenRecently"), "an hours-old timestamp still produces a line");
  assert.ok(!today!.includes("{"), "no unresolved interpolation placeholder");
  const yesterday = presenceLabel({ online: false, lastSeen: NOW - 86_400 }, NOW, i);
  assert.ok(yesterday!.includes("yesterday"), `expected the yesterday wording, got ${yesterday}`);
  const older = presenceLabel({ online: false, lastSeen: NOW - 5 * 86_400 }, NOW, i);
  assert.ok(older!.includes("on"), `expected the dated wording, got ${older}`);
});

test("presenceLabel: a timestamp from the future never reads as a negative age", () => {
  const i = i18n();
  assert.equal(presenceLabel({ online: false, lastSeen: NOW + 3600 }, NOW, i), i.t("chat.lastSeenJustNow"));
});

test("presenceLabel: both shipped locales resolve every branch", () => {
  for (const locale of ["ru", "en"] as const) {
    const i = createI18n({ locale, dicts: { ru, en } });
    for (const state of [
      { online: true, lastSeen: null },
      { online: false, lastSeen: "recently" as const },
      { online: false, lastSeen: NOW - 5 },
      { online: false, lastSeen: NOW - 600 },
      { online: false, lastSeen: NOW - 7200 },
      { online: false, lastSeen: NOW - 86_400 },
      { online: false, lastSeen: NOW - 400_000 },
    ]) {
      const label = presenceLabel(state, NOW, i);
      assert.ok(label && label.length > 0, `${locale}: empty label for ${JSON.stringify(state)}`);
      assert.ok(!label.includes("{"), `${locale}: unresolved placeholder in "${label}"`);
      assert.ok(!/^chat\./.test(label), `${locale}: missing translation key rendered as "${label}"`);
    }
  }
});

// --- the wallpaper must separate from the bubbles that sit on it -----------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");
const declarations = (name: string): string[] =>
  [...tokens.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
const hex = (value: string): number[] => {
  const m = /#([0-9a-f]{6})/i.exec(value);
  assert.ok(m, `not a hex colour: ${value}`);
  const n = parseInt(m![1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const stops = (gradient: string): number[][] =>
  [...gradient.matchAll(/#[0-9a-f]{6}/gi)].map((m) => hex(m[0]));

const lab = ([r, g, b]: number[]): number[] => {
  const f = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [f(r / 255), f(g / 255), f(b / 255)];
  const t = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const x = t((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = t(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = t((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
// CIEDE2000 — perceptual distance. Simple RGB or luminance deltas cannot express "these two greens
// look like one colour", which is exactly the defect being guarded.
const de2000 = (c1: number[], c2: number[]): number => {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const A1 = (1 + G) * a1;
  const A2 = (1 + G) * a2;
  const Cp1 = Math.hypot(A1, b1);
  const Cp2 = Math.hypot(A2, b2);
  let h1 = (Math.atan2(b1, A1) * 180) / Math.PI;
  if (h1 < 0) h1 += 360;
  let h2 = (Math.atan2(b2, A2) * 180) / Math.PI;
  if (h2 < 0) h2 += 360;
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * Math.PI) / 360);
  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hb = h1 + h2;
  if (Cp1 * Cp2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (hb + 360) / 2 : hb / 2;
  const T = 1
    - 0.17 * Math.cos(((hb - 30) * Math.PI) / 180)
    + 0.24 * Math.cos((2 * hb * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * hb + 6) * Math.PI) / 180)
    - 0.2 * Math.cos(((4 * hb - 63) * Math.PI) / 180);
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -2
    * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7))
    * Math.sin((60 * Math.exp(-(((hb - 275) / 25) ** 2)) * Math.PI) / 180);
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
};

test("every bubble separates from the wallpaper it is painted on, in both themes", () => {
  const walls = declarations("gc-wallpaper-bg");
  const incoming = declarations("gc-bubble-in");
  const own = declarations("gc-bubble-own");
  assert.equal(walls.length, 2, "one wallpaper declaration per theme");
  assert.equal(incoming.length, 2);
  assert.equal(own.length, 2);
  for (const theme of [0, 1]) {
    const wall = hex(walls[theme]);
    const inDelta = de2000(hex(incoming[theme]), wall);
    assert.ok(
      inDelta >= 8,
      `theme ${theme}: incoming bubble ${incoming[theme]} is ΔE00 ${inDelta.toFixed(2)} from the wallpaper `
        + `${walls[theme]} — under 8 it reads as the same surface (the shipped defect measured 4.96)`,
    );
    for (const stop of stops(own[theme])) {
      const ownDelta = de2000(stop, wall);
      assert.ok(
        ownDelta >= 8,
        `theme ${theme}: an own-bubble stop is only ΔE00 ${ownDelta.toFixed(2)} from the wallpaper`,
      );
    }
  }
});
