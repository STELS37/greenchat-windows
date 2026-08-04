import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_CORE_VERSION } from "../src/index.ts";

test("core package is importable", () => {
  assert.equal(CLIENT_CORE_VERSION, "0.1.0");
});
