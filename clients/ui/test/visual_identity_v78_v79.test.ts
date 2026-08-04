// clients/ui/test/visual_identity_v78_v79.test.ts — V78/V79 regression guards.
//
// Two measured defects, both from the owner's complaint that every screen looked like the same
// white-and-green page and that nothing in the app felt alive.
//
// V78 (probes var/ux-audit/tools/sweep_v77.mjs, m_brand_v78.mjs, 390x844, 2026-07-30):
//   Chats, Звонки and Ещё all painted body rgb(243,247,245) under a near-white header with the same
//   hairline. The only difference between two top-level destinations was the text inside them. On top
//   of that the app drew a stroked "G with a leaf" while the shipped identity — launcher icon, PWA,
//   favicon, store listing — is the speech bubble of public/icon.svg: two different logos in one
//   product.
//
// V79 (probes m_motion_v79.mjs, m_rail_v79.mjs, same session):
//   Every tab switch animated `gc-screen-fade` on `.gc-superapp` — the SHELL ROOT — so the tab bar
//   blinked on every tap and all three switches played the identical 150 ms opacity fade regardless
//   of direction. Separately `.gc-app-rail` measured y=778 h=66 bottom=844 in a 844px viewport with
//   `border-radius: 24px`: a floating card with its bottom corners cut off by the screen edge.
//
// These assertions read the shipped source, so a regression fails in review instead of on a phone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const clients = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const css = readFileSync(join(clients, "web", "src", "redesign.css"), "utf8");
const appTs = readFileSync(join(clients, "ui", "src", "screens", "app.ts"), "utf8");
const icons = readFileSync(join(clients, "ui", "src", "icons.ts"), "utf8");
const brandIcon = readFileSync(join(clients, "web", "public", "icon.svg"), "utf8");

test("V78: a section owns a tone, and the tone never touches the primary action colour", () => {
  assert.match(appTs, /"data-gc-section": section/, "the shell publishes the live section on its root");
  for (const section of ["calls", "settings", "wallet"]) {
    assert.ok(
      css.includes(`.gc-superapp[data-gc-section="${section}"]`),
      `section "${section}" declares its own tone`,
    );
  }
  // Three distinct hues + the brand default: that is what makes two destinations tell themselves
  // apart in the first 60px, before any content has loaded.
  for (const token of ["--gc-cyan-500", "--gc-violet-500", "--gc-gold-500", "--gc-brand-500"]) {
    assert.ok(css.includes(token), `the tone set reuses the declared brand colour ${token}`);
  }
  const block = css.slice(css.indexOf("V78: one mark"), css.indexOf("V78 motion"));
  assert.ok(
    !/\.gc-fab\b|\.gc-btn-accent\b|\.gc-shell-item\.is-active/.test(block),
    "the tab bar, the FAB and filled buttons stay GreenChat green — a section tints chrome, not actions",
  );
});

test("V78: the app draws the SHIPPED mark, not a second drawing of the brand", () => {
  assert.match(brandIcon, /M256 120c-83 0-150 55-150 123/, "public/icon.svg still carries the speech bubble");
  const logo = icons.slice(icons.indexOf("  logo: {"), icons.indexOf("  chats: {"));
  // icon.svg scaled by 24/512 = 0.046875: bubble start 256,120 -> 12,5.625; dot radius 20 -> .94.
  assert.match(logo, /M12 5\.625c-3\.891 0-7\.031 2\.578-7\.031 5\.766/, "the app mark IS the shipped bubble");
  assert.ok(logo.includes("evenOdd: true"), "the three dots are knocked-out holes, so the mark works on any surface");
  assert.equal((logo.match(/\.94a?\b|\.94 0/g) ?? []).length >= 3, true, "all three dots are present");
  assert.ok(!/leaf|M12 3a9/.test(logo), "the old stroked G-with-a-leaf must not come back");
});

test("V79: motion moves the content, never the chrome", () => {
  assert.match(
    appTs,
    /querySelector\?\.\(["'`]\.gc-superapp-stage["'`]\)/,
    "the animated node is the stage (content), not `.gc-superapp` (shell root with the tab bar in it)",
  );
  assert.match(appTs, /data-gc-nav/, "the direction is published as an attribute the stylesheet reads");
  assert.match(
    appTs,
    /removeAttribute\(["'`]data-gc-nav["'`]\)/,
    "the attribute is dropped after the animation: a lingering transform turns every fixed overlay "
      + "inside the screen into a container-relative box",
  );
  // Direction comes from the tab order, so travelling right in the bar brings the screen in from the
  // right. A single undirected fade is exactly the defect V79 removed.
  assert.match(appTs, /tabOrder\(/, "the direction is derived from the order of the tabs");
  assert.ok(css.includes(".gc-superapp-stage { overflow-x: clip; }"),
    "the sliding stage must not hand the user a horizontal scrollbar mid-animation");
});

test("V79: the tab bar sits ON the screen edge, so it is rounded only where there is something to round", () => {
  const v79 = css.slice(css.indexOf("V79: the chrome stops moving"));
  assert.match(
    v79,
    /@media \(max-width: 760px\)[\s\S]{0,200}\.gc-app-rail\s*\{\s*border-radius:\s*var\(--gc-radius-lg\) var\(--gc-radius-lg\) 0 0/,
    "on a phone the rail keeps the radius on its top corners only",
  );
});

test("V78 motion: every decoration is removed under prefers-reduced-motion", () => {
  const motion = css.slice(css.indexOf("V78 motion"), css.indexOf("V79: the chrome stops moving"));
  assert.match(motion, /@media \(prefers-reduced-motion: no-preference\)/, "the press feedback is opt-in");
  const reduce = motion.slice(motion.indexOf("prefers-reduced-motion: reduce"));
  for (const sel of [".gc-shell-item-icon", ".gc-fab", ".gc-chat-row", ".gc-call-log-row", ".gc-more-tile"]) {
    assert.ok(reduce.includes(sel), `${sel} is switched off under reduced motion`);
  }
  assert.match(reduce, /transition: none;[\s\S]{0,40}animation: none;/, "both transition and animation are cleared");
});
