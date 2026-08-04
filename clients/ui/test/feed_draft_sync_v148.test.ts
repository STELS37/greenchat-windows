import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteDraftDecision } from "../src/screens/feed_model.ts";

test("V148: a remote draft replaces an inactive composer", () => {
  assert.deepEqual(remoteDraftDecision("текст с другого устройства", false), {
    apply: true,
    text: "текст с другого устройства",
  });
});

test("V148: both server clear forms remove a stale inactive draft", () => {
  assert.deepEqual(remoteDraftDecision(null, false), { apply: true, text: "" });
  assert.deepEqual(remoteDraftDecision("", false), { apply: true, text: "" });
});

test("V148: the local active composer wins over a remote echo or clear", () => {
  assert.deepEqual(remoteDraftDecision("старый серверный текст", true), { apply: false, text: "" });
  assert.deepEqual(remoteDraftDecision(null, true), { apply: false, text: "" });
});

test("V148: malformed or absent draft payloads are ignored", () => {
  assert.deepEqual(remoteDraftDecision(undefined, false), { apply: false, text: "" });
  assert.deepEqual(remoteDraftDecision(42, false), { apply: false, text: "" });
});
