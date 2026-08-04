import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCombo, matchChord, Shortcuts } from "../src/shortcuts.ts";
import type { KeyEventLike } from "../src/shortcuts.ts";

const ev = (over: Partial<KeyEventLike>): KeyEventLike =>
  ({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

test("parseCombo: modifiers and aliases", () => {
  assert.deepEqual(parseCombo("mod+k"), { key: "k", mod: true, ctrl: false, meta: false, alt: false, shift: false });
  const p = parseCombo("ctrl+shift+p");
  assert.equal(p.ctrl, true); assert.equal(p.shift, true); assert.equal(p.key, "p");
  assert.equal(parseCombo("esc").key, "escape");
  assert.equal(parseCombo("up").key, "arrowup");
});

test("matchChord: mod resolves per platform", () => {
  const chord = parseCombo("mod+k");
  assert.equal(matchChord(chord, ev({ ctrlKey: true }), false), true, "ctrl on win/linux");
  assert.equal(matchChord(chord, ev({ metaKey: true }), false), false, "meta is wrong on win/linux");
  assert.equal(matchChord(chord, ev({ metaKey: true }), true), true, "cmd on mac");
  assert.equal(matchChord(chord, ev({ ctrlKey: true }), true), false, "ctrl is wrong on mac");
});

test("matchChord: exact modifier match (no accidental extra keys)", () => {
  const chord = parseCombo("ctrl+k");
  assert.equal(matchChord(chord, ev({ ctrlKey: true }), false), true);
  assert.equal(matchChord(chord, ev({ ctrlKey: true, altKey: true }), false), false);
});

test("Shortcuts: dispatch, input suppression, and when-guard", () => {
  const sc = new Shortcuts({ isMac: false });
  let ran = 0;
  sc.register({ combo: "mod+k", run: () => { ran++; } });
  assert.equal(sc.handle(ev({ ctrlKey: true })), true);
  assert.equal(ran, 1);
  // suppressed while typing in an input
  assert.equal(sc.handle(ev({ ctrlKey: true }), { tagName: "INPUT" }), false);
  assert.equal(ran, 1);
  // allowInInput bypasses suppression
  let ran2 = 0;
  sc.register({ combo: "mod+enter", allowInInput: true, run: () => { ran2++; } });
  assert.equal(sc.handle(ev({ key: "Enter", ctrlKey: true }), { tagName: "TEXTAREA" }), true);
  assert.equal(ran2, 1);
  // when-guard false blocks
  let ran3 = 0;
  sc.register({ combo: "shift+g", when: () => false, run: () => { ran3++; } });
  assert.equal(sc.handle(ev({ key: "g", shiftKey: true })), false);
  assert.equal(ran3, 0);
});
