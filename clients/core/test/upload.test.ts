// T-403 — FileUploader (PUT /v1/files, T-016) + MediaCache LRU, against a LIVE compiled server.
// The compatibility path uses a buffered request body that every supported browser/WebView accepts;
// content-addressed replay provides whole-file retry safety, and media downloads are cached with LRU.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { MemoryStore } from "../src/store.ts";
import { FileUploader } from "../src/upload.ts";
import { MediaCache } from "../src/media_cache.ts";
import type { SessionResult } from "../src/types.ts";

let srv: LiveServer;
// The persistence-failure regression is deliberately runnable in a clean broker candidate without
// booting server/dist. Normal suite runs are unchanged; the opt-in mode is used only with a matching
// --test-name-pattern so unrelated live-server cases stay skipped.
const mediaCacheUnitOnly = process.env.GC_MEDIA_CACHE_UNIT_ONLY === "1";
before(async () => {
  if (!mediaCacheUnitOnly) srv = await startLiveServer();
});
after(async () => {
  if (!mediaCacheUnitOnly) await srv.teardown();
});

let uSeq = 0;
function uname(): string {
  return `u${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}
function client(): ApiClient {
  return new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
}
async function register(api: ApiClient, name = "User"): Promise<void> {
  const r = await api.post<SessionResult>(
    "/v1/auth/register",
    { username: uname(), password: "password1", name, legal_accepted: true, age_confirmed: true },
    { idempotent: false },
  );
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
}
// Deterministic pseudo-random bytes (LCG) so uploads are reproducible and dedup is exercised.
function bytes(n: number, seed = 7): Uint8Array {
  const a = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    a[i] = x & 0xff;
  }
  return a;
}

test("FileUploader: buffered PUT reaches the live server and dedups identical bytes", async () => {
  const api = client();
  await register(api, "Uploader");
  const up = new FileUploader({
    baseUrl: srv.base,
    tokens: api.tokens,
    clientId: "node/0.1.0",
    refresh: () => api.refreshTokens(),
  });

  const data = bytes(300 * 1024);
  const ticks: number[] = [];
  const r1 = await up.upload(data, {
    name: "photo.bin",
    mime: "application/octet-stream",
    onProgress: (loaded) => ticks.push(loaded),
  });
  assert.equal(typeof r1.file_id, "number");
  assert.equal(r1.size, data.byteLength);
  assert.equal(r1.dedup, false);
  assert.equal(typeof r1.sha256, "string");
  assert.deepEqual(
    ticks,
    [0, data.byteLength],
    "buffered fetch reports an honest attempt start and completion only after the server accepts it",
  );

  // Re-PUT identical bytes → the same-owner upload lands on their SAME file row (this is our "resume").
  // T-155 (server, rev №76): dedup is deliberately INDISTINGUISHABLE from a fresh upload — the wire
  // response carries no dedup marker, so the SDK's synthesized flag stays false. The old `dedup:true`
  // expectation predated T-155 (the smoke suite's check 49 was updated the same way in 5d87045).
  const r2 = await up.upload(data, { name: "photo-again.bin", mime: "application/octet-stream" });
  assert.equal(r2.dedup, false);
  assert.equal(r2.file_id, r1.file_id);
});

test("MediaCache: downloads a blob once via GET /v1/files/:id, then serves the second get from cache", async () => {
  const api = client();
  await register(api, "Downloader");
  const up = new FileUploader({ baseUrl: srv.base, tokens: api.tokens, clientId: "node/0.1.0" });
  const data = bytes(4096, 99);
  const r = await up.upload(data, { name: "blob.bin", mime: "application/octet-stream" });

  const store = new MemoryStore();
  let fetches = 0;
  const countingFetch: typeof fetch = (input, init) => {
    fetches++;
    return fetch(input, init);
  };
  const mc = new MediaCache({
    baseUrl: srv.base,
    tokens: api.tokens,
    clientId: "node/0.1.0",
    store,
    fetchImpl: countingFetch,
  });

  const b1 = await mc.get(r.file_id);
  assert.deepEqual([...b1.bytes], [...data], "downloaded bytes match the uploaded blob");
  assert.equal(b1.size, data.byteLength);
  assert.equal(await mc.has(r.file_id), true);

  const afterFirst = fetches;
  const b2 = await mc.get(r.file_id); // present in the store → no new network fetch
  assert.equal(b2.size, data.byteLength);
  assert.equal(fetches, afterFirst, "the second get is a pure cache hit");
});

test("MediaCache: a failed local media-cache write does not discard a successful download", async () => {
  class RejectMediaWritesStore extends MemoryStore {
    override put(collection: Parameters<MemoryStore["put"]>[0], key: Parameters<MemoryStore["put"]>[1], value: unknown): Promise<void> {
      if (collection === "media") return Promise.reject(new Error("simulated IndexedDB media write failure"));
      return super.put(collection, key, value);
    }
  }

  const payload = bytes(4096, 123);
  const store = new RejectMediaWritesStore();
  let fetches = 0;
  const mc = new MediaCache({
    baseUrl: "https://media.invalid",
    tokens: emptyTokens(),
    clientId: "node/0.1.0",
    store,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(payload.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "image/webp" },
      });
    },
  });

  const downloaded = await mc.get(77);
  assert.deepEqual([...downloaded.bytes], [...payload]);
  assert.equal(downloaded.mime, "image/webp");
  assert.equal(fetches, 1);
  assert.equal(await mc.has(77), false, "failed cache write leaves no misleading cache hit");
});

test("MediaCache: LRU eviction drops the least-recently-used blob past the byte budget", async () => {
  const store = new MemoryStore();
  let clock = 1000;
  const mc = new MediaCache({
    baseUrl: "http://unused.invalid",
    tokens: emptyTokens(),
    clientId: "node/0.1.0",
    store,
    limitBytes: 10,
    now: () => (clock += 1000),
  });

  await mc.put(1, new Uint8Array(6), "application/octet-stream"); // at=2000, total 6 ≤ 10
  await mc.put(2, new Uint8Array(6), "application/octet-stream"); // at=3000, total 12 > 10 → evict #1
  assert.equal(await mc.has(1), false, "least-recently-used blob evicted");
  assert.equal(await mc.has(2), true, "most-recent blob kept");
  assert.ok((await mc.size()) <= 10, "cache respects the byte budget");
});

// V150 — the picture's pixel size must reach the receiver BEFORE its bytes do, or the bubble cannot
// reserve a box and the conversation jumps when the image decodes. The sender declares it (the server
// owns no image library); this asserts the whole round trip against the live server, including the
// rule that a layout hint may never cost an upload.
test("FileUploader: declared picture dimensions survive the round trip, and a bad one is dropped, not sent", async () => {
  const api = client();
  await register(api, "Sizer");
  const up = new FileUploader({ baseUrl: srv.base, tokens: api.tokens, clientId: "node/0.1.0", refresh: () => api.refreshTokens() });

  const good = await up.upload(bytes(4096, 11), { name: "beach.jpg", mime: "image/jpeg", meta: { width: 1600, height: 1200 } });
  assert.deepEqual(good.meta, { width: 1600, height: 1200 }, "files.meta echoes the declared size");

  // Values the server would refuse (0, fractional, past its 65535px ceiling, a lone edge) never reach
  // it: the upload succeeds and simply carries no size, so a picture is never lost to a layout hint.
  const junk: Array<{ width?: number; height?: number }> = [
    { width: 0, height: 10 }, { width: 1.5, height: 2 }, { width: 99_999, height: 10 }, { width: 800 },
  ];
  let seed = 20;
  for (const meta of junk) {
    const r = await up.upload(bytes(2048, seed++), { name: "odd.jpg", mime: "image/jpeg", meta });
    assert.equal(r.meta, null, `an implausible ${JSON.stringify(meta)} must not be sent`);
  }
});


test("FileUploader: round-video metadata survives upload while malformed optional fields are omitted", async () => {
  const api = client();
  await register(api, "VideoNote");
  const up = new FileUploader({
    baseUrl: srv.base,
    tokens: api.tokens,
    clientId: "node/0.1.0",
    refresh: () => api.refreshTokens(),
  });

  const good = await up.upload(bytes(8192, 71), {
    name: "video-note.webm",
    mime: "video/webm",
    meta: { width: 720, height: 720, duration: 12, round: true },
  });
  assert.deepEqual(good.meta, { width: 720, height: 720, duration: 12, round: true });

  // A bad duration/waveform is advisory and must not turn a usable video note into a failed upload.
  // The valid round flag remains, proving that metadata sanitation is field-local rather than all-or-none.
  const sanitised = await up.upload(bytes(4096, 72), {
    name: "video-note-odd.webm",
    mime: "video/webm",
    meta: { duration: 86_401, waveform: [-1], round: true },
  });
  assert.deepEqual(sanitised.meta, { round: true });
});
