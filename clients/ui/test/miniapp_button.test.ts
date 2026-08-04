import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  createFeedScreen,
  type EventFeed,
  type OutboxPort,
} from "../src/screens/feed_screen.ts";
import type { ChatEntry, ChatMember, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { setTimeout, clearTimeout },
});
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const message: Message = {
  id: 77,
  chat_id: 9,
  sender: { id: 42, username: "ordersbot", name: "Orders Bot" },
  kind: "text",
  text: "Open the order console",
  created_at: 1_700_000_000,
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Open app", mini_app: { app_id: 42, start_param: "order_17" } },
        { text: "Refresh", callback_data: "refresh:17" },
      ],
      [
        { text: "Help", url: "https://docs.example/help" },
        { text: "Unsafe", url: "javascript:alert(1)" },
      ],
    ],
  },
};

class FeedApi implements ApiLike {
  callbackBody: unknown = null;

  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([message] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 9,
        kind: "dialog",
        title: "Orders Bot",
        username: "ordersbot",
        photo_file_id: null,
        last_message: null,
        unread_count: 0,
        muted_until: 0,
        pinned: false,
        archived: false,
        my_role: "member",
        message_ttl_sec: 0,
        draft: null,
        updated_at: 1,
      }] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice" },
        { id: 42, username: "ordersbot", name: "Orders Bot" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({} as T);
    if (path === "/v1/messages/77/callback") {
      this.callbackBody = body;
      return Promise.resolve({ accepted: true } as T);
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }

  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const outbox: OutboxPort = {
  enqueueMessage: () => Promise.reject(new Error("unused enqueue")),
  enqueueEdit: () => Promise.reject(new Error("unused edit")),
  enqueueDelete: () => Promise.reject(new Error("unused delete")),
  cancel: () => Promise.resolve(false),
  retry: () => Promise.reject(new Error("unused retry")),
  subscribe: () => () => {},
};
const events: EventFeed = { subscribe: () => () => {} };

test("bot inline keyboard opens native Mini Apps, preserves callbacks and fails closed on unsafe URLs", async () => {
  const api = new FeedApi();
  const opened: Array<{ appId: number; chatId: number; startParam?: string }> = [];
  const view = createFeedScreen({
    api,
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
    onOpenMiniApp(appId, chatId, startParam) {
      opened.push({ appId, chatId, ...(startParam === undefined ? {} : { startParam }) });
    },
  });
  await settle();
  const root = view.root as unknown as StubNode;

  const appButton = root.find((node) => node.tag === "button" && node.hasClass("is-miniapp"));
  assert.ok(appButton);
  appButton.dispatch("click", { stopPropagation() {} });
  assert.deepEqual(opened, [{ appId: 42, chatId: 9, startParam: "order_17" }]);

  const callback = root.find((node) => node.tag === "button" && node.hasClass("is-callback"));
  assert.ok(callback);
  callback.dispatch("click", { stopPropagation() {} });
  await settle();
  assert.deepEqual(api.callbackBody, { data: "refresh:17" });

  const help = root.find((node) => node.tag === "a" && node.textContent === "Help");
  assert.ok(help);
  assert.equal(help.attrs.href, "https://docs.example/help");
  assert.equal(help.attrs.target, "_blank");
  assert.equal(help.attrs.rel, "noopener noreferrer");

  const unsafe = root.find((node) => node.tag === "a" && node.textContent === "Unsafe");
  assert.ok(unsafe);
  assert.equal("href" in unsafe.attrs, false);
  assert.equal(unsafe.attrs["aria-disabled"], "true");
  assert.equal(unsafe.hasClass("is-disabled"), true);

  assert.equal(root.findAll((node) => node.tag === "iframe").length, 0, "the feed navigates to the native host instead of embedding the app itself");
  view.destroy();
});
