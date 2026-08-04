// T-422 (revision #25) — an offline moment must NOT destroy a valid session.
//
// Regression for the bug where ApiClient.doRefresh cleared BOTH tokens on ANY error (including a
// NetworkError), so a single network blip at refresh time wiped a live session forever. The fix:
// clear tokens ONLY on a server verdict (ApiError 4xx: reuse/expired/revoked); on NetworkError/5xx
// keep the tokens and rethrow so the caller retries later without onAuthLost.
//
// Two live-server tests prove the real acceptance ("same refresh_token on a live server -> 200 after
// the network returns"; "reuse/invalid -> logout"); two scripted-fetch tests prove request() never
// fires onAuthLost on a transient refresh failure (idempotent retries, non-idempotent surfaces).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { ApiError, NetworkError } from "../src/errors.ts";
import type { SessionResult } from "../src/types.ts";

let srv: LiveServer;
before(async () => {
  srv = await startLiveServer();
});
after(async () => {
  await srv.teardown();
});

let uSeq = 0;
function uname(): string {
  return `u${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}

async function register(api: ApiClient): Promise<void> {
  const r = await api.post<SessionResult>(
    "/v1/auth/register",
    { username: uname(), password: "password1", name: "T422", legal_accepted: true, age_confirmed: true },
    { idempotent: false },
  );
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
}

// A non-JSON envelope Response is never produced here; these helpers script a live-looking wire.
function expiredEnvelope(): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: "TOKEN_EXPIRED", message: "expired" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

test("T-422: an offline refresh preserves the session and recovers when the network returns", async () => {
  // Wrap the real fetch with an offline toggle so the same live refresh_token first fails on the
  // network, then succeeds once connectivity is restored.
  let offline = false;
  const realFetch = globalThis.fetch.bind(globalThis);
  const toggle = ((input: Request | string | URL, init?: RequestInit) =>
    offline ? Promise.reject(new TypeError("fetch failed")) : realFetch(input as RequestInfo, init)) as typeof fetch;

  let authLost = 0;
  const api = new ApiClient({
    baseUrl: srv.base,
    clientId: "node/0.1.0",
    tokens: emptyTokens(),
    fetchImpl: toggle,
    onAuthLost: () => {
      authLost++;
    },
  });
  await register(api);
  const savedRefresh = api.tokens.refresh;
  const savedAccess = api.tokens.access;
  assert.ok(savedRefresh && savedAccess);

  // Network dies exactly at refresh time -> must REJECT with NetworkError and touch NOTHING.
  offline = true;
  await assert.rejects(
    () => api.refreshTokens(),
    (e: unknown) => e instanceof NetworkError,
    "a transient refresh failure must reject, not resolve false",
  );
  assert.equal(api.tokens.refresh, savedRefresh, "refresh token preserved through the blip");
  assert.equal(api.tokens.access, savedAccess, "access token preserved through the blip");
  assert.equal(authLost, 0, "a network blip must never log the user out");

  // Network returns -> the SAME refresh_token now yields 200 and the session lives.
  offline = false;
  const ok = await api.refreshTokens();
  assert.equal(ok, true, "refresh succeeds once the server is reachable again");
  assert.notEqual(api.tokens.access, savedAccess, "access token rotated on the successful refresh");
  const me = await api.get<{ id: number }>("/v1/users/me");
  assert.equal(typeof me.id, "number", "the recovered session can call an authed endpoint");
});

test("T-422: explicit UNAUTHORIZED on refresh is an honest logout that clears the session", async () => {
  const api = new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
  await register(api);
  // A garbage refresh token receives explicit UNAUTHORIZED -> tokens cleared, resolves false.
  api.tokens.refresh = "not-a-real-refresh-token";
  const ok = await api.refreshTokens();
  assert.equal(ok, false, "an explicit terminal auth verdict resolves false");
  assert.equal(api.tokens.access, null, "access cleared on a server verdict");
  assert.equal(api.tokens.refresh, null, "refresh cleared on a server verdict");
});

test("T-422: a non-idempotent request whose refresh fails offline surfaces NetworkError, no logout", async () => {
  let refreshHits = 0;
  let authLost = 0;
  const fetchImpl = ((input: Request | string | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/auth/refresh")) {
      refreshHits++;
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(expiredEnvelope());
  }) as typeof fetch;

  const api = new ApiClient({
    baseUrl: "http://127.0.0.1:1",
    clientId: "node/0.1.0",
    tokens: { access: "expired", refresh: "live-refresh", accessExpiresAt: null },
    fetchImpl,
    onAuthLost: () => {
      authLost++;
    },
  });

  await assert.rejects(
    () => api.post("/v1/messages", { text: "hi" }, { idempotent: false }),
    (e: unknown) => e instanceof NetworkError,
    "a non-idempotent call gets the transient error back",
  );
  assert.equal(authLost, 0, "no onAuthLost on a transient refresh failure");
  assert.equal(refreshHits, 1, "exactly one refresh attempt (no retry storm for a non-idempotent call)");
  assert.equal(api.tokens.access, "expired", "access preserved");
  assert.equal(api.tokens.refresh, "live-refresh", "refresh preserved");
});

test("T-422: an idempotent request retries a failing offline refresh but still never logs out", async () => {
  let refreshHits = 0;
  let authLost = 0;
  const fetchImpl = ((input: Request | string | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/auth/refresh")) {
      refreshHits++;
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(expiredEnvelope());
  }) as typeof fetch;

  const api = new ApiClient({
    baseUrl: "http://127.0.0.1:1",
    clientId: "node/0.1.0",
    tokens: { access: "expired", refresh: "live-refresh", accessExpiresAt: null },
    fetchImpl,
    sleepImpl: async () => {}, // collapse backoff so the retry loop is instant
    onAuthLost: () => {
      authLost++;
    },
  });

  await assert.rejects(
    () => api.get("/v1/users/me"),
    (e: unknown) => e instanceof NetworkError,
    "the idempotent call eventually surfaces the transient error",
  );
  assert.equal(authLost, 0, "never onAuthLost on offline refresh, even after retries");
  assert.ok(refreshHits >= 2, "the idempotent path re-attempted the refresh under the retry policy");
  assert.equal(api.tokens.access, "expired", "access preserved across retries");
  assert.equal(api.tokens.refresh, "live-refresh", "refresh preserved across retries");
});


test("durable refresh rotation survives a lost successful response without logging out", async () => {
  const realFetch = globalThis.fetch.bind(globalThis);
  let loseFirstRefreshResponse = true;
  const sent: Array<{ refresh_token?: string; next_refresh_token?: string }> = [];
  const lossyFetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/auth/refresh")) {
      sent.push(JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string; next_refresh_token?: string });
      const response = await realFetch(input as RequestInfo, init);
      if (loseFirstRefreshResponse) {
        loseFirstRefreshResponse = false;
        throw new TypeError("connection reset after response commit");
      }
      return response;
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  let authLost = 0;
  const api = new ApiClient({
    baseUrl: srv.base,
    clientId: "node/0.1.0",
    tokens: emptyTokens(),
    fetchImpl: lossyFetch,
    onAuthLost: () => { authLost++; },
  });
  await register(api);
  const originalRefresh = api.tokens.refresh;
  assert.ok(originalRefresh);

  await assert.rejects(() => api.refreshTokens(), (err: unknown) => err instanceof NetworkError);
  const pending = api.tokens.refreshNext;
  assert.match(pending ?? "", /^[0-9a-f]{96}$/);
  assert.equal(api.tokens.refresh, originalRefresh, "unacknowledged rotation keeps the current credential");
  assert.equal(authLost, 0);

  assert.equal(await api.refreshTokens(), true, "the same journaled pair is replayed successfully");
  assert.equal(api.tokens.refresh, pending, "server returns the already-committed successor");
  assert.equal(api.tokens.refreshNext, null, "rotation journal is cleared only after acknowledgement");
  assert.equal(authLost, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], "recovery must replay the exact same current/successor pair");

  const me = await api.get<{ id: number }>("/v1/users/me");
  assert.equal(typeof me.id, "number", "the recovered device session remains authenticated");
});

test("a superseded refresh race preserves credentials instead of wiping the account", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    ok: false,
    error: { code: "REFRESH_SUPERSEDED", message: "another context completed refresh" },
  }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
  const tokens = { access: "access", refresh: "refresh", refreshNext: null, accessExpiresAt: null };
  const api = new ApiClient({ baseUrl: "http://test", clientId: "test/1", tokens, fetchImpl });

  await assert.rejects(
    () => api.refreshTokens(),
    (err: unknown) => err instanceof ApiError && err.code === "REFRESH_SUPERSEDED",
  );
  assert.equal(tokens.access, "access");
  assert.equal(tokens.refresh, "refresh");
  assert.match(tokens.refreshNext ?? "", /^[0-9a-f]{96}$/);
});
