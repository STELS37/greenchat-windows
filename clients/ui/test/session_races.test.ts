// QA — auth lifecycle races. The latest explicit user action owns tokens, persisted identity and cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/screens/session.ts";
import type {
  LocalData,
  PersistedSession,
  SessionStorage,
  TokenHolder,
} from "../src/screens/session.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { AuthSession } from "../src/screens/types.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; started: Promise<void>; markStarted(): void } {
  let resolve!: (value: T) => void;
  let markStarted!: () => void;
  return {
    promise: new Promise<T>((res) => { resolve = res; }),
    resolve,
    started: new Promise<void>((res) => { markStarted = res; }),
    markStarted,
  };
}

function auth(id: number, username: string): AuthSession {
  return {
    user: { id, username, name: username.toUpperCase() },
    session_id: id,
    access_token: `access-${username}`,
    access_expires_at: 2_000_000_000 + id,
    refresh_token: `refresh-${username}`,
  };
}

class Storage implements SessionStorage {
  value: PersistedSession | null = null;
  load(): PersistedSession | null { return this.value; }
  save(value: PersistedSession): void { this.value = value; }
  clear(): void { this.value = null; }
}

abstract class ApiBase implements ApiLike {
  get<T>(_path: string): Promise<T> { return Promise.reject(new Error("unexpected get")); }
  put<T>(_path: string, _body?: unknown): Promise<T> { return Promise.reject(new Error("unexpected put")); }
  patch<T>(_path: string, _body?: unknown): Promise<T> { return Promise.reject(new Error("unexpected patch")); }
  delete<T>(_path: string): Promise<T> { return Promise.reject(new Error("unexpected delete")); }
  abstract post<T>(path: string, body?: unknown): Promise<T>;
  refreshTokens(): Promise<boolean> { return Promise.resolve(true); }
}

function setup(api: ApiLike, storage = new Storage(), localData?: LocalData) {
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const session = new Session({ api, tokens, storage, ...(localData ? { localData } : {}) });
  return { tokens, storage, session };
}

test("overlapping logins are latest-wins even when the older response arrives last", async () => {
  const old = deferred<AuthSession>();
  class Api extends ApiBase {
    post<T>(path: string, body?: unknown): Promise<T> {
      assert.equal(path, "/v1/auth/login");
      const username = (body as { username?: unknown }).username;
      if (username === "alice") {
        old.markStarted();
        return old.promise as Promise<T>;
      }
      return Promise.resolve(auth(2, "bob") as T);
    }
  }
  const { session, tokens, storage } = setup(new Api());

  const alice = session.login({ username: "alice", password: "Pass-123456" });
  await old.started;
  const bob = await session.login({ username: "bob", password: "Pass-123456" });
  assert.equal(bob.username, "bob");

  old.resolve(auth(1, "alice"));
  await assert.rejects(alice, /superseded|newer|session/i);
  assert.equal(session.currentUser()?.username, "bob");
  assert.equal(tokens.access, "access-bob");
  assert.equal(tokens.refresh, "refresh-bob");
  assert.equal(storage.value?.user.username, "bob");
  assert.equal(storage.value?.refresh, "refresh-bob");
});

test("a late restore refresh cannot overwrite a newer manual login", async () => {
  const refresh = deferred<boolean>();
  const storage = new Storage();
  storage.value = { refresh: "refresh-alice-saved", user: { id: 1, username: "alice", name: "ALICE" } };
  let tokens!: TokenHolder;
  class Api extends ApiBase {
    post<T>(path: string): Promise<T> {
      assert.equal(path, "/v1/auth/login");
      return Promise.resolve(auth(2, "bob") as T);
    }
    override async refreshTokens(): Promise<boolean> {
      refresh.markStarted();
      await refresh.promise;
      // Real ApiClient rotates the shared holder in place before resolving.
      tokens.access = "access-alice-restored";
      tokens.refresh = "refresh-alice-rotated";
      tokens.accessExpiresAt = 2_100_000_000;
      return true;
    }
  }
  const state = setup(new Api(), storage);
  tokens = state.tokens;

  const restore = state.session.restore();
  await refresh.started;
  await state.session.login({ username: "bob", password: "Pass-123456" });
  refresh.resolve(true);

  assert.equal(await restore, false, "superseded restore reports that it did not activate a session");
  assert.equal(state.session.currentUser()?.username, "bob");
  assert.equal(tokens.access, "access-bob");
  assert.equal(tokens.refresh, "refresh-bob");
  assert.equal(storage.value?.user.username, "bob");
  assert.equal(storage.value?.refresh, "refresh-bob");
});

test("a late logout completion cannot wipe a newer login", async () => {
  const revoke = deferred<unknown>();
  class Api extends ApiBase {
    post<T>(path: string, body?: unknown): Promise<T> {
      if (path === "/v1/auth/login") {
        const username = String((body as { username?: unknown }).username);
        return Promise.resolve(auth(username === "alice" ? 1 : 2, username) as T);
      }
      assert.equal(path, "/v1/auth/logout");
      revoke.markStarted();
      return revoke.promise as Promise<T>;
    }
  }
  const { session, tokens, storage } = setup(new Api());
  await session.login({ username: "alice", password: "Pass-123456" });

  const logout = session.logout();
  await revoke.started;
  await session.login({ username: "bob", password: "Pass-123456" });
  revoke.resolve({ revoked: true });
  await logout;

  assert.equal(session.currentUser()?.username, "bob");
  assert.equal(tokens.access, "access-bob");
  assert.equal(tokens.refresh, "refresh-bob");
  assert.equal(storage.value?.user.username, "bob");
});

class DelayedOldWipe implements LocalData {
  owner: number | null = 1;
  wipeCalls = 0;
  readonly firstWipe = deferred<void>();
  getOwner(): Promise<number | null> { return Promise.resolve(this.owner); }
  async wipe(): Promise<void> {
    this.wipeCalls += 1;
    if (this.wipeCalls === 1) {
      this.firstWipe.markStarted();
      await this.firstWipe.promise;
    }
    this.owner = null;
  }
  setOwner(userId: number): Promise<void> { this.owner = userId; return Promise.resolve(); }
}

test("a delayed old physical wipe cannot erase the cache owner stamped by a newer login", async () => {
  class Api extends ApiBase {
    post<T>(path: string): Promise<T> {
      assert.equal(path, "/v1/auth/login");
      return Promise.resolve(auth(2, "bob") as T);
    }
  }
  const localData = new DelayedOldWipe();

  const { session, tokens } = setup(new Api(), new Storage(), localData);
  const oldWipe = session.wipeLocalData();
  await localData.firstWipe.started;
  let loginDone = false;
  const login = session.login({ username: "bob", password: "Pass-123456" }).then((user) => {
    loginDone = true;
    return user;
  });
  await Promise.resolve();
  assert.equal(loginDone, false, "new login waits until the previous physical wipe is safely finished");

  localData.firstWipe.resolve();
  await oldWipe;
  await login;
  assert.equal(session.currentUser()?.username, "bob");
  assert.equal(tokens.access, "access-bob");
  assert.equal(localData.owner, 2, "the newer login is the final cache owner");
});


test("a superseded logout never coalesces a later logout for the new account", async () => {
  const oldRevoke = deferred<unknown>();
  const newRevoke = deferred<unknown>();
  let logoutCalls = 0;
  class Api extends ApiBase {
    post<T>(path: string, body?: unknown): Promise<T> {
      if (path === "/v1/auth/login") {
        const username = String((body as { username?: unknown }).username);
        return Promise.resolve(auth(username === "alice" ? 1 : 2, username) as T);
      }
      assert.equal(path, "/v1/auth/logout");
      logoutCalls += 1;
      if (logoutCalls === 1) {
        oldRevoke.markStarted();
        return oldRevoke.promise as Promise<T>;
      }
      newRevoke.markStarted();
      return newRevoke.promise as Promise<T>;
    }
  }
  const { session } = setup(new Api());
  await session.login({ username: "alice", password: "Pass-123456" });
  const firstLogout = session.logout();
  await oldRevoke.started;

  await session.login({ username: "bob", password: "Pass-123456" });
  const secondLogout = session.logout();
  await newRevoke.started;
  assert.equal(logoutCalls, 2, "the new account owns a distinct server revoke");

  newRevoke.resolve({ revoked: true });
  await secondLogout;
  assert.equal(session.isAuthed(), false);

  oldRevoke.resolve({ revoked: true });
  await firstLogout;
  assert.equal(session.isAuthed(), false);
});
