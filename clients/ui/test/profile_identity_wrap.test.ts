// The profile card behind a `@username` link (clients/ui/src/screens/deep_link_screen.ts) is the only
// settings row whose label carries user-controlled text: a display name in a <strong> immediately
// followed by the handle in a `.gc-settings-note`, with no whitespace text node between them. The card
// clips (`.gc-setting-list { overflow: hidden }`), so an inline, unbreakable pair is not just misplaced
// — the tail is silently cut. These tests read the shipped stylesheets and the markup that feeds them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string): string =>
  readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
const readUi = (file: string): string =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const rulesFor = (css: string, selector: string): string[] =>
  [
    ...strip(css).matchAll(
      new RegExp(`(^|[},;\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{}]*\\{([^}]*)\\}`, "g"),
    ),
  ].map((m) => m[2]);

const LAYERS = ["styles.css", "redesign.css", "brand.css", "message_delivery.css", "shortscreen.css"];

test("the handle under a profile name gets its own line", () => {
  const decls = rulesFor(read("styles.css"), ".gc-setting-label > .gc-settings-note").join(";");
  // inline, the handle is glued to the last word of the name: measured 64px past the card edge
  assert.match(decls, /display:\s*block/);
});

test("both user-controlled strings in a settings label may wrap mid-word", () => {
  const css = strip(read("styles.css"));
  // `anywhere`, not `break-word`: only `anywhere` shrinks min-content so the flex row can narrow it
  for (const selector of [".gc-setting-label > strong", ".gc-setting-label > .gc-settings-note"]) {
    const decls = rulesFor(css, selector).join(";");
    assert.match(decls, /overflow-wrap:\s*anywhere/, `${selector} may not wrap mid-word`);
  }
});

test("a name with no break opportunity stays reachable instead of being clipped away", () => {
  const decls = rulesFor(read("styles.css"), ".gc-setting-label:has(> strong)").join(";");
  // a run of conjoining Hangul L-jamo is one grapheme cluster (UAX #29 GB6) and no CSS can break it
  assert.match(decls, /overflow-x:\s*auto/);
  assert.match(decls, /overscroll-behavior-x:\s*contain/);
  assert.match(decls, /min-width:\s*0/);
});

test("no later layer re-inlines the handle or takes the wrap permission away", () => {
  for (const layer of LAYERS) {
    let css: string;
    try {
      css = read(layer);
    } catch {
      continue;
    }
    for (const decls of rulesFor(css, ".gc-settings-note")) {
      assert.doesNotMatch(decls, /overflow-wrap:\s*(normal|break-word)/, `${layer} narrows the wrap`);
      assert.doesNotMatch(decls, /white-space:\s*nowrap/, `${layer} forbids the handle to wrap`);
    }
  }
});

test("the profile card is still the markup these rules were measured against", () => {
  const src = readUi("screens/deep_link_screen.ts");
  const card = src.slice(src.indexOf('class: "gc-setting-label"'));
  assert.match(card.slice(0, 400), /el\("strong",\s*\{\}/);
  assert.match(card.slice(0, 400), /class:\s*"gc-settings-note"/);
});
