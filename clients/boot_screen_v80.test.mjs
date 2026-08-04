// clients/boot_screen_v80.test.mjs — V80 regression guard.
//
// Defect, measured on the running client at 390x844 with the app bundle throttled to a phone link
// (probe var/ux-audit/tools/m_boot_v79.mjs, 2026-07-30):
//
//   t=120ms  bg=rgb(243,247,245) visibleBoxes=1 svg/img=0 text=""
//   t=350ms  … identical …
//   t=700ms  … identical …
//   t=1400ms … identical …
//
// For the whole time between the tap and the first screen the product was a blank pale sheet: no
// mark, no name, nothing moving. That is the single most-seen frame of any phone app, and it looked
// like a failed page load.
//
// V80 puts a static boot block inside #app: the shipped identity inlined as SVG, the product name and
// an indeterminate sweep — zero requests, zero JavaScript. app.ts calls clear(host) before mounting
// the first screen, which is what removes it, so the boot screen cannot outlive the app (verified
// live by var/ux-audit/tools/m_boot_v80.mjs: boot=1 at DOM ready, boot=0 the moment .gc-auth-card
// mounts, boot=0 after sign-in, and 0x0 in site mode where #app is display:none).
//
// This test locks the four properties that keep both halves true. It reads the source files, not a
// build, so it fails in review rather than in a browser.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(root, "web", "index.html"), "utf8");
const siteCss = await readFile(join(root, "web", "public", "site.css"), "utf8");
const appTs = await readFile(join(root, "ui", "src", "screens", "app.ts"), "utf8");

test("the boot screen lives INSIDE #app, so mounting the first screen removes it", () => {
  const appOpen = html.indexOf('<div id="app"');
  assert.ok(appOpen > 0, "the application host is still #app");
  const appClose = html.indexOf("</div>", html.indexOf("</noscript>", appOpen));
  const inside = html.slice(appOpen, appClose);
  assert.match(inside, /class="gc-boot"/, "the boot block is a child of #app");
  assert.ok(
    !html.slice(0, appOpen).includes("gc-boot"),
    "nothing named gc-boot may sit outside #app: a sibling would survive clear(host) and cover the app",
  );
  assert.match(
    appTs,
    /clear\(host\);/,
    "app.ts must still clear the host before mounting a screen — that is the removal mechanism",
  );
});

test("the boot screen costs no extra request: the mark is inlined, not linked", () => {
  const block = html.slice(html.indexOf('class="gc-boot"'), html.indexOf("</noscript>"));
  assert.match(block, /<svg[^>]*class="gc-boot-mark"/, "the mark is an inline <svg>");
  assert.ok(!/<img/.test(block), "no <img> in the boot block: a request cannot be part of a boot screen");
  // The shipped identity, not a second drawing of the brand (V78 closed that split for the app icons).
  assert.match(block, /M256 120c-83 0-150 55-150 123/, "the geometry is public/icon.svg's speech bubble");
  assert.match(block, /viewBox="0 0 512 512"/, "same coordinate system as the launcher/PWA/favicon icon");
});

test("the boot screen is styled by site.css, the only stylesheet present before the bundle", () => {
  // Content-Security-Policy is style-src 'self' (server/src/core/http.ts): an inline <style> would be
  // blocked, and the app stylesheet is attached by site-loader.js only after mode detection.
  for (const sel of [".gc-boot", ".gc-boot-mark", ".gc-boot-name", ".gc-boot-bar"]) {
    assert.ok(siteCss.includes(sel), `site.css styles ${sel}`);
  }
  assert.ok(!/<style/i.test(html), "no inline <style> in the document: CSP style-src 'self' forbids it");
  assert.match(siteCss, /@keyframes gc-boot-sweep/, "the indeterminate sweep is defined");
});

test("the boot screen is app-mode only and survives a notch and reduced motion", () => {
  const rules = siteCss.slice(siteCss.indexOf("V80 — the boot screen"));
  const bootRules = rules.split("\n").filter((line) => line.includes(".gc-boot") && line.includes("{"));
  assert.ok(bootRules.length >= 4, "the V80 block declares the boot rules");
  for (const line of bootRules) {
    assert.match(
      line,
      /html\[data-gc-mode="app"\]/,
      `every boot rule is scoped to app mode, else the marketing page inherits it: ${line.trim()}`,
    );
  }
  assert.match(rules, /env\(safe-area-inset-top\)/, "the block is centred inside the safe area, not the raw viewport");
  assert.match(rules, /prefers-reduced-motion: reduce/, "reduced motion still gets a boot screen, just a still one");
  assert.match(rules, /prefers-color-scheme: dark/, "the default theme is 'system', so a dark phone gets a dark boot");
});
