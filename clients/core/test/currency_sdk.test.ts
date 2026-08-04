// T-503 — user-currency SDK: the 204 transport fix + the putMyCurrency/getFxRates shortcuts.
// Hermetic (a mock fetch, api_observe.test.ts style): no live server. Proves that a 204 self-response
// decodes to null instead of the BAD_RESPONSE trap, and that the two shortcuts hit the right
// method+path+body over the same transport (auth header, envelope decode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, type RequestObservation } from "../src/api.ts";
import { ApiError } from "../src/errors.ts";
import type { FxRatesResult } from "../src/types.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

// A mock fetch that records the last call and replies with `make(captured)` — lets a test assert on
// the request AND control the response (status/body).
function recordingFetch(make: (c: Captured) => Response): { fn: typeof fetch; last: () => Captured } {
  let last: Captured;
  const fn = (async (url: string, init: RequestInit): Promise<Response> => {
    const h = (init.headers ?? {}) as Record<string, string>;
    last = { url, method: init.method ?? "GET", headers: h, body: init.body as string | undefined };
    return make(last);
  }) as unknown as typeof fetch;
  return { fn, last: () => last };
}

function makeApi(fn: typeof fetch, sink: RequestObservation[] = []): ApiClient {
  return new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: "tok", refresh: null, accessExpiresAt: null },
    fetchImpl: fn,
    onRequest: (o) => sink.push(o),
    maxRetries: 0,
  });
}

const res204 = (): Response => new Response(null, { status: 204 });
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("attempt(): a 204 self-response decodes to null (not BAD_RESPONSE) and observes ok:true", async () => {
  const sink: RequestObservation[] = [];
  const { fn } = recordingFetch(() => res204());
  const api = makeApi(fn, sink);
  const r = await api.put<null>("/v1/me/currency", { currency: "EUR" });
  assert.equal(r, null);
  assert.equal(sink.length, 1);
  assert.equal(sink[0]!.status, 204);
  assert.equal(sink[0]!.ok, true);
  assert.equal(sink[0]!.code, null);
});

test("putMyCurrency(): PUT /v1/me/currency {currency}, Bearer auth, resolves null on 204", async () => {
  const { fn, last } = recordingFetch(() => res204());
  const api = makeApi(fn);
  const r = await api.putMyCurrency("EUR");
  assert.equal(r, null);
  const c = last();
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "http://x/v1/me/currency");
  assert.deepEqual(JSON.parse(c.body!), { currency: "EUR" });
  assert.equal(c.headers["authorization"], "Bearer tok");
});

test("putMyCurrency(): an unknown code still surfaces the server VALIDATION_FAILED (enveloped 400)", async () => {
  const { fn } = recordingFetch(() => jsonRes({ ok: false, error: { code: "VALIDATION_FAILED", message: "invalid currency" } }, 400));
  const api = makeApi(fn);
  await assert.rejects(() => api.putMyCurrency("XXX"), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "VALIDATION_FAILED");
    assert.equal(err.httpStatus, 400);
    return true;
  });
});

test("getFxRates(): GET /v1/fx/rates with no filter; decodes the reference table", async () => {
  const table: FxRatesResult = {
    enabled: true, source: "manual", refresh_sec: 21600, max_age_sec: 259200,
    manual_max_age_sec: 0, fetch_fail_streak: 0,
    items: [{ base: "USD", quote: "EUR", price: "923600000", source: "manual", fetched_at: 1784017089, age_sec: 5, stale: false }],
  };
  const { fn, last } = recordingFetch(() => jsonRes({ ok: true, result: table }));
  const api = makeApi(fn);
  const r = await api.getFxRates<FxRatesResult>();
  assert.equal(last().url, "http://x/v1/fx/rates");
  assert.equal(last().method, "GET");
  assert.equal(r.items[0]!.price, "923600000", "amount stays a string (no float parse)");
  assert.equal(r.enabled, true);
});

test("getFxRates(currency): appends ?currency=, URL-encoded", async () => {
  const { fn, last } = recordingFetch(() => jsonRes({ ok: true, result: { items: [] } }));
  const api = makeApi(fn);
  await api.getFxRates("EUR");
  assert.equal(last().url, "http://x/v1/fx/rates?currency=EUR");
});
