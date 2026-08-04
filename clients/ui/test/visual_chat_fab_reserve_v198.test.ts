// clients/ui/test/visual_chat_fab_reserve_v198.test.ts — V198: the floating "new chat" button
// printed itself over the last conversation in the list.
//
// Evidence (ephemeral stand, own GC_DATA_DIR, port 9377; Chromium mobile context,
// deviceScaleFactor 2, ru-RU, signed in, route `#/chats`, five rows; probes `fab3.mjs`,
// `fab4.mjs`, `fabtrial.mjs`, 2026-08-04). `.gc-fab` is 56x56 at `bottom: calc(18px + safe)`
// inside `.gc-chats`, so it owns a 74 px band at the end of the list; the list reserved 18 px:
//
//   viewport      list scroll   text under the button AT THE END of the scroll
//   320x640       0 px          subtitle «Создание и управление ботами Green» 56x19 px
//   320x568       50 px         title «Центр ботов · Бот» 50x17.5 px AND the subtitle 56x19 px
//   360x640/1.4   0 px          subtitle 56x26.7 px
//
// The list was already scrolled as far as it goes, so the covered text could not be reached at
// all. The fix is the missing reserve: the list's trailing padding now covers the button's own
// band. This file pins the SHAPE out of the cascade — the reserve is compared against the
// button's own declared size, so shrinking the padding or growing the button fails the test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
/** Bundle order, as `clients/web/src/main.ts` imports them: styles first, redesign after. */
const SHEETS = ["../../web/src/styles.css", "../../web/src/redesign.css"] as const;
const markup = readFileSync(resolve(here, "../src/screens/chat_list_screen.ts"), "utf8");

interface Rule {
  /** Selector list as written. */
  sel: string;
  /** Declarations of that block. */
  decls: string;
  /** `@media …` chain the rule sits under, empty for an unconditional rule. */
  at: string;
  /** Position in the bundle: sheet index first, then offset inside the sheet. */
  order: number;
}

/** Comments hold prose that mentions these very class names and properties, so they go first. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace scanner: enough for these sheets (no nesting, no strings with braces). */
function collectRules(src: string, sheetIndex: number): Rule[] {
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
      if (top && !top.sel.startsWith("@")) {
        out.push({ sel: top.sel, decls: src.slice(top.start, i), at: top.at, order: sheetIndex * 1e7 + top.start });
      }
      preludeStart = i + 1;
    }
  }
  return out;
}

const rules = SHEETS.flatMap((rel, i) =>
  collectRules(stripComments(readFileSync(resolve(here, rel), "utf8")), i),
).sort((a, b) => a.order - b.order);

/** Split a selector list on its TOP-LEVEL commas — commas inside `:is(...)` are not separators. */
function selectorList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  out.push(sel.slice(start));
  return out;
}

/** The compound the rule actually styles: everything after the last top-level combinator. */
function subject(sel: string): string {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && (c === " " || c === "\t" || c === "\n" || c === ">" || c === "+" || c === "~")) {
      last = i + 1;
    }
  }
  return sel.slice(last);
}

/** Class/attribute/pseudo-class count — enough to order two class-only selectors. */
const specificity = (sel: string): number =>
  (sel.match(/\.[\w-]+/g) ?? []).length + (sel.match(/\[[^\]]+\]/g) ?? []).length;

/** Every selector that styles `cls` ITSELF — the class must be the subject, not an ancestor. */
function branchesFor(cls: string): { rule: Rule; one: string }[] {
  const token = new RegExp(`\\.${cls}(?![\\w-])`);
  const out: { rule: Rule; one: string }[] = [];
  for (const rule of rules) {
    for (const one of selectorList(rule.sel)) {
      if (token.test(subject(one))) out.push({ rule, one: one.trim() });
    }
  }
  return out;
}

/** `padding-bottom` of one block, from the longhand or the right slot of the shorthand. */
function paddingBottomOf(decls: string): string | null {
  let value: string | null = null;
  const re = /(?:^|;|\n)\s*(padding|padding-bottom|padding-block|padding-block-end)\s*:\s*([^;}]+)/g;
  for (let m = re.exec(decls); m; m = re.exec(decls)) {
    const prop = m[1];
    const raw = m[2].trim();
    if (prop === "padding-bottom" || prop === "padding-block-end") { value = raw; continue; }
    // Split on top-level whitespace so `calc(… + …)` stays one value.
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= raw.length; i += 1) {
      const c = raw[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      if ((i === raw.length || /\s/.test(c ?? "")) && depth === 0) {
        const piece = raw.slice(start, i).trim();
        if (piece) parts.push(piece);
        start = i + 1;
      }
    }
    if (prop === "padding-block") value = parts[1] ?? parts[0] ?? null;
    else if (parts.length >= 3) value = parts[2];
    else if (parts.length === 2 || parts.length === 1) value = parts[0];
  }
  return value;
}

/** The chat list really is `div.gc-chat-list` inside `.gc-chats` inside the superapp stage. */
const CHAIN = /^(?:\.gc-chat-list|\.gc-chats|\.gc-superapp[\w-]*|:is\([^)]*\)|>|\s|div)+$/;
const reachable = (one: string): boolean => CHAIN.test(one) && !/\.gc-(overlay|palette-overlay|msgmenu-layer)\b/.test(one);

/** What the browser applies to the live list: highest specificity, then last in bundle order. */
function winningPaddingBottom(): { value: string; sel: string } {
  let best: { value: string; sel: string; spec: number; order: number } | null = null;
  for (const { rule, one } of branchesFor("gc-chat-list")) {
    if (rule.at) continue; // the sheets set no conditional padding-bottom here; see the media test
    if (!reachable(one)) continue;
    const value = paddingBottomOf(rule.decls);
    if (value === null) continue;
    const spec = specificity(one);
    if (!best || spec > best.spec || (spec === best.spec && rule.order >= best.order)) {
      best = { value, sel: one, spec, order: rule.order };
    }
  }
  assert.ok(best, "no rule sets a bottom padding on .gc-chat-list at all");
  return { value: best.value, sel: best.sel };
}

/** Static pixel total of a `calc()` — the safe-area term is a runtime value, counted separately. */
const staticPx = (value: string): number =>
  (value.match(/(\d+(?:\.\d+)?)px/g) ?? []).reduce((sum, px) => sum + Number.parseFloat(px), 0);

/** The button's own numbers, read from the sheet rather than repeated here. */
function fabBand(): { size: number; inset: number } {
  const decls = branchesFor("gc-fab")
    .filter(({ one }) => !/[:.]\w+$/.test(subject(one).replace(/^\.gc-fab/, "")) || subject(one) === ".gc-fab")
    .map(({ rule }) => rule.decls)
    .join(";");
  const height = /(?:^|;|\n)\s*height\s*:\s*(\d+(?:\.\d+)?)px/.exec(decls);
  const bottom = /(?:^|;|\n)\s*bottom\s*:\s*([^;}]+)/.exec(decls);
  assert.ok(height, ".gc-fab must declare a height for the reserve to be derived from");
  assert.ok(bottom, ".gc-fab must declare a bottom offset for the reserve to be derived from");
  return { size: Number.parseFloat(height[1]), inset: staticPx(bottom[1]) };
}

test("V198: the chat list reserves the whole band the floating button occupies", () => {
  const { value, sel } = winningPaddingBottom();
  const { size, inset } = fabBand();
  const band = size + inset;
  assert.ok(
    staticPx(value) >= band,
    `the button owns ${band}px (${size}px tall at ${inset}px from the pane bottom); the list ` +
      `reserves ${staticPx(value)}px via "${sel} { padding-bottom: ${value} }" — measured at 320x568 ` +
      "a shortfall left the row's title AND subtitle under an opaque button at the end of the scroll",
  );
});

test("V198: the reserve carries the safe-area inset, exactly as the button does", () => {
  const { value } = winningPaddingBottom();
  assert.match(
    value,
    /var\(\s*--gc-safe-bottom/,
    "the button sits at `calc(18px + var(--gc-safe-bottom))`, so a reserve without the same term " +
      "falls short by the inset on every notched device",
  );
});

test("V198: the reserve is scoped to the pane that owns the button", () => {
  const { sel } = winningPaddingBottom();
  assert.match(
    sel,
    /\.gc-chats\s*>\s*\.gc-chat-list/,
    "an unscoped reserve would add a dead strip to any future list without a floating button; " +
      "the list is created once (chat_list_screen.ts) as a child of .gc-chats, next to the button",
  );
});

test("V198: no narrow-screen branch takes the reserve back", () => {
  const { size, inset } = fabBand();
  for (const { rule, one } of branchesFor("gc-chat-list")) {
    if (!rule.at || !reachable(one)) continue;
    const value = paddingBottomOf(rule.decls);
    if (value === null) continue;
    assert.ok(
      staticPx(value) >= size + inset,
      `"${rule.at}" lowers the reserve to ${value} on the very screens where the collision was ` +
        "measured (320x568, 320x640)",
    );
  }
});

test("V198: the list is still the scroll container the reserve depends on", () => {
  let overflow: string | null = null;
  for (const { rule, one } of branchesFor("gc-chat-list")) {
    if (!reachable(one)) continue;
    const m = /(?:^|;|\n)\s*overflow(?:-y)?\s*:\s*([^;}]+)/.exec(rule.decls);
    if (m) overflow = m[1].trim();
  }
  assert.match(
    overflow ?? "",
    /auto|scroll/,
    "padding at the end of the content only helps if the end can be scrolled to; without a scroll " +
      "container the reserve is dead weight",
  );
});

test("V198: the button and the list are still siblings inside one pane", () => {
  // The selector above is only true of the live DOM while the screen keeps building both here.
  assert.match(markup, /class:\s*"gc-chats"/, "the pane class the reserve is scoped to must exist");
  assert.match(markup, /class:\s*"gc-chat-list"/, "the list class must still be the one measured");
  assert.match(
    markup,
    /root\.append\([^)]*\bfab\b[^)]*\)/,
    "the floating button must stay a child of the pane root; moved elsewhere it would be " +
      "positioned against another box and the reserve would guard the wrong edge",
  );
});
