// clients/ui/test/visual_server_card_shrink_v195.test.ts — V195: a control that flexbox deleted.
//
// Evidence (seeded ephemeral stand, Chromium touch profile, 2026-08-04; probes probe_server.mjs,
// probe_squash.mjs, probe_srvcost.mjs). Route #/connect, DEFAULT in-app font scale, viewport
// 640x360 — a phone held sideways:
//
//   div.gc-setting-list   box height 2.2 px, content 72 px     <- the failover switch, 2 px tall
//   .gc-server-card       scrollHeight - clientHeight = 0      <- nothing to scroll to reach it
//
// «Автопереключение на резервный сервер» — row, toggle and note — was simply absent, with no
// affordance of any kind (shots/srvL-640x360-s1.png). The cause is structural, not cosmetic:
// V-fix made `.gc-server-card` a bounded flex column with `overflow-y: auto`, but its children keep
// the default `flex-shrink: 1`, and `.gc-setting-list` is itself a scroll container (`overflow:
// hidden` from the shared settings rule), so its automatic minimum size is 0 — flexbox is allowed to
// shrink it to nothing, and does, before the card ever scrolls.
//
// At 320x568 with the in-app font at FONT_SCALE_MAX (1.4) the same shrink squeezed `.gc-setting-row`
// to its declared min-height while it needed 70 px, and the overflowing label painted THROUGH its
// neighbours: the save button overlapped the first line by 0.7 px, the label's last line overlapped
// the note by 13.6 px. After the rule: list 2.2/72 -> 86.3/86, card scroll 0 -> 84 px, both overlaps
// negative, and on the five combinations where the card already fits not one of 21 boxes moves.
//
// The test is structural — it guards the declaration and the three preconditions the measurement
// blamed, so a later layer cannot quietly restore the shrink.
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
      new RegExp(`(^|[},;\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ].map((m) => m[2]);

const LAYERS = ["styles.css", "redesign.css", "brand.css", "message_delivery.css", "shortscreen.css"];

test("the children of the server card may not be shrunk below their content", () => {
  const decls = rulesFor(read("redesign.css"), ".gc-server-card > *").join(";");
  // `flex-shrink: 0` is the whole fix: the card owns the scroll, the children own their height
  assert.match(decls, /flex:\s*0\s+0\s+auto|flex-shrink:\s*0/);
});

test("the card is still the bounded scroller that makes the no-shrink rule safe", () => {
  // without `overflow-y: auto` on the card, refusing to shrink would push content out of reach
  const decls = rulesFor(read("redesign.css"), ".gc-server-card").join(";");
  assert.match(decls, /overflow-y:\s*auto/);
  assert.match(decls, /min-height:\s*0/);
  assert.match(decls, /flex:\s*0\s+1\s+auto/);
});

test("the card is still a flex column, which is why its children could shrink at all", () => {
  const decls = rulesFor(read("redesign.css"), ".gc-server-card").join(";");
  assert.match(decls, /display:\s*flex/);
  assert.match(decls, /flex-direction:\s*column/);
});

test("no later layer gives the card's children permission to shrink again", () => {
  const marker = ".gc-server-card > *";
  for (const layer of LAYERS) {
    let css: string;
    try {
      css = read(layer);
    } catch {
      continue;
    }
    const body = strip(css);
    const at = body.indexOf(marker);
    const after = at === -1 ? body : body.slice(at + marker.length);
    for (const decls of rulesFor(after, ".gc-server-card > *")) {
      assert.doesNotMatch(decls, /flex-shrink:\s*[1-9]/, `${layer} re-enables the shrink`);
      assert.doesNotMatch(decls, /flex:\s*\d+\s+[1-9]/, `${layer} re-enables the shrink`);
    }
  }
});

test("the failover switch is still a settings list inside that card", () => {
  // the shrink was possible because this child is a scroll container: if the markup stops nesting a
  // `.gc-setting-list` in the card, the measurement above no longer describes the screen
  const src = readUi("screens/server_screen.ts");
  const at = src.indexOf("server.failoverLabel");
  assert.ok(at > 0, "the failover row is gone from the server screen");
  const around = src.slice(Math.max(0, at - 400), at + 400);
  assert.match(around, /class:\s*"gc-setting-list"/);
  assert.match(around, /class:\s*"gc-setting-row"/);
});

test("that settings list still clips, which is what zeroes its automatic minimum size", () => {
  // the clip lives in redesign.css (the V-fix that made the row highlight full-bleed), not in the
  // base layer — a scroll container has an automatic minimum size of 0, which is the licence
  // flexbox used to delete the row. If this clip is ever dropped the measurement stops applying.
  const decls = rulesFor(read("redesign.css"), ".gc-setting-list").join(";");
  assert.match(decls, /overflow:\s*hidden/);
});
