// T-520 (DS-02) — EncryptedStore: AES-256-GCM(K_db) per record over any ClientStore.
// Pure units run on a MemoryStore lower layer (same contract as IndexedDbStore — see
// store.test.ts); one integration test drives the real Outbox against a LIVE compiled
// server THROUGH the wrapper, proving the ClientStore consumers need no changes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, type ClientStore, type Collection, type WriteOp } from "../src/store.ts";
import {
  EncryptedStore,
  EncryptedStoreIntegrityError,
  type DbKeyProvider,
} from "../src/encrypted_store.ts";
import { startLiveServer, emptyTokens, waitFor, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { Outbox, type OutboxChange } from "../src/outbox.ts";
import type { SessionResult } from "../src/types.ts";

const ALL: Collection[] = ["meta", "chats", "messages", "contacts", "files", "outbox", "media"];
const ENCRYPTED: Collection[] = ALL.filter((c) => c !== "media");

function freshKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

interface Rig {
  lower: MemoryStore;
  enc: EncryptedStore;
  key: Uint8Array;
}

function rig(provider?: DbKeyProvider): Rig {
  const lower = new MemoryStore();
  const key = freshKey();
  const enc = new EncryptedStore({ store: lower, key: provider ?? (() => key), warn: () => {} });
  return { lower, enc, key };
}

// The raw envelope as the lower store persists it.
interface RawEnvelope { __gc_enc: number; k: string | number; iv: Uint8Array; ct: Uint8Array }
async function rawOf(lower: ClientStore, c: Collection, k: string | number): Promise<RawEnvelope> {
  const raw = await lower.get<RawEnvelope>(c, k);
  assert.ok(raw && raw.__gc_enc === 1, `expected an envelope in ${c}/${k}`);
  return raw;
}

async function rejectsIntegrity(
  action: Promise<unknown>,
  collection: Collection,
  recordKey: string | number | null,
): Promise<EncryptedStoreIntegrityError> {
  let caught: EncryptedStoreIntegrityError | null = null;
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof EncryptedStoreIntegrityError);
    assert.equal(error.collection, collection);
    assert.equal(error.recordKey, recordKey);
    caught = error;
    return true;
  });
  return caught as unknown as EncryptedStoreIntegrityError;
}

// ---------------------------------------------------------------- round-trip

test("round-trip: put/get preserves values across every encrypted collection", async () => {
  const { lower, enc } = rig();
  const samples: Record<string, unknown> = {
    meta: 42, // local_data.ts stores owner_user_id as a RAW NUMBER — top-level scalars must survive
    chats: { id: 7, title: "Приветик", unread: 0, muted: false },
    messages: { id: 1, chat_id: 7, text: "секретный текст 🔐", ts: 1720000000 },
    contacts: { id: 3, name: "Alice", username: null },
    files: { id: "f1", name: "doc.pdf", size: 1024, sha: new Uint8Array([1, 2, 3, 255]) },
    outbox: { id: "c1", status: "queued", payload: { text: "draft" }, attempts: 0 },
  };
  for (const c of ENCRYPTED) {
    await enc.put(c, "k1", samples[c]);
    assert.deepEqual(await enc.get(c, "k1"), samples[c], `round-trip in ${c}`);
    await rawOf(lower, c, "k1"); // and the lower store really holds an envelope, not the value
  }
});

test("round-trip: structured-clone value graphs (nested arrays, Uint8Array, Date, undefined, null)", async () => {
  const { enc } = rig();
  const v = {
    nested: { deep: [1, "two", { three: true }, null] },
    bytes: new Uint8Array([0, 127, 255]),
    when: new Date(1720000000000),
    missing: undefined,
    nan: NaN,
    inf: Infinity,
  };
  await enc.put("messages", 5, v);
  const back = await enc.get<typeof v>("messages", 5);
  assert.ok(back);
  assert.deepEqual(back.nested, v.nested);
  assert.deepEqual(back.bytes, v.bytes);
  assert.ok(back.when instanceof Date && back.when.getTime() === 1720000000000);
  assert.equal(back.missing, undefined);
  assert.ok(Number.isNaN(back.nan));
  assert.equal(back.inf, Infinity);
});

test("delete/clear/get-miss behave exactly like the lower store", async () => {
  const { enc } = rig();
  assert.equal(await enc.get("chats", "absent"), undefined);
  await enc.put("chats", 1, { id: 1 });
  await enc.delete("chats", 1);
  assert.equal(await enc.get("chats", 1), undefined);
  await enc.put("chats", 2, { id: 2 });
  await enc.clear("chats");
  assert.deepEqual(await enc.scan("chats"), []);
});

test("batch: mixed puts+deletes are sealed per-record and stay atomic through one lower.batch", async () => {
  const { lower, enc } = rig();
  await enc.put("messages", 1, { id: 1, text: "old" });
  const ops: WriteOp[] = [
    { op: "put", collection: "messages", key: 2, value: { id: 2, chat_id: 9, text: "b2" } },
    { op: "put", collection: "chats", key: 9, value: { id: 9, title: "c9" } },
    { op: "delete", collection: "messages", key: 1 },
    { op: "put", collection: "media", key: "m1", value: { id: "m1", bytes: new Uint8Array([9]) } },
  ];
  await enc.batch(ops);
  assert.deepEqual(await enc.get("messages", 2), { id: 2, chat_id: 9, text: "b2" });
  assert.deepEqual(await enc.get("chats", 9), { id: 9, title: "c9" });
  assert.equal(await enc.get("messages", 1), undefined);
  await rawOf(lower, "messages", 2); // sealed
  const media = await lower.get<{ bytes: Uint8Array }>("media", "m1");
  assert.deepEqual(media?.bytes, new Uint8Array([9])); // media op passed through untouched
});

// ---------------------------------------------------------------- scan semantics

test("scan: index/value filter, limit and reverse run on DECRYPTED values with plain-store semantics", async () => {
  const { enc } = rig();
  const plain = new MemoryStore(); // reference: identical writes, no encryption
  for (let i = 1; i <= 8; i++) {
    const m = { id: i, chat_id: i % 2 === 0 ? 7 : 8, text: `m${i}` };
    await enc.put("messages", i, m);
    await plain.put("messages", i, m);
  }
  for (const q of [
    {},
    { reverse: true },
    { limit: 3 },
    { index: "chat_id", value: 7 },
    { index: "chat_id", value: 7, reverse: true, limit: 2 },
    { index: "chat_id", value: 999 },
  ]) {
    assert.deepEqual(await enc.scan("messages", q), await plain.scan("messages", q), JSON.stringify(q));
  }
});

// ---------------------------------------------------------------- no plaintext on disk

test("no plaintext on disk: canary bytes never appear in the serialized lower-store state", async () => {
  const { lower, enc } = rig();
  const canary = "CANARY-9f31-совершенно-секретно";
  await enc.put("messages", 1, { id: 1, text: canary });
  await enc.put("meta", "draft:7", `${canary} draft`);
  await enc.batch([{ op: "put", collection: "outbox", key: "o1", value: { payload: { text: canary } } }]);
  // Serialize EVERYTHING the lower store holds (values incl. envelope bytes) and grep.
  for (const c of ENCRYPTED) {
    const rows = await lower.scan(c);
    const flat = JSON.stringify(rows, (_k, v) =>
      v instanceof Uint8Array ? Array.from(v).join(",") + "|" + new TextDecoder().decode(v) : v,
    );
    assert.ok(!flat.includes(canary), `plaintext canary leaked into lower store collection ${c}`);
    assert.ok(!flat.includes("CANARY"), `partial canary leaked into ${c}`);
  }
});

// ---------------------------------------------------------------- AAD binding + tamper

test("AAD: a ciphertext moved to a FOREIGN COLLECTION fails GCM authentication", async () => {
  const { lower, enc } = rig();
  await enc.put("messages", "x", { secret: "payload" });
  const env = await rawOf(lower, "messages", "x");
  await lower.put("chats", "x", env); // attacker copies the envelope across collections
  await rejectsIntegrity(enc.get("chats", "x"), "chats", "x");
});

test("AAD: a ciphertext moved to a FOREIGN KEY in the same collection is rejected", async () => {
  const { lower, enc } = rig();
  await enc.put("messages", "a", { n: 1 });
  const env = await rawOf(lower, "messages", "a");
  await lower.put("messages", "b", env); // splice into another slot
  await rejectsIntegrity(enc.get("messages", "b"), "messages", "b");
});

test("tamper: flipping one ciphertext byte breaks the GCM tag", async () => {
  const { lower, enc } = rig();
  await enc.put("contacts", 1, { name: "Mallory-target" });
  const env = await rawOf(lower, "contacts", 1);
  const ct = new Uint8Array(env.ct);
  ct[0] ^= 0x01;
  await lower.put("contacts", 1, { ...env, ct });
  await rejectsIntegrity(enc.get("contacts", 1), "contacts", 1);
});

test("tamper: string-vs-number keys never alias in the AAD", async () => {
  const { lower, enc } = rig();
  await enc.put("meta", 5, { v: "for numeric five" });
  const env = await rawOf(lower, "meta", 5);
  await lower.put("meta", "5", env); // same textual key, different type
  await rejectsIntegrity(enc.get("meta", "5"), "meta", "5");
});

test("strict posture rejects injected plaintext cursor and reports one integrity incident", async () => {
  const lower = new MemoryStore();
  const key = freshKey();
  const incidents: EncryptedStoreIntegrityError[] = [];
  const enc = new EncryptedStore({
    store: lower,
    key: () => key,
    allowPlaintext: false,
    onIntegrityError: (error) => incidents.push(error),
    warn: () => {},
  });
  await lower.put("meta", "last_seq", { id: "last_seq", value: Number.MAX_SAFE_INTEGER });

  const first = await rejectsIntegrity(enc.get("meta", "last_seq"), "meta", "last_seq");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0], first);
  await rejectsIntegrity(enc.scan("meta"), "meta", null);
  assert.equal(incidents.length, 1, "one corrupt store must emit only one wipe signal");
});

test("malformed encrypted marker is corruption, never a legacy plaintext record", async () => {
  const lower = new MemoryStore();
  const key = freshKey();
  const enc = new EncryptedStore({ store: lower, key: () => key, allowPlaintext: false, warn: () => {} });
  await lower.put("outbox", "bad", {
    __gc_enc: 1,
    k: "bad",
    iv: new Uint8Array(3),
    ct: new Uint8Array([1, 2, 3]),
    body: { text: "must-not-be-trusted" },
  });
  await rejectsIntegrity(enc.get("outbox", "bad"), "outbox", "bad");
});

test("plaintext is readable only while the explicit pre-lock posture remains active", async () => {
  const lower = new MemoryStore();
  let passthrough = true;
  let key: Uint8Array | null = null;
  const enc = new EncryptedStore({
    store: lower,
    key: () => key,
    allowPassthrough: () => passthrough,
    allowPlaintext: () => passthrough,
    warn: () => {},
  });
  await lower.put("chats", 1, { id: 1, title: "legacy" });
  assert.deepEqual(await enc.get("chats", 1), { id: 1, title: "legacy" });

  key = freshKey();
  passthrough = false;
  await rejectsIntegrity(enc.get("chats", 1), "chats", 1);
});

test("migration rejects malformed marker without firing the runtime incident callback", async () => {
  const lower = new MemoryStore();
  const key = freshKey();
  let reports = 0;
  const enc = new EncryptedStore({
    store: lower,
    key: () => key,
    allowPlaintext: true,
    onIntegrityError: () => { reports += 1; },
    warn: () => {},
  });
  await lower.put("messages", 9, { __gc_enc: 1, k: 9, iv: "wrong", ct: "wrong" });
  await assert.rejects(enc.preparePlaintextMigrationOps(key), EncryptedStoreIntegrityError);
  assert.equal(reports, 0, "enable/migration owns its own rollback path before runtime data-plane starts");
});

// ---------------------------------------------------------------- nonces

test("nonces: unique across records AND across rewrites of the same key", async () => {
  const { lower, enc } = rig();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    await enc.put("messages", i, { id: i });
    seen.add((await rawOf(lower, "messages", i)).iv.join(","));
  }
  for (let i = 0; i < 50; i++) {
    await enc.put("messages", 1, { id: 1, rev: i }); // rewrite the same slot
    seen.add((await rawOf(lower, "messages", 1)).iv.join(","));
  }
  assert.equal(seen.size, 100, "every write used a fresh 12-byte nonce");
});

// ---------------------------------------------------------------- passthrough + lock posture

test("passthrough: with no key (allowPassthrough) every value is byte-for-byte the lower store's", async () => {
  const lower = new MemoryStore();
  const warnings: string[] = [];
  const enc = new EncryptedStore({ store: lower, key: () => null, allowPassthrough: true, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, "constructor warns about passthrough");
  assert.match(warnings[0]!, /UNENCRYPTED/);

  const v = { id: 1, text: "plain", bytes: new Uint8Array([1, 2, 3]) };
  await enc.put("messages", 1, v);
  assert.deepEqual(await lower.get("messages", 1), v); // stored verbatim, no envelope
  assert.deepEqual(await enc.get("messages", 1), v);
  await enc.batch([{ op: "put", collection: "chats", key: 2, value: { id: 2 } }]);
  assert.deepEqual(await lower.get("chats", 2), { id: 2 });
  assert.deepEqual(await enc.scan("messages", { index: "id", value: 1 }), [v]);
});

test("locked posture: no key WITHOUT allowPassthrough throws on data ops", async () => {
  const enc = new EncryptedStore({ store: new MemoryStore(), key: () => null });
  await assert.rejects(enc.put("messages", 1, { x: 1 }), /locked/);
  await assert.rejects(enc.scan("messages"), /locked/);
});

// ---------------------------------------------------------------- media exception (T-521 contract)

test("media is NOT encrypted by this layer — always passthrough, even with an active key", async () => {
  const { lower, enc } = rig(); // key IS present
  const blob = { id: "f9", bytes: new Uint8Array([10, 20, 30, 40]), mime: "image/png", size: 4, at: 1 };
  await enc.put("media", "f9", blob);
  const raw = await lower.get<typeof blob>("media", "f9");
  assert.deepEqual(raw, blob, "media blob stored verbatim (per-file K_files encryption is T-521/DS-03)");
  assert.deepEqual(await enc.get("media", "f9"), blob);
  assert.deepEqual(await enc.scan("media", { index: "mime", value: "image/png" }), [blob]);
});

// ---------------------------------------------------------------- lazy migration plaintext→cipher

test("migration: pre-key plaintext stays readable after the key appears; the next put re-encrypts it", async () => {
  const lower = new MemoryStore();
  let key: Uint8Array | null = null; // no session yet
  const enc = new EncryptedStore({ store: lower, key: () => key, allowPassthrough: true, warn: () => {} });

  await enc.put("chats", 1, { id: 1, title: "before-unlock" }); // plaintext era
  await enc.put("meta", "owner", 42);

  key = freshKey(); // DS-04 unlock happens

  // Old plaintext records are still readable (and scannable) through the wrapper…
  assert.deepEqual(await enc.get("chats", 1), { id: 1, title: "before-unlock" });
  assert.deepEqual(await enc.scan("chats", { index: "id", value: 1 }), [{ id: 1, title: "before-unlock" }]);
  assert.equal(await enc.get("meta", "owner"), 42);
  // …new writes are ciphertext…
  await enc.put("chats", 2, { id: 2, title: "after-unlock" });
  await rawOf(lower, "chats", 2);
  // …and rewriting an old record migrates it in place.
  await enc.put("chats", 1, { id: 1, title: "rewritten" });
  await rawOf(lower, "chats", 1);
  assert.deepEqual(await enc.get("chats", 1), { id: 1, title: "rewritten" });
});

// ---------------------------------------------------------------- micro-bench (numbers → result.md)

test("micro-bench: p50 put/get overhead vs bare MemoryStore", async () => {
  const N = 300;
  const value = { id: 0, chat_id: 7, text: "x".repeat(200), ts: 1720000000 };
  async function bench(store: ClientStore): Promise<{ put: number; get: number }> {
    const puts: number[] = [];
    const gets: number[] = [];
    for (let i = 0; i < N; i++) {
      let t = performance.now();
      await store.put("messages", i, { ...value, id: i });
      puts.push(performance.now() - t);
      t = performance.now();
      await store.get("messages", i);
      gets.push(performance.now() - t);
    }
    const p50 = (a: number[]): number => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    return { put: p50(puts), get: p50(gets) };
  }
  const bare = await bench(new MemoryStore());
  const { enc } = rig();
  const wrapped = await bench(enc);
  // eslint-disable-next-line no-console
  console.log(
    `[bench] p50 put: bare=${bare.put.toFixed(3)}ms enc=${wrapped.put.toFixed(3)}ms | ` +
      `p50 get: bare=${bare.get.toFixed(3)}ms enc=${wrapped.get.toFixed(3)}ms (N=${N}, ~230B record)`,
  );
  // §13.1: send/receive budget is +≤5ms per message — the whole encrypt+write must sit far under it.
  assert.ok(wrapped.put < 5, `encrypted p50 put ${wrapped.put.toFixed(3)}ms exceeds the 5ms budget`);
  assert.ok(wrapped.get < 5, `encrypted p50 get ${wrapped.get.toFixed(3)}ms exceeds the 5ms budget`);
});

// ---------------------------------------------------------------- Outbox over the wrapper (live server)

let srv: LiveServer;
before(async () => {
  srv = await startLiveServer();
});
after(async () => {
  await srv.teardown();
});

let uSeq = 0;
function uname(): string {
  return `w5${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}
async function register(api: ApiClient, name: string): Promise<SessionResult & { user: { id: number } }> {
  const r = await api.post<SessionResult>(
    "/v1/auth/register",
    { username: uname(), password: "password1", name, legal_accepted: true, age_confirmed: true },
    { idempotent: false },
  );
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
  return r as SessionResult & { user: { id: number } };
}

test("Outbox works unchanged over EncryptedStore: queued items are ciphertext at rest, send reconciles", async () => {
  const apiA = new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
  const apiB = new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
  await register(apiA, "Alice");
  const b = await register(apiB, "Bob");
  const d = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: b.user.id }, { idempotent: false });

  const { lower, enc } = rig();
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api: apiA, store: enc, undoMs: 0, onChange: (c) => changes.push(c) });

  const canary = "outbox-canary-текст";
  const id = await ob.enqueueMessage(d.id, { text: canary });
  // At rest the queued item is an envelope; the payload text is not in the lower store.
  const atRest = JSON.stringify(await lower.scan("outbox"), (_k, v) =>
    v instanceof Uint8Array ? new TextDecoder().decode(v) : v,
  );
  assert.ok(!atRest.includes(canary), "outbox payload must be ciphertext at rest");

  await waitFor(() => changes.some((c) => c.removed === true && c.item.status === "sent"));
  assert.equal(await enc.get("outbox", id), undefined, "sent item removed through the wrapper");
  const msgs = await apiA.get<Array<{ text: string }>>(`/v1/chats/${d.id}/messages`);
  assert.ok(msgs.some((m) => m.text === canary), "the message reached the server");
});
