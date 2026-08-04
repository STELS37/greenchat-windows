// T-512 — ApiClient.onRequest observer: one PII-free record per round-trip (feeds the diag buffer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, type RequestObservation } from "../src/api.ts";
import { ApiError, NetworkError } from "../src/errors.ts";

function makeApi(fetchImpl: unknown, sink: RequestObservation[]): ApiClient {
  return new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: null, refresh: null, accessExpiresAt: null },
    fetchImpl: fetchImpl as typeof fetch,
    onRequest: (o) => sink.push(o),
    maxRetries: 0,
  });
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("onRequest fires ok:true for a decoded success envelope", async () => {
  const sink: RequestObservation[] = [];
  const api = makeApi(async () => jsonRes({ ok: true, result: { x: 1 } }), sink);
  const r = await api.get<{ x: number }>("/v1/thing/42?q=secret");
  assert.deepEqual(r, { x: 1 });
  assert.equal(sink.length, 1);
  assert.equal(sink[0]!.ok, true);
  assert.equal(sink[0]!.method, "GET");
  assert.equal(sink[0]!.status, 200);
  assert.equal(sink[0]!.code, null);
  assert.equal(sink[0]!.path, "/v1/thing/42?q=secret"); // RAW here; the buffer redacts the path
  assert.ok(sink[0]!.ms >= 0);
});

test("onRequest fires ok:false with the server error code on an envelope error", async () => {
  const sink: RequestObservation[] = [];
  const api = makeApi(async () => jsonRes({ ok: false, error: { code: "VALIDATION" } }, 400), sink);
  await assert.rejects(() => api.post("/v1/support/tickets", { a: 1 }), ApiError);
  assert.equal(sink.length, 1);
  assert.equal(sink[0]!.ok, false);
  assert.equal(sink[0]!.code, "VALIDATION");
  assert.equal(sink[0]!.status, 400);
});

test("onRequest fires status:0 code:NETWORK when no response is seen", async () => {
  const sink: RequestObservation[] = [];
  const api = makeApi(async () => { throw new TypeError("boom"); }, sink);
  await assert.rejects(() => api.get("/v1/x"), NetworkError);
  assert.equal(sink.length, 1);
  assert.equal(sink[0]!.status, 0);
  assert.equal(sink[0]!.code, "NETWORK");
  assert.equal(sink[0]!.ok, false);
});

test("a throwing observer never breaks the request", async () => {
  const api = new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: null, refresh: null, accessExpiresAt: null },
    fetchImpl: (async () => jsonRes({ ok: true, result: 7 })) as typeof fetch,
    onRequest: () => { throw new Error("observer blew up"); },
  });
  const r = await api.get<number>("/v1/x");
  assert.equal(r, 7);
});


test("caller AbortSignal is terminal: no retry/backoff after app lifecycle revokes the request", async () => {
  let attempts = 0;
  let sleeps = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const fetchImpl: typeof fetch = async (_input, init) => {
    attempts++;
    markStarted();
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const api = new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: "a", refresh: "r", accessExpiresAt: null },
    fetchImpl,
    maxRetries: 3,
    sleepImpl: async () => { sleeps++; },
  });
  const controller = new AbortController();
  const request = api.get("/v1/x", { signal: controller.signal });
  await started;
  controller.abort(new Error("application locked"));
  await assert.rejects(request, NetworkError);
  assert.equal(attempts, 1, "an explicit caller abort is never replayed");
  assert.equal(sleeps, 0, "no retry backoff runs after caller abort");
});
