// UI redesign V6 — the conversation header must not park an OS control beside its actions.
//
// Measured before this change (running client, 2026-07-30): `.gc-chat-cache-mode` rendered a native
// <select> 168 px wide inside the 1280 px desktop header — a grey OS dropdown reading "Inherit" next to
// the search icon, i.e. a rarely-touched preference given the most valuable chrome in the screen — and
// under 760 px the stylesheet hid it outright (`display: none`), so on a phone the setting was simply
// unreachable. The setting now lives in the header's overflow menu as radio items, which also gives the
// in-chat support destination a home instead of a second competing icon.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type {
  CachePolicyPort,
  CacheRetentionMode,
  ChatCacheMode,
} from "../src/screens/cache_policy_model.ts";
import type { ChatEntry, ChatMember } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class HeaderApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 9, kind: "dialog", title: "Bob", username: "bob", photo_file_id: null,
        last_message: null, unread_count: 0, muted_until: 0, pinned: false, archived: false,
        my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1,
      }] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice" },
        { id: 2, username: "bob", name: "Bob" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({} as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const outbox: OutboxPort = {
  enqueueMessage: () => Promise.reject(new Error("unexpected enqueue")),
  enqueueEdit: () => Promise.reject(new Error("unexpected edit")),
  enqueueDelete: () => Promise.reject(new Error("unexpected delete")),
  cancel: () => Promise.resolve(false),
  retry: () => Promise.reject(new Error("unexpected retry")),
  subscribe: () => () => {},
};
const events: EventFeed = { subscribe: () => () => {} };

function cachePolicyStub(): { port: CachePolicyPort; writes: Array<[number, ChatCacheMode]> } {
  const writes: Array<[number, ChatCacheMode]> = [];
  let chatMode: ChatCacheMode = "7d";
  const port: CachePolicyPort = {
    getGlobal: () => "forever" as CacheRetentionMode,
    setGlobal: () => Promise.resolve(),
    getChat: () => chatMode,
    setChat: (chatId, mode) => { writes.push([chatId, mode]); chatMode = mode; return Promise.resolve(); },
    shouldPersist: () => true,
    recordMedia: () => Promise.resolve(),
    subscribe: () => () => {},
  };
  return { port, writes };
}

test("the chat header keeps one overflow menu instead of a native cache <select>", async () => {
  const { port, writes } = cachePolicyStub();
  let supportOpened = 0;
  const view = createFeedScreen({
    api: new HeaderApi(),
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
    cachePolicy: port,
    onOpenSupport: () => { supportOpened += 1; },
  });
  await settle();
  const root = view.root as unknown as StubNode;

  // 1. No OS control anywhere in the screen chrome.
  assert.equal(root.find((n) => n.tag === "select"), null, "the header must not host a native <select>");

  // 2. Exactly one overflow button, and the visible header actions stay at two (search + overflow).
  const actions = root.find((n) => n.hasClass("gc-feed-header-actions"));
  assert.ok(actions, "header exposes its actions row");
  const buttons = actions.children.filter((n) => n.tag === "button");
  assert.equal(buttons.length, 2, "header shows search and overflow only");
  const overflow = root.find((n) => n.tag === "button" && n.hasClass("gc-feed-overflow"));
  assert.ok(overflow, "the overflow button exists");
  assert.equal(overflow.attrs["aria-haspopup"], "menu");

  // 3. The menu carries the support destination and all six cache modes, the active one marked.
  overflow.dispatch("click", { stopPropagation() {} });
  const item = (action: string): StubNode | null =>
    root.find((n) => n.tag === "button" && n.attrs["data-action"] === action);
  for (const mode of ["inherit", "forever", "30d", "7d", "24h", "cloud_only"]) {
    const node = item(`cache-${mode}`);
    assert.ok(node, `menu offers cache mode ${mode}`);
    assert.equal(node.attrs["role"], "menuitemradio", `${mode} is a one-of-several choice`);
    assert.equal(
      node.attrs["aria-checked"],
      mode === "7d" ? "true" : "false",
      `only the active mode is checked (${mode})`,
    );
  }
  assert.ok(root.find((n) => n.hasClass("gc-msgmenu-group")), "the choices carry a group caption");

  // 4. Choosing a mode writes it through the port; the menu is the only route now.
  const cloudOnly = item("cache-cloud_only");
  assert.ok(cloudOnly);
  cloudOnly.dispatch("click", {});
  await settle();
  assert.deepEqual(writes, [[9, "cloud_only"]]);

  // 5. Support is a menu destination, not a second header icon.
  overflow.dispatch("click", { stopPropagation() {} });
  const support = item("chat-support");
  assert.ok(support, "menu offers help & support");
  support.dispatch("click", {});
  assert.equal(supportOpened, 1);

  // 6. Reopening reflects the new active mode.
  overflow.dispatch("click", { stopPropagation() {} });
  assert.equal(item("cache-cloud_only")?.attrs["aria-checked"], "true");
  assert.equal(item("cache-7d")?.attrs["aria-checked"], "false");
  view.destroy();
});

class BotHeaderApi implements ApiLike {
  profileReads = 0;

  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 9, kind: "dialog", title: "Helper", username: "helper_bot", photo_file_id: null,
        peer_is_bot: true,
        last_message: null, unread_count: 0, muted_until: 0, pinned: false, archived: false,
        my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1,
      }] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice" },
        { id: 2, username: "helper_bot", name: "Helper", is_bot: true },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    if (path === "/v1/users/2") {
      this.profileReads += 1;
      return Promise.resolve({ last_seen: 1 } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({} as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("a bot dialog says bot and never exposes audio or video call actions", async () => {
  const api = new BotHeaderApi();
  let starts = 0;
  const view = createFeedScreen({
    api,
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
    onStartCall: () => { starts += 1; },
  });
  await settle();
  const root = view.root as unknown as StubNode;
  const subtitle = root.find((node) => node.hasClass("gc-feed-subtitle"));
  assert.equal(subtitle?.textContent, i18n.t("chat.botSubtitle"));
  const callButtons = root.findAll((node) => node.hasClass("gc-feed-call"));
  assert.equal(callButtons.length, 2, "the shared header still constructs both controls");
  assert.ok(callButtons.every((button) => button.attrs.hidden !== undefined), "both controls remain hidden for bots");
  for (const button of callButtons) button.dispatch("click");
  assert.equal(starts, 0, "even a synthetic click cannot start a bot call");
  assert.equal(api.profileReads, 0, "bot presence is not queried or rendered as human online status");
  view.destroy();
});
