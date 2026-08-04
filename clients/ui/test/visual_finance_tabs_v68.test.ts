// clients/ui/test/visual_finance_tabs_v68.test.ts — V68 regression guard.
//
// Defect, measured on the running client at 390x844 (probe var/ux-audit/tools/m_fintabs_v68.mjs,
// 2026-07-30, pointer parked off the strip):
//
//   nav.gc-finance-tabs    358 x 54   x=16   padding 4  gap 5   → 350px of usable track
//   .gc-finance-tab        112.7 x 44 x=21          «Кошелёк», the active white pill
//   .gc-finance-tab        112.7 x 44 x=138.7       «Биржа»
//   right edge of pills    251.4                    → 119.6px of empty control, exactly one third
//
// The control declared `grid-template-columns: repeat(3, minmax(0, 1fr))` while its third tab —
// «Карты» — is appended only after /v1/config advertises the cards contour (finance_screen.ts:126-128,
// "deliberately absent"). With the contour off, which is the default deployment, the empty track
// stayed: a pill that visibly continued past the two segments standing in it. The hardcoded 3 also
// appeared as `min-width: calc((100vw - 32px) / 3)`.
//
// Reference: FilterTabsView divides spare width by the tabs that exist, never by a constant —
// `additionalTabWidth = trueTabsWidth < width ? (width - trueTabsWidth) / tabs.size() : 0`
// (Tabs.java:1554), and when they do not fit the strip scrolls rather than squeezing a title.
// `grid-auto-flow: column` + `grid-auto-columns: minmax(min-content, 1fr)` is both branches in CSS.
//
// Textual guard, like V63–V67: the claim is that no rule states a tab COUNT and that the tab strip has
// one type. A rendered assertion would pass today, with the cards contour off, and still ship a hole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const legacy = strip(readFileSync(resolve(here, "../../web/src/styles.css"), "utf8"));
const redesign = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));
const financeScreen = readFileSync(resolve(here, "../src/screens/finance_screen.ts"), "utf8");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = [...rules(legacy), ...rules(redesign)];
const TAB = /\.gc-finance-tab(?![-\w])/;
const STRIP = /\.gc-finance-tabs(?![-\w])/;

test("V68: the tab count is the server's business, not the stylesheet's", () => {
  // No rule may divide the control by a constant number of tabs — neither as tracks nor as a floor.
  const offenders = all.filter(([s, body]) =>
    (STRIP.test(s) || TAB.test(s))
    && (/grid-template-columns\s*:\s*repeat\(\s*\d/.test(body) || /min-width\s*:[^;]*\/\s*\d/.test(body)));
  assert.deepEqual(offenders.map(([s]) => s), [], "a hardcoded tab count leaves a hole when a tab is gated");
  // …and the screen really does gate the third tab, which is why a constant cannot be right.
  assert.match(financeScreen, /"cards" is deliberately absent/, "the cards tab is server-gated");
});

test("V68: the tracks are created by the tabs that exist", () => {
  const owners = all.filter(([s, body]) => STRIP.test(s) && /grid-auto-columns\s*:/.test(body));
  assert.equal(owners.length, 1, "exactly one rule may size the control's tracks");
  const [, body] = owners[0]!;
  assert.match(body, /grid-auto-flow:\s*column/, "one track per tab, laid out across");
  assert.match(
    body,
    /grid-auto-columns:\s*minmax\(\s*min-content\s*,\s*1fr\s*\)/,
    "equal shares while the labels fit, each tab's own width once they do not",
  );
  // The second branch needs somewhere to go, exactly as the reference's RecyclerView scrolls.
  assert.match(body, /overflow-x:\s*auto/, "the strip scrolls instead of clipping a label");
});

test("V68: the strip's inset and rhythm survived the change", () => {
  const owners = all.filter(([s, body]) => STRIP.test(s) && /grid-auto-columns/.test(body));
  const body = owners[0]![1];
  assert.match(body, /gap:\s*5px/, "the gap between segments is unchanged");
  assert.match(body, /padding:\s*4px/, "the pill's own inset is unchanged");
  // V62 owns the page edge; the control must keep reading it rather than restating a number.
  const inset = all.filter(([s, b]) => STRIP.test(s) && /margin-inline:\s*var\(--gc-pad\)/.test(b));
  assert.ok(inset.length >= 1, "the control keeps the page edge token");
});

test("V68: a tab strip has one type across the product", () => {
  const typed = all.filter(([s, body]) => TAB.test(s) && /font-size\s*:/.test(body));
  assert.equal(typed.length, 1, "exactly one rule may set the finance tab's size");
  const [, body] = typed[0]!;
  assert.match(body, /font-size:\s*var\(--gc-fs-15\)/, "the chat strip's size, not an 11px caption");
  assert.match(body, /font-weight:\s*var\(--gc-weight-semibold\)/, "the chat strip's weight");
  // The weight must not be restated anywhere else on this class either.
  const weighted = all.filter(([s, b]) => TAB.test(s) && /font-weight\s*:/.test(b));
  assert.equal(weighted.length, 1, "exactly one rule may set the finance tab's weight");
});

test("V68: the tab keeps its comfortable target", () => {
  const tall = all.filter(([s, b]) => TAB.test(s) && /min-height:\s*44px/.test(b));
  assert.ok(tall.length >= 1, "the finance tab keeps the 44px touch target");
});
