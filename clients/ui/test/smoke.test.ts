import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_UI_VERSION } from "../src/index.ts";

test("ui package is importable", () => {
  assert.equal(CLIENT_UI_VERSION, "0.1.0");
});
