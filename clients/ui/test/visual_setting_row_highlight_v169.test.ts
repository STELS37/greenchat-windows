// clients/ui/test/visual_setting_row_highlight_v169.test.ts — V169: the settings row highlighted
// itself as a hard-edged rectangle floating inside a rounded card.
//
// Evidence (stand `gc-row-stand`, own GC_DATA_DIR, port 9360, production 8990 untouched; Chromium,
// mobile context 390x844, deviceScaleFactor 2, hasTouch, en-US, signed in, route #/settings; two
// independent probes — Playwright captured the frames, a separate Pillow script counted the pixels,
// so neither could hide the other's mistake; 2026-08-03):
//
//   state                     paint box        sharp corners   white gutter L/R   text pixels
//   before, hover row 1       328.0 x 51.0     4 of 4          21.0 / 21.0 px     1749 -> 1792
//   before, focus row 1       328.0 x 51.0     4 of 4          21.0 / 21.0 px     identical frame
//   after,  hover row 1       368.0 x 53.0     0 of 4           1.0 /  1.0 px     1752 -> 1795
//   after,  focus row 1       368.0 x 53.0     0 of 4           1.0 /  1.0 px     identical frame
//   after,  hover last row    368.0 x 52.0     2 of 4 (top)     1.0 /  1.0 px     3071 -> 3123
//
// The card is 370 px wide with a 17 px radius, so before the fix the highlight was a 328 px
// rectangle with four square corners, inset 21 px on each side and stopping 7 px short of the card's
// top and bottom — a shape that belongs to no element the reader can see. `:focus-within` produced a
// byte-identical frame to `:hover`, which is why this is not a mouse-only cosmetic: a tap focuses
// the invisible full-area `.gc-select` and paints the same rectangle on a phone.
//
// The product already answered this one screen earlier. `.gc-settings-nav` is a rounded card with
// `overflow: hidden` whose rows are full-bleed and `border-radius: 0`; the CARD's curve is what cuts
// the corners of a row highlight. Settings sections were the only grouped list not following it.
//
// The shape of the fix, and what this file pins:
//
//   1. the row is pulled out to the card's inner edge with a negative inline margin and the same
//      value is handed back as inline padding, so the text cannot move: the content edge is
//      `cardContent - bleed + bleed` for ANY bleed. Measured label x 31 -> 31, value right edge
//      329 -> 329, row height 52 -> 52, section scroll height 778 -> 778.
//   2. the card clips, so the corners are concentric instead of square.
//   3. the card's block padding retires for cards that HAVE rows, otherwise the first and last row
//      leave a white shelf across the full width (measured 7 px top and bottom). `:has()` keeps the
//      licence card — an `h2` and paragraphs, no rows — padded, and a WebView without `:has()`
//      simply keeps that shelf instead of losing the padding.
//   4. the hairline moves from `border-bottom` on every row to `::after` on the row that FOLLOWS a
//      row, inset by the same variable — a full-bleed row would otherwise stretch the hairline to
//      the card edge, and a straight line drawn across the bottom of a corner-cut highlight is the
//      very artefact being removed. It is withdrawn on the hovered/focused row AND on the row
//      beneath it, exactly as `.gc-chat-row` already does.
//
// Sweep after the fix: 7 widths (320…1024) x 3 system font scales (default/lg/xl) x 4 sections =
// 84 cells, 0 with a row escaping the card, 0 with clipped text, 0 with horizontal scroll, and the
// label sat 21 px from the card edge in every single cell — the same 21 px as before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string): string => readFileSync(resolve(here, "../../web/src/", name), "utf8");

interface Rule {
  sel: string;
  decls: string;
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

const rules = [...collectRules(stripComments(read("styles.css"))), ...collectRules(stripComments(read("redesign.css")))];

/** Rules whose selector list names `cls` as a whole class token. */
const rulesFor = (cls: string): Rule[] => rules.filter((r) => new RegExp(`\\.${cls}(?![\\w-])`).test(r.sel));

const decls = (r: Rule): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of r.decls.matchAll(/(^|[;{])\s*([-a-z]+)\s*:\s*([^;{}]+)/gi)) out.set(m[2].toLowerCase(), m[3].trim());
  return out;
};

/**
 * Last declaration of `prop` in document order among rules that name `cls` and satisfy `where`.
 * These sheets state the row and the card at one specificity (`.scope .class`), so document order
 * is what the browser resolves — the same reading the other visual tests in this directory use.
 */
function last(cls: string, prop: string, where: (r: Rule) => boolean = () => true): { value: string; sel: string; at: string } | undefined {
  let hit: { value: string; sel: string; at: string } | undefined;
  for (const r of rulesFor(cls)) {
    if (!where(r)) continue;
    const v = decls(r).get(prop);
    if (v !== undefined) hit = { value: v, sel: r.sel, at: r.at };
  }
  return hit;
}

/**
 * Is `.gc-setting-row` the SUBJECT of the selector — the element being styled — rather than an
 * ancestor of it? `… .gc-setting-row .gc-select` names the row but styles the select inside it, so a
 * question about the row's own corners must not read that rule's `border-radius`.
 */
const subjectIsRow = (sel: string): boolean =>
  sel.split(",").some((part) => {
    const last = part.trim().replace(/::[\w-]+$/, "").split(/[\s>+~]+/).pop() ?? "";
    return /\.gc-setting-row(?![\w-])/.test(last);
  });

/** The plain row rule: the row IS the subject, in no interactive state, with no pseudo-element. */
const plainRow = (r: Rule): boolean =>
  subjectIsRow(r.sel) && !/:(hover|focus|active|last-child|first-child)/.test(r.sel) && !/::/.test(r.sel);

test("V169: the row bleeds to the card's inner edge — and gives the same value back as padding", () => {
  const margin = last("gc-setting-row", "margin-inline", plainRow);
  const padding = last("gc-setting-row", "padding-inline", plainRow);
  assert.ok(margin, "without a negative inline margin the highlight stays a 328 px rectangle in a 370 px card");
  assert.ok(padding, "the pulled-out row must hand the same value back, or every label shifts left");
  const varOf = (v: string): string | undefined => v.match(/var\(\s*(--[\w-]+)/)?.[1];
  assert.equal(
    varOf(margin!.value),
    varOf(padding!.value),
    "margin and padding must read the SAME variable: that identity is what keeps the text still",
  );
  assert.match(margin!.value, /-1\s*\*|-\s*var\(/, "the margin has to be the negative of the padding");
  assert.match(
    padding!.value,
    /var\(\s*--gc-setting-bleed\s*,\s*0px\s*\)/,
    "the fallback must be 0px: at an unknown mount point the rules have to degrade to a no-op",
  );
});

test("V169: the card clips, so the corners of the highlight are the card's own corners", () => {
  const overflow = last("gc-setting-list", "overflow");
  assert.equal(overflow?.value, "hidden", "the 17 px radius can only cut the highlight if the card clips");
  assert.equal(overflow?.at, "", "a scoped clip would leave square corners at some widths");
  // A row inside the card must not draw a corner of its own: two radii inside one another read as a
  // mistake, and that was the measured rejection of the pill candidates — a 12 px pill inside a 17 px
  // card with no horizontal gap leaves a tapering white L at the card corner.
  for (const r of rulesFor("gc-setting-row")) {
    if (!decls(r).has("border-radius") || !subjectIsRow(r.sel)) continue;
    assert.doesNotMatch(
      r.sel,
      /\.gc-setting-list\s+\.gc-setting-row/,
      `a row inside the card must take the card's corners, not its own: ${r.sel}`,
    );
    assert.match(
      r.sel,
      /\.gc-profile/,
      "the only row allowed a radius is the standalone currency pill in the profile card",
    );
  }
});

test("V169: the fix touches only rows that live inside a card, never the standalone profile pill", () => {
  // `.gc-profile > .gc-setting-row` is the same class used as a 12 px pill between free-standing
  // fields. Measured on the stand it is untouched — `::after` is `content: none`, radius 12 px,
  // margin -12 px, padding 12 px — but only because it is an only child today. The scope is what
  // keeps that true when a second row appears beside it.
  const touched = rulesFor("gc-setting-row").filter((r) => {
    const d = decls(r);
    return subjectIsRow(r.sel) && (d.has("margin-inline") || d.has("padding-inline") || d.has("transition") || /::after/.test(r.sel));
  });
  const mine = touched.filter((r) => /--gc-setting-bleed/.test(r.decls) || /\+\s*\.gc-setting-row::after/.test(r.sel));
  assert.ok(mine.length >= 3, "the bleed, the divider and its withdrawal all belong to this fix");
  for (const r of mine) {
    assert.match(
      r.sel,
      /\.gc-setting-list\s+\.gc-setting-row/,
      `every rule of this fix must be scoped to a row inside a card: ${r.sel}`,
    );
  }
});

test("V169: a card that HAS rows loses its block padding, the licence card keeps it", () => {
  const padded = rulesFor("gc-setting-list").filter((r) => decls(r).get("padding-block") === "0");
  assert.equal(padded.length, 1, "exactly one rule may retire the block padding");
  assert.match(
    padded[0].sel,
    /:has\(\s*\.gc-setting-row\s*\)/,
    "restricted to cards with rows: the licence card is an h2 plus paragraphs and must stay padded",
  );
  assert.equal(padded[0].at, "", "the white shelf is not a width-dependent defect, so neither is its fix");
});

test("V169: the bleed is declared for every mount point this card actually has", () => {
  const declared = new Map<string, string>();
  for (const r of rulesFor("gc-setting-list")) {
    const v = decls(r).get("--gc-setting-bleed");
    if (v !== undefined) declared.set(r.sel, v);
  }
  const find = (needle: string): string | undefined => {
    let hit: string | undefined;
    for (const [sel, v] of declared) if (sel.includes(needle)) hit = v;
    return hit;
  };
  // Measured paddings of the card: 4px 16px by default, 6px 20px in the app shell, 0 2px in the
  // flattened lists, 0 inside the server card. A bleed wider than the padding would push the
  // hairline out of the clip and the dividers would vanish.
  assert.equal(find("gc-superapp .gc-setting-list"), "20px", "app shell card is padded 20 px inline");
  assert.equal(find("gc-media-settings"), "2px", "the flattened lists are padded 2 px inline");
  assert.equal(find("gc-lock-settings"), "2px", "the lock section shares that flattened rule");
  assert.equal(find("gc-telegram-settings"), "2px", "so does the Telegram import section");
  assert.equal(find("gc-server-card"), "0px", "the failover list is already full-bleed");
});

test("V169: the hairline is drawn between rows, inset by the same bleed, and withdrawn on contact", () => {
  const border = last("gc-setting-row", "border-bottom", plainRow);
  assert.match(border?.value ?? "", /^0/, "a per-row border would run to the card edge once the row bleeds");
  const line = rulesFor("gc-setting-row").find((r) => /\+\s*\.gc-setting-row::after/.test(r.sel) && decls(r).has("content"));
  assert.ok(line, "the divider must exist as ::after on the row that FOLLOWS a row");
  const d = decls(line!);
  assert.equal(d.get("content"), '""');
  assert.match(
    d.get("inset-inline") ?? "",
    /var\(\s*--gc-setting-bleed\s*,\s*0px\s*\)/,
    "same variable as the bleed: the line has to stay exactly where it is today",
  );
  assert.equal(d.get("pointer-events"), "none", "a divider must never take a tap meant for the row");

  const off = rulesFor("gc-setting-row").filter((r) => /::after/.test(r.sel) && decls(r).get("opacity") === "0");
  const sel = off.map((r) => r.sel).join(" ");
  for (const needed of [
    ":hover::after",
    ":focus-within::after",
    ":hover + .gc-setting-row::after",
    ":focus-within + .gc-setting-row::after",
  ]) {
    assert.ok(sel.includes(needed), `the line must retire for ${needed}: a highlight cut by a hairline is the same artefact`);
  }
});

test("V169: touch keeps the highlight — the fix is not mouse-only", () => {
  // The affordance IS the row background: `.gc-select:focus-visible` is `outline: none`, and the
  // select is an invisible `inset: 0` overlay. A hover-only paint would leave a tap unacknowledged.
  const focus = rulesFor("gc-setting-row").some(
    (r) => /:focus-within(?!.*::after)/.test(r.sel) && /background/.test(r.decls),
  );
  assert.ok(focus, "the focused row must still paint its background");
});

test("V169: the new transitions respect a reader who asked for less motion", () => {
  const moving = rulesFor("gc-setting-row").filter((r) => r.at === "" && decls(r).has("transition"));
  assert.ok(moving.length > 0, "the highlight and the hairline fade in");
  const stilled = rulesFor("gc-setting-row").filter(
    (r) => /prefers-reduced-motion/.test(r.at) && decls(r).get("transition") === "none",
  );
  assert.ok(
    stilled.length > 0,
    "every transition this file adds must be answered inside a prefers-reduced-motion block",
  );
});
