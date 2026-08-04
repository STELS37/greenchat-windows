// clients/core/test/diag_redact.test.ts -- unit tests for the device-side redactor (T-515, SUPPORT.md
// section 2.3, rules R1-R7). Each rule is pinned in isolation on the PURE string->string transforms,
// independent of the Diagnostics controller wiring (exercised end-to-end in diagnostics.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitize,
  maskPii,
  redactText,
  redactRoute,
  redactBreadcrumb,
  redactStack,
  MSG_MAX,
  FIELD_MAX,
  STACK_MAX_FRAMES,
} from "../src/diag_redact.ts";

// ---- R1: sanitise + cap ---------------------------------------------------------------------------
test("R1: sanitize strips control chars and collapses whitespace", () => {
  assert.equal(sanitize("  a\t\tb\n\nc  "), "a b c");
  assert.equal(sanitize("x y"), "x y");
  assert.equal(sanitize(""), "");
});

test("R1: redactText caps to the requested max", () => {
  // Whitespace-separated so no single run is long enough to be blobbed by R3 before the cap applies.
  const long = Array.from({ length: 300 }, () => "ab").join(" "); // 899 chars, survives masking intact
  assert.equal(redactText(long, MSG_MAX).length, MSG_MAX);
  assert.equal(redactText(long, FIELD_MAX).length, FIELD_MAX);
});

// ---- R2: e-mail + long-digit masking --------------------------------------------------------------
test("R2: an e-mail becomes e***@***", () => {
  assert.equal(maskPii("write to john.doe+tag@example.co.uk please"), "write to e***@*** please");
  assert.ok(!maskPii("a@b.com").includes("@b.com"));
});

test("R2: 7+ consecutive digits are masked, short runs kept", () => {
  assert.equal(maskPii("id 1234567 end"), "id ####### end");
  assert.equal(maskPii("call +15551234567"), "call +#######");
  assert.equal(maskPii("only 123456 here"), "only 123456 here"); // 6 digits -- below the threshold
});

// ---- R3: base64 / hex / base58 blob ---------------------------------------------------------------
test("R3: long token/key/seed/wallet runs collapse to a blob", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const hex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const eth = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
  const btc = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
  for (const secret of [jwt, hex, eth, btc]) {
    const out = maskPii("value=" + secret);
    assert.ok(!out.includes(secret), "must blob: " + secret.slice(0, 16));
  }
  assert.equal(maskPii("short abcd1234"), "short abcd1234"); // < 25 chars -- kept verbatim
});

test("R3: a file path is NOT swallowed by the blob rule", () => {
  assert.equal(maskPii("/usr/local/lib/app/main.js"), "/usr/local/lib/app/main.js");
});

// ---- R5: route path-only + numeric-segment masking ------------------------------------------------
test("R5: query and fragment are dropped from a route", () => {
  assert.equal(redactRoute("/search?q=secret&token=abc#frag"), "/search");
  assert.equal(redactRoute("/settings#section"), "/settings");
});

test("R5: numeric path segments become {id}", () => {
  assert.equal(redactRoute("/chat/8821/thread/990077"), "/chat/{id}/thread/{id}");
  assert.equal(redactRoute("/chat/abc"), "/chat/abc");
});

test("R5: an absolute URL is reduced to its path (no scheme/host)", () => {
  assert.equal(redactRoute("https://app.example.com/chat/8821?token=x"), "/chat/{id}");
  assert.equal(redactRoute("https://app.example.com"), "/");
});

test("R5: redactBreadcrumb routes routes and masks residual PII in plain names", () => {
  assert.equal(redactBreadcrumb("/wallet/import?mnemonic=witch+collapse"), "/wallet/import");
  assert.equal(redactBreadcrumb("chats"), "chats");
  assert.equal(redactBreadcrumb("user 1234567 profile"), "user ####### profile");
  assert.equal(redactBreadcrumb(""), "");
});

// ---- R4: stack frames reduced to file:line:column -------------------------------------------------
test("R4: a frame keeps only bundle file:line:column", () => {
  const stack = [
    "TypeError: boom",
    '    at submit (secret="hunter2secret") (https://app.example.com/assets/app.js?token=deadbeefcafebabe0123456789:5:9)',
  ].join("\n");
  const out = redactStack(stack);
  assert.match(out, /^TypeError: boom/);
  assert.match(out, /at app\.js:5:9/);
  for (const bad of ["hunter2secret", "deadbeefcafebabe", "app.example.com", "token=", "assets"]) {
    assert.ok(!out.includes(bad), "frame must not leak: " + bad);
  }
});

test("R4: at most STACK_MAX_FRAMES frames survive", () => {
  const frames = Array.from({ length: 25 }, (_, i) => "    at fn" + i + " (app.js:" + (i + 1) + ":1)");
  const out = redactStack(["Error: many", ...frames].join("\n"));
  const kept = out.split("\n").filter((l) => l.startsWith("at ")).length;
  assert.equal(kept, STACK_MAX_FRAMES);
});

test("R4: the message header is PII-masked", () => {
  const out = redactStack("Error: contact john@example.com now\n    at f (app.js:1:1)");
  assert.ok(!out.includes("john@example.com"));
  assert.ok(out.includes("e***@***"));
});

test("R4: empty input yields empty output", () => {
  assert.equal(redactStack(""), "");
  assert.equal(redactStack("   "), "");
});
