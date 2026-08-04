// clients/ui/test/calls_history_failure_v146.test.ts — V146 regression guard.
//
// A failed GET /v1/calls/history used to be converted to `null` inside Promise.all. The parser then
// treated that as an empty page, so an offline client or a server 500 showed «Звонков ещё не было».
// That is not graceful degradation: it replaces an unknown state with a false fact and gives no retry
// for the failed read while the rest of the Calls screen continues to render.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createCallsScreen } from "../src/screens/calls_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

class NetworkError extends Error {
  override name = "NetworkError";
}

class CallsApi implements ApiLike {
  historyRequests = 0;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve([] as T);
    if (path.startsWith("/v1/calls/history")) {
      this.historyRequests += 1;
      return Promise.reject(new NetworkError("offline"));
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const byClass = (root: StubNode, cls: string): StubNode[] => root.findAll((node) => node.hasClass(cls));

test("V146: a failed call-history read is not rendered as a genuinely empty log", async () => {
  const api = new CallsApi();
  const screen = createCallsScreen({
    api,
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
    now: () => 1_700_000_000_000,
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  const log = byClass(root, "gc-call-log")[0];
  assert.ok(log, "the Calls screen still renders its log section beside the people section");
  assert.equal(byClass(log, "gc-call-log-empty").length, 0, "a failed read must not claim there were no calls");

  const failure = byClass(log, "gc-state")[0];
  assert.ok(failure, "the log shows an explicit failure state");
  assert.equal(failure.attrs["data-tone"], "offline", "a transport failure keeps its offline meaning");
  assert.ok(failure.textContent.includes(i18n.t("state.offlineTitle")));
  assert.ok(!failure.textContent.includes(i18n.t("calls.logEmpty")));
  assert.ok(failure.textContent.includes(i18n.t("common.retry")), "the failed read offers retry");

  const before = api.historyRequests;
  byClass(failure, "gc-state-action")[0]!.dispatch("click");
  await settle();
  assert.ok(api.historyRequests > before, "retry actually issues another history request");

  screen.destroy();
});

class RaceApi implements ApiLike {
  readonly historyResolvers: Array<(value: unknown) => void> = [];

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve([] as T);
    if (path.startsWith("/v1/calls/history")) {
      return new Promise<T>((resolve) => this.historyResolvers.push((value) => resolve(value as T)));
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const page = (id: number, name: string) => ({
  items: [{
    id,
    chat_id: id,
    direction: "in",
    status: "ok",
    duration_sec: 2,
    video: false,
    peer: { id, name, username: null },
    created_at: 1_700_000_000 + id,
  }],
  next_before: null,
});

test("V146: an older slow refresh cannot overwrite a newer call-history response", async () => {
  const api = new RaceApi();
  const screen = createCallsScreen({
    api,
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
    now: () => 1_700_000_100_000,
  });
  await settle();
  assert.equal(api.historyResolvers.length, 1, "the initial history request is pending");

  const root = screen.root as unknown as StubNode;
  const refresh = byClass(root, "gc-icon-btn")[0];
  assert.ok(refresh, "the root Calls screen has its refresh action");
  refresh.dispatch("click");
  await settle();
  assert.equal(api.historyResolvers.length, 2, "refresh starts a newer history request");

  api.historyResolvers[1]!(page(2, "Newer result"));
  await settle();
  assert.ok(root.textContent.includes("Newer result"), "the newer response is rendered first");

  api.historyResolvers[0]!(page(1, "Older result"));
  await settle();
  assert.ok(root.textContent.includes("Newer result"), "the newer response remains authoritative");
  assert.ok(!root.textContent.includes("Older result"), "the late stale response is ignored");

  screen.destroy();
});

class NullFailureApi extends CallsApi {
  override get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/calls/history")) {
      this.historyRequests += 1;
      return Promise.reject(null);
    }
    return super.get<T>(path);
  }
}

test("V146: even Promise.reject(null) remains a failure rather than the empty-history sentinel", async () => {
  const screen = createCallsScreen({
    api: new NullFailureApi(),
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  const log = byClass(root, "gc-call-log")[0]!;
  assert.equal(byClass(log, "gc-call-log-empty").length, 0);
  const failure = byClass(log, "gc-state")[0];
  assert.ok(failure, "a null rejection reason still produces an explicit failure state");
  assert.equal(failure.attrs["data-tone"], "error");

  screen.destroy();
});

class PaginationRaceApi implements ApiLike {
  historyCalls = 0;
  loadMoreResolver: ((value: unknown) => void) | null = null;
  refreshResolver: ((value: unknown) => void) | null = null;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve([] as T);
    if (path.includes("before=50")) {
      return new Promise<T>((resolve) => { this.loadMoreResolver = (value) => resolve(value as T); });
    }
    if (path.startsWith("/v1/calls/history")) {
      this.historyCalls += 1;
      if (this.historyCalls === 1) {
        return Promise.resolve({ ...page(50, "Initial result"), next_before: 50 } as T);
      }
      return new Promise<T>((resolve) => { this.refreshResolver = (value) => resolve(value as T); });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V146: an old pagination page cannot append after a newer full refresh", async () => {
  const api = new PaginationRaceApi();
  const screen = createCallsScreen({
    api,
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  assert.ok(root.textContent.includes("Initial result"));
  const more = byClass(root, "gc-call-log-more")[0];
  assert.ok(more, "the initial page exposes its pagination action");
  more.dispatch("click");
  await settle();
  assert.ok(api.loadMoreResolver, "the older-page request is pending");

  byClass(root, "gc-icon-btn")[0]!.dispatch("click");
  await settle();
  assert.ok(api.refreshResolver, "a newer full refresh is pending");
  api.refreshResolver!(page(60, "Fresh result"));
  await settle();
  assert.ok(root.textContent.includes("Fresh result"));

  api.loadMoreResolver!(page(40, "Stale older page"));
  await settle();
  assert.ok(root.textContent.includes("Fresh result"), "the refreshed page remains authoritative");
  assert.ok(!root.textContent.includes("Stale older page"), "the obsolete pagination response is discarded");

  screen.destroy();
});

class PaginationFailureApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve([] as T);
    if (path.includes("before=50")) return Promise.reject(new NetworkError("offline"));
    if (path.startsWith("/v1/calls/history")) {
      return Promise.resolve({ ...page(50, "Initial result"), next_before: 50 } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V146: failed call-history pagination never claims a read was queued", async () => {
  const screen = createCallsScreen({
    api: new PaginationFailureApi(),
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  byClass(root, "gc-call-log-more")[0]!.dispatch("click");
  await settle();

  const status = byClass(root, "gc-calls-status")[0]!;
  assert.equal(status.textContent, i18n.t("state.staleOffline"));
  assert.ok(!status.textContent.includes("очеред"), "a failed GET must not borrow queued-write wording");
  assert.ok(byClass(root, "gc-call-log-more").length === 1, "the failed page restores the pagination action");

  screen.destroy();
});

class RequiredFailureWithHungHistoryApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") return Promise.reject(new NetworkError("offline"));
    if (path === "/v1/chats?filter=all") return Promise.resolve([] as T);
    if (path.startsWith("/v1/calls/history")) return new Promise<T>(() => {});
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V146: a required request failure is shown without waiting for a hung optional history request", async () => {
  const screen = createCallsScreen({
    api: new RequiredFailureWithHungHistoryApi(),
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  const failure = byClass(root, "gc-state")[0];
  assert.ok(failure, "the required config failure must replace the loading skeleton promptly");
  assert.equal(failure.attrs["data-tone"], "offline");
  assert.equal(byClass(root, "gc-calls-body")[0]!.attrs["aria-busy"], "false");

  screen.destroy();
});

const dialog = [{ id: 7, kind: "dialog", title: "Existing peer", username: null }];

class OptionalRefreshFailureApi implements ApiLike {
  historyCalls = 0;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve(dialog as T);
    if (path.startsWith("/v1/calls/history")) {
      this.historyCalls += 1;
      if (this.historyCalls === 1) return Promise.resolve({ ...page(50, "Cached call"), next_before: 50 } as T);
      return Promise.reject(new NetworkError("offline"));
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V146: a failed optional refresh preserves the last successful call-history snapshot", async () => {
  const api = new OptionalRefreshFailureApi();
  const screen = createCallsScreen({
    api,
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  assert.ok(root.textContent.includes("Cached call"));
  byClass(root, "gc-icon-btn")[0]!.dispatch("click");
  await settle();

  const log = byClass(root, "gc-call-log")[0]!;
  assert.ok(log.textContent.includes("Cached call"), "offline refresh keeps the known history visible");
  assert.equal(byClass(log, "gc-state").length, 0, "stale data is not replaced by a blank failure card");
  assert.equal(byClass(root, "gc-calls-status")[0]!.textContent, i18n.t("state.staleOffline"));

  screen.destroy();
});

class RequiredRefreshFailureApi implements ApiLike {
  configCalls = 0;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      this.configCalls += 1;
      if (this.configCalls === 1) {
        return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
      }
      return Promise.reject(new NetworkError("offline"));
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve(dialog as T);
    if (path.startsWith("/v1/calls/history")) return Promise.resolve(page(50, "Cached call") as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V146: a failed required refresh preserves the already rendered Calls screen", async () => {
  const screen = createCallsScreen({
    api: new RequiredRefreshFailureApi(),
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  assert.ok(root.textContent.includes("Cached call"));
  byClass(root, "gc-icon-btn")[0]!.dispatch("click");
  await settle();

  assert.ok(root.textContent.includes("Cached call"), "a failed refresh must not wipe a valid snapshot");
  assert.equal(byClass(root, "gc-calls-status")[0]!.textContent, i18n.t("state.staleOffline"));
  assert.equal(byClass(root, "gc-calls-body")[0]!.attrs["aria-busy"], "false");

  screen.destroy();
});

class RefreshPaginationOverlapApi implements ApiLike {
  historyCalls = 0;
  paginationCalls = 0;
  refreshResolver: ((value: unknown) => void) | null = null;
  paginationResolver: ((value: unknown) => void) | null = null;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve(dialog as T);
    if (path.includes("before=50")) {
      this.paginationCalls += 1;
      return new Promise<T>((resolve) => { this.paginationResolver = (value) => resolve(value as T); });
    }
    if (path.startsWith("/v1/calls/history")) {
      this.historyCalls += 1;
      if (this.historyCalls === 1) return Promise.resolve({ ...page(50, "Initial call"), next_before: 50 } as T);
      return new Promise<T>((resolve) => { this.refreshResolver = (value) => resolve(value as T); });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V146: pagination cannot start on the stale cursor while a full refresh is in flight", async () => {
  const api = new RefreshPaginationOverlapApi();
  const screen = createCallsScreen({
    api,
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  byClass(root, "gc-icon-btn")[0]!.dispatch("click");
  await settle();
  assert.ok(api.refreshResolver, "the full refresh is pending");
  byClass(root, "gc-call-log-more")[0]!.dispatch("click");
  await settle();
  assert.equal(api.paginationCalls, 0, "the old cursor is unavailable until the full refresh settles");

  api.refreshResolver!({ ...page(60, "Fresh call"), next_before: 50 });
  await settle();
  assert.ok(root.textContent.includes("Fresh call"));
  assert.ok(!root.textContent.includes("Initial call"));

  screen.destroy();
});

class TestEvents {
  private handler: ((evt: { type: string; payload: unknown }) => void | Promise<void>) | null = null;

  subscribe(handler: (evt: { type: string; payload: unknown }) => void | Promise<void>): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  emit(type: string): void {
    void this.handler?.({ type, payload: null });
  }
}

test("V146: a failed call.finished refetch keeps the last successful history snapshot", async () => {
  const api = new OptionalRefreshFailureApi();
  const events = new TestEvents();
  const screen = createCallsScreen({
    api,
    i18n,
    events,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  assert.ok(root.textContent.includes("Cached call"));
  events.emit("call.finished");
  await settle();

  assert.ok(root.textContent.includes("Cached call"), "the realtime-triggered refresh keeps known history offline");
  assert.equal(byClass(root, "gc-calls-status")[0]!.textContent, i18n.t("state.staleOffline"));
  assert.equal(byClass(root, "gc-call-log-empty").length, 0, "the event path never flashes a false empty log");

  screen.destroy();
});
