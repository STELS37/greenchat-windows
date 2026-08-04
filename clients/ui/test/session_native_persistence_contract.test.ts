import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("Android and desktop session writes expose an awaited secure-store barrier", () => {
  const mobile = source("../../mobile/bridge/index.ts");
  const desktop = source("../../desktop/src-tauri/src/bridge.js");
  const storage = source("../../web/src/session_storage.ts");
  const refresh = source("../../web/src/refresh_lock.ts");
  const session = source("../src/screens/session.ts");

  assert.match(mobile, /__gcFlushSessionStorage[\s\S]*flushSessionPersistence/);
  assert.match(mobile, /enqueueSessionPersistence\(\(\) => SecureStorage\.set/);
  assert.match(mobile, /enqueueSessionPersistence\(\(\) => SecureStorage\.remove/);
  assert.doesNotMatch(mobile, /void SecureStorage\.(?:set|remove)\([^\n]+\.catch/);

  assert.match(desktop, /window\.__gcFlushSessionStorage = flushSessionPersistence/);
  assert.match(desktop, /enqueueSessionPersistence\(function \(\) \{ return invoke\("keyring_set"/);
  assert.match(desktop, /enqueueSessionPersistence\(function \(\) \{ return invoke\("keyring_delete"/);

  assert.match(storage, /flush: flushSessionStorage/);
  assert.ok((refresh.match(/await storage\.flush\?\.\(\)/g) ?? []).length >= 2);
  assert.match(session, /storage\.save\(\{ refresh: s\.refresh_token, user \}\);[\s\S]{0,180}await this\.storage\.flush\?\.\(\)/);
});
