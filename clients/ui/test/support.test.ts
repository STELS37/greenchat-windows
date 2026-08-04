// Unit tests for the support controller's pure parts (T-512): the localStorage-backed offline queue
// (S-003), the error→result classifier, and flushQueue's replay policy. No DOM — open() is covered by
// support_overlay.test.ts and the live shell probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSupportQueue, classifySupportError, attemptSend, createSupportController,
  type StorageLike, type SupportControllerDeps,
} from "../src/screens/support.ts";
import type { ApiLike, SupportTicketPayload, SupportTicketCreated } from "../src/screens/api.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

const i18n = createI18n({ locale: "en", dicts: { ru, en } });

// A fake Web Storage backed by a Map.
function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}
const payload = (ref: string, withDiag = false): SupportTicketPayload => ({
  category: "bug", text: "a".repeat(20), client_ref: ref,
  ...(withDiag ? { diagnostics: { env: {}, entries: [] } } : {}),
});
// Fabricated errors matching the clients/core .name/.code/.httpStatus/.data contract.
const netErr = () => Object.assign(new Error("offline"), { name: "NetworkError" });
const apiErr = (code: string, httpStatus = 400, data: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { name: "ApiError", code, httpStatus, data });

// ---- offline queue (S-003) -----------------------------------------------------------------------

test("queue: add/list/size, dedup by client_ref, remove", () => {
  const q = createSupportQueue(fakeStorage());
  q.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
  q.add({ client_ref: "r2", payload: payload("r2"), created_at: 2 });
  assert.equal(q.size(), 2);
  assert.deepEqual(q.list().map((i) => i.client_ref), ["r1", "r2"], "oldest first");
  q.add({ client_ref: "r1", payload: payload("r1"), created_at: 9 }); // same ref → replace, not double
  assert.equal(q.size(), 2, "deduped by client_ref");
  assert.equal(q.list().at(-1)!.created_at, 9, "the replacement moved to the tail");
  q.remove("r1");
  assert.deepEqual(q.list().map((i) => i.client_ref), ["r2"]);
});

test("queue: caps at max (oldest evicted) and survives corrupt storage", () => {
  const s = fakeStorage();
  const q = createSupportQueue(s, "gc.support.queue", 3);
  for (let i = 0; i < 5; i++) q.add({ client_ref: `r${i}`, payload: payload(`r${i}`), created_at: i });
  assert.deepEqual(q.list().map((i) => i.client_ref), ["r2", "r3", "r4"], "kept the 3 newest");
  s.map.set("gc.support.queue", "{ not json");
  assert.deepEqual(createSupportQueue(s, "gc.support.queue", 3).list(), [], "corrupt → empty, no throw");
});

// ---- classifier ----------------------------------------------------------------------------------

test("classify: network / 5xx / BAD_RESPONSE → queued (retry later)", () => {
  assert.deepEqual(classifySupportError(netErr(), false, i18n), { kind: "queued" });
  assert.deepEqual(classifySupportError(apiErr("INTERNAL", 500), true, i18n), { kind: "queued" });
  assert.deepEqual(classifySupportError(apiErr("BAD_RESPONSE", 502), false, i18n), { kind: "queued" });
});

test("classify: FEATURE_DISABLED / LIMIT_EXCEEDED (+retry_after)", () => {
  assert.deepEqual(classifySupportError(apiErr("FEATURE_DISABLED", 403), true, i18n), { kind: "disabled" });
  assert.deepEqual(classifySupportError(apiErr("LIMIT_EXCEEDED", 429, { retry_after: 60 }), true, i18n), { kind: "limit", retryAfter: 60 });
  assert.deepEqual(classifySupportError(apiErr("LIMIT_EXCEEDED", 429), true, i18n), { kind: "limit" });
});

test("classify: VALIDATION_FAILED → oversize only when diagnostics were attached, else a plain error", () => {
  assert.deepEqual(classifySupportError(apiErr("VALIDATION_FAILED", 400), true, i18n), { kind: "oversize" });
  const noDiag = classifySupportError(apiErr("VALIDATION_FAILED", 400), false, i18n);
  assert.equal(noDiag.kind, "error");
  const other = classifySupportError(apiErr("NOT_FOUND", 404), false, i18n);
  assert.equal(other.kind, "error");
});

// ---- attemptSend ---------------------------------------------------------------------------------

test("attemptSend: success → created{ref}; throw → classified failure", async () => {
  const ok = await attemptSend(async () => ({ ref: "GC-000007", status: "open", chat_id: 3 }), payload("r"), i18n);
  assert.deepEqual(ok, { kind: "created", ref: "GC-000007" });
  const fail = await attemptSend(async () => { throw netErr(); }, payload("r"), i18n);
  assert.deepEqual(fail, { kind: "queued" });
});

// ---- controller.flushQueue -----------------------------------------------------------------------

interface Rig { ctrl: ReturnType<typeof createSupportController>; queue: ReturnType<typeof createSupportQueue>; created: SupportTicketPayload[]; toasts: string[]; }
function controller(create: (b: SupportTicketPayload) => Promise<SupportTicketCreated>, online = true): Rig {
  const created: SupportTicketPayload[] = [];
  const toasts: string[] = [];
  const queue = createSupportQueue(fakeStorage());
  const api = { createSupportTicket: (b: SupportTicketPayload) => { created.push(b); return create(b); } } as unknown as ApiLike;
  const deps: SupportControllerDeps = {
    api, i18n, queue,
    mount: () => {}, newClientRef: () => "x", now: () => 1,
    online: () => online, toast: (m) => { toasts.push(m); },
  };
  return { ctrl: createSupportController(deps), queue, created, toasts };
}
let seq = 0;
const okRef = (): Promise<SupportTicketCreated> => { seq++; return Promise.resolve({ ref: `GC-00000${seq}`, status: "open", chat_id: null }); };

test("flush: sends every queued ticket in order, clears them, toasts each ref", async () => {
  seq = 0;
  const rig = controller(okRef);
  rig.queue.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
  rig.queue.add({ client_ref: "r2", payload: payload("r2"), created_at: 2 });
  const n = await rig.ctrl.flushQueue();
  assert.equal(n, 2);
  assert.equal(rig.queue.size(), 0, "queue drained");
  assert.deepEqual(rig.created.map((p) => p.client_ref), ["r1", "r2"], "oldest first");
  assert.equal(rig.toasts.length, 2);
});

test("flush: offline is a no-op that keeps the queue", async () => {
  const rig = controller(okRef, /*online*/ false);
  rig.queue.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
  assert.equal(await rig.ctrl.flushQueue(), 0);
  assert.equal(rig.queue.size(), 1, "nothing sent, nothing lost");
});

test("flush: a network failure stops the drain and preserves the whole tail", async () => {
  const rig = controller(async () => { throw netErr(); });
  rig.queue.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
  rig.queue.add({ client_ref: "r2", payload: payload("r2"), created_at: 2 });
  assert.equal(await rig.ctrl.flushQueue(), 0);
  assert.equal(rig.queue.size(), 2, "kept for the next online drain");
});

test("flush: LIMIT_EXCEEDED and FEATURE_DISABLED both stop and keep the queue", async () => {
  for (const code of ["LIMIT_EXCEEDED", "FEATURE_DISABLED"]) {
    const rig = controller(async () => { throw apiErr(code, code === "LIMIT_EXCEEDED" ? 429 : 403); });
    rig.queue.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
    assert.equal(await rig.ctrl.flushQueue(), 0, code);
    assert.equal(rig.queue.size(), 1, `${code} keeps the ticket`);
  }
});

test("flush: a permanent VALIDATION (no diagnostics) is dropped so it can't loop forever", async () => {
  const rig = controller(async () => { throw apiErr("VALIDATION_FAILED", 400); });
  rig.queue.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
  assert.equal(await rig.ctrl.flushQueue(), 0);
  assert.equal(rig.queue.size(), 0, "dropped, not retried endlessly");
});

test("flush: an oversize queued ticket is retried WITHOUT diagnostics (same client_ref) and then clears", async () => {
  let calls = 0;
  const rig = controller(async (b) => {
    calls++;
    if (b.diagnostics) throw apiErr("VALIDATION_FAILED", 400); // oversize with the blob
    return { ref: "GC-000123", status: "open", chat_id: null };  // succeeds without it
  });
  rig.queue.add({ client_ref: "r1", payload: payload("r1", /*withDiag*/ true), created_at: 1 });
  assert.equal(await rig.ctrl.flushQueue(), 1);
  assert.equal(calls, 2, "one oversize attempt + one slimmed resend");
  assert.equal(rig.queue.size(), 0, "cleared after the slimmed resend");
  assert.equal(rig.created[1]!.client_ref, "r1", "same client_ref → server-idempotent");
  assert.equal(rig.created[1]!.diagnostics, undefined, "resend dropped the blob");
});

test("pendingCount reflects the queue size", () => {
  const rig = controller(okRef);
  assert.equal(rig.ctrl.pendingCount(), 0);
  rig.queue.add({ client_ref: "r1", payload: payload("r1"), created_at: 1 });
  assert.equal(rig.ctrl.pendingCount(), 1);
});


test("flush: concurrent online/resume triggers share one drain, one request and one toast", async () => {
  let release!: (value: SupportTicketCreated) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<SupportTicketCreated>((resolve) => { release = resolve; });
  const rig = controller(async () => {
    started();
    return pending;
  });
  rig.queue.add({ client_ref: "race-1", payload: payload("race-1"), created_at: 1 });

  const first = rig.ctrl.flushQueue();
  const second = rig.ctrl.flushQueue();
  await requestStarted;
  assert.equal(rig.created.length, 1, "the same queued client_ref is sent only once");

  release({ ref: "GC-000777", status: "open", chat_id: null });
  assert.deepEqual(await Promise.all([first, second]), [1, 1], "both callers observe the shared result");
  assert.equal(rig.queue.size(), 0);
  assert.equal(rig.toasts.length, 1, "one accepted ticket produces one toast");
});

test("flush: single-flight is released after a transient stop so a later trigger can retry", async () => {
  let attempt = 0;
  const rig = controller(async () => {
    attempt += 1;
    if (attempt === 1) throw netErr();
    return { ref: "GC-000778", status: "open", chat_id: null };
  });
  rig.queue.add({ client_ref: "retry-1", payload: payload("retry-1"), created_at: 1 });

  assert.equal(await rig.ctrl.flushQueue(), 0);
  assert.equal(rig.queue.size(), 1);
  assert.equal(await rig.ctrl.flushQueue(), 1, "a later online event starts a fresh drain");
  assert.equal(attempt, 2);
  assert.equal(rig.queue.size(), 0);
});


test("support reset clears every account-owned offline ticket", () => {
  const rig = controller(okRef);
  rig.queue.add({ client_ref: "a-1", payload: payload("a-1"), created_at: 1 });
  rig.queue.add({ client_ref: "a-2", payload: payload("a-2"), created_at: 2 });

  rig.ctrl.reset();
  assert.equal(rig.queue.size(), 0);
  assert.equal(rig.ctrl.pendingCount(), 0);
});

test("support reset suppresses a late accepted flush and its previous-account toast", async () => {
  let release!: (value: SupportTicketCreated) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<SupportTicketCreated>((resolve) => { release = resolve; });
  const rig = controller(async () => { started(); return pending; });
  rig.queue.add({ client_ref: "alice-1", payload: payload("alice-1"), created_at: 1 });

  const oldFlush = rig.ctrl.flushQueue();
  await requestStarted;
  rig.ctrl.reset();
  release({ ref: "GC-000901", status: "open", chat_id: null });

  assert.equal(await oldFlush, 0, "a superseded account drain reports no accepted ticket to the new shell");
  assert.equal(rig.queue.size(), 0);
  assert.deepEqual(rig.toasts, [], "account A completion cannot toast in account B/sign-in UI");
});

test("support reset detaches the old single-flight so the next account can drain independently", async () => {
  let releaseAlice!: (value: SupportTicketCreated) => void;
  let aliceStarted!: () => void;
  const aliceRequestStarted = new Promise<void>((resolve) => { aliceStarted = resolve; });
  const alicePending = new Promise<SupportTicketCreated>((resolve) => { releaseAlice = resolve; });
  const rig = controller(async (body) => {
    if (body.client_ref === "alice-1") {
      aliceStarted();
      return alicePending;
    }
    return { ref: "GC-000902", status: "open", chat_id: null };
  });
  rig.queue.add({ client_ref: "alice-1", payload: payload("alice-1"), created_at: 1 });

  const aliceFlush = rig.ctrl.flushQueue();
  await aliceRequestStarted;
  rig.ctrl.reset();
  rig.queue.add({ client_ref: "bob-1", payload: payload("bob-1"), created_at: 2 });
  const bobFlush = rig.ctrl.flushQueue();
  await Promise.resolve();
  await Promise.resolve();

  releaseAlice({ ref: "GC-000900", status: "open", chat_id: null });
  const [aliceSent, bobSent] = await Promise.all([aliceFlush, bobFlush]);
  assert.deepEqual([aliceSent, bobSent], [0, 1]);
  assert.deepEqual(rig.created.map((p) => p.client_ref), ["alice-1", "bob-1"]);
  assert.equal(rig.queue.size(), 0);
  assert.equal(rig.toasts.length, 1, "only Bob's current-account acceptance is surfaced");
});
