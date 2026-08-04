// T-419 — pure validation/comparison for the «Адрес сервера» screen. These rules mirror core's
// normalizeBase (the ui layer stays decoupled from the SDK), so they are pinned here independently:
// "" resets to the built-in default, a bare host gets https://, only http(s) is accepted, and the value
// is reduced to a scheme+host origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerAddress, sameServer } from "../src/screens/server_model.ts";

test("parseServerAddress: empty / whitespace resets to the built-in default", () => {
  assert.deepEqual(parseServerAddress(""), { ok: true, value: "" });
  assert.deepEqual(parseServerAddress("   "), { ok: true, value: "" });
});

test("parseServerAddress: a bare host gains https:// (secure by default)", () => {
  assert.deepEqual(parseServerAddress("chat.example.com"), { ok: true, value: "https://chat.example.com" });
  assert.deepEqual(parseServerAddress("chat.example.com:8443"), { ok: true, value: "https://chat.example.com:8443" });
});

test("parseServerAddress: an explicit http(s) scheme is kept; path/query are dropped to the origin", () => {
  assert.deepEqual(parseServerAddress("http://localhost:8080"), { ok: true, value: "http://localhost:8080" });
  assert.deepEqual(parseServerAddress("https://a.example/v1/x?y=1"), { ok: true, value: "https://a.example" });
  assert.deepEqual(parseServerAddress("https://a.example/"), { ok: true, value: "https://a.example" });
  assert.deepEqual(parseServerAddress("HTTPS://A.Example"), { ok: true, value: "https://a.example" });
});

test("parseServerAddress: non-http(s) schemes and garbage are rejected", () => {
  assert.deepEqual(parseServerAddress("ftp://a.example"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseServerAddress("http://"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseServerAddress("has space"), { ok: false, reason: "invalid" });
});

test("sameServer: compares normalised targets so a no-op save skips the session-ending switch", () => {
  assert.equal(sameServer("chat.example.com", "https://chat.example.com"), true);
  assert.equal(sameServer("https://a.example/path", "a.example"), true);
  assert.equal(sameServer("", ""), true);
  assert.equal(sameServer("https://a.example", "https://b.example"), false);
  // Two unparseable inputs fall back to a trimmed raw comparison.
  assert.equal(sameServer(" ftp://x ", "ftp://x"), true);
});
