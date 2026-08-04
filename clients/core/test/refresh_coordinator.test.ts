import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, type RefreshCoordinator, type TokenStore } from "../src/api.ts";

function okRefresh(access: string, refresh: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    result: {
      session_id: 1,
      access_token: access,
      access_expires_at: 4_000_000_000,
      refresh_token: refresh,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("RefreshCoordinator serializes rotating tokens across independent ApiClient instances", async () => {
  let persisted = "r0";
  let tail = Promise.resolve();
  const wireTokens: string[] = [];

  const coordinator = (tokens: TokenStore): RefreshCoordinator => async (task) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      tokens.refresh = persisted;
      const ok = await task();
      if (ok && tokens.refresh) persisted = tokens.refresh;
      return ok;
    } finally {
      release();
    }
  };

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
    wireTokens.push(body.refresh_token ?? "");
    if (body.refresh_token === "r0") return okRefresh("a1", "r1");
    if (body.refresh_token === "r1") return okRefresh("a2", "r2");
    return new Response(JSON.stringify({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "refresh token reuse detected" },
    }), { status: 401, headers: { "content-type": "application/json" } });
  };

  const tokensA: TokenStore = { access: null, refresh: "r0", accessExpiresAt: null };
  const tokensB: TokenStore = { access: null, refresh: "r0", accessExpiresAt: null };
  const apiA = new ApiClient({
    baseUrl: "http://test",
    clientId: "test/1",
    tokens: tokensA,
    fetchImpl,
    maxRetries: 0,
    refreshCoordinator: coordinator(tokensA),
  });
  const apiB = new ApiClient({
    baseUrl: "http://test",
    clientId: "test/1",
    tokens: tokensB,
    fetchImpl,
    maxRetries: 0,
    refreshCoordinator: coordinator(tokensB),
  });

  const [a, b] = await Promise.all([apiA.refreshTokens(), apiB.refreshTokens()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.deepEqual(wireTokens, ["r0", "r1"]);
  assert.equal(tokensA.refresh, "r1");
  assert.equal(tokensB.refresh, "r2");
  assert.equal(persisted, "r2");
});
