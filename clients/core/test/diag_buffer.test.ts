// T-512 — diag_buffer.ts (SUPPORT.md §2.1): ring buffer bounds + write-time R1–R7 redaction, isolated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiagBuffer, MAX_ENTRIES, MAX_BYTES } from "../src/diag_buffer.ts";
import type { DiagEntry } from "../src/diag_buffer.ts";

function counterNow(): () => number {
  let t = 0;
  return () => ++t;
}

const KINDS = new Set(["route", "api", "ws", "err", "perf", "ui"]);

test("fresh buffer has no env head and no entries", () => {
  const b = createDiagBuffer();
  const s = b.snapshot();
  assert.equal(s.env, null);
  assert.deepEqual(s.entries, []);
  assert.deepEqual(b.size(), { entries: 0, bytes: 0, ok: 0 });
});

test("setEnv redacts PII in the head but keeps the pseudonymous install_id intact", () => {
  const b = createDiagBuffer();
  b.setEnv({
    app_version: "0.1.0",
    platform: "web",
    ua: "Mozilla/5.0 contact me@example.com now",
    locale: "ru-RU",
    install_id: "11111111-2222-3333-4444-555555555555",
    online: true,
    clock_offset: -3,
  });
  const env = b.snapshot().env!;
  assert.ok(env);
  assert.equal(env.platform, "web");
  assert.equal(env.online, true);
  assert.equal(env.clock_offset, -3);
  assert.ok(!env.ua.includes("me@example.com"), "e-mail masked in UA");
  assert.ok(env.ua.includes("e***@***"), "R2 mask applied to UA");
  assert.equal(env.install_id, "11111111-2222-3333-4444-555555555555");
});

test("route breadcrumb keeps path, drops query + masks numeric id (R5)", () => {
  const b = createDiagBuffer();
  b.route("/chat/42?token=abcdefghijklmnopqrstuvwxyz012345");
  const e = b.snapshot().entries[0]!;
  assert.equal(e.kind, "route");
  assert.equal(e.data.to, "/chat/{id}");
  assert.ok(!JSON.stringify(e.data).includes("token="), "query stripped");
});

test("successful api calls are counted, not stored; failures are stored with masked path", () => {
  const b = createDiagBuffer();
  b.api("GET", "/v1/users/42?q=secret", 200, null, 12); // success -> counted only
  b.api("POST", "/v1/support/tickets", 0, "NETWORK", 5); // network failure -> stored
  b.api("get", "/v1/chats/99/messages/7", 500, "SERVER", 8); // 5xx -> stored, ids masked
  const s = b.snapshot();
  assert.equal(s.entries.length, 2);
  assert.equal(b.size().ok, 1);
  assert.equal(s.entries[0]!.data.m, "POST");
  assert.equal(s.entries[0]!.data.p, "/v1/support/tickets");
  assert.equal(s.entries[0]!.data.code, "NETWORK");
  assert.equal(s.entries[1]!.data.m, "GET"); // "get" normalised to a known verb
  assert.equal(s.entries[1]!.data.p, "/v1/chats/{id}/messages/{id}");
});

test("err entry is { msg, stack:[] } with masked msg and bundle-form frames (server error_hash)", () => {
  const b = createDiagBuffer();
  b.err(
    "boom for user@example.com",
    "Error: boom for user@example.com\n    at foo (/app/main.ts:10:5)\n    at bar (https://host/app/x.ts:2:1)",
  );
  const e = b.snapshot().entries[0]!;
  assert.equal(e.kind, "err");
  assert.equal(typeof e.data.msg, "string");
  assert.ok(!(e.data.msg as string).includes("user@example.com"), "msg PII masked");
  assert.ok((e.data.msg as string).includes("e***@***"));
  const stack = e.data.stack as string[];
  assert.ok(Array.isArray(stack));
  assert.ok(stack.length >= 1 && stack.length <= 10);
  assert.ok(stack[0]!.startsWith("at "), "first frame in bundle form");
  assert.ok(stack[0]!.includes("main.ts:10:5"));
  assert.ok(!JSON.stringify(stack).includes("/app/"), "R4 drops absolute path, keeps basename");
});

test("ws event outside the allowlist is coerced; codes/retry kept as ints", () => {
  const b = createDiagBuffer();
  b.ws("open");
  b.ws("bogus-state", 4401);
  b.ws("reconnecting", undefined, 3);
  const es = b.snapshot().entries;
  assert.equal(es[0]!.data.ev, "open");
  assert.equal(es[1]!.data.ev, "state"); // not in allowlist -> generic
  assert.equal(es[1]!.data.code, 4401);
  assert.equal(es[2]!.data.retry, 3);
});

test("every stored entry uses only the §2.1 kind allowlist", () => {
  const b = createDiagBuffer();
  b.route("/a"); b.api("POST", "/x", 400, "VALIDATION", 1); b.ws("closed");
  b.err("x"); b.perf("first-paint", 120); b.ui("open-support");
  for (const e of b.snapshot().entries) assert.ok(KINDS.has(e.kind), `kind ${e.kind}`);
});

test("dual cap: never more than MAX_ENTRIES, oldest evicted first", () => {
  const b = createDiagBuffer({ now: counterNow() });
  for (let i = 0; i < 250; i++) b.route("/a");
  const s = b.snapshot();
  assert.equal(s.entries.length, MAX_ENTRIES);
  // 250 pushes with a 1..250 clock; survivors are the newest 200 => first surviving t === 51.
  assert.equal(s.entries[0]!.t, 51);
  assert.equal(s.entries[MAX_ENTRIES - 1]!.t, 250);
});

test("dual cap: total stringified bytes stay under the byte ceiling", () => {
  const b = createDiagBuffer({ maxBytes: 1024, maxEntries: 10_000 });
  const big = "x".repeat(300);
  for (let i = 0; i < 50; i++) b.err(big);
  const sz = b.size();
  assert.ok(sz.bytes <= 1024, `bytes ${sz.bytes} <= 1024`);
  assert.ok(sz.entries < 50, "older entries evicted to respect the byte cap");
  assert.ok(sz.entries >= 1, "at least the newest entry survives");
});

test("default caps are 200 records AND 64 KiB", () => {
  assert.equal(MAX_ENTRIES, 200);
  assert.equal(MAX_BYTES, 64 * 1024);
});

test("snapshot returns a detached array (later writes do not mutate an earlier snapshot)", () => {
  const b = createDiagBuffer();
  b.route("/a");
  const first: DiagEntry[] = b.snapshot().entries;
  b.route("/b");
  assert.equal(first.length, 1);
  assert.equal(b.snapshot().entries.length, 2);
});

test("clear() empties the ring and the success counter but keeps env", () => {
  const b = createDiagBuffer();
  b.setEnv({ app_version: "1", platform: "web", ua: "ua", locale: "en", install_id: "id", online: false, clock_offset: 0 });
  b.route("/a"); b.api("GET", "/x", 200, null, 1);
  b.clear();
  const s = b.snapshot();
  assert.equal(s.entries.length, 0);
  assert.equal(b.size().ok, 0);
  assert.ok(s.env, "env survives clear()");
});
