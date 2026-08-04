import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/screens/video_note_recorder.ts", import.meta.url), "utf8");

test("video note permission/transient errors expose one retryable state", () => {
  assert.match(source, /const retry = el\("button"[\s\S]*?i18n\.t\("common\.retry"\)/);
  assert.match(source, /retry\.hidden = next !== "error"/);
  assert.match(source, /status\.hidden = next === "error"/);
  assert.match(source, /retry\.addEventListener\("click"[\s\S]*?phase === "error"[\s\S]*?openStream\(\)/);
  assert.doesNotMatch(source, /status\.textContent = i18n\.t\(key\);\s*error\.textContent = i18n\.t\(key\)/,
    "the same permission error must not be printed twice");
});
