// clients/ui/test/visual_bot_avatar_zoom_v150.test.ts — V150: the Bot Center joined none of the
// families that keep this product usable at the Android maximum system font, so at font 2.0 its
// monogram left the disc, the disc itself was painted as an ellipse, and the card dragged the whole
// screen 41 px sideways.
//
// Measured on the stand (own GC_DATA_DIR, port 9320, production untouched; Chromium reproducing the
// WebView system font the way this project already measures it — `--enable-text-autosizing` plus
// `-webkit-text-size-adjust`, mobile context, deviceScaleFactor 2, hasTouch, ru-RU, signed in with 8
// seeded bots; probe `probes/bots_defect_scan.mjs` of the outbox package, 2026-08-03). Ink is taken
// with a Range INSIDE the live element, never with a detached probe span:
//
//   window / font   element                            box     type   content   ink       verdict
//   320x568 / 2.0   .gc-bot-avatar (list row)          48x48   40px   48x59     33.5x46   line box 11 px past the disc
//   320x568 / 2.0   .gc-bot-avatar-large (bot card)    40x48   48px   40x71     40.1x56   ellipse, glyph 8 px out
//   360x740 / 2.0   .gc-bot-avatar-large (bot card)    40x48   48px   40x71     40.1x56   same
//   320x568 / 2.0   section.gc-bot-center                   horizontal scroll 361/320     the screen drifts sideways
//   320x568 / 2.0   h1.gc-bot-title "Помощник N8"           needs 293 in a 184 box
//   320x568 / 2.0   h2 in .gc-bot-overview-copy             needs 247 in a 206 box
//   320x568 / 2.0   h2.gc-bot-card-title "Безопасность..."  needs 266 in a 262 box
//
// The same run carried a positive control in the same browser: `.gc-avatar` on `#/` is capped at
// 28px (= 20px type x 1.4) with its content exactly 54x54 — the machinery works, the Bot Center was
// simply never enrolled in it. Three families do this job and each lists its members by hand in
// clients/web/src/styles.css:
//
//   V109 case 5    `:root[data-gc-text-zoom] :is(.gc-avatar, .gc-badge, .gc-asset)` — `line-height: 1`
//                  with `overflow: hidden`, so an enlarged line box cannot leave round chrome;
//   V120           `--gc-disc-type` plus `font-size: min(type * --gc-font-scale,
//                  type * 1.4 / --gc-sys-text-zoom)`, so a disc renders at most the product maximum;
//   V109 case 2/7  `overflow-wrap: anywhere` for titles and row labels, because a single Russian word
//                  is itself wider than its box and a wrap opportunity between words never arrives.
//
// The Bot Center's own defect is separate and not about fonts: `.gc-bot-avatar` is a flex item of
// `.gc-bot-overview` without a `flex` of its own, so it was squeezed from 48 to 40 px — a circle
// drawn as an egg. Its sibling `.gc-bot-card-icon` has carried `flex: 0 0 auto` since day one.
//
// This file pins the cascade as it resolves, not the presence of a comment: it parses the two
// sheets, keeps the rules that name these classes and asks what the winning declaration says. It
// also checks the one thing prose cannot — styles.css is loaded BEFORE bot_center.css, so the capped
// `font-size` only wins if its rule outranks the plain `.gc-bot-avatar-large` declaration that comes
// later in the cascade.
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
  /** `@media ...` chain the rule sits under; empty for an unconditional rule. */
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

const shellRules = collectRules(stripComments(read("styles.css")));
const botRules = collectRules(stripComments(read("bot_center.css")));

/** Whole-token class match, so `.gc-bot-avatar` never matches `.gc-bot-avatar-large`. */
const names = (sel: string, cls: string): boolean => new RegExp(`\\.${cls}(?![\\w-])`).test(sel);
const rulesFor = (rules: Rule[], cls: string): Rule[] => rules.filter((r) => names(r.sel, cls));

/** Declarations of one property in document order; the last one is what the browser applies. */
function declsOf(rules: Rule[], prop: string): { value: string; rule: Rule }[] {
  const out: { value: string; rule: Rule }[] = [];
  for (const r of rules)
    for (const m of r.decls.matchAll(/(^|[;{])\s*((?:--)?[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)/g))
      if (m[2].toLowerCase() === prop) out.push({ value: m[3].trim(), rule: r });
  return out;
}

/**
 * The class column of specificity (the 0-B-0 digit) — the only one that varies in these sheets.
 * `:is()` contributes its most specific argument, exactly as the spec says; that is what lets a
 * one-line family enrolment outrank a plain class rule written later in the cascade.
 */
function specificity(sel: string): number {
  let s = sel.trim();
  let fromIs = 0;
  for (let guard = 0; guard < 8 && /:is\([^()]*\)/.test(s); guard += 1)
    s = s.replace(/:is\(([^()]*)\)/g, (_m: string, inner: string) => {
      fromIs += Math.max(0, ...inner.split(",").map((part) => specificity(part)));
      return "";
    });
  const classes = (s.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length;
  const attrs = (s.match(/\[[^\]]*\]/g) ?? []).length;
  const pseudo = (s.match(/(?<!:):(?!:)[a-z-]+/g) ?? []).length;
  return classes + attrs + pseudo + fromIs;
}
/** A selector LIST is as strong as its strongest branch. */
const listSpecificity = (sel: string): number => Math.max(0, ...sel.split(",").map(specificity));

const ZOOM_GATE = /\[data-gc-text-zoom[\]=]/;
const botAvatarShell = rulesFor(shellRules, "gc-bot-avatar");

test("V150: the bot disc joins the round-chrome family, so an enlarged line box cannot leave it", () => {
  const family = shellRules.filter(
    (r) => ZOOM_GATE.test(r.sel) && names(r.sel, "gc-bot-avatar") && /line-height\s*:\s*1\b/.test(r.decls),
  );
  assert.ok(
    family.length > 0,
    "at system font 2.0 the monogram's line box measured 59 px inside a 48 px disc; `line-height: 1` " +
      "with `overflow: hidden` is what V109 case 5 already gives .gc-avatar, .gc-badge and .gc-asset",
  );
  assert.match(
    family[0].decls,
    /overflow\s*:\s*hidden/,
    "the belt that keeps any future font metric inside the disc",
  );
  // Control: this fix EXTENDS the family, it does not take it over.
  for (const member of ["gc-avatar", "gc-badge", "gc-asset"])
    assert.ok(names(family[0].sel, member), `the round-chrome family must keep .${member}`);
});

test("V150: both bot discs declare a type, so the V120 ceiling has something to cap", () => {
  const small = declsOf(rulesFor(shellRules, "gc-bot-avatar"), "--gc-disc-type");
  const large = declsOf(rulesFor(shellRules, "gc-bot-avatar-large"), "--gc-disc-type");
  assert.ok(
    small.length > 0,
    "`.gc-bot-avatar` has no `--gc-disc-type`, so the V120 rule would cap a default it never declared",
  );
  assert.ok(
    large.length > 0,
    "the card's hero disc sets its own font-size (--gc-fs-24) and therefore needs its own type",
  );
  const px = (v: string): number => Number.parseFloat(v);
  assert.ok(
    px(large.at(-1)!.value) > px(small.at(-1)!.value),
    "the hero disc is the larger of the two and its type must say so",
  );
});

test("V150: the disc renders at most the product's own maximum, whatever the system font is", () => {
  const capped = botAvatarShell.filter((r) => ZOOM_GATE.test(r.sel) && /font-size\s*:/.test(r.decls));
  assert.ok(
    capped.length > 0,
    "measured 40px of type inside a 48px disc at system font 2.0 — nothing stopped it at the rim",
  );
  const value = declsOf(capped, "font-size").at(-1)!.value;
  assert.match(
    value,
    /min\(/,
    "a ceiling is `min(token, ceiling)`, never a flat size — the in-app font preference must keep working below it",
  );
  assert.match(
    value,
    /--gc-sys-text-zoom/,
    "the ceiling divides by the MEASURED system zoom (ui/src/text_zoom.ts), the only lever CSS has here",
  );
  assert.match(
    value,
    /--gc-disc-zoom-max/,
    "and the ceiling itself is the product's own maximum, not a second number invented for bots",
  );
});

test("V150: the ceiling outranks the plain rule that comes later in the cascade", () => {
  // clients/web/src/main.ts loads styles.css BEFORE bot_center.css, so at equal specificity the Bot
  // Center's own `font-size` would win and the ceiling would be dead code.
  const capped = botAvatarShell.filter((r) => ZOOM_GATE.test(r.sel) && /font-size\s*:/.test(r.decls));
  const ceiling = Math.max(0, ...capped.map((r) => listSpecificity(r.sel)));
  const plain = Math.max(
    0,
    ...[...rulesFor(botRules, "gc-bot-avatar"), ...rulesFor(botRules, "gc-bot-avatar-large")]
      .filter((r) => /font-size\s*:/.test(r.decls))
      .map((r) => listSpecificity(r.sel)),
  );
  assert.ok(
    ceiling > plain,
    `the capped rule scores ${ceiling} against ${plain} for the later plain declaration in bot_center.css`,
  );
});

test("V150: the disc is pinned, so the bot card stops drawing a circle as an ellipse", () => {
  const flex = declsOf(rulesFor(botRules, "gc-bot-avatar"), "flex").at(-1);
  assert.ok(
    flex,
    "`.gc-bot-overview` is a flex row: with no `flex` of its own the 48 px disc was squeezed to 40 px",
  );
  const parts = flex.value.trim() === "none" ? ["0", "0", "auto"] : flex.value.trim().split(/\s+/);
  assert.equal(parts[0], "0", "a disc must not grow");
  assert.equal(parts[1] ?? "1", "0", "and must not shrink — measured 40x48 on the bot card at 320 and 360 dp");
});

test("V150: bot headings may wrap at the enlarged system font, so the screen stops drifting sideways", () => {
  const all = [...shellRules, ...botRules];
  for (const target of [
    { probe: (sel: string) => names(sel, "gc-bot-title"), what: 'the screen title "Помощник N8" needed 293 px in a 184 px box' },
    { probe: (sel: string) => names(sel, "gc-bot-card-title"), what: '"Безопасность и удаление" needed 266 px in a 262 px box' },
    { probe: (sel: string) => /\.gc-bot-overview-copy\s+h2/.test(sel), what: "the bot's name on its own card needed 247 px in a 206 px box" },
  ]) {
    const wrap = all.filter(
      (r) => ZOOM_GATE.test(r.sel) && target.probe(r.sel) && /overflow-wrap\s*:\s*anywhere/.test(r.decls),
    );
    assert.ok(wrap.length > 0, `${target.what}; a single Russian word cannot wrap without permission (V109 case 2/7)`);
  }
});

test("V150: at the default system font the shell sheet does not touch the Bot Center at all", () => {
  // Cost control in the sheet, matching the measured one (probes/zero_cost_v150.mjs): 45 cells,
  // 23 155 boxes, 127 moved — every one of them inside #/bots at system font 2.0, and none at font
  // 1.0 or 1.3 anywhere. A rule that painted outside the gate would break that claim silently.
  const RENDERING = /(^|[;{])\s*(font-size|line-height|overflow|overflow-wrap|width|height)\s*:/;
  const ungated = [...rulesFor(shellRules, "gc-bot-avatar"), ...rulesFor(shellRules, "gc-bot-title")].filter(
    (r) => !ZOOM_GATE.test(r.sel) && RENDERING.test(r.decls),
  );
  assert.deepEqual(
    ungated.map((r) => r.sel),
    [],
    "the shell sheet may only declare inert custom properties here; everything that paints is gated on [data-gc-text-zoom]",
  );
});

test("V150: control — the families this fix joins are the ones that already existed", () => {
  const disc = shellRules.filter(
    (r) => ZOOM_GATE.test(r.sel) && names(r.sel, "gc-avatar") && /font-size\s*:\s*min\(/.test(r.decls),
  );
  assert.ok(
    disc.length > 0,
    "V120's disc ceiling must still be there — the bot disc enrols in it instead of inventing a second one",
  );
  assert.ok(
    disc.some((r) => names(r.sel, "gc-bot-avatar")),
    "and the bot disc must be a member of that same rule, not of a copy of it",
  );
});
