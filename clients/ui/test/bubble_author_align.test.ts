// The sender name inside a bubble is a <button> when the sender can be reported and a <div> when it
// cannot (clients/ui/src/screens/feed_screen.ts). A button's UA style is `text-align: center` and
// `.gc-link` adds padding, so without an explicit reset the same name is indented and centred for some
// readers only. These tests read the shipped stylesheets, so they fail if a later layer re-opens it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string): string =>
  readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const rulesFor = (css: string, selector: string): string[] =>
  [
    ...strip(css).matchAll(
      new RegExp(`(^|[},;\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ].map((m) => m[2]);

const LAYERS = ["styles.css", "redesign.css", "brand.css", "message_delivery.css", "shortscreen.css"];

test("the sender name is start-aligned so a wrapped name follows the message body", () => {
  const decls = rulesFor(read("styles.css"), ".gc-bubble-author").join(";");
  assert.match(decls, /text-align:\s*(start|left)/);
});

test("the clickable sender name occupies the same box as the plain one", () => {
  const decls = rulesFor(read("styles.css"), "button.gc-bubble-author").join(";");
  // measured on the stand: only display:block plus -3px/-2px reproduces the plain <div> box exactly
  assert.match(decls, /display:\s*block/);
  assert.match(decls, /padding:\s*3px\s+0/);
  assert.match(decls, /margin-top:\s*-3px/);
  assert.match(decls, /margin-bottom:\s*-2px/);
  assert.doesNotMatch(decls, /padding(-inline|-left|-right)?:\s*[1-9]\d*px\s+[1-9]/);
});

test("no later layer re-centres the sender name", () => {
  for (const layer of LAYERS) {
    let css: string;
    try {
      css = read(layer);
    } catch {
      continue;
    }
    for (const decls of rulesFor(css, ".gc-bubble-author")) {
      assert.doesNotMatch(decls, /text-align:\s*center/, `${layer} re-centres .gc-bubble-author`);
    }
  }
});
