// clients/ui/test/visual_tab_marker_v67.test.ts — V67 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile (probe
// var/ux-audit/tools/m_tabs_v67.mjs, 2026-07-30, pointer parked off the strip so no :hover leaks in):
//
//   .gc-tabs             358 x 47   x=16    bottom border 1px
//   .gc-tab.is-active    179 x 46   x=16    border-bottom 2.5px rgb(19,170,91)
//   its label + badge    ~58 wide           (badge 18.1 x 16.3 at x=113.2)
//
// Two tabs split the strip, so each slot is 179px — and the accent line was the SLOT's bottom border:
// 179px of paint under 58px of text, 121px of it under empty space. A marker that wide stops saying
// «this tab is selected» and starts saying «the left half of the header is a different colour».
//
// Reference (Telegram for Android master, FilterTabsView.java read 2026-07-30) keeps the two roles
// apart, and the fix copies that split exactly:
//   · the slot absorbs spare width — additionalTabWidth = (width - trueTabsWidth) / tabs.size()
//     (:1554) — so our 179px slot is right and stays the tap target;
//   · the indicator is bounded by the label — width from titleWidth (+ counter), centred in the slot
//     (indicatorX = tabView.getX() + (viewWidth - indicatorWidth) / 2, :1497) and inset by
//     TAB_INTERNAL_PADDING = 12.5f dp per side (:177, applied at :1510).
//
// The guard is textual against the source, like V63–V66: the claim is that the SLOT no longer owns an
// underline and the LABEL owns exactly one, sized by its own content. A screenshot diff would pass on
// any build where the two happen to look similar at one string length.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const redesign = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));
const legacy = strip(readFileSync(resolve(here, "../../web/src/styles.css"), "utf8"));
const chatList = readFileSync(resolve(here, "../src/screens/chat_list_screen.ts"), "utf8");
const settings = readFileSync(resolve(here, "../src/screens/settings_screen.ts"), "utf8");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = [...rules(redesign), ...rules(legacy)];
/** `.gc-tab` itself — never `.gc-tabs` and never `.gc-tab-label`, which the `-\w` guard excludes. */
const TAB = /\.gc-tab(?![-\w])/;
const LABEL = /\.gc-tab-label(?![-\w])/;
const chatsTabs = all.filter(([s]) => s.includes(".gc-chats-header") && TAB.test(s) && !LABEL.test(s));

test("V67: the tab slot no longer paints an underline", () => {
  const offenders = chatsTabs.filter(([, body]) => /border-bottom/.test(body));
  assert.deepEqual(
    offenders.map(([s]) => s),
    [],
    "the 179px slot must not own the marker — the label does",
  );
});

test("V67: the marker is declared exactly once, on the label", () => {
  const owners = all.filter(([s, body]) => LABEL.test(s) && /border-bottom\s*:/.test(body));
  assert.equal(owners.length, 1, "exactly one rule may create the marker");
  const [selector, body] = owners[0]!;
  assert.match(selector, /\.gc-chats-header/, "the marker is scoped to the chat-list strip");
  assert.doesNotMatch(selector, /is-active/, "the resting label carries the box; only its colour changes");
  assert.match(body, /border-bottom:\s*2\.5px\s+solid\s+transparent/, "resting: reserved and invisible");
});

test("V67: only the active tab's label is coloured, and by the accent", () => {
  const lit = all.filter(([s, body]) => LABEL.test(s) && /border-bottom-color\s*:/.test(body));
  assert.equal(lit.length, 1, "exactly one rule may light the marker");
  const [selector, body] = lit[0]!;
  assert.match(selector, /\.gc-tab\.is-active\s+\.gc-tab-label/, "it is the active tab's label");
  assert.match(body, /border-bottom-color:\s*var\(--gc-accent\)/, "the product accent, not a literal");
});

test("V67: the marker is as wide as its content plus the reference overhang", () => {
  const owners = all.filter(([s]) => LABEL.test(s) && s.includes(".gc-chats-header"));
  const body = owners.map(([, b]) => b).join(";");
  // Shrink-to-fit: an inline box that is never told to fill its slot.
  assert.match(body, /display:\s*inline-flex/, "the label is an inline box, so it is content-sized");
  assert.doesNotMatch(body, /(?:^|;|\s)(?:width|flex)\s*:/, "the label must never be given the slot's width");
  const pad = body.match(/padding-inline:\s*([^;]+);/g) ?? [];
  assert.equal(pad.length, 1, "the overhang has exactly one owner");
  assert.match(pad[0]!, /12\.5px/, "TAB_INTERNAL_PADDING, the reference's per-side inset");
});

test("V67: the slot stays the tap target and centres the marker", () => {
  const slot = chatsTabs.map(([, b]) => b).join(";");
  assert.match(slot, /flex:\s*1/, "the tabs still split the strip evenly, as the reference does");
  assert.match(slot, /justify-content:\s*center/, "the marker is centred in its slot");
  assert.match(slot, /align-items:\s*stretch/, "the label spans the slot so its border stands on the edge");
  // Vertical padding would lift the marker off the strip's own hairline.
  assert.match(slot, /padding:\s*0\s+10px/, "no vertical padding between the marker and the strip edge");
  // The 46px comfortable target from the touch-target layer must survive the change.
  const heights = all.filter(([s, b]) => s.includes(".gc-chats-header") && TAB.test(s) && !LABEL.test(s) && /min-height:\s*46px/.test(b));
  assert.ok(heights.length >= 1, "the chat-list tab keeps its 46px height");
});

test("V67: the markup gives the label its own box and keeps the badge inside it", () => {
  const labels = chatList.match(/class:\s*"gc-tab-label"/g) ?? [];
  assert.equal(labels.length, 2, "both chat-list tabs wrap their label");
  assert.match(
    chatList,
    /class:\s*"gc-tab-label"\s*\}\s*,\s*\[i18n\.t\("chat\.tabAll"\)\s*,\s*badgeEl\s*\]/,
    "the counter travels with the title, so the marker measures both",
  );
  const badges = chatList.match(/class:\s*"gc-tab-badge"/g) ?? [];
  assert.equal(badges.length, 1, "the badge stays a single node (e2e counts it)");
  // The button remains the tab: aria-selected and the click target are unchanged by the wrapper.
  assert.match(chatList, /allTab\.classList\.toggle\("is-active"/, "the active class stays on the button");
  assert.match(chatList, /allTab\.setAttribute\("aria-selected"/, "the accessible state stays on the button");
});

test("V67: the segmented strips are untouched", () => {
  // The settings strip reuses `.gc-tab` and must keep its pill: it owns no label box…
  assert.doesNotMatch(settings, /gc-tab-label/, "the settings tabs are not relabelled");
  // …and the marker rules reach only the UNDERLINE strips on top of that. V83 added the second one:
  // the call log's «Все | Пропущенные» filter is the same object as the chat list's — a filter over
  // the list below it — so it wears the same marker. The pill strips (settings, finance) are named
  // nowhere in these selectors, which is what keeps them segmented.
  const underline = /\.gc-chats-header|\.gc-call-log-tabs/;
  // Commas inside `:is(...)` are not selector separators, so the list is split at depth 0 only.
  const split = (selector: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let at = 0;
    for (let i = 0; i < selector.length; i += 1) {
      const ch = selector[i]!;
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        parts.push(selector.slice(at, i));
        at = i + 1;
      }
    }
    parts.push(selector.slice(at));
    return parts;
  };
  for (const [selector] of all.filter(([s]) => LABEL.test(s))) {
    for (const part of split(selector)) {
      assert.match(part, underline, `${part.trim()} must not reach a segmented strip`);
    }
    assert.doesNotMatch(selector, /gc-(settings|finance)-/, `${selector} must not reach a pill strip`);
  }
});
