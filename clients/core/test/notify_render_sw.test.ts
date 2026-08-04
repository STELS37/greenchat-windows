// clients/core/test/notify_render_sw.test.ts — T-531: pins clients/web/sw.js to the node-tested
// notify_render module. sw.js is a classic worker that cannot import ESM, so it carries a MIRROR of
// renderNotification; this test executes the real sw.js file in a vm (with stubbed worker globals) and
// (a) proves the mirror renders byte-identically to the module across a payload×mode matrix, and
// (b) drives the actual "push" listener end-to-end on a fake IndexedDB, pinning that the persisted
// gc-diag kv "notify_mode" governs what showNotification receives — including the CONTRACT case of a
// payload with no title/body (server default, notify_preview=false) and the never-crash guarantees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  renderNotification,
  NOTIFY_MODES,
  NOTIFY_MODE_KV_KEY,
} from "../src/notify_render.ts";

const swPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "sw.js");

interface SwHarness {
  ctx: Record<string, any>;
  listeners: Map<string, (event: any) => void>;
  shown: Array<{ title: string; options: any }>;
  kv: Map<string, unknown>;
  cacheKeys: string[];
  deletedCaches: string[];
}

// Minimal fake of the worker environment: enough for sw.js to evaluate and for the push path to run.
// The fake indexedDB implements exactly the calls sw.js makes (open → transaction("kv"|"samples") →
// get/add), resolving success callbacks on a microtask like the real API does asynchronously.
function loadSw(): SwHarness {
  const listeners = new Map<string, (event: any) => void>();
  const shown: Array<{ title: string; options: any }> = [];
  const kv = new Map<string, unknown>();
  const cacheKeys = ["gc-shell-old", "gc-shell-test", "gc-media-v1"];
  const deletedCaches: string[] = [];

  const fakeRequest = (result: unknown) => {
    const rq: any = { result, onsuccess: null, onerror: null };
    queueMicrotask(() => { if (rq.onsuccess) rq.onsuccess(); });
    return rq;
  };
  const fakeDb = {
    close(): void {},
    objectStoreNames: { contains: () => true },
    transaction(_store: string, _mode?: string) {
      const tx: any = {
        onerror: null, onabort: null, oncomplete: null,
        objectStore(_name: string) {
          return {
            get: (key: string) => fakeRequest(kv.get(key)),
            add: (_row: unknown) => fakeRequest(undefined),
          };
        },
      };
      queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
      return tx;
    },
  };
  const indexedDB = {
    open(_name: string, _version: number) {
      const rq: any = { result: fakeDb, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => { if (rq.onsuccess) rq.onsuccess(); });
      return rq;
    },
  };

  const self: any = {
    location: { origin: "https://gc.test" },
    addEventListener(type: string, cb: (event: any) => void) { listeners.set(type, cb); },
    registration: {
      showNotification(title: string, options: any) { shown.push({ title, options }); return Promise.resolve(); },
    },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => undefined,
  };
  const ctx: Record<string, any> = {
    self, indexedDB,
    setTimeout, clearTimeout, queueMicrotask,
    Promise, URL, Response: class {},
    caches: {
      open: () => Promise.resolve({
        addAll: () => Promise.resolve(),
        match: () => Promise.resolve(undefined),
        put: () => Promise.resolve(),
        keys: () => Promise.resolve([]),
        delete: () => Promise.resolve(true),
      }),
      keys: () => Promise.resolve([...cacheKeys]),
      delete: (key: string) => {
        deletedCaches.push(key);
        const index = cacheKeys.indexOf(key);
        if (index >= 0) cacheKeys.splice(index, 1);
        return Promise.resolve(index >= 0);
      },
    },
    fetch: () => Promise.reject(new Error("no network in test")),
    Date, Number, JSON, Error, console,
  };
  vm.createContext(ctx);
  const src = readFileSync(swPath, "utf8")
    .replace('"__SW_VERSION__"', '"test"')
    .replace("= __PRECACHE__;", "= [];");
  vm.runInContext(src, ctx, { filename: "sw.js" });
  return { ctx, listeners, shown, kv, cacheKeys, deletedCaches };
}

// Deliver one push event to the sw's listener and wait for its waitUntil chain to settle.
async function deliverPush(sw: SwHarness, payload: unknown): Promise<void> {
  const push = sw.listeners.get("push");
  assert.ok(push, "sw.js registered a push listener");
  let settled: Promise<unknown> = Promise.resolve();
  push!({
    data: { json: () => payload },
    waitUntil(p: Promise<unknown>) { settled = p; },
  });
  await settled;
}

test("service worker activation removes legacy private-media caches", async () => {
  const sw = loadSw();
  const activate = sw.listeners.get("activate");
  assert.ok(activate, "sw.js registered an activate listener");
  let settled: Promise<unknown> = Promise.resolve();
  activate!({ waitUntil(p: Promise<unknown>) { settled = p; } });
  await settled;
  assert.deepEqual(sw.deletedCaches.sort(), ["gc-media-v1", "gc-shell-old"]);
  assert.deepEqual(sw.cacheKeys, ["gc-shell-test"]);
});

test("service worker never intercepts API or ACL-protected media requests", () => {
  const sw = loadSw();
  const fetchListener = sw.listeners.get("fetch");
  assert.ok(fetchListener, "sw.js registered a fetch listener");
  for (const pathname of ["/v1/files/42", "/v1/users/me", "/v1/chats"]) {
    let responded = false;
    fetchListener!({
      request: { method: "GET", url: `https://gc.test${pathname}`, mode: "cors" },
      respondWith() { responded = true; },
    });
    assert.equal(responded, false, `${pathname} must stay network-only`);
  }
});

const FIXTURES: unknown[] = [
  // Exactly what buildPayload (server/src/push/senders.ts:34) emits, with and without the opt-in preview.
  { chat_id: 42, message_id: 7, kind: "text", sent_at: 1752480000 },
  { chat_id: 42, message_id: 7, kind: "text", sent_at: 1752480000, title: "Alice", body: "Привет!" },
  { chat_id: 42, message_id: 7, kind: "photo", sent_at: 1752480000, title: "Новое сообщение", body: "photo" },
  { chat_id: 9, message_id: 0, kind: "call", sent_at: 1752480000, urgent: true },
  { chat_id: 9, kind: "call", title: "Alice", sent_at: 1752480000 },
  // Contract-violating shapes: must render generic, never crash.
  {}, { title: 123, body: null }, { chat_id: 0, kind: "unknown" }, "junk", null,
];

test("sw.js mirror renders byte-identically to the core module across the fixture×mode matrix", () => {
  const sw = loadSw();
  const swRender = sw.ctx.renderNotification as typeof renderNotification;
  assert.equal(typeof swRender, "function", "sw.js defines renderNotification");
  // vm results live in another realm (foreign Object.prototype), so strict deep-equal would fail on
  // prototypes alone; JSON round-tripping both sides compares pure structure — which IS the contract.
  const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  for (const payload of FIXTURES) {
    for (const mode of [...NOTIFY_MODES, undefined, "junk"]) {
      assert.deepEqual(
        plain(swRender(payload, mode)),
        plain(renderNotification(payload, mode)),
        `mirror parity for ${JSON.stringify(payload)} in mode ${String(mode)}`,
      );
    }
  }
  // The hidden-chat hook is mirrored too (T-527 will plug it in inside sw.js).
  const hooks = { isHiddenChat: (id: unknown) => id === 42 };
  assert.deepEqual(plain(swRender(FIXTURES[1], "full", hooks)), plain(renderNotification(FIXTURES[1], "full", hooks)));
});

test("push handler reads notify_mode from gc-diag kv and renders accordingly", async () => {
  const optedIn = { chat_id: 42, message_id: 7, kind: "text", sent_at: 1, title: "Alice", body: "Привет!" };
  for (const [mode, title, body] of [
    ["full", "Alice", "Привет!"],
    ["name", "Alice", "Новое сообщение"],
    ["generic", "Green Chat", "Новое сообщение"],
  ] as const) {
    const sw = loadSw();
    sw.kv.set(NOTIFY_MODE_KV_KEY, mode);
    await deliverPush(sw, optedIn);
    assert.equal(sw.shown.length, 1, `${mode}: exactly one notification`);
    assert.equal(sw.shown[0]!.title, title, `${mode}: title`);
    assert.equal(sw.shown[0]!.options.body, body, `${mode}: body`);
    assert.equal(sw.shown[0]!.options.tag, "gc-chat-42", `${mode}: coalescing tag kept`);
  }
});

test("push handler: no stored mode / junk mode → default (full); minimal payload → generic strings", async () => {
  // No kv entry at all — the privacy-first server default payload must still notify, generically.
  const sw = loadSw();
  await deliverPush(sw, { chat_id: 1, message_id: 2, kind: "text", sent_at: 1 });
  assert.equal(sw.shown[0]!.title, "Green Chat");
  assert.equal(sw.shown[0]!.options.body, "Новое сообщение");

  const junk = loadSw();
  junk.kv.set(NOTIFY_MODE_KV_KEY, "everything");
  await deliverPush(junk, { chat_id: 1, kind: "text", title: "Alice", body: "hi", sent_at: 1 });
  assert.equal(junk.shown[0]!.title, "Alice", "junk mode falls back to full");
  assert.equal(junk.shown[0]!.options.body, "hi");
});

test("push handler never crashes: undecodable payload and broken IndexedDB still notify", async () => {
  const sw = loadSw();
  const push = sw.listeners.get("push")!;
  let settled: Promise<unknown> = Promise.resolve();
  push({ data: { json: () => { throw new Error("bad json"); } }, waitUntil(p: Promise<unknown>) { settled = p; } });
  await settled;
  assert.equal(sw.shown[0]!.title, "Green Chat", "undecodable payload → generic notification");

  const broken = loadSw();
  broken.ctx.indexedDB.open = () => { throw new Error("idb down"); };
  await deliverPush(broken, { chat_id: 3, kind: "call", sent_at: 1 });
  assert.equal(broken.shown[0]!.options.body, "Входящий звонок", "IDB failure → default mode, call intact");
  assert.equal(broken.shown[0]!.options.renotify, true);
});
