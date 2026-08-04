import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setPendingShare,
  hasPendingShare,
  peekPendingShare,
  takePendingShare,
} from "../src/screens/share.ts";

test("pending share: set → peek (non-consuming) → take (consuming, once)", () => {
  takePendingShare(); // reset any residue
  assert.equal(hasPendingShare(), false);
  assert.equal(takePendingShare(), null);

  setPendingShare("hello\nhttps://a.b");
  assert.equal(hasPendingShare(), true);
  assert.equal(peekPendingShare(), "hello\nhttps://a.b");
  assert.equal(hasPendingShare(), true); // peek does not consume

  assert.equal(takePendingShare(), "hello\nhttps://a.b");
  assert.equal(hasPendingShare(), false); // consumed
  assert.equal(takePendingShare(), null);
});

test("pending share: blank input clears instead of storing", () => {
  setPendingShare("x");
  setPendingShare("   ");
  assert.equal(hasPendingShare(), false);
  setPendingShare("  trimmed  ");
  assert.equal(takePendingShare(), "trimmed");
});
