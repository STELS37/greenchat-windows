// Re-consent program (client half, legal v2 / T-124): the two thin SDK shortcuts over the legal
// endpoints. Hermetic (a mock fetch, currency_sdk.test.ts style): no live server. Proves that
// getLegalStatus() reads the exact consent triple over the authed transport, and that acceptLegal()
// binds the write to the DISPLAYED edition — the body carries {legal_accepted:true, version} verbatim,
// and a server refusal (the operator bumped the edition between display and click) surfaces as the
// LEGAL_RECONSENT ApiError with the now-required version in .data, never as a silent success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api.ts";
import { ApiError } from "../src/errors.ts";

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

function makeApi(fn: typeof fetch): ApiClient {
  return new ApiClient({
    baseUrl: "http://x",
    clientId: "node/0.1.0",
    tokens: { access: "tok", refresh: null, accessExpiresAt: null },
    fetchImpl: fn,
    maxRetries: 0,
  });
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface LegalStatus { accepted_version: number; current_version: number; reconsent_required: boolean }
interface LegalAccept { version: number; accepted_at: number }

test("getLegalStatus(): GET /v1/legal/status with Bearer auth; decodes the exact consent triple", async () => {
  const { fn, last } = recordingFetch(() =>
    jsonRes({ ok: true, result: { accepted_version: 1, current_version: 2, reconsent_required: true } }),
  );
  const api = makeApi(fn);
  const st = await api.getLegalStatus<LegalStatus>();
  const c = last();
  assert.equal(c.method, "GET");
  assert.equal(c.url, "http://x/v1/legal/status");
  assert.equal(c.headers["authorization"], "Bearer tok", "status is account state — always authed");
  assert.deepEqual(st, { accepted_version: 1, current_version: 2, reconsent_required: true });
});

test("acceptLegal(v): POST /v1/legal/accept carries EXACTLY {legal_accepted:true, version:v}", async () => {
  const { fn, last } = recordingFetch(() => jsonRes({ ok: true, result: { version: 2, accepted_at: 1784182051 } }));
  const api = makeApi(fn);
  const r = await api.acceptLegal<LegalAccept>(2);
  const c = last();
  assert.equal(c.method, "POST");
  assert.equal(c.url, "http://x/v1/legal/accept");
  assert.equal(c.headers["authorization"], "Bearer tok");
  // deepEqual against the FULL body: the displayed version rides through untouched, nothing extra
  // (no fabricated age_confirmed, no legacy version-less shortcut once a version is known).
  assert.deepEqual(JSON.parse(c.body!), { legal_accepted: true, version: 2 });
  assert.deepEqual(r, { version: 2, accepted_at: 1784182051 });
});

test("acceptLegal(v): a stale displayed edition surfaces 403 LEGAL_RECONSENT with the required version in .data", async () => {
  const { fn } = recordingFetch(() =>
    jsonRes({ ok: false, error: { code: "LEGAL_RECONSENT", message: "legal terms updated — re-consent required", version: 3 } }, 403),
  );
  const api = makeApi(fn);
  await assert.rejects(() => api.acceptLegal(2), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "LEGAL_RECONSENT");
    assert.equal(err.httpStatus, 403);
    assert.equal(err.data.version, 3, "the now-required edition rides in .data for the re-show");
    return true;
  });
});
