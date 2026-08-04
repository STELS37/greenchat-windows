// The sign-in card is the only screen whose heading is a single long Russian word inside a
// fixed-width box («С возвращением», «Создание аккаунта»). Measured on a live stand at 320x568 with
// Range extents — the element box stays [35,285] at every font step, so a box-based sweep sees
// nothing — the heading painted 29.6 px past the card at system font 1.4 and 150.1 px past it at
// 2.0, the tail off the screen. The same card charged every field plate the 60 px reserve the
// password plate needs for its native trailing affordance, which truncated «Имя пользователя» to
// «Имя пользова…» at font 1.4 while 45 px of the plate stood empty. These tests read the shipped
// stylesheets and the markup contract they depend on.
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
const layer = (name: string): string | null => {
  try {
    return read(name);
  } catch {
    return null;
  }
};

test("the auth heading may break a word that cannot fit the card", () => {
  const decls = rulesFor(read("styles.css"), ".gc-auth-title").join(";");
  // break-word, not anywhere: only a word too wide for a line of its own is allowed to split, so
  // headings that already fit keep their natural wrap
  assert.match(decls, /overflow-wrap:\s*break-word/);
});

test("the break is hyphenated where the engine can hyphenate", () => {
  const decls = rulesFor(read("styles.css"), ".gc-auth-title").join(";");
  assert.match(decls, /(^|[;\s])hyphens:\s*auto/, "no automatic hyphenation");
  assert.match(decls, /-webkit-hyphens:\s*auto/, "Safari and every WebKit shell need the prefix");
});

test("no later layer takes the heading's break permission away", () => {
  for (const name of LAYERS) {
    const css = layer(name);
    if (!css) continue;
    for (const decls of rulesFor(css, ".gc-auth-title")) {
      assert.doesNotMatch(decls, /overflow-wrap:\s*normal/, `${name} forbids the heading to break`);
      assert.doesNotMatch(decls, /white-space:\s*nowrap/, `${name} pins the heading to one line`);
      assert.doesNotMatch(decls, /hyphens:\s*(none|manual)/, `${name} disables hyphenation`);
    }
  }
});

test("a field label reserves the plate gutter, not the password control's room", () => {
  const decls = rulesFor(read("redesign.css"), ".gc-auth .gc-field-label").join(";");
  assert.match(decls, /max-width:\s*calc\(100% - 30px\)/, "the plain plate still pays for a button it has not got");
});

test("the plate that carries a trailing control keeps the wider reserve", () => {
  const css = strip(read("redesign.css"));
  assert.match(
    css,
    /\.gc-auth\s+\.gc-field-box:has\(\.gc-field-control\)\s+\.gc-field-label\s*\{[^}]*max-width:\s*calc\(100% - 60px\)/,
    "the native password affordance may end up under the label",
  );
});

test("the markup reserves native password space without emitting a duplicate app eye", () => {
  const src = readUi("screens/auth_screen.ts");
  // The structural wrapper exists only around the password input and keeps text clear of the
  // platform/browser trailing affordance. A second app button must not be rendered beside it.
  assert.match(src, /class:\s*"gc-field-control"/, "password input stopped reserving native control space");
  assert.doesNotMatch(src, /class:\s*"gc-field-eye"/, "auth screen renders a duplicate reveal eye");
  assert.match(src, /class:\s*"gc-field-label"/);
});
