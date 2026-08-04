// NR-03 client half (T-603 counterpart — NETWORK_RESILIENCE.md §5/§7 "подпись проверяется независимым
// верификатором; порча тела ⇒ отказ"): the independent ed25519 verifier for the signed /v1/config core
// {endpoints, policy, kill_switch} against a BUILD-PINNED public key.
//
// The static fixtures below are NOT hand-rolled: they were produced by the server's own compiled
// signConfig/canonicalize (server/dist/core/config_sign.js; throwaway ed25519 keys generated in /tmp —
// prod var/keys was never read). A green "valid fixture verifies" test therefore proves byte-for-byte
// canonicalization parity with the server, not just internal consistency. The parity suite at the
// bottom additionally runs BOTH canonicalizers (client mirror vs server dist, read-only require) over
// an edge-case battery and asserts byte equality.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalizeConfigCore, verifyConfigSignature } from "../src/config_verify.ts";

// ---------------------------------------------------------------------------------------------------
// Fixture: generated 2026-07-16 by the server's compiled signConfig (see file header). CORE_JSON keys
// are deliberately UNSORTED and include a unicode id, a nested reality object, a null value and two
// endpoints whose order is meaningful. CANONICAL is the server's exact canonicalize() output — the
// byte string that was signed.
const CORE_JSON =
  '{"endpoints":[{"weight":100,"priority":10,"id":"de-direct","base":"https://greenchat.globalsystem.cc","region":"de","transport":"direct"},{"id":"ру-релей-1","base":"https://relay1.example","region":"ru","transport":"reality","priority":20,"weight":100,"reality":{"port":8443,"host":"77.222.63.16","sni":"www.microsoft.com","fingerprint":"chrome","public_key":"sVZG61B3IqFC1jUJ0ZYoZ0m6aE93AohEnJ0e3zeXWEE","short_id":"ab12cd34"}}],"policy":{"probe_timeout_ms":2500,"failures_before_rotate":3,"race_direct_vs_known_good":true,"sticky_per_network_ttl_s":86400},"kill_switch":{"force_transport":null}}';
const CANONICAL =
  '{"endpoints":[{"base":"https://greenchat.globalsystem.cc","id":"de-direct","priority":10,"region":"de","transport":"direct","weight":100},{"base":"https://relay1.example","id":"ру-релей-1","priority":20,"reality":{"fingerprint":"chrome","host":"77.222.63.16","port":8443,"public_key":"sVZG61B3IqFC1jUJ0ZYoZ0m6aE93AohEnJ0e3zeXWEE","short_id":"ab12cd34","sni":"www.microsoft.com"},"region":"ru","transport":"reality","weight":100}],"kill_switch":{"force_transport":null},"policy":{"failures_before_rotate":3,"probe_timeout_ms":2500,"race_direct_vs_known_good":true,"sticky_per_network_ttl_s":86400}}';
// ed25519 over CANONICAL by the pinned key / by a second (foreign) key, and both public keys (JWK x).
const SIG = "4cP81glfp9PqnNZ+Y0zZlqhYcKCLfIlgjW3bHQmSy8sBdbAj+MZ1jnU+fN5vLSg8ibtwIumqKgfVwBtk2Ys0CQ==";
const SIG_FOREIGN = "KCGH2hOOtKgRzrMURlG7uEe/1S1avionbzO009IX+Dv9Gs+9F0EPSWjkeEhc0ouYRqSblK+XOIFGrxY9hAdGCQ==";
const PIN = "uDAu7Bx3TcVuPrwBRnpLrZ9xMdrHQwbGo5il3jHkGLk";
const PIN_FOREIGN = "UlhlCSR3vSnYQInTBanuxw0vJtIoXZCtii74XjCQA8A";

type Core = {
  endpoints: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
  kill_switch: Record<string, unknown>;
};
const core = (): Core => JSON.parse(CORE_JSON) as Core;

// --- canonicalization: byte-for-byte mirror of the server -----------------------------------------

test("canonicalizeConfigCore reproduces the server's canonicalize() bytes on the signed fixture", () => {
  assert.equal(canonicalizeConfigCore(core()), CANONICAL, "client canonical form != server canonical form");
  // idempotent w.r.t. an already-canonical parse: sorting sorted keys changes nothing
  assert.equal(canonicalizeConfigCore(JSON.parse(CANONICAL)), CANONICAL);
});

test("canonicalizeConfigCore preserves array order (it is part of what the signature protects)", () => {
  const swapped = core();
  swapped.endpoints = [swapped.endpoints[1]!, swapped.endpoints[0]!];
  assert.notEqual(canonicalizeConfigCore(swapped), CANONICAL, "endpoint order must be canonical-visible");
});

// --- verification: the DoD matrix ------------------------------------------------------------------

test("valid server signConfig fixture verifies against the pinned key", async () => {
  assert.equal(await verifyConfigSignature(core(), SIG, PIN), true);
});

test("one corrupted body byte ⇒ отказ", async () => {
  const c = core();
  // flip one byte inside a signed string value ("greenchat" → "greenchaT")
  c.endpoints[0]!.base = "https://greenchaT.globalsystem.cc";
  assert.equal(await verifyConfigSignature(c, SIG, PIN), false);
});

test("swapped endpoints[] elements ⇒ отказ (array order is signed)", async () => {
  const c = core();
  c.endpoints = [c.endpoints[1]!, c.endpoints[0]!];
  assert.equal(await verifyConfigSignature(c, SIG, PIN), false);
});

test("added key in policy ⇒ отказ", async () => {
  const c = core();
  c.policy.injected = 1;
  assert.equal(await verifyConfigSignature(c, SIG, PIN), false);
});

test("removed key in policy ⇒ отказ", async () => {
  const c = core();
  delete c.policy.probe_timeout_ms;
  assert.equal(await verifyConfigSignature(c, SIG, PIN), false);
});

test("tampered kill_switch (the emergency lever) ⇒ отказ", async () => {
  const c = core();
  c.kill_switch.force_transport = "reality";
  assert.equal(await verifyConfigSignature(c, SIG, PIN), false);
});

test("signature by a foreign key ⇒ отказ; pinning the foreign key rejects the genuine signature", async () => {
  assert.equal(await verifyConfigSignature(core(), SIG_FOREIGN, PIN), false, "foreign signature");
  assert.equal(await verifyConfigSignature(core(), SIG, PIN_FOREIGN), false, "foreign pin");
  assert.equal(await verifyConfigSignature(core(), SIG_FOREIGN, PIN_FOREIGN), true, "sanity: foreign pair is internally consistent");
});

test("unparseable signature ⇒ отказ (never throws)", async () => {
  assert.equal(await verifyConfigSignature(core(), "", PIN), false, "empty");
  assert.equal(await verifyConfigSignature(core(), "not!!base64@@", PIN), false, "bad charset");
  assert.equal(await verifyConfigSignature(core(), "AAAA", PIN), false, "wrong length (3 bytes)");
  assert.equal(await verifyConfigSignature(core(), SIG.slice(0, 20), PIN), false, "truncated");
});

test("unparseable/wrong-size pinned key ⇒ отказ (never throws)", async () => {
  assert.equal(await verifyConfigSignature(core(), SIG, ""), false, "empty pin");
  assert.equal(await verifyConfigSignature(core(), SIG, "####"), false, "bad charset");
  assert.equal(await verifyConfigSignature(core(), SIG, "AAAA"), false, "3 bytes, not 32");
  assert.equal(await verifyConfigSignature(core(), SIG, PIN + PIN), false, "64 bytes, not 32");
});

test("WebCrypto (crypto.subtle) недоступен ⇒ throw в стиле crypto_store/primitives", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(desc, "crypto global must exist in the test env");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    await assert.rejects(
      () => verifyConfigSignature(core(), SIG, PIN),
      /WebCrypto \(crypto\.subtle\) недоступен/,
      "must fail loudly, callers under a pin treat it as rejection (fail closed)",
    );
  } finally {
    Object.defineProperty(globalThis, "crypto", desc!);
  }
  assert.equal(await verifyConfigSignature(core(), SIG, PIN), true, "global restored, verification works again");
});

// --- cross-canonicalizer parity: client mirror vs server dist (read-only) --------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
// clients/core/test -> repo/server/dist/core/config_sign.js (same convention as server-harness.ts)
const SERVER_SIGN = path.resolve(HERE, "../../../server/dist/core/config_sign.js");

test("canonicalizer parity with server/dist canonicalize on edge cases (byte equality)", () => {
  assert.ok(
    fs.existsSync(SERVER_SIGN),
    `compiled server not found at ${SERVER_SIGN} — run \`npm --prefix ../server run build\` first`,
  );
  const req = createRequire(import.meta.url);
  const server = req(SERVER_SIGN) as { canonicalize: (v: unknown) => string };
  const loneSurrogate = String.fromCharCode(0xd800); // built at runtime — literal escape breaks tooling
  const cases: unknown[] = [
    null,
    {},
    [],
    { a: [] },
    { b: 1, a: 2 }, // sort
    { "10": 1, "2": 2, b: 3, "": 4 }, // integer-like keys: engine numeric enumeration must match
    { "ю": { "я": 1, "а": [null, { b: 2, a: 1 }] } }, // unicode keys, nested objects, null in array
    { "emoji🙂": "🙂", "zé": 1 }, // astral plane + accented key
    { s: " \n\t\"\\" }, // control chars / escapes inside values
    { s: loneSurrogate }, // lone surrogate — JSON.stringify well-formed escaping (Node >= 20)
    { a: 0.1, b: -0, c: 1e21, d: 1e-7, e: 9007199254740991 }, // number formatting corners
    { t: true, f: false, n: null },
    { deep: [{ z: [], y: {} }, [[]], [{ b: [3, 2, 1], a: null }]] }, // arrays as-is, recursively
    JSON.parse(CORE_JSON), // the realistic signed core itself
  ];
  for (const value of cases) {
    assert.equal(
      canonicalizeConfigCore(value),
      server.canonicalize(value),
      "parity broke on: " + String(JSON.stringify(value)).slice(0, 100),
    );
  }
});
