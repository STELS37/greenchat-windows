// clients/ui/test/visual_bar_v63.test.ts — V63 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (probe var/ux-audit/tools/m_barbox_v63.mjs, 2026-07-30):
//
//   screen      bar                  min-height   padding        title
//   /           .gc-chats-titlebar   auto (44)    10 / 16 / 0    20px 800 -0.40px lh 22
//   /calls      .gc-calls-header     66px         8  / 16        20px 800 -0.80px lh 23
//   /settings   .gc-settings-header  62px         9  / 16 / 12   20px 600 -0.09px lh 25
//   /wallet     .gc-finance-header   66px         8  / 16        20px 800 -0.80px lh 23
//   /chat       .gc-feed-header      62px         9  / 16 / 12   17px 600 -0.34px lh 20.4
//
// 1. The bar had no chosen height: 62, 66 or "as tall as the 44px button inside it". On /settings a
//    root tab's back arrow collapses to 0x0 — nothing to go back to — which is exactly why that bar
//    is the short one, i.e. the height was DERIVED FROM A CONTROL. Walking Кошелёк -> Настройки
//    shifted the whole page below by 4px.
// 2. Vertical padding was 8/8 on two screens and 9/12 on two others, so two titles sat 1.5px above
//    the centre of their own bar. 9/12 is three stacked styles.css layers: 12px bottom (:2090), top
//    restated 10px (:2436), top restated again 9px (:3374), bottom left behind unpaired.
// 3. One role — the name of the screen — in two weights, three trackings, three line-heights.
//
// Reference (Telegram for Android master, read 2026-07-30):
//   ActionBar.getCurrentActionBarHeight() -> dp(56) portrait / dp(48) landscape: ONE static constant
//   on the one ActionBar class every screen instantiates. createTitleTextView(): one typeface,
//   AndroidUtilities.bold() = weight 500 (Typeface.create(null, 500, false)), symmetric dp(8)
//   padding, 20sp alone and 18sp when a subtitle shows (:1435/:1443), subtitle 14sp. `letterSpacing`
//   appears zero times in ActionBar.java. DialogCell's row name uses the same bold() = 500, so title
//   and row name share one weight and only size separates them.
//
// The guard is textual against the source: the point of the fix is that ONE declaration, taken from
// ONE token, now owns the bar height for every screen. A rendering assertion would still pass on a
// build where five separate literals happen to agree today and drift apart tomorrow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

const mediaBodies = (condition: RegExp): string[] => {
  const out: string[] = [];
  const at = /@media([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(bare))) {
    if (!condition.test(m[1]!)) continue;
    let depth = 1;
    let i = at.lastIndex;
    for (; i < bare.length && depth > 0; i += 1) {
      if (bare[i] === "{") depth += 1;
      else if (bare[i] === "}") depth -= 1;
    }
    out.push(bare.slice(at.lastIndex, i - 1));
  }
  return out;
};

const phoneRules: Array<[string, string]> = mediaBodies(/max-width:\s*760px/).flatMap((body) =>
  body
    .split("}")
    .filter((r) => r.includes("{"))
    .map((r) => {
      const cut = r.indexOf("{");
      return [r.slice(0, cut).trim(), r.slice(cut + 1)] as [string, string];
    }),
);

const BARS = [
  ".gc-calls-header",
  ".gc-finance-header",
  ".gc-settings-header",
  ".gc-feed-header",
  ".gc-import-header",
  ".gc-server-header",
];

const covers = (selector: string, name: string): boolean =>
  new RegExp(`\\${name}(?![\\w-])`).test(selector);

test("the bar height is a token, declared in one place", () => {
  assert.match(
    tokens,
    /--gc-bar-h:\s*56px\s*;/,
    "the shell's bar height must be a named decision, not a literal repeated per screen",
  );
});

test("every screen's bar takes that one height", () => {
  const stating = phoneRules.filter(([, d]) => /min-height:\s*calc\(var\(--gc-bar-h\)/.test(d));
  assert.equal(stating.length, 1, "one role, one declaration — a second rule is how 62/66/auto happened");
  const [selector, decl] = stating[0]!;
  for (const bar of BARS) {
    assert.ok(covers(selector, bar), `${bar} must stop deciding its own height`);
  }
  // The safe-area inset is added to the height AND paid for by padding, so content clears a notch
  // instead of being centred behind it; the bottom padding is zero so the height is the number.
  assert.match(decl, /padding-block:\s*var\(--gc-safe-top\)\s+0\s*(;|$)/m, "9/12 asymmetry must be withdrawn");
  assert.match(decl, /align-items:\s*center\s*(;|$)/m, "a bare title must centre in the band, not sit on its top edge");
});

test("the chat list's titlebar is the same bar and takes the same number", () => {
  // Home's header is a column (bar + search + tabs): the bar is the titlebar inside it, and it was
  // the one bar with no floor at all — exactly as tall as its 44px action button.
  const titlebar = phoneRules.filter(([s]) => covers(s, ".gc-chats-titlebar"));
  assert.ok(
    titlebar.some(([, d]) => /min-height:\s*var\(--gc-bar-h\)\s*(;|$)/m.test(d)),
    "the chat list's bar must read the same token as every other screen's bar",
  );
});

test("the screen title has one weight and one tracking", () => {
  const stating = phoneRules.filter(([, d]) => /font-weight:\s*var\(--gc-weight-semibold\)/.test(d) && /letter-spacing:/.test(d));
  assert.equal(stating.length, 1, "the title's weight and tracking must be stated together, once");
  const [selector, decl] = stating[0]!;
  for (const title of [
    ".gc-chats-title",
    ".gc-calls-heading h1",
    ".gc-finance-heading h1",
    ".gc-settings-title",
    ".gc-import-title",
    ".gc-server-title",
    ".gc-feed-title",
  ]) {
    assert.ok(selector.includes(title), `${title} rendered its own weight or tracking`);
  }
  assert.match(decl, /letter-spacing:\s*-0\.01em\s*(;|$)/m, "-0.04em is display tracking on a 20px interface label");
  assert.ok(
    !/var\(--gc-weight-heavy\)/.test(decl),
    "the reference title is weight 500 — the same weight as a conversation name, not two steps above it",
  );
  assert.match(decl, /line-height:\s*1\.25\s*(;|$)/m, "one ratio replaces three absolute pixel heights");
});

test("size, not weight, separates the title from the row beneath it", () => {
  // Reference: 20sp when the bar shows a title alone, 18sp when a subtitle is visible. The chat bar
  // is the only one of the five with a subtitle, so it is the only one that keeps the smaller size.
  const twenty = phoneRules.find(
    ([s, d]) => /font-size:\s*var\(--gc-fs-20\)\s*(;|$)/m.test(d) && covers(s, ".gc-settings-title") && covers(s, ".gc-calls-heading"),
  );
  assert.ok(twenty, "the bars that show a title alone must share one size");
  assert.ok(
    !covers(twenty![0], ".gc-feed-title"),
    "the chat bar carries a subtitle; giving it the 20px size would contradict the reference it came from",
  );
  const seventeen = phoneRules.filter(([s]) => covers(s, ".gc-feed-title"));
  assert.ok(
    seventeen.some(([, d]) => /font-size:\s*var\(--gc-fs-17\)\s*(;|$)/m.test(d)),
    "the chat bar's title size must be stated, not inherited from whichever layer loads last",
  );
});
