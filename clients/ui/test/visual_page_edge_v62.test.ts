// clients/ui/test/visual_page_edge_v62.test.ts — V62 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (probe var/ux-audit/tools/m_edge_v62.mjs, 2026-07-30). The distance from the screen edge to a
// page's own content — ONE role — resolved to five different numbers, one of them asymmetric:
//
//   /            .gc-chats-header   12      .gc-app-rail        10
//   /calls       .gc-calls-header   16      .gc-calls-body      10      .gc-calls-status   16
//   /settings    .gc-settings-header 16     .gc-settings-status 18
//   /wallet      .gc-finance-header 10      .gc-finance-tabs    10 (margin)
//                .gc-finance-body   10      .gc-finance-status  18
//   /chat        .gc-feed-header    8 / 10  <- not symmetric with itself
//
// Consequence: switching tabs slid the whole page sideways by up to 8px. Invisible in any single
// screenshot, and exactly what "not proportional" means in use.
//
// The cause was not an absent decision. The decision exists as a token — `--gc-pad: 16px` in
// ui/src/tokens.css — and the live client resolves it (density=comfortable). It was bypassed:
// styles.css holds four stacked historical layers and each restates the same container with a
// literal. `.gc-calls-body` alone is declared at clamp(16px,3vw,34px), 10px, 16px and 10px again
// (styles.css:3577/4090/4256/4870), and the last one wins on a phone — so the phone, the only
// viewport this product ships to, was the one place the token never reached.
//
// Two exceptions are kept, each against a reference number rather than a preference:
//   1. `.gc-chat-row` stays 12/16 (V61): a leading avatar DISC needs the smaller frame to look
//      equal. Telegram for Android does the same in DialogCell (avatarStart 11dp vs time dp(15)).
//   2. `.gc-feed-list` and `.gc-composer` keep the 10px bubble rail and keep it EQUAL to each
//      other, so the message column and the input plate share one left edge. Reference:
//      ChatMessageCell.java places an incoming bubble at dp(3) plus the tail's own transparent
//      inset — a bubble is content, not chrome, so it sits tighter than the page edge.
//
// The guard is textual against redesign.css: the fix is that one declaration, taken FROM THE TOKEN,
// must cover every one of those containers. A rendering test could pass on a build where the number
// happens to agree while the literals are still there, ready to drift apart again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Bodies of every `@media` block whose condition matches, resolved by brace matching. */
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

const PHONE = mediaBodies(/max-width:\s*760px/);

/** Rules of the phone layers as [selectorList, declarations] pairs. */
const phoneRules: Array<[string, string]> = PHONE.flatMap((body) =>
  body
    .split("}")
    .filter((r) => r.includes("{"))
    .map((r) => {
      const cut = r.indexOf("{");
      return [r.slice(0, cut).trim(), r.slice(cut + 1)] as [string, string];
    }),
);

const CHROME = [
  // header bands
  ".gc-chats-header",
  ".gc-calls-header",
  ".gc-finance-header",
  ".gc-feed-header",
  ".gc-settings-header",
  // scrolling page bodies
  ".gc-calls-body",
  ".gc-finance-body",
  // status strips
  ".gc-calls-status",
  ".gc-finance-status",
  ".gc-settings-status",
  // the bottom tab bar's own plate
  ".gc-app-rail",
];

test("the phone breakpoint states the page edge once, and takes it from the token", () => {
  const stating = phoneRules.filter(([, d]) => /padding-inline:\s*var\(--gc-pad\)\s*(;|$)/m.test(d));
  assert.equal(
    stating.length,
    1,
    "one role, one declaration: a second rule is how 8/10/12/16/18 happened in the first place",
  );
  assert.ok(
    !/padding-inline:\s*(?:\d|clamp)/.test(stating[0]![1]!),
    "the edge must not be re-stated as a literal next to the token",
  );
});

test("every container that had its own number is covered", () => {
  const [selector] = phoneRules.find(([, d]) => /padding-inline:\s*var\(--gc-pad\)/.test(d))!;
  for (const name of CHROME) {
    assert.ok(
      selector.includes(`${name},`) || selector.includes(`${name}\n`) || selector.includes(`${name} `) || selector.endsWith(name),
      `${name} measured its own page edge and must be brought back to the token`,
    );
  }
});

test("the wallet's segmented control is inset by the same number, through margin", () => {
  // `.gc-finance-tabs` carries the role as margin, not padding. Same role must mean same number,
  // otherwise the tab strip alone slides 6px away from the header above it.
  const tabs = phoneRules.filter(([s]) => s.includes(".gc-finance-tabs"));
  assert.ok(tabs.length > 0, "the wallet tab strip must be restated at the phone breakpoint");
  assert.ok(
    tabs.some(([, d]) => /margin-inline:\s*var\(--gc-pad\)\s*(;|$)/m.test(d)),
    "the strip is inset by margin; it must read the same token as the page edge",
  );
});

test("the bubble rail is the documented exception, and both its halves are equal", () => {
  // The feed and the composer are two boxes that must share one left edge. If they ever disagree,
  // the input plate steps out from under the message column — visible on every screenshot of a chat.
  // The class name must be matched at its boundary: `.gc-composer` is a prefix of
  // `.gc-composer-input`, whose own 16px text inset is a different role entirely.
  const rail = (className: string, prop: RegExp): string => {
    const exact = new RegExp(`\\${className}(?![\\w-])`);
    const hit = bare
      .split("}")
      .filter((r) => r.includes("{") && exact.test(r.split("{")[0]!) && prop.test(r))
      .pop();
    assert.ok(hit, `no ${className} rule declares ${prop}`);
    return hit!;
  };
  const feed = /padding-inline:\s*10px\s*(;|$)/m;
  assert.match(rail(".gc-feed-list", /padding-inline:/), feed, "the message column rail is 10px");
  assert.match(
    rail(".gc-composer", /padding:/),
    /padding:\s*\d+px\s+10px\s/,
    "the composer plate must share the message column's 10px rail, not the 16px page edge",
  );
});

test("the conversation row keeps its optical 12/16 frame", () => {
  // V61's exception must survive V62: a token sweep that also normalised the row would push the
  // avatar disc to 16px and make the leading frame look wider than the trailing one.
  const row = bare
    .split("}")
    .filter((r) => r.includes("{") && r.split("{")[0]!.includes(".gc-chat-row") && /padding-inline:/.test(r))
    .pop()!;
  assert.match(row, /padding-inline:\s*12px\s+16px\s*(;|$)/m);
});
