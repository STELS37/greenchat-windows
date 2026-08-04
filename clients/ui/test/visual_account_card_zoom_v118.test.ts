// clients/ui/test/visual_account_card_zoom_v118.test.ts — V118: at an enlarged system font the
// settings hub could not say whose account it was.
//
// The card is `display: flex` with a fixed 56 px avatar, an 18 px chevron and
// `.gc-account-card-copy { flex: 1; min-width: 0 }`, so on a 320 dp phone the copy column is 148 px
// whatever the text needs. Measured on the signed direct APK through the device WebView (redroid
// Android 15, dedicated device 127.0.0.1:5556, routes #/settings and #/more, ru-RU, 2026-07-31):
//
//   320 dp, font 2.0   «Ника Северова» needs 243, has 148 -> «Ника Север…»; «НС» needs 54, has 52
//   393 dp, font 2.0   name and initials both clipped
//   320 dp, font 1.3   name clipped
//   393 dp, font 1.3   nothing clipped
//   320 dp, font 1.0   nothing clipped
//
// Three remedies for three different boxes: the name and handle are body copy and may wrap at any
// enlarged font; the initials sit in a FIXED disc, so they take capped type (dividing the declared
// font-size, not `zoom` — `zoom` shrank the disc itself to 28 px on the device); and at the largest
// font the card wraps so the copy takes the full width, which puts the name back on one line
// instead of the 128 px mid-word stack that wrapping alone produced.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Comments are stripped: this file's own rationale quotes the selectors it asserts on.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(
  readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8"),
);
const redesign = strip(
  readFileSync(new URL("../../web/src/redesign.css", import.meta.url), "utf8"),
);

/** The declaration block that follows the LAST mention of `sel` in `source`. */
function lastBlockFor(source: string, sel: string): string {
  const idx = source.lastIndexOf(sel);
  assert.notEqual(idx, -1, `stylesheet must still style ${sel}`);
  const open = source.indexOf("{", idx);
  const close = source.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `${sel} must have a declaration block`);
  return source.slice(open + 1, close);
}

/** The selector text of the LAST rule in `source` whose selector mentions `needle`. */
function lastSelectorFor(source: string, needle: string): string {
  const idx = source.lastIndexOf(needle);
  assert.notEqual(idx, -1, `stylesheet must still contain ${needle}`);
  const open = source.indexOf("{", idx);
  const start = Math.max(source.lastIndexOf("}", idx), source.lastIndexOf("{", idx)) + 1;
  return source.slice(start, open).trim();
}

test("V118: a device at the default font renders the card exactly as before", () => {
  const name = lastBlockFor(redesign, ".gc-account-card-name {");
  assert.match(
    name,
    /white-space:\s*nowrap/,
    "the untouched card must still keep the name on one line",
  );
  assert.match(
    name,
    /text-overflow:\s*ellipsis/,
    "the untouched card must still end the name in an ellipsis",
  );
  const avatar = lastBlockFor(redesign, ".gc-account-card-avatar {");
  assert.match(
    avatar,
    /width:\s*56px/,
    "the fixed 56 px disc is the box the capped type is measured against",
  );
  assert.match(
    avatar,
    /font-size:\s*20px/,
    "20px is the declared size the cap divides; changing it invalidates the calc below",
  );
});

test("V118: an enlarged system font lets the account name and handle wrap", () => {
  const zoomed = lastBlockFor(
    css,
    ":root[data-gc-text-zoom] :is(.gc-account-card-name, .gc-account-card-handle)",
  );
  assert.match(zoomed, /white-space:\s*normal/, "the name must be allowed to wrap");
  assert.match(
    zoomed,
    /overflow:\s*visible/,
    "a hidden overflow keeps swallowing the tail once wrapping is allowed",
  );
  assert.match(zoomed, /text-overflow:\s*clip/, "the ellipsis must stop replacing the name");
  assert.match(
    zoomed,
    /overflow-wrap:\s*anywhere/,
    "a 148 px column cannot hold «Северова» even after a word break",
  );
  const sel = lastSelectorFor(
    css,
    ":root[data-gc-text-zoom] :is(.gc-account-card-name, .gc-account-card-handle)",
  );
  assert.doesNotMatch(
    sel,
    /data-gc-text-zoom="large"/,
    "font_scale 1.3 already cut the name at 320 dp, so the wrap must not wait for the largest font",
  );
});

test("V118: the initials are capped type, and the disc keeps its size", () => {
  const capped = lastBlockFor(css, ":root[data-gc-text-zoom] .gc-account-card-avatar");
  assert.match(
    capped,
    /font-size:\s*calc\(20px\s*\/\s*var\(--gc-sys-text-zoom,\s*1\)\)/,
    "the initials are capped by dividing the declared size, which renders back at 20 px",
  );
  // Not a bare /zoom/: the cap itself reads `--gc-sys-text-zoom`. What must not appear is the
  // `zoom` PROPERTY, which scales the disc itself — measured 56 -> 28 px on the device.
  assert.doesNotMatch(
    capped,
    /(?:^|[;{])\s*zoom\s*:/,
    "`zoom` scales the disc itself — measured 56 -> 28 px on the device",
  );
});

test("V118: at the largest system font the card wraps so the name gets the full width", () => {
  // The trailing brace matters: `.gc-account-card` is a prefix of `.gc-account-card-copy`, whose
  // rule is written later in the file.
  const card = lastBlockFor(css, ':root[data-gc-text-zoom="large"] .gc-account-card {');
  assert.match(card, /flex-wrap:\s*wrap/, "the copy must be able to leave the avatar's row");
  const copy = lastBlockFor(css, ':root[data-gc-text-zoom="large"] .gc-account-card-copy');
  assert.match(
    copy,
    /flex:\s*1\s+0\s+100%/,
    "the copy takes the full width (250 px at 320 dp), which puts the name back on one line",
  );
});
