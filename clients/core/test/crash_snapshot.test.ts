// clients/core/test/crash_snapshot.test.ts — T-514 (MS-4): the persisted crash snapshot (SUPPORT.md §2.3 R7).
// Pure/DOM-free: a Map-backed CrashStorageLike stands in for localStorage. We pin the round-trip, the
// last-wins single-snapshot rule, the byte cap (oldest ring entries evicted first), message redaction, the
// malformed/unknown-version → null contract, and the distinct-key invariant (no collision with the queue).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  saveCrashSnapshot, readCrashSnapshot, clearCrashSnapshot, isBrowserLayoutNotice,
  CRASH_SNAPSHOT_KEY, CRASH_SNAPSHOT_MAX_BYTES,
  type CrashStorageLike,
} from "../src/crash_snapshot.ts";
import type { DiagSnapshot } from "../src/diag_buffer.ts";

function memStore(): CrashStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function snap(entries: DiagSnapshot["entries"], env: DiagSnapshot["env"] = null): DiagSnapshot {
  return { env, entries };
}

test("save → read round-trips the snapshot and stamps v:1 + at", () => {
  const s = memStore();
  const snapshot = snap([
    { t: 1, kind: "route", data: { to: "chats" } },
    { t: 2, kind: "err", data: { msg: "boom", stack: [] } },
  ], { app_version: "0.1.0", platform: "web", ua: "x", locale: "en", install_id: "abc", online: true, clock_offset: 0 });
  saveCrashSnapshot(s, "TypeError: boom", snapshot, { now: () => 1234 });

  const back = readCrashSnapshot(s);
  assert.ok(back);
  assert.equal(back.v, 1);
  assert.equal(back.at, 1234);
  assert.equal(back.message, "TypeError: boom");
  assert.equal(back.snapshot.entries.length, 2);
  assert.deepEqual(back.snapshot.env, snapshot.env);
});

test("only ONE snapshot is kept — a later crash overwrites an unsent one (last-wins)", () => {
  const s = memStore();
  saveCrashSnapshot(s, "first", snap([{ t: 1, kind: "err", data: { msg: "first" } }]), { now: () => 1 });
  saveCrashSnapshot(s, "second", snap([{ t: 2, kind: "err", data: { msg: "second" } }]), { now: () => 2 });
  const back = readCrashSnapshot(s);
  assert.equal(back?.message, "second");
  assert.equal(back?.at, 2);
  // Exactly one key holds the record.
  assert.equal(s.map.size, 1);
});

test("clear removes the snapshot; a subsequent read is null", () => {
  const s = memStore();
  saveCrashSnapshot(s, "x", snap([{ t: 1, kind: "err", data: {} }]));
  assert.ok(readCrashSnapshot(s));
  clearCrashSnapshot(s);
  assert.equal(readCrashSnapshot(s), null);
  assert.equal(s.map.size, 0);
});

test("byte cap: oldest ring entries are evicted first, env + message survive", () => {
  const s = memStore();
  // Build many bulky entries so the record blows past a tiny cap; the newest must be retained.
  const entries: DiagSnapshot["entries"] = [];
  for (let i = 0; i < 400; i++) entries.push({ t: i, kind: "api", data: { p: "/v1/x/{id}/" + "z".repeat(40), i } });
  const env = { app_version: "0.1.0", platform: "web", ua: "u", locale: "en", install_id: "id", online: true, clock_offset: 0 };
  saveCrashSnapshot(s, "cap me", snap(entries, env), { maxBytes: 4096 });

  const raw = s.map.get(CRASH_SNAPSHOT_KEY)!;
  assert.ok(Buffer.byteLength(raw, "utf8") <= 4096, "record must fit the cap");
  const back = readCrashSnapshot(s)!;
  assert.equal(back.message, "cap me");
  assert.deepEqual(back.snapshot.env, env); // env preserved
  assert.ok(back.snapshot.entries.length > 0 && back.snapshot.entries.length < 400, "some entries evicted");
  // Eviction is oldest-first: the retained head index must be greater than the original head (0).
  const firstKeptI = (back.snapshot.entries[0]!.data as { i: number }).i;
  assert.ok(firstKeptI > 0, "oldest entries dropped first");
  // The very newest entry is retained.
  const lastKeptI = (back.snapshot.entries[back.snapshot.entries.length - 1]!.data as { i: number }).i;
  assert.equal(lastKeptI, 399);
});

test("default cap is 64 KiB", () => {
  assert.equal(CRASH_SNAPSHOT_MAX_BYTES, 64 * 1024);
});

test("crash message is redacted (R2 e-mail / R2 digit runs)", () => {
  const s = memStore();
  saveCrashSnapshot(s, "login failed for user@example.com card 4111111111111111", snap([]));
  const back = readCrashSnapshot(s)!;
  assert.ok(!back.message.includes("user@example.com"), "e-mail masked");
  assert.ok(!/\d{7,}/.test(back.message), "long digit runs masked");
});

test("malformed / unknown-version values read back as null (never throw)", () => {
  const s = memStore();
  const cases = [
    "not json at all {",
    JSON.stringify({ v: 2, at: 1, message: "x", snapshot: { env: null, entries: [] } }), // unknown version
    JSON.stringify({ v: 1, at: "nope", message: "x", snapshot: { env: null, entries: [] } }), // bad at
    JSON.stringify({ v: 1, at: 1, message: 5, snapshot: { env: null, entries: [] } }), // bad message
    JSON.stringify({ v: 1, at: 1, message: "x", snapshot: { env: null } }), // no entries array
    JSON.stringify({ v: 1, at: 1, message: "x" }), // no snapshot
    JSON.stringify(null),
  ];
  for (const raw of cases) {
    s.map.set(CRASH_SNAPSHOT_KEY, raw);
    assert.equal(readCrashSnapshot(s), null, `should be null for: ${raw.slice(0, 40)}`);
  }
});

test("read is null when nothing was ever saved", () => {
  assert.equal(readCrashSnapshot(memStore()), null);
});

test("distinct localStorage key — does not collide with the offline ticket queue", () => {
  // The queue's key is "gc.support.queue" (SUPPORT_QUEUE_KEY); the crash key must differ so persisting one
  // never clobbers the other.
  assert.equal(CRASH_SNAPSHOT_KEY, "gc.support.crash");
  assert.notEqual(CRASH_SNAPSHOT_KEY, "gc.support.queue");
});

test("a save that throws inside Storage is swallowed (never breaks the crash handler)", () => {
  const throwing: CrashStorageLike = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("nope"); },
  };
  assert.doesNotThrow(() => saveCrashSnapshot(throwing, "x", snap([{ t: 1, kind: "err", data: {} }])));
  assert.doesNotThrow(() => clearCrashSnapshot(throwing));
  assert.equal(readCrashSnapshot(throwing), null);
});

// --- V99: a browser layout notice is not a crash -----------------------------------------------
//
// Measured on the signed superapp APK (redroid Android, WebView 128, 2026-07-31): switching tabs raised
// the window error "ResizeObserver loop completed with undelivered notifications." — a browser-generated
// notice with `error === null`, dispatched when a ResizeObserver callback changed layout and the rest of
// the observations were deferred one frame. Nothing was thrown and the frame was painted. The product
// still persisted a crash snapshot, counted the session as crashed and, on the NEXT launch, showed the
// user "the app crashed last time — send a report?". The app accused itself of crashing after a clean
// session, and its crash-rate telemetry was inflated by a layout notice.
//
// These cases pin the narrow gate: browser-generated ResizeObserver notices are filtered, anything
// carrying a real Error — or any other reason value — stays a crash.
test("isBrowserLayoutNotice: ResizeObserver notices are filtered, real errors are not", () => {
  // The exact strings the engines emit (Chromium/WebView and Firefox wordings).
  assert.equal(isBrowserLayoutNotice("ResizeObserver loop completed with undelivered notifications.", null), true);
  assert.equal(isBrowserLayoutNotice("ResizeObserver loop limit exceeded", undefined), true);
  // Case/prefix insensitive: WebView prefixes the message with "Uncaught " in some builds.
  assert.equal(isBrowserLayoutNotice("Uncaught resizeobserver loop completed", null), true);

  // A real throw is always a crash, even if its message happens to mention the observer.
  assert.equal(isBrowserLayoutNotice("ResizeObserver loop completed", new Error("boom")), false);
  assert.equal(isBrowserLayoutNotice("boom", new Error("boom")), false);
  // A non-Error rejection value is the app's own value, never a browser notice.
  assert.equal(isBrowserLayoutNotice("ResizeObserver loop completed", "resize"), false);
  assert.equal(isBrowserLayoutNotice("ResizeObserver loop completed", 0), false);
  // Unrelated failures keep their crash status.
  assert.equal(isBrowserLayoutNotice("TypeError: x is not a function", null), false);
  assert.equal(isBrowserLayoutNotice("", null), false);
  assert.equal(isBrowserLayoutNotice(undefined, null), false);
});
