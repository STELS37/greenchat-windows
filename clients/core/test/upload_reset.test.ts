// QA — FileUploader account lifecycle. Uploads started by account A must not resolve or refresh after
// logout, and a following account must use its own credential even when the old response arrives late.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FileUploader } from "../src/upload.ts";
import type { TokenStore } from "../src/api.ts";

function payload(seed: number): Uint8Array {
  return new Uint8Array([seed, seed + 1, seed + 2, seed + 3]);
}

function okResponse(fileId: number): Response {
  return new Response(JSON.stringify({
    ok: true,
    result: {
      file_id: fileId,
      name: `f-${fileId}.bin`,
      mime: "application/octet-stream",
      size: 4,
      dedup: false,
      meta: null,
    },
  }), { status: 201, headers: { "content-type": "application/json" } });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class DelayedFirstFetch {
  calls = 0;
  authorizations: Array<string | null> = [];
  private releaseFirst!: () => void;
  private markFirstStarted!: () => void;
  readonly firstStarted = new Promise<void>((resolve) => { this.markFirstStarted = resolve; });
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  readonly fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    this.calls += 1;
    const headers = new Headers(init?.headers);
    this.authorizations.push(headers.get("authorization"));
    if (this.calls === 1) {
      this.markFirstStarted();
      await this.firstGate; // deliberately ignores AbortSignal to emulate a response already committed upstream
      return okResponse(101);
    }
    return okResponse(202);
  }) as typeof fetch;
}

class DelayedUnauthorizedFetch {
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
    this.markFirstStarted();
    await this.firstGate;
    return new Response(JSON.stringify({
      ok: false,
      error: { code: "TOKEN_EXPIRED", message: "expired" },
    }), { status: 401, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function uploader(tokens: TokenStore, fetchImpl: typeof fetch, refresh?: () => Promise<boolean>): FileUploader {
  return new FileUploader({
    baseUrl: "http://upload.test",
    tokens,
    clientId: "qa/1",
    fetchImpl,
    maxRetries: 0,
    ...(refresh ? { refresh } : {}),
  });
}

test("FileUploader reset rejects a late old-account success and the next upload uses the new token", async () => {
  const tokens: TokenStore = { access: "token-A", refresh: null, accessExpiresAt: null };
  const server = new DelayedFirstFetch();
  const up = uploader(tokens, server.fetch);
  const resettable = up as FileUploader & { reset(): void };

  const oldUpload = up.upload(payload(10), { name: "old.bin" });
  await server.firstStarted;

  resettable.reset();
  tokens.access = "token-B";
  const freshUpload = up.upload(payload(90), { name: "new.bin" });
  await nextTurn();
  assert.equal(server.calls, 2, "new account starts an independent upload");

  const fresh = await freshUpload;
  assert.equal(fresh.file_id, 202);
  assert.deepEqual(server.authorizations, ["Bearer token-A", "Bearer token-B"]);

  server.release();
  await assert.rejects(oldUpload, /reset|account|session/i);
});

test("FileUploader reset prevents a late old-account 401 from refreshing the new session", async () => {
  const tokens: TokenStore = { access: "token-A", refresh: "refresh-A", accessExpiresAt: null };
  const server = new DelayedUnauthorizedFetch();
  let refreshCalls = 0;
  const up = uploader(tokens, server.fetch, async () => {
    refreshCalls += 1;
    tokens.access = "unexpected-refresh";
    return true;
  });
  const resettable = up as FileUploader & { reset(): void };

  const oldUpload = up.upload(payload(20), { name: "old-401.bin" });
  await server.firstStarted;
  resettable.reset();
  tokens.access = "token-B";
  tokens.refresh = "refresh-B";

  server.release();
  await assert.rejects(oldUpload, /reset|account|session/i);
  assert.equal(refreshCalls, 0, "stale 401 cannot rotate credentials for the next account");
  assert.equal(tokens.access, "token-B");
  assert.equal(tokens.refresh, "refresh-B");
});


test("FileUploader user cancellation is terminal and never retries the upload", async () => {
  const tokens: TokenStore = { access: "token-A", refresh: null, accessExpiresAt: null };
  let calls = 0;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }) as typeof fetch;
  const up = new FileUploader({
    baseUrl: "http://upload.test",
    tokens,
    clientId: "qa/1",
    fetchImpl,
    maxRetries: 3,
    sleepImpl: async () => undefined,
  });
  const controller = new AbortController();

  const pending = up.upload(payload(30), { name: "cancel.bin", signal: controller.signal });
  await nextTurn();
  controller.abort();

  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(calls, 1, "AbortSignal cancellation is not retried as NetworkError");
});


test("FileUploader cancellation during retry backoff prevents the next PUT", async () => {
  const tokens: TokenStore = { access: "token-A", refresh: null, accessExpiresAt: null };
  let calls = 0;
  let releaseSleep!: () => void;
  let markSleepStarted!: () => void;
  const sleepStarted = new Promise<void>((resolve) => { markSleepStarted = resolve; });
  const sleepGate = new Promise<void>((resolve) => { releaseSleep = resolve; });
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "SERVER_ERROR", message: "retry later" },
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return okResponse(303);
  }) as typeof fetch;
  const up = new FileUploader({
    baseUrl: "http://upload.test",
    tokens,
    clientId: "qa/1",
    fetchImpl,
    maxRetries: 3,
    sleepImpl: async () => { markSleepStarted(); await sleepGate; },
  });
  const controller = new AbortController();

  const pending = up.upload(payload(40), { name: "cancel-backoff.bin", signal: controller.signal });
  await sleepStarted;
  controller.abort();
  releaseSleep();

  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(calls, 1, "cancellation during backoff must not issue another PUT");
});

test("FileUploader cancellation during token refresh prevents replaying the PUT", async () => {
  const tokens: TokenStore = { access: "token-A", refresh: "refresh-A", accessExpiresAt: null };
  let calls = 0;
  let releaseRefresh!: () => void;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "TOKEN_EXPIRED", message: "expired" },
      }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return okResponse(404);
  }) as typeof fetch;
  const up = new FileUploader({
    baseUrl: "http://upload.test",
    tokens,
    clientId: "qa/1",
    fetchImpl,
    maxRetries: 0,
    refresh: async () => {
      markRefreshStarted();
      await refreshGate;
      tokens.access = "token-A-rotated";
      return true;
    },
  });
  const controller = new AbortController();

  const pending = up.upload(payload(50), { name: "cancel-refresh.bin", signal: controller.signal });
  await refreshStarted;
  controller.abort();
  releaseRefresh();

  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(calls, 1, "cancellation during refresh must not replay the upload");
});

test("FileUploader uses a WebView-compatible buffered body instead of a request stream", async () => {
  const tokens: TokenStore = { access: "token-A", refresh: null, accessExpiresAt: null };
  const original = payload(60);
  const ticks: number[] = [];
  let observed: number[] = [];
  let duplex: unknown = "missing";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "http://upload.test/v1/files");
    assert.ok(init?.body instanceof ArrayBuffer, "Android/WebView-safe ArrayBuffer body");
    assert.equal(init.body instanceof ReadableStream, false, "request streams are rejected by embedded WebViews");
    duplex = (init as RequestInit & { duplex?: unknown }).duplex;
    observed = [...new Uint8Array(init.body)];
    return okResponse(505);
  }) as typeof fetch;
  const up = uploader(tokens, fetchImpl);

  const result = await up.upload(original, { name: "webview.bin", onProgress: (loaded) => ticks.push(loaded) });

  assert.equal(result.file_id, 505);
  assert.deepEqual(observed, [...original], "the exact payload reaches fetch");
  assert.equal(duplex, undefined, "duplex is a stream-only option and must not leak into WebView fetch");
  assert.deepEqual(ticks, [0, original.byteLength], "progress changes to complete only after acceptance");
});
