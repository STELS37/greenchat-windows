// QA — account-switch races in MediaCache. A completed session wipe must stay authoritative even when
// an old download/store transaction was already in flight, and a new account must never reuse that promise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, type Collection, type StoreKey } from "../src/store.ts";
import { MediaCache } from "../src/media_cache.ts";

function tokens(): { access: string | null; refresh: string | null; accessExpiresAt: number | null } {
  return { access: "old-access", refresh: null, accessExpiresAt: null };
}

function bytes(marker: number): Uint8Array {
  return new Uint8Array([marker, marker + 1, marker + 2, marker + 3]);
}

function mediaCache(store: MemoryStore, fetchImpl?: typeof fetch): MediaCache {
  return new MediaCache({
    baseUrl: "http://files.test",
    tokens: tokens(),
    clientId: "qa/1",
    store,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class DeferredMediaPutStore extends MemoryStore {
  blockNextMediaPut = false;
  private releasePut!: () => void;
  private markPutStarted!: () => void;
  readonly putStarted = new Promise<void>((resolve) => { this.markPutStarted = resolve; });
  private readonly putGate = new Promise<void>((resolve) => { this.releasePut = resolve; });

  release(): void {
    this.releasePut();
  }

  override async put(collection: Collection, key: StoreKey, value: unknown): Promise<void> {
    if (collection === "media" && this.blockNextMediaPut) {
      this.blockNextMediaPut = false;
      this.markPutStarted();
      await this.putGate;
    }
    await super.put(collection, key, value);
  }
}

class DeferredFirstDownload {
  calls = 0;
  private releaseFirst!: () => void;
  private markFirstStarted!: () => void;
  readonly firstStarted = new Promise<void>((resolve) => { this.markFirstStarted = resolve; });
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  readonly fetch = (async () => {
    this.calls += 1;
    if (this.calls === 1) {
      this.markFirstStarted();
      await this.firstGate;
      return new Response(bytes(10) as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(bytes(90) as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;
}

test("MediaCache reset drains a started old-account put and gates the next account write", async () => {
  const store = new DeferredMediaPutStore();
  const cache = mediaCache(store);
  const resettable = cache as MediaCache & { reset(): Promise<void> };

  store.blockNextMediaPut = true;
  const stalePut = cache.put(1, bytes(10), "image/png");
  await store.putStarted;

  const reset = resettable.reset();
  await store.clear("media"); // Session/LocalData wipe completed while the old transaction was blocked.
  let newPutDone = false;
  const newPut = cache.put(2, bytes(90), "image/png").then(() => { newPutDone = true; });
  await nextTurn();
  assert.equal(newPutDone, false, "new-account media waits behind the reset barrier");

  store.release();
  await assert.rejects(stalePut, /reset|account|session/i);
  await reset;
  await newPut;

  assert.equal(await store.get("media", 1), undefined, "late old-account media is erased after commit");
  const fresh = await store.get<{ bytes?: Uint8Array }>("media", 2);
  assert.deepEqual(fresh?.bytes, bytes(90), "new-account media survives after the barrier opens");
});

test("MediaCache reset rejects an old download and never shares its inflight promise with the next account", async () => {
  const store = new MemoryStore();
  const server = new DeferredFirstDownload();
  const cache = mediaCache(store, server.fetch);
  const resettable = cache as MediaCache & { reset(): Promise<void> };

  const oldGet = cache.get(7);
  await server.firstStarted;

  const reset = resettable.reset();
  const newGet = cache.get(7);
  await nextTurn();
  assert.equal(server.calls, 1, "new-account request is gated while reset drains the old epoch");

  server.release();
  await assert.rejects(oldGet, /reset|account|session/i);
  await reset;
  const fresh = await newGet;

  assert.equal(server.calls, 2, "the next account performs its own authenticated download");
  assert.deepEqual(fresh.bytes, bytes(90));
  const stored = await store.get<{ bytes?: Uint8Array }>("media", 7);
  assert.deepEqual(stored?.bytes, bytes(90));
});
