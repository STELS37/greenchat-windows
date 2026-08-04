// clients/ui/test/conference_controls_layout.test.ts — the in-call control strip stays readable on a phone.
//
// WHAT THIS PINS. Measured 2026-08-04 in Chromium at a 390px viewport, with the six controls a host
// actually gets (microphone, camera, screen, hand, leave, end for everyone) and the phone override that
// conference.css itself declares (min-width 62px, caption 10px):
//
//   «Выключить микрофон»  button 62px  caption 116.7px  -> the caption spilled ±27.3px past its button
//   «Завершить для всех»  button 62px  caption 107.5px  -> ±22.7px
//   five of six captions spilled, and neighbouring captions painted over each other
//
// The strip is a flex row, so every control shrank to its min-width floor the moment the row did not
// fit — which on a phone is always — while the `nowrap` caption kept its full width with no overflow
// control. The strip already declares `overflow-x: auto`, so scrolling, not shrinking, was the intended
// answer; `flex: 0 0 auto` is what makes that true. These assertions read the shipped sheet, because the
// defect is entirely a CSS one and no DOM stub can observe painted text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../web/src/conference.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

test("an in-call control is never squeezed narrower than its own caption", () => {
  const strip = rule(".gc-conference-controls");
  assert.match(strip, /overflow-x:\s*auto/, "a row that does not fit is scrolled, so nothing may be shrunk away instead");

  const control = rule(".gc-conference-controls .gc-conference-control");
  assert.match(control, /flex:\s*0 0 auto/,
    "without this the flex row shrinks every control to its 62px phone floor and the captions overlap");
});

test("a caption longer than its own button is contained, not painted over the neighbour", () => {
  const caption = css.match(/\.gc-conference-control span\s*\{([^}]*)\}\s*$/m);
  const all = [...css.matchAll(/\.gc-conference-control span\s*\{([^}]*)\}/g)].map((m) => m[1]).join(" ");
  assert.ok(caption !== null || all.length > 0, "the caption rule must exist at all");
  assert.match(all, /overflow:\s*hidden/, "an overlong caption is clipped inside its own button");
  assert.match(all, /text-overflow:\s*ellipsis/, "…and ends in an ellipsis rather than mid-letter");
  assert.match(all, /max-width:\s*100%/, "the caption may never be wider than the control that owns it");
});
