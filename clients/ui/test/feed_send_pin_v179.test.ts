// Regression for the live Android defect reported 2026-08-04: after an own send the bubble could
// settle below the visible feed, and opening/focusing the IME could leave the last sent bubble under
// the composer. The important distinction is reader intent versus transient geometry. V116 already
// keeps `pinnedToBottom` true when a scroll event is caused by the app's own relayout, but paint()
// re-asked raw geometry and discarded that intent on the next outbox/status repaint.

import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  createFeedScreen,
  type EventFeed,
  type OutboxChangeView,
  type OutboxPort,
} from "../src/screens/feed_screen.ts";
import type { ChatMember, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const self = { id: 1, username: "alice", name: "Alice" };
const peer = { id: 2, username: "bob", name: "Bob" };
const initial: Message = {
  id: 41,
  chat_id: 9,
  sender: peer,
  kind: "text",
  text: "Последнее входящее",
  created_at: 1_700_000_041,
};

class FeedApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) {
      return Promise.resolve((path.includes("before_id=") ? [] : [initial]) as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([self, peer] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    if (path.startsWith("/v1/chats?")) {
      return Promise.resolve([{ id: 9, title: "Bob", kind: "dialog" }] as T);
    }
    return Promise.resolve([] as T);
  }
  post<T>(): Promise<T> { return Promise.resolve({} as T); }
  put<T>(): Promise<T> { return Promise.resolve({} as T); }
  patch<T>(): Promise<T> { return Promise.resolve({} as T); }
  delete<T>(): Promise<T> { return Promise.resolve({} as T); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

interface OutboxHarness {
  port: OutboxPort;
  emit(change: OutboxChangeView): void;
  lastClientMessageId(): string;
}

function outboxHarness(): OutboxHarness {
  let subscriber: (change: OutboxChangeView) => void = () => {};
  let cmid = "";
  const never = new Promise<string>(() => {});
  return {
    port: {
      enqueueMessage(_chatId, body) {
        cmid = String(body.client_msg_id ?? "");
        return never;
      },
      enqueueEdit: () => Promise.reject(new Error("unexpected edit")),
      enqueueDelete: () => Promise.reject(new Error("unexpected delete")),
      cancel: () => Promise.resolve(false),
      retry: () => Promise.resolve(),
      subscribe(handler) { subscriber = handler; return () => {}; },
    },
    emit(change) { subscriber(change); },
    lastClientMessageId() { return cmid; },
  };
}

const events: EventFeed = { subscribe: () => () => {} };

async function mount(): Promise<{
  root: StubNode;
  list: StubNode;
  input: StubNode;
  outbox: OutboxHarness;
  destroy(): void;
}> {
  const outbox = outboxHarness();
  const view = createFeedScreen({
    api: new FeedApi(),
    i18n,
    chatId: 9,
    self,
    outbox: outbox.port,
    events,
    onBack() {},
  });
  await settle();
  const root = view.root as unknown as StubNode;
  const list = root.find((node) => node.hasClass("gc-feed-list"));
  const input = root.find((node) => node.hasClass("gc-composer-input"));
  assert.ok(list, "feed list exists");
  assert.ok(input, "composer input exists");
  return { root, list, input, outbox, destroy: () => view.destroy() };
}

function settleAtBottom(list: StubNode): void {
  list.clientHeight = 200;
  list.scrollHeight = 1000;
  list.scrollTop = 800;
  // First event teaches the handler the declared geometry; second is a stable reader event.
  list.dispatch("scroll");
  list.dispatch("scroll");
  assert.equal(list.scrollTop, 800);
}

test("own-send status repaint preserves the reader's tail intent after keyboard/layout growth", async (t) => {
  const { list, input, outbox, destroy } = await mount();
  t.after(destroy);
  settleAtBottom(list);

  input.value = "Отладка";
  input.dispatch("input");
  input.dispatch("keydown", { key: "Enter", shiftKey: false });
  await settle();

  const cmid = outbox.lastClientMessageId();
  assert.ok(cmid, "the composer enqueued the optimistic message");
  assert.equal(list.scrollTop, 800, "the immediate send pins to the then-current bottom");

  // Model the real Android ordering: the WebView/IME or late bubble layout grows the scrollable
  // content after the first pin. The scroll event reports CHANGED geometry, so V116 correctly keeps
  // the reader-intent flag true rather than treating this app relayout as a manual history scroll.
  list.scrollHeight = 1100;
  list.dispatch("scroll");
  assert.equal(list.scrollTop, 800);
  assert.equal(list.scrollHeight - list.scrollTop - list.clientHeight, 100);

  // A normal outbox transition repaints the feed. Before V179 paint() ignored the intent flag,
  // called isAtBottom() on this transient 100px gap, and restored the stale 800px offset. The sent
  // bubble then lived below the composer until the user dragged the thread down by hand.
  outbox.emit({
    item: {
      id: cmid,
      chat_id: 9,
      kind: "message",
      status: "sending",
      created_at: 1_700_000_050,
    },
  });
  await settle();

  assert.equal(
    list.scrollTop,
    900,
    "a repaint while reader intent is pinned must heal to scrollHeight - clientHeight",
  );
  assert.equal(list.scrollHeight - list.scrollTop - list.clientHeight, 0);
});


test("an explicit stable scroll into history still wins over an outbox repaint", async (t) => {
  const { list, input, outbox, destroy } = await mount();
  t.after(destroy);
  settleAtBottom(list);

  input.value = "Сообщение, после которого читают историю";
  input.dispatch("input");
  input.dispatch("keydown", { key: "Enter", shiftKey: false });
  await settle();
  const cmid = outbox.lastClientMessageId();
  assert.ok(cmid);

  // This time geometry is stable and the offset really is chosen by the reader. Two events mirror the
  // browser settling after the assignment and make the V116 intent gate answer `false` deliberately.
  list.scrollTop = 500;
  list.dispatch("scroll");
  list.dispatch("scroll");
  assert.equal(list.scrollHeight - list.scrollTop - list.clientHeight, 300);

  outbox.emit({
    item: {
      id: cmid,
      chat_id: 9,
      kind: "message",
      status: "sending",
      created_at: 1_700_000_051,
    },
  });
  await settle();

  assert.equal(list.scrollTop, 500, "a person who actually scrolled up must never be yanked to the tail");
});
