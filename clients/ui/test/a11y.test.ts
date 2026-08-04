import { test } from "node:test";
import assert from "node:assert/strict";
import { nextIndex, prefersReducedMotion } from "../src/a11y.ts";

test("nextIndex: ring navigation with wraparound", () => {
  assert.equal(nextIndex(0, 3, -1), 2);
  assert.equal(nextIndex(2, 3, 1), 0);
  assert.equal(nextIndex(0, 3, 1), 1);
});

test("nextIndex: clamps without wrap and guards empty", () => {
  assert.equal(nextIndex(0, 3, -1, false), 0);
  assert.equal(nextIndex(2, 3, 1, false), 2);
  assert.equal(nextIndex(5, 0, 1), 0);
});

test("prefersReducedMotion: reads the injected matcher", () => {
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
  assert.equal(prefersReducedMotion(() => ({ matches: false })), false);
});
