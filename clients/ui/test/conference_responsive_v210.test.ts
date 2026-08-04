import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../web/src/conference.css", import.meta.url), "utf8");

test("V210: conference shell follows dynamic viewport and every safe-area edge", () => {
  assert.match(css, /height:\s*100dvh/u);
  assert.match(css, /min-height:\s*100svh/u);
  for (const edge of ["top", "right", "bottom", "left"]) {
    assert.match(css, new RegExp(`safe-area-inset-${edge}`, "u"), `missing ${edge} safe-area inset`);
  }
  assert.match(css, /overscroll-behavior:\s*none/u);
});

test("V210: phone, tablet, wide desktop and short landscape layouts have explicit contracts", () => {
  assert.match(css, /@media \(max-width:\s*820px\)/u, "tablet/phone stack is missing");
  assert.match(css, /@media \(max-width:\s*520px\)/u, "small-phone layout is missing");
  assert.match(css, /@media \(max-width:\s*360px\)/u, "narrow-phone controls are missing");
  assert.match(css, /@media \(min-width:\s*1180px\)/u, "wide desktop layout is missing");
  assert.match(css, /@media \(orientation:\s*landscape\) and \(max-height:\s*560px\)/u, "short landscape layout is missing");
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(180px,\s*29vw\)/u);
  assert.match(css, /grid-template-rows:\s*minmax\(0,\s*1fr\) minmax\(108px,\s*24dvh\)/u);
});

test("V210: group-call controls scroll without shrinking, clipping or inaccessible first actions", () => {
  assert.match(css, /\.gc-conference-controls\s*\{[^}]*justify-content:\s*flex-start/su);
  assert.match(css, /\.gc-conference-controls\s*\{[^}]*overflow-x:\s*auto/su);
  assert.match(css, /\.gc-conference-controls\s*\{[^}]*scroll-snap-type:\s*x proximity/su);
  assert.match(css, /\.gc-conference-controls \.gc-conference-control\s*\{\s*flex:\s*0 0 auto/su);
  assert.match(css, /\.gc-conference-control\s*\{[^}]*scroll-snap-align:\s*center/su);
  assert.match(css, /@media \(hover:\s*none\) and \(pointer:\s*coarse\)/u);
  assert.match(css, /min-width:\s*44px;\s*min-height:\s*44px/u, "touch targets must remain at least 44px");
});
