import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/screens/miniapp_host.ts", import.meta.url), "utf8");

test("V172: Mini Apps clipboard requests fail closed without a managed secure-copy port", () => {
  assert.doesNotMatch(source, /navigator\.clipboard|execCommand\(["']copy["']/);
  const branch = source.match(/case "writeClipboard": \{([\s\S]*?)\n        \}/)?.[1] ?? "";
  assert.match(branch, /response\(message\.id, false, undefined, t\("clipboardDenied"\)\)/);
  assert.doesNotMatch(branch, /response\(message\.id, true/);
});
