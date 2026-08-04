// clients/ui/test/feed_modal_ownership_v178.test.ts — V178.
//
// Measured on the real screen before the fix (DOM stub, headless, 2026-08-03):
//
//     PROBE chat-info: after 1 tap=1  after 3 taps=3  after destroy=3
//
// i.e. an impatient triple tap on the chat title stacked three identical info sheets — each painting its
// own `rgba(2,12,8,.58)` scrim, so the screen went visibly darker and dismissing the top one uncovered
// another — and every one of them was still on screen after the person left the conversation, a card
// about a chat they had already walked away from, covering the chat they went to.
//
// This is the same pair of defects the «Новый чат» sheet had, on a different screen, because the
// convention was copied by hand. It is pinned here on the SECOND screen deliberately: the fix is a
// shared owner (src/modal_layer.ts), and a shared owner is only worth the name if more than one screen
// is held to it.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type { ChatEntry, ChatMember } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const CHAT: ChatEntry = {
  id: 9, kind: "dialog", title: "Боб", username: "bob", photo_file_id: null,
  last_message: null, unread_count: 0, muted_until: 0, pinned: false, archived: false,
  my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1,
} as ChatEntry;

class ChatApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([] as T);
    if (path === "/v1/chats?filter=all") return Promise.resolve([CHAT] as T);
    if (path === "/v1/chats/9") return Promise.resolve(CHAT as unknown as T);
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Алиса" },
        { id: 2, username: "bob", name: "Боб" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    if (path.startsWith("/v1/users/")) return Promise.resolve({ id: 2, username: "bob", name: "Боб" } as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.resolve({} as T); }
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

async function openChat() {
  const view = createFeedScreen({
    api: new ChatApi(), i18n, chatId: 9,
    self: { id: 1, username: "alice", name: "Алиса" },
    outbox, events, onBack() {},
  });
  await settle();
  const root = view.root as unknown as StubNode;
  const identity = root.find((n) => n.hasClass("gc-feed-identity"));
  assert.ok(identity, "the header title is the entry point to the info sheet");
  const sheets = (): StubNode[] => root.findAll((n) => n.hasClass("gc-info-overlay"));
  return { view, identity, sheets };
}

test("an impatient triple tap on the chat title opens one info sheet, not three", async () => {
  const { view, identity, sheets } = await openChat();
  identity.dispatch("click", {});
  identity.dispatch("click", {});
  identity.dispatch("click", {});
  await settle();
  assert.equal(sheets().length, 1, "three taps must leave exactly one sheet on screen");
  view.destroy();
});

test("leaving the conversation takes the info sheet with it", async () => {
  const { view, identity, sheets } = await openChat();
  identity.dispatch("click", {});
  await settle();
  assert.equal(sheets().length, 1, "the sheet opened");
  view.destroy();
  await settle();
  assert.equal(sheets().length, 0, "and it does not outlive the screen that opened it");
});

test("closing the sheet lets it be opened again", async () => {
  const { view, identity, sheets } = await openChat();
  identity.dispatch("click", {});
  await settle();
  const sheet = sheets()[0];
  assert.ok(sheet, "the sheet is there to close");
  sheet.dispatch("keydown", { key: "Escape" });
  await settle();
  assert.equal(sheets().length, 0, "Escape closes it");

  // The half a naive ownership fix breaks: the owner must forget the sheet it no longer has, or the
  // title becomes a dead control for the rest of the session.
  identity.dispatch("click", {});
  await settle();
  assert.equal(sheets().length, 1, "and the title still works afterwards");
  view.destroy();
});
