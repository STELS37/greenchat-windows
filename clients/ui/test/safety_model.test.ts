import test from "node:test";
import assert from "node:assert/strict";

import type { ApiLike, SearchUser } from "../src/screens/api.ts";
import {
  SafetyControlError,
  blockUserByUsername,
  loadBlockedUsers,
  unblockUser,
} from "../src/screens/safety_model.ts";

type Call = { method: string; path: string; body?: unknown };

class SafetyApi implements ApiLike {
  readonly calls: Call[] = [];
  resolved: SearchUser | null = null;
  blocked: unknown = [];
  blockResult: unknown | undefined;
  blockPromise: Promise<unknown> | undefined;

  get<T>(path: string): Promise<T> {
    this.calls.push({ method: "GET", path });
    return Promise.resolve(this.blocked as T);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ method: "POST", path, body });
    if (this.blockPromise)
      return this.blockPromise as Promise<T>;
    if (this.blockResult !== undefined)
      return Promise.resolve(this.blockResult as T);
    const id = Number(path.split("/").at(-1));
    const user = this.resolved?.id === id ? this.resolved : null;
    if (!user) return Promise.reject(new Error("missing user"));
    return Promise.resolve(user as T);
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected put"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected patch"));
  }
  delete<T>(path: string): Promise<T> {
    this.calls.push({ method: "DELETE", path });
    return Promise.resolve({ ok: true } as T);
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
  resolveUser(username: string): Promise<SearchUser> {
    this.calls.push({ method: "RESOLVE", path: username });
    return this.resolved
      ? Promise.resolve(this.resolved)
      : Promise.reject(
          Object.assign(new Error("not found"), {
            name: "ApiError",
            code: "NOT_FOUND",
          }),
        );
  }
}

const user = (over: Partial<SearchUser> = {}): SearchUser => ({
  id: 9,
  username: "helperbot",
  name: "Helper Bot",
  avatar_file_id: null,
  is_bot: true,
  ...over,
});

test("visible safety control lists blocks and keeps bots blockable", async () => {
  const api = new SafetyApi();
  const bot = user();
  api.blocked = [bot];
  assert.deepEqual(await loadBlockedUsers(api), [bot]);

  api.resolved = bot;
  const blocked = await blockUserByUsername(api, " @HelperBot ", 1);
  assert.equal(blocked.is_bot, true);
  assert.deepEqual(api.calls.slice(-2), [
    { method: "RESOLVE", path: "HelperBot" },
    { method: "POST", path: "/v1/blocks/9", body: {} },
  ]);
});

test("client rejects self/service-account blocks but not ordinary bot reports", async () => {
  const api = new SafetyApi();
  api.resolved = user({ id: 1, username: "self" });
  await assert.rejects(() => blockUserByUsername(api, "self", 1), /yourself/i);
  assert.equal(
    api.calls.some((call) => call.method === "POST"),
    false,
  );

  api.calls.length = 0;
  api.resolved = user({ is_system: true, username: "support" });
  await assert.rejects(
    () => blockUserByUsername(api, "support", 1),
    /service account/i,
  );
  assert.equal(
    api.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("blocked-user list fails closed on a malformed server response", async () => {
  const api = new SafetyApi();
  api.blocked = { users: [] };
  await assert.rejects(
    () => loadBlockedUsers(api),
    /invalid blocked-user list/i,
  );
  api.blocked = [{ id: "9", username: "malformed" }];
  await assert.rejects(
    () => loadBlockedUsers(api),
    /invalid blocked-user list/i,
  );
});

test("block mutation fails closed on a malformed or mismatched POST response", async () => {
  const api = new SafetyApi();
  api.resolved = user();
  api.blockResult = { id: "9", username: "helperbot" };
  await assert.rejects(
    () => blockUserByUsername(api, "helperbot", 1),
    (error: unknown) =>
      error instanceof SafetyControlError && error.code === "invalid_response",
  );

  api.calls.length = 0;
  api.blockResult = user({ id: 10, username: "other" });
  await assert.rejects(
    () => blockUserByUsername(api, "helperbot", 1),
    (error: unknown) =>
      error instanceof SafetyControlError && error.code === "invalid_response",
  );
  assert.deepEqual(api.calls.slice(-2), [
    { method: "RESOLVE", path: "helperbot" },
    { method: "POST", path: "/v1/blocks/9", body: {} },
  ]);
});

test("block mutation honours an abort that happens while POST is in flight", async () => {
  const api = new SafetyApi();
  api.resolved = user();
  let resolvePost!: (value: unknown) => void;
  api.blockPromise = new Promise<unknown>((resolve) => {
    resolvePost = resolve;
  });
  const lifecycle = new AbortController();
  const operation = blockUserByUsername(api, "helperbot", 1, lifecycle.signal);
  await Promise.resolve();
  assert.equal(
    api.calls.some((call) => call.method === "POST"),
    true,
    "the mutation reached its write boundary",
  );

  lifecycle.abort();
  resolvePost(user());
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
});

test("unblock uses the existing reversible server contract", async () => {
  const api = new SafetyApi();
  await unblockUser(api, 42);
  assert.deepEqual(api.calls, [{ method: "DELETE", path: "/v1/blocks/42" }]);
});
