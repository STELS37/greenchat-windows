import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/screens/session.ts";
import type { TokenHolder, SessionStorage, PersistedSession, LocalData } from "../src/screens/session.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { AuthSession } from "../src/screens/types.ts";

// A scriptable ApiLike: each method pops the next queued outcome (value or thrown error), recording calls.
interface Call { path: string; body?: unknown; }
class FakeApi implements ApiLike {
  calls: Call[] = [];
  posts: Array<() => unknown> = [];
  deletes: Array<() => unknown> = [];
  refreshResult: () => boolean = () => true;
  refreshCalls = 0;
  private nextPost(): unknown {
    const fn = this.posts.shift();
    if (!fn) throw new Error("unexpected post");
    return fn();
  }
  get<T>(path: string): Promise<T> { this.calls.push({ path }); return Promise.reject(new Error("no get")); }
  post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    try {
      return Promise.resolve(this.nextPost() as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  put<T>(path: string): Promise<T> {
    this.calls.push({ path });
    return Promise.reject(new Error("no put"));
  }
  patch<T>(path: string): Promise<T> {
    this.calls.push({ path });
    return Promise.reject(new Error("no patch"));
  }
  delete<T>(path: string, opts: { body?: unknown } = {}): Promise<T> {
    this.calls.push({ path, body: opts.body });
    const next = this.deletes.shift();
    if (!next) return Promise.reject(new Error("no delete"));
    try {
      return Promise.resolve(next() as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  refreshTokens(): Promise<boolean> {
    this.refreshCalls++;
    try { return Promise.resolve(this.refreshResult()); } catch (e) { return Promise.reject(e); }
  }
}

// An in-memory SessionStorage mirroring the shell's persisted slice.
class FakeStorage implements SessionStorage {
  value: PersistedSession | null = null;
  saves = 0;
  clears = 0;
  load(): PersistedSession | null { return this.value; }
  save(v: PersistedSession): void { this.value = v; this.saves++; }
  clear(): void { this.value = null; this.clears++; }
}

// A fake durable-cache port recording wipes and the stamped owner (T-423).
class FakeLocalData implements LocalData {
  owner: number | null = null;
  wipes = 0;
  setOwnerCalls: number[] = [];
  constructor(initialOwner: number | null = null) { this.owner = initialOwner; }
  wipe(): Promise<void> { this.wipes++; this.owner = null; return Promise.resolve(); }
  getOwner(): Promise<number | null> { return Promise.resolve(this.owner); }
  setOwner(userId: number): Promise<void> { this.owner = userId; this.setOwnerCalls.push(userId); return Promise.resolve(); }
}

function setup() {
  const api = new FakeApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const session = new Session({ api, tokens, storage });
  return { api, tokens, storage, session };
}

// A variant wired with a durable-cache port for the T-423 wipe/owner-guard tests.
function setupWithLocalData(initialOwner: number | null = null) {
  const api = new FakeApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const localData = new FakeLocalData(initialOwner);
  const session = new Session({ api, tokens, storage, localData });
  return { api, tokens, storage, localData, session };
}

const sessionPayload = (over: Partial<AuthSession> = {}): AuthSession => ({
  user: { id: 7, username: "ann", name: "Ann" },
  session_id: 1,
  access_token: "acc-1",
  access_expires_at: 2_000_000_000,
  refresh_token: "ref-1",
  ...over,
});

test("register: adopts tokens in memory, persists refresh+user, notifies", async () => {
  const { api, tokens, storage, session } = setup();
  const seen: Array<unknown> = [];
  session.subscribe((u) => seen.push(u));
  api.posts = [() => sessionPayload()];
  const user = await session.register({ username: "ann", password: "hunter2!", name: "Ann", legal_accepted: true, age_confirmed: true });
  assert.equal(user.username, "ann");
  assert.equal(tokens.access, "acc-1");
  assert.equal(tokens.refresh, "ref-1");
  assert.equal(tokens.accessExpiresAt, 2_000_000_000);
  assert.deepEqual(storage.value, { refresh: "ref-1", user: { id: 7, username: "ann", name: "Ann" } });
  assert.equal(session.isAuthed(), true);
  assert.equal(api.calls[0]?.path, "/v1/auth/register");
  assert.equal(seen.length, 1);
});

test("register: sends explicit legal acknowledgements and invite only when provided", async () => {
  const { api, session } = setup();
  api.posts = [() => sessionPayload()];
  await session.register({
    username: "ann",
    password: "hunter2!",
    name: "Ann",
    email: "a@b.co",
    legal_accepted: true,
    age_confirmed: true,
    invite_code: "invite-1",
  });
  const body = api.calls[0]?.body as Record<string, unknown>;
  assert.equal(body.email, "a@b.co");
  assert.equal(body.legal_accepted, true);
  assert.equal(body.age_confirmed, true);
  assert.equal(body.invite_code, "invite-1");
  assert.equal("phone" in body, false);
  assert.equal("locale" in body, false);
});

test("login: sends totp_code only when present", async () => {
  const { api, session } = setup();
  api.posts = [() => sessionPayload({ access_token: "acc-2" })];
  await session.login({ username: "ann", password: "pw", totp_code: "123456" });
  const body = api.calls[0]?.body as Record<string, unknown>;
  assert.equal(api.calls[0]?.path, "/v1/auth/login");
  assert.equal(body.totp_code, "123456");
});

test("login: omits totp_code when absent", async () => {
  const { api, session } = setup();
  api.posts = [() => sessionPayload()];
  await session.login({ username: "ann", password: "pw" });
  const body = api.calls[0]?.body as Record<string, unknown>;
  assert.equal("totp_code" in body, false);
});

test("logout: revokes on the server then clears local state", async () => {
  const { api, tokens, storage, session } = setup();
  api.posts = [() => sessionPayload(), () => ({ ok: true })];
  await session.login({ username: "ann", password: "pw" });
  await session.logout();
  assert.equal(api.calls[1]?.path, "/v1/auth/logout");
  assert.equal(tokens.access, null);
  assert.equal(tokens.refresh, null);
  assert.equal(session.isAuthed(), false);
  assert.equal(storage.clears, 1);
});

test("logout: clears locally even when the server call fails", async () => {
  const { api, tokens, session } = setup();
  api.posts = [() => sessionPayload(), () => { throw new Error("offline"); }];
  await session.login({ username: "ann", password: "pw" });
  await session.logout();
  assert.equal(tokens.access, null);
  assert.equal(session.isAuthed(), false);
});

test("deleteAccount: confirms on the authenticated endpoint, then wipes every local account trace", async () => {
  const { api, tokens, storage, localData, session } = setupWithLocalData();
  api.posts = [() => sessionPayload()];
  api.deletes = [() => ({ deleted: true, cancellable_until: 2_000_086_400 })];
  await session.login({ username: "ann", password: "password-123" });

  const result = await session.deleteAccount("password-123");

  assert.deepEqual(result, { deleted: true, cancellable_until: 2_000_086_400 });
  assert.deepEqual(api.calls.at(-1), {
    path: "/v1/account",
    body: { password: "password-123" },
  });
  assert.equal(
    api.calls.some((call) => call.path === "/v1/auth/logout"),
    false,
  );
  assert.equal(tokens.access, null);
  assert.equal(tokens.refresh, null);
  assert.equal(storage.value, null);
  assert.equal(localData.wipes, 1);
  assert.equal(session.isAuthed(), false);
});

test("deleteAccount: a server rejection preserves the live session and local data", async () => {
  const { api, tokens, storage, localData, session } = setupWithLocalData(7);
  api.posts = [() => sessionPayload()];
  api.deletes = [
    () => {
      throw new Error("wrong password");
    },
  ];
  await session.login({ username: "ann", password: "password-123" });

  await assert.rejects(() => session.deleteAccount("wrong"), /wrong password/);

  assert.equal(tokens.access, "acc-1");
  assert.equal(tokens.refresh, "ref-1");
  assert.notEqual(storage.value, null);
  assert.equal(localData.wipes, 0);
  assert.equal(session.isAuthed(), true);
});

test("deleteAccount: concurrent callers share one request and one durable wipe", async () => {
  const { api, storage, localData, session } = setupWithLocalData();
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  api.posts = [() => sessionPayload()];
  api.deletes = [() => pending];
  await session.login({ username: "ann", password: "password-123" });

  const first = session.deleteAccount("password-123");
  const second = session.deleteAccount("password-123");
  await Promise.resolve();

  assert.equal(
    api.calls.filter((call) => call.path === "/v1/account").length,
    1,
  );
  release({ deleted: true, cancellable_until: 2_000_086_400 });
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(a, b);
  assert.equal(localData.wipes, 1);
  assert.equal(storage.value, null);
  assert.equal(session.isAuthed(), false);
});

test("logout invalidates account operations before waiting for the server revoke", async () => {
  const api = new FakeApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const localData = new FakeLocalData(7);
  let release!: () => void;
  const revokeGate = new Promise<void>((resolve) => { release = resolve; });
  let beforeCalls = 0;
  let session!: Session;
  session = new Session({
    api,
    tokens,
    storage,
    localData,
    onBeforeClear: () => {
      beforeCalls += 1;
      assert.equal(tokens.access, "acc-1", "the old token remains available only for the revoke request");
      assert.equal(session.isAuthed(), true);
    },
  });
  api.posts = [() => sessionPayload(), () => revokeGate.then(() => ({ ok: true }))];
  await session.login({ username: "ann", password: "password-123" });

  const logout = session.logout();
  assert.equal(beforeCalls, 1, "the data plane is invalidated synchronously at logout start");
  assert.equal(tokens.access, "acc-1", "local credentials are cleared after the revoke attempt");
  assert.equal(session.isAuthed(), true);
  assert.equal(localData.wipes, 0, "durable wipe has not started while revoke is pending");
  assert.equal(api.calls.at(-1)?.path, "/v1/auth/logout");

  release();
  await logout;
  assert.equal(tokens.access, null);
  assert.equal(session.isAuthed(), false);
  assert.equal(localData.wipes, 1);
  assert.equal(beforeCalls, 1, "wipeLocalData does not repeat the same account boundary");
});

test("logout: concurrent callers share one server revoke and one durable wipe", async () => {
  const { api, storage, localData, session } = setupWithLocalData();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  api.posts = [() => sessionPayload(), () => pending.then(() => ({ ok: true }))];
  await session.login({ username: "ann", password: "test-password" });

  const calls = [session.logout(), session.logout(), session.logout()];
  await Promise.resolve();
  assert.equal(api.calls.filter((call) => call.path === "/v1/auth/logout").length, 1);
  release();
  await Promise.all(calls);

  assert.equal(api.calls.filter((call) => call.path === "/v1/auth/logout").length, 1);
  assert.equal(localData.wipes, 1);
  assert.equal(storage.clears, 1);
  assert.equal(session.isAuthed(), false);
});

test("wipeLocalData: concurrent auth-loss callbacks share one wipe", async () => {
  const { storage, localData, session } = setupWithLocalData(7);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  localData.wipe = async () => {
    localData.wipes += 1;
    await pending;
    localData.owner = null;
  };

  const wipes = [session.wipeLocalData(), session.wipeLocalData(), session.wipeLocalData()];
  await Promise.resolve();
  assert.equal(localData.wipes, 1);
  release();
  await Promise.all(wipes);
  assert.equal(localData.wipes, 1);
  assert.equal(storage.clears, 1);
});

test("wipeLocalData invalidates account operations before token clear and before durable wipe", async () => {
  const api = new FakeApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const localData = new FakeLocalData(7);
  let release!: () => void;
  const wipeGate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  let beforeCalls = 0;
  let session!: Session;
  localData.wipe = async () => {
    localData.wipes += 1;
    order.push(`wipe:${tokens.access}:${session.isAuthed()}`);
    await wipeGate;
    localData.owner = null;
  };
  session = new Session({
    api,
    tokens,
    storage,
    localData,
    onBeforeClear: () => {
      beforeCalls += 1;
      order.push(`before:${tokens.access}:${session.isAuthed()}:${storage.value !== null}`);
    },
    onAfterClear: async () => { order.push(`after:${tokens.access}:${session.isAuthed()}`); },
  });
  api.posts = [() => sessionPayload()];
  await session.login({ username: "ann", password: "password-123" });
  session.subscribe(() => { order.push("emit"); });

  const wipes = [session.wipeLocalData(), session.wipeLocalData(), session.wipeLocalData()];
  await Promise.resolve();
  assert.equal(beforeCalls, 1, "single-flight wipe crosses the account boundary once");
  assert.deepEqual(order, [
    "before:acc-1:true:true",
    "wipe:null:false",
  ]);
  assert.equal(tokens.access, null);
  assert.equal(storage.value, null);
  assert.equal(localData.wipes, 1);

  release();
  await Promise.all(wipes);
  assert.deepEqual(order, [
    "before:acc-1:true:true",
    "wipe:null:false",
    "after:null:false",
    "emit",
  ], "post-wipe barrier completes before signed-out observers run");
});

test("failing account-boundary hooks cannot keep credentials or durable data alive", async () => {
  const api = new FakeApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const localData = new FakeLocalData(7);
  let beforeCalls = 0;
  let afterCalls = 0;
  const session = new Session({
    api,
    tokens,
    storage,
    localData,
    onBeforeClear: () => { beforeCalls += 1; throw new Error("subsystem failed"); },
    onAfterClear: async () => { afterCalls += 1; throw new Error("post-wipe failed"); },
  });
  api.posts = [() => sessionPayload()];
  await session.login({ username: "ann", password: "password-123" });
  await session.wipeLocalData();

  assert.equal(beforeCalls, 1);
  assert.equal(afterCalls, 1);
  assert.equal(tokens.access, null);
  assert.equal(tokens.refresh, null);
  assert.equal(session.isAuthed(), false);
  assert.equal(storage.value, null);
  assert.equal(localData.wipes, 1);
});

test("restore: no saved session → false, no refresh attempted", async () => {
  const { api, session } = setup();
  const ok = await session.restore();
  assert.equal(ok, false);
  assert.equal(api.refreshCalls, 0);
});

test("restore: saved session + successful refresh → authed, persists rotated refresh", async () => {
  const { api, tokens, storage, session } = setup();
  storage.value = { refresh: "ref-old", user: { id: 7, username: "ann", name: "Ann" } };
  // A real refresh rotates tokens in place; emulate that side effect.
  api.refreshResult = () => { tokens.access = "acc-new"; tokens.refresh = "ref-new"; return true; };
  const ok = await session.restore();
  assert.equal(ok, true);
  assert.equal(tokens.refresh, "ref-new");
  assert.equal(session.isAuthed(), true);
  assert.equal(session.currentUser()?.username, "ann");
  assert.deepEqual(storage.value, { refresh: "ref-new", user: { id: 7, username: "ann", name: "Ann" } });
});

test("restore: browser-managed refresh never overwrites a newer peer rotation after lock release", async () => {
  const api = new FakeApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const user = { id: 7, username: "ann", name: "Ann" };
  storage.value = { refresh: "ref-old", user };
  const session = new Session({ api, tokens, storage, refreshStorageManaged: true });
  api.refreshResult = () => {
    tokens.access = "acc-from-this-tab";
    tokens.refresh = "ref-from-this-tab";
    // Simulate another tab rotating again after this tab's coordinator released the Web Lock.
    storage.value = { refresh: "ref-newer-peer", user };
    return true;
  };

  const ok = await session.restore();
  assert.equal(ok, true);
  assert.equal(tokens.refresh, "ref-from-this-tab");
  assert.deepEqual(storage.value, { refresh: "ref-newer-peer", user });
  assert.equal(storage.saves, 0, "Session.restore must not perform an out-of-lock duplicate write");
});

test("restore: refresh returns false (dead token) → logs out honestly", async () => {
  const { api, tokens, storage, session } = setup();
  storage.value = { refresh: "ref-dead", user: { id: 7, username: "ann", name: "Ann" } };
  api.refreshResult = () => false;
  const ok = await session.restore();
  assert.equal(ok, false);
  assert.equal(tokens.refresh, null);
  assert.equal(session.isAuthed(), false);
  assert.equal(storage.clears, 1);
});

test("restore: refresh throws (offline) → keeps the optimistic session", async () => {
  const { api, tokens, storage, session } = setup();
  storage.value = { refresh: "ref-keep", user: { id: 7, username: "ann", name: "Ann" } };
  api.refreshResult = () => { throw new Error("offline"); };
  const ok = await session.restore();
  assert.equal(ok, true, "offline keeps the session (T-422)");
  assert.equal(tokens.refresh, "ref-keep");
  assert.equal(session.isAuthed(), true);
  assert.equal(storage.clears, 0);
});

// --- T-423: logout wipes ALL local data; login/restore reconcile the cache owner --------------------

test("T-423 logout: wipes the durable cache, not just the token slice", async () => {
  const { api, localData, session } = setupWithLocalData();
  api.posts = [() => sessionPayload({ user: { id: 7, username: "ann", name: "Ann" } }), () => ({ ok: true })];
  await session.login({ username: "ann", password: "pw" });
  assert.equal(localData.owner, 7, "login stamps the owner");
  await session.logout();
  assert.equal(localData.wipes, 1, "logout wiped the durable cache");
  assert.equal(localData.owner, null, "owner cleared after wipe");
});

test("T-423 logout: wipes locally even when the server revoke fails", async () => {
  const { api, localData, session } = setupWithLocalData();
  api.posts = [() => sessionPayload(), () => { throw new Error("offline"); }];
  await session.login({ username: "ann", password: "pw" });
  await session.logout();
  assert.equal(localData.wipes, 1, "offline logout still wipes");
});

test("T-423 login: SAME owner as the cache → no wipe, owner re-stamped", async () => {
  const { api, localData, session } = setupWithLocalData(7);
  api.posts = [() => sessionPayload({ user: { id: 7, username: "ann", name: "Ann" } })];
  await session.login({ username: "ann", password: "pw" });
  assert.equal(localData.wipes, 0, "same account keeps its cache");
  assert.equal(localData.owner, 7);
});

test("T-423 login: DIFFERENT owner in the cache → wipe first, then adopt", async () => {
  const { api, localData, session } = setupWithLocalData(7); // cache belongs to user 7
  api.posts = [() => sessionPayload({ user: { id: 42, username: "bob", name: "Bob" } })];
  await session.login({ username: "bob", password: "pw" });
  assert.equal(localData.wipes, 1, "another account's cache is wiped on login");
  assert.equal(localData.owner, 42, "new owner stamped after the wipe");
});

test("T-423 register: fresh cache (null owner) → adopted silently, no wipe", async () => {
  const { api, localData, session } = setupWithLocalData(null);
  api.posts = [() => sessionPayload({ user: { id: 9, username: "cat", name: "Cat" } })];
  await session.register({ username: "cat", password: "hunter2!", name: "Cat", legal_accepted: true, age_confirmed: true });
  assert.equal(localData.wipes, 0);
  assert.equal(localData.owner, 9);
});

test("T-423 restore: stale cache from another user → wiped before the session is trusted", async () => {
  const { api, localData, storage, session } = setupWithLocalData(7); // cache belongs to user 7
  storage.value = { refresh: "ref-old", user: { id: 42, username: "bob", name: "Bob" } };
  api.refreshResult = () => true;
  const ok = await session.restore();
  assert.equal(ok, true);
  assert.equal(localData.wipes, 1, "another user's cache wiped on restore");
  assert.equal(localData.owner, 42);
});

test("T-423 restore: dead refresh token → honest logout also wipes the cache", async () => {
  const { api, localData, storage, session } = setupWithLocalData(7);
  storage.value = { refresh: "ref-dead", user: { id: 7, username: "ann", name: "Ann" } };
  api.refreshResult = () => false;
  const ok = await session.restore();
  assert.equal(ok, false);
  assert.ok(localData.wipes >= 1, "a dead-token logout wipes the cache");
});

// --- T-419: wipeLocalData() — the «свой сервер» server-switch wipe (no server round-trip) -----------
// Changing the server address is paired with a full local wipe (a different server is a different account
// namespace). When signed in the shell calls logout() (revoke on the OLD server, THEN wipe); when signed
// out it calls wipeLocalData() directly — which must still purge any stale cache without a network call.

test("T-419 wipeLocalData: clears the token slice + durable cache with NO server call", async () => {
  const { api, tokens, storage, localData, session } = setupWithLocalData();
  api.posts = [() => sessionPayload({ user: { id: 7, username: "ann", name: "Ann" } })];
  await session.login({ username: "ann", password: "pw" });
  const callsBefore = api.calls.length;
  let notified: unknown = "unset";
  session.subscribe((u) => { notified = u; });
  await session.wipeLocalData();
  assert.equal(api.calls.length, callsBefore, "no /v1/auth/logout — this is a purely local wipe");
  assert.equal(tokens.access, null, "access token cleared");
  assert.equal(tokens.refresh, null, "refresh token cleared");
  assert.equal(storage.clears, 1, "persisted refresh/user slice cleared");
  assert.equal(localData.wipes, 1, "durable cache wiped");
  assert.equal(localData.owner, null, "owner cleared");
  assert.equal(session.isAuthed(), false, "session ended");
  assert.equal(notified, null, "subscribers notified of the signed-out state");
});

test("T-419 wipeLocalData: signed out with a stale cache → cleared (server-switch hygiene)", async () => {
  const { api, localData, session } = setupWithLocalData(42); // stale cache from a previous server/account
  await session.wipeLocalData(); // no login, no server call
  assert.equal(api.calls.length, 0, "never touches the network");
  assert.equal(localData.wipes, 1, "the stale cache is wiped on a signed-out server switch");
  assert.equal(localData.owner, null);
});

test("T-419 wipeLocalData: best-effort — a failing wipe still resolves and ends the session", async () => {
  const { localData, session } = setupWithLocalData(1);
  localData.wipe = () => Promise.reject(new Error("delete blocked"));
  await session.wipeLocalData(); // must resolve despite the failing wipe
  await session.wipeLocalData(); // a second call is a safe no-op
  assert.equal(session.isAuthed(), false);
});

test("T-419 logout still revokes on the server BEFORE the local wipe (refactor parity)", async () => {
  const { api, localData, session } = setupWithLocalData();
  api.posts = [() => sessionPayload(), () => ({ ok: true })];
  await session.login({ username: "ann", password: "pw" });
  await session.logout();
  assert.equal(api.calls.at(-1)?.path, "/v1/auth/logout", "logout revoked on the server");
  assert.equal(localData.wipes, 1, "then wiped the durable cache");
});


test("loginWithQr: pending -> approved adopts exactly the QR-minted session", async () => {
  const { api, tokens, storage, session } = setup();
  const ready: Array<{ token: string; link: string; expiresAt: number }> = [];
  const token = "a".repeat(96);
  api.posts = [
    () => ({ qr_token: token, expires_in: 120 }),
    () => ({ status: "pending" }),
    () => ({ status: "approved", ...sessionPayload({ access_token: "qr-access", refresh_token: "qr-refresh" }) }),
  ];

  const user = await session.loginWithQr({
    pollIntervalMs: 0,
    now: () => 1_000,
    onReady: (value) => ready.push(value),
  });

  assert.equal(user.id, 7);
  assert.equal(tokens.access, "qr-access");
  assert.equal(tokens.refresh, "qr-refresh");
  assert.equal(storage.value?.refresh, "qr-refresh");
  assert.deepEqual(api.calls.map((call) => call.path), [
    "/v1/auth/qr/start",
    "/v1/auth/qr/poll",
    "/v1/auth/qr/poll",
  ]);
  assert.equal(ready[0]?.token, token);
  assert.equal(ready[0]?.link, `greenchat://auth/qr/${token}`);
  assert.equal(ready[0]?.expiresAt, 121_000);
});

test("loginWithQr: an explicit phone denial is terminal and does not issue cancel", async () => {
  const { api, session } = setup();
  const token = "b".repeat(96);
  api.posts = [
    () => ({ qr_token: token, expires_in: 120 }),
    () => ({ status: "denied" }),
  ];

  await assert.rejects(
    () => session.loginWithQr({ pollIntervalMs: 0 }),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "QR_DENIED",
  );
  assert.deepEqual(api.calls.map((call) => call.path), ["/v1/auth/qr/start", "/v1/auth/qr/poll"]);
  assert.equal(session.isAuthed(), false);
});

test("loginWithQr: leaving the QR view cancels the server attempt", async () => {
  const { api, session } = setup();
  const token = "c".repeat(96);
  const controller = new AbortController();
  api.posts = [
    () => ({ qr_token: token, expires_in: 120 }),
    () => ({ cancelled: true }),
  ];

  await assert.rejects(
    () => session.loginWithQr({
      signal: controller.signal,
      pollIntervalMs: 0,
      onReady: () => controller.abort(),
    }),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "QR_CANCELLED",
  );
  assert.deepEqual(api.calls.map((call) => call.path), ["/v1/auth/qr/start", "/v1/auth/qr/cancel"]);
});
