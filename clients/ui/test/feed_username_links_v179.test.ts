// V179: @username tokens in message text are internal profile links. The parser must preserve the
// original message verbatim while refusing email addresses, too-short names and overlong prefixes —
// otherwise a tap could navigate to a user the sender never actually named.
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
const i18n = createI18n({ locale: "en", dicts: { en, ru } });
const overlong = `@${"a".repeat(33)}`;
const text = `Open @Alice_7, then (@bob9). Email alice@example.com; ignore @abc and ${overlong}.`;

const message: Message = {
  id: 51,
  chat_id: 9,
  sender: { id: 2, username: "sender", name: "Sender" },
  kind: "text",
  text,
  created_at: 1_700_000_000,
};

class FeedApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([message] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 9,
        kind: "dialog",
        title: "Sender",
        username: "sender",
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
        { id: 1, username: "me", name: "Me" },
        { id: 2, username: "sender", name: "Sender" },
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

test("valid @usernames in a message are links to the internal profile route", async () => {
  const view = createFeedScreen({
    api: new FeedApi(),
    i18n,
    chatId: 9,
    self: { id: 1, username: "me", name: "Me" },
    outbox,
    events,
    onBack() {},
  });
  await settle();
  const root = view.root as unknown as StubNode;
  const links = root.findAll((node) => node.tag === "a" && node.hasClass("gc-message-mention"));

  assert.deepEqual(links.map((link) => link.textContent), ["@Alice_7", "@bob9"]);
  assert.deepEqual(links.map((link) => link.attrs.href), ["#/user/Alice_7", "#/user/bob9"]);
  assert.deepEqual(links.map((link) => link.attrs["data-username"]), ["Alice_7", "bob9"]);
  assert.equal(links.every((link) => link.focusable), true, "every mention must be keyboard reachable");

  const body = root.find((node) => node.hasClass("gc-bubble-body"));
  assert.ok(body);
  assert.ok(body.textContent.startsWith(text), "linkification must preserve every visible character");
  assert.equal(body.textContent.includes("alice@example.com"), true);
  assert.equal(body.textContent.includes("@abc"), true);
  assert.equal(body.textContent.includes(overlong), true);
  view.destroy();
});
