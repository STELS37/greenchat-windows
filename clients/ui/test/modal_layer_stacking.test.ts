// clients/ui/test/modal_layer_stacking.test.ts — V38 regression guard.
//
// The "Новый чат" sheet was cut off by the bottom navigation bar, and raising its z-index changed
// nothing. Two independent causes were measured in the browser at 390×844:
//
//   1. `.gc-superapp-stage` carried `backdrop-filter`, which by spec makes an element the containing
//      block for `position: fixed` descendants. The overlay asked for `inset: 0` and got the stage
//      rectangle — 390×778 — so it had no pixels under the navigation bar at all.
//   2. The sheet was appended inside `.gc-superapp-list`, an element with `position: relative;
//      z-index: 2`. Everything in that column paints as one unit worth 2, while `.gc-app-rail` is a
//      sibling worth 100 one level up, so no inner z-index could ever win.
//
// Both rules are pinned here because both are invisible in code review and only show up as a
// half-hidden first row in a screenshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(resolve(here, "..", "src", p), "utf8");
const web = (p: string): string => readFileSync(resolve(here, "..", "..", "web", "src", p), "utf8");

// Read every `.gc-superapp-stage { ... }` rule body in a sheet. The first version of this guard
// inspected only the LAST one, which quietly stopped testing anything the day V79 appended a second
// stage rule at the end of the file (`overflow-x: clip`) — a passing assertion about the wrong text.
// The property, not the position, is what must hold: NO stage rule may reintroduce a containing
// block for `position: fixed`, and at least one must state the opt-out.
function stageRules(css: string): string[] {
  const bodies: string[] = [];
  const marker = ".gc-superapp-stage {";
  for (let at = css.indexOf(marker); at !== -1; at = css.indexOf(marker, at + 1)) {
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    if (close === -1) continue;
    bodies.push(css.slice(open + 1, close));
  }
  return bodies;
}

test("the app stage does not become a containing block for fixed modal layers", () => {
  const css = web("redesign.css");
  const rules = stageRules(css);
  assert.ok(rules.length > 0, "the stage must be styled here at all");

  // CSS Filter Effects / CSS Transforms: each of these makes the element the containing block for
  // fixed descendants, which is exactly how the sheet got clipped to 390×778 in V38. The value is
  // read and compared, not lookahead-tested: `\s*(?!none)` silently passes on " none" by giving the
  // space back to the negative lookahead.
  const decl = /(?:^|[\s;])(?:-webkit-)?(backdrop-filter|filter|transform|perspective)\s*:\s*([^;}]+)/g;
  for (const body of rules) {
    for (const [, prop, rawValue] of body.matchAll(decl)) {
      const value = (rawValue ?? "").trim().toLowerCase();
      assert.equal(
        value,
        "none",
        `.gc-superapp-stage sets ${prop}: ${value} — that makes the stage the containing block for fixed layers`,
      );
    }
  }
  assert.ok(
    rules.some((body) => /backdrop-filter:\s*none/.test(body)),
    "the stage must state the backdrop-filter opt-out explicitly",
  );
  assert.match(css, /\.gc-superapp-stage::before[\s\S]*backdrop-filter:\s*blur/, "the glass effect moves to a decorative pseudo-layer");
});

test("modal layers are mounted on the document body, not inside the list column", () => {
  const dom = src("dom.ts");
  assert.match(dom, /export function modalRoot\(fallback: HTMLElement\): HTMLElement/);

  // V178: the mount moved into one place for the whole client. The rule this guard defends did not
  // change — an overlay must not be appended into the column it was opened from — but it is now stated
  // once instead of being re-derived, and re-checked, per screen.
  const layer = src("modal_layer.ts");
  assert.match(layer, /modalRoot\(ownerNode\(\)\)\.append\(present\.node\)/);

  const chatList = src("screens/chat_list_screen.ts");
  assert.match(chatList, /createModalLayer\(root\)/);
  assert.doesNotMatch(chatList, /^\s*root\.append\(overlay\.root\);/m);

  const feed = src("screens/feed_screen.ts");
  assert.match(feed, /createModalLayer\(\(\) => root\)/);
  assert.doesNotMatch(feed, /^\s*root\.append\(overlay\);/m);
  // Anchored menus mount themselves — they have to measure the trigger — so they still name the root.
  assert.match(feed, /host: modalRoot\(root\)/);
});
