import test from "node:test";
import assert from "node:assert/strict";

import { ApiClient } from "../src/api.ts";
import { ApiError } from "../src/errors.ts";

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function apiWith(
  responder: (request: CapturedRequest) => Response,
  onAuthLost: () => void = () => {},
): { api: ApiClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const request = {
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      method: init.method ?? "GET",
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    };
    requests.push(request);
    return responder(request);
  }) as typeof fetch;
  return {
    api: new ApiClient({
      baseUrl: "https://chat.example",
      clientId: "test/1",
      tokens: { access: "access", refresh: null, accessExpiresAt: null },
      fetchImpl,
      maxRetries: 0,
      onAuthLost,
    }),
    requests,
  };
}

test("deleteAccount: wrong-password 401 stays local and preserves the live session", async () => {
  let authLost = 0;
  const { api, requests } = apiWith(
    () =>
      json(
        {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "invalid credentials" },
        },
        401,
      ),
    () => {
      authLost += 1;
    },
  );

  await assert.rejects(
    () => api.deleteAccount("wrong-password"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    },
  );

  assert.equal(
    authLost,
    0,
    "a handler-level credential rejection must not globally sign out",
  );
  assert.deepEqual(requests, [
    {
      url: "https://chat.example/v1/account",
      method: "DELETE",
      body: JSON.stringify({ password: "wrong-password" }),
    },
  ]);
});

test("ordinary fatal session 401 still triggers the global auth-loss callback", async () => {
  let authLost = 0;
  const { api } = apiWith(
    () =>
      json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "unauthorized" } },
        401,
      ),
    () => {
      authLost += 1;
    },
  );

  await assert.rejects(() => api.get("/v1/users/me"), ApiError);
  assert.equal(authLost, 1);
});

test("wrong old password probes the durable session once but never replays the mutation or logs out", async () => {
  let authLost = 0;
  const { api, requests } = apiWith(
    (request) => {
      if (request.url.endsWith("/v1/auth/refresh")) {
        return json({
          ok: true,
          result: {
            session_id: 7,
            access_token: "access-new",
            access_expires_at: 9_999_999_999,
            refresh_token: "refresh-new",
          },
        });
      }
      return json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "invalid credentials" } },
        401,
      );
    },
    () => {
      authLost += 1;
    },
  );
  api.tokens.refresh = "refresh-old";

  await assert.rejects(
    () => api.post("/v1/auth/password", { old_password: "wrong", new_password: "new-password" }),
    (error: unknown) => error instanceof ApiError && error.code === "UNAUTHORIZED",
  );

  assert.equal(authLost, 0, "a live durable session must survive a secondary credential rejection");
  assert.equal(api.tokens.access, "access-new");
  assert.equal(api.tokens.refresh, "refresh-new");
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/v1/auth/password", "/v1/auth/refresh"],
    "an ambiguous non-idempotent mutation is never replayed automatically",
  );
});

test("generic 401 on an idempotent read refreshes and replays without logging out", async () => {
  let authLost = 0;
  let profileReads = 0;
  const { api, requests } = apiWith(
    (request) => {
      if (request.url.endsWith("/v1/auth/refresh")) {
        return json({
          ok: true,
          result: {
            session_id: 8,
            access_token: "access-new",
            access_expires_at: 9_999_999_999,
            refresh_token: "refresh-new",
          },
        });
      }
      profileReads += 1;
      if (profileReads === 1) {
        return json(
          { ok: false, error: { code: "UNAUTHORIZED", message: "unauthorized" } },
          401,
        );
      }
      return json({ ok: true, result: { id: 42 } });
    },
    () => {
      authLost += 1;
    },
  );
  api.tokens.refresh = "refresh-old";

  assert.deepEqual(await api.get("/v1/users/me"), { id: 42 });
  assert.equal(authLost, 0);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/v1/users/me", "/v1/auth/refresh", "/v1/users/me"],
  );
});

test("explicit remote wipe remains fatal even on a secondary-credential endpoint", async () => {
  let authLost = 0;
  const { api } = apiWith(
    () =>
      json(
        { ok: false, error: { code: "SESSION_WIPED", message: "session was remotely wiped" } },
        401,
      ),
    () => {
      authLost += 1;
    },
  );

  await assert.rejects(() => api.deleteAccount("password-123"), ApiError);
  assert.equal(authLost, 1);
});

test("account suspension immediately closes the local authenticated session", async () => {
  let authLost = 0;
  const { api } = apiWith(
    () =>
      json(
        { ok: false, error: { code: "ACCOUNT_SUSPENDED", message: "account suspended" } },
        403,
      ),
    () => {
      authLost += 1;
    },
  );

  await assert.rejects(() => api.get("/v1/users/me"), ApiError);
  assert.equal(authLost, 1);
});

test("deleteAccount: token-expiry remains globally fatal even with the password challenge exception", async () => {
  let authLost = 0;
  const { api } = apiWith(
    () =>
      json(
        {
          ok: false,
          error: { code: "TOKEN_EXPIRED", message: "access token expired" },
        },
        401,
      ),
    () => {
      authLost += 1;
    },
  );

  await assert.rejects(
    () => api.deleteAccount("password-123"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "TOKEN_EXPIRED");
      return true;
    },
  );
  assert.equal(authLost, 1);
});

test("resolveUser: uses the authoritative exact-username endpoint", async () => {
  const resolved = {
    id: 42,
    username: "ExactBot",
    name: "Exact Bot",
    avatar_file_id: null,
    is_bot: true,
  };
  const { api, requests } = apiWith(() => json({ ok: true, result: resolved }));

  assert.deepEqual(await api.resolveUser("@ExactBot"), resolved);
  assert.deepEqual(requests, [
    {
      url: "https://chat.example/v1/users/resolve?username=ExactBot",
      method: "GET",
    },
  ]);
});
