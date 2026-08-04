// clients/ui/test/visual_bot_center_header_pin_v174.test.ts — V174: the Bot Center was the only
// screen of the shell whose top bar scrolled away with the page, taking the title and the only way
// back to the bot list with it.
//
// V147 gave this screen a scrollport (`.gc-bot-center`). It left `.gc-bot-header` INSIDE that
// scrollport as an ordinary in-flow grid row, so the bar travelled up with the content.
//
// Evidence (stand from a clean `git archive`, own GC_DATA_DIR, port 9411, production untouched;
// mobile Chromium, deviceScaleFactor 2, hasTouch, ru-RU, owner with 8 bots; probes
// `header_pin.mjs` / `bot_detail_pin.mjs` of the outbox package, 2026-08-03). The scrollport was
// scrolled to its end, then each control of the bar was hit-tested at its own centre:
//
//   window / system font   state      scroll range   bar top before → after   «Назад» hittable
//   390x844 / 1.0          list          143 px        8 → -135               no
//   320x568 / 2.0          list          419 px        8 → -411               no
//   390x844 / 1.0          bot card      974 px       14 → -960               no
//
// Positive control in every cell: `#/settings`, `#/import`, `#/connect` — bar stays at top 0 and
// stays hittable, because there the bar is chrome and only the body under it scrolls. The bottom
// tab rail is not a substitute: it leaves the section instead of returning to the bot list.
//
// After the fix the same probes report the bar at top 0 with both controls hittable in all three
// cells, and the lateral inset of `#/bots` joins the other seven screens at the `--gc-pad` token
// (measured 12 px before, 16 px after; probe `page_edge.mjs`).
//
// Like the V147 file, this test reads the SHAPE of the cascade — the last declaration in document
// order, shorthands expanded — instead of the presence of a comment, so it survives renumbering and
// fails the moment the bar goes back into the flow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string): string => readFileSync(resolve(here, "../../web/src/", name), "utf8");

interface Rule { sel: string; decls: string; at: string }

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

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

const rulesFor = (rules: Rule[], cls: string): Rule[] =>
  rules.filter((r) => new RegExp(`\\.${cls}(?![\\w-])`).test(r.sel));

interface Decl { value: string; at: string; sel: string }

/**
 * Splits a shorthand value on TOP-LEVEL whitespace only. The values here are
 * `calc(-1 * var(--gc-bot-edge-end))` — spaces inside nested parentheses — so a plain split would
 * tear one component into three and the assertions below would read nonsense.
 */
function topLevelParts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Longhands of the shorthands this file reasons about; `margin`/`padding` use the CSS 1-4 rule. */
function expandBox(prop: string, value: string): [string, string][] {
  const [t, r = t, b = t, l = r] = topLevelParts(value);
  return [[`${prop}-top`, t], [`${prop}-right`, r], [`${prop}-bottom`, b], [`${prop}-left`, l]];
}

function resolved(rules: Rule[], cls: string): Map<string, Decl> {
  const out = new Map<string, Decl>();
  for (const r of rulesFor(rules, cls)) {
    for (const m of r.decls.matchAll(/(^|[;{])\s*([-a-z]+)\s*:\s*([^;{}]+)/gi)) {
      const prop = m[2].toLowerCase();
      const value = m[3].trim();
      if (prop === "margin" || prop === "padding") {
        for (const [p, v] of expandBox(prop, value)) out.set(p, { value: v, at: r.at, sel: r.sel });
      }
      if (prop === "border-bottom") {
        out.set("border-bottom-width", { value: value.split(/\s+/)[0] ?? "", at: r.at, sel: r.sel });
        out.set("border-bottom-style", { value: value.split(/\s+/)[1] ?? "", at: r.at, sel: r.sel });
      }
      out.set(prop, { value, at: r.at, sel: r.sel });
    }
  }
  return out;
}

const center = resolved(botRules, "gc-bot-center");
const header = resolved(botRules, "gc-bot-header");

test("V174: the bar is pinned to the top of the scrollport instead of riding the content away", () => {
  assert.equal(
    header.get("position")?.value,
    "sticky",
    "in the flow the bar leaves the screen after 143 px of scrolling and takes the only back arrow with it",
  );
  assert.equal(header.get("top")?.value, "0", "a sticky bar without an inset never sticks to anything");
  assert.equal(
    header.get("position")?.at ?? "",
    "",
    "the bar is lost at the shipping 390x844 profile too — the fix must not be gated by a media query",
  );
});

test("V174: the pinned bar is opaque chrome — content passes UNDER it, not through it", () => {
  const bg = header.get("background")?.value ?? header.get("background-color")?.value ?? "";
  assert.notEqual(bg, "", "a transparent sticky bar shows the scrolling list through the title");
  assert.doesNotMatch(bg, /^(none|transparent)$/, "the bar needs a surface of its own");
  assert.match(
    header.get("border-bottom-width")?.value ?? "0",
    /^1px$/,
    "every other top bar of the shell draws the same 1px hairline (.gc-settings-header, .gc-import-header, .gc-server-header)",
  );
  assert.match(header.get("border-bottom-style")?.value ?? "", /solid/);
});

test("V174: the safe-area inset moved to the bar, so a notch is padding and not a hidden title", () => {
  // Shared bar idiom of the shell: `min-height: calc(var(--gc-bar-h) + var(--gc-safe-top))` with the
  // inset paid by padding. If the scrollport kept its own top inset as well, the two would stack.
  assert.match(header.get("min-height")?.value ?? "", /--gc-bar-h/);
  assert.match(header.get("min-height")?.value ?? "", /--gc-safe-top/);
  assert.match(header.get("padding-top")?.value ?? "", /--gc-safe-top/);
  assert.doesNotMatch(
    center.get("padding-top")?.value ?? "",
    /--gc-safe-top/,
    "the top inset must be paid once — on the pinned bar, which is what covers the notch",
  );
});

test("V174: the bar bleeds to the page edge, so nothing scrolls past it in the gutters", () => {
  // The scrollport carries the lateral padding; a bar that stops at the content box would leave a
  // 16 px channel on each side where rows slide past the title.
  for (const side of ["left", "right"] as const) {
    const margin = header.get(`margin-${side}`)?.value ?? "";
    assert.match(margin, /calc\(\s*-1\s*\*/, `the bar must cancel the scrollport's ${side} padding`);
    assert.match(margin, /--gc-bot-edge-(start|end)/, "one source of truth for the edge, or the two drift apart");
    assert.match(header.get(`padding-${side}`)?.value ?? "", /--gc-bot-edge-(start|end)/);
  }
});

test("V174: the page edge comes from the token — `#/bots` stops being the eighth number", () => {
  // V62 ("one page edge, instead of five") put every screen on `--gc-pad`; this one restated the
  // number as a literal and measured 12 px against 16 px everywhere else — and ignored the density
  // setting, where the token is 16 px comfortable / 12 px compact.
  for (const prop of ["--gc-bot-edge-start", "--gc-bot-edge-end"]) {
    assert.match(center.get(prop)?.value ?? "", /--gc-pad/, `${prop} must read the token`);
    assert.match(center.get(prop)?.value ?? "", /--gc-safe-(left|right)/, `${prop} must still clear a curved edge`);
  }
  const literalEdge = rulesFor(botRules, "gc-bot-center").some((r) =>
    /padding-(left|right)\s*:\s*max\(\s*\d/.test(r.decls),
  );
  assert.equal(literalEdge, false, "no rule may restate the page edge as a literal — that is how the 12 px got in");
});
