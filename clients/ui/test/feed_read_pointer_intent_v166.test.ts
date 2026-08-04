// clients/ui/test/feed_read_pointer_intent_v166.test.ts — a read receipt is a claim about a PERSON,
// so it may only be sent for messages that person actually reached.
//
// Evidence (deployed build, https://greenchat.globalsystem.cc, 2026-08-03, CloakBrowser 412x915
// ru-RU, accounts 66 -> 67, dialog chat 27):
//
//   reader (67) parked in history   .gc-feed-list scrollTop 0, 965 px still below the fold
//   peer (66) sends                 28 messages, then one control message id 114
//   GET /v1/chats as the reader     unread_count: 0   after EVERY burst
//
// Nothing about that reader had changed: the box never scrolled (scrollTop stayed 0 across the whole
// burst, which was recorded separately), and the control message was worded so a human could not
// have missed noticing it had been "read" — "КОНТРОЛЬНОЕ: читатель стоит вверху и меня не видит".
//
// Two people were misinformed by one line. The sender was told messages were read that nobody looked
// at, and the reader lost the unread count that is the only route back to them. The mechanism was
// then located in feed_screen.ts: markRead() sends `up_to_message_id = newestId(messages)` — the
// newest message in the LOADED WINDOW — and it fires on every `message.new`, gated only by `atHead`.
// `atHead` says the window still contains the chat's tail. That is a fact about the data, and it
// stays true no matter where the reader is looking.
//
// The gate this file pins is the one already maintained in the same screen for scrolling: the
// reader's own `pinnedToBottom` intent (V116). Both halves are asserted here, because a fix that
// only stops sending would trade a wrong receipt for a permanently stuck unread badge.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type { ChatMember, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const peer = { id: 2, username: "bob", name: "Bob" };
const message = (id: number): Message => ({
  id,
  chat_id: 9,
  sender: peer,
  kind: "text",
  text: `m${id}`,
  created_at: 1_700_000_000 + id,
});

class FeedApi implements ApiLike {
  readonly reads: number[] = [];
  get<T>(path: string): Promise<T> {
    // history: the first page is the tail; paging older returns nothing (short chat)
    if (path.startsWith("/v1/chats/9/messages?")) {
      return Promise.resolve((path.includes("before_id=") ? [] : [message(41)]) as T);
    }
    if (path === "/v1/chats/9/members") return Promise.resolve([{ id: 1, username: "alice", name: "Alice" }, peer] as ChatMember[] as T);
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    if (path.startsWith("/v1/chats?")) return Promise.resolve([] as T);
    return Promise.resolve([] as T);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    if (path === "/v1/chats/9/read") {
      this.reads.push((body as { up_to_message_id: number }).up_to_message_id);
      return Promise.resolve({} as T);
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.resolve({} as T); }
  patch<T>(): Promise<T> { return Promise.resolve({} as T); }
  delete<T>(): Promise<T> { return Promise.resolve({} as T); }
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

type Handler = (evt: { type: string; payload: unknown }) => void | Promise<void>;

const mount = async (): Promise<{
  api: FeedApi;
  list: StubNode;
  deliver: (m: Message) => Promise<void>;
  scrollTo: (top: number) => Promise<void>;
  destroy: () => void;
}> => {
  const api = new FeedApi();
  let handler: Handler = () => {};
  const events: EventFeed = { subscribe: (h) => { handler = h; return () => {}; } };
  const view = createFeedScreen({
    api, i18n, chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox, events, onBack() {},
  });
  await settle();
  const root = view.root as unknown as StubNode;
  const list = root.find((node) => node.hasClass("gc-feed-list"));
  assert.ok(list, "the feed must expose its scroll box");
  // A viewport the reader can actually be somewhere in. The stub lays nothing out, so the geometry
  // is stated rather than measured — these are the proportions of the recorded device run.
  list.clientHeight = 200;
  list.scrollHeight = 2000;
  const scrollTo = async (top: number): Promise<void> => {
    list.scrollTop = top;
    // The intent gate (V116) ignores an event on a box whose geometry just changed, so the harness
    // dispatches on a settled box exactly as a browser would after the relayout is over.
    list.dispatch("scroll", {});
    list.dispatch("scroll", {});
    await settle();
  };
  const deliver = async (m: Message): Promise<void> => {
    await handler({ type: "message.new", payload: { message: m } });
    await settle();
  };
  return { api, list, deliver, scrollTo, destroy: () => view.destroy() };
};

test("opening a chat still reports the newest message as read", async () => {
  const { api, destroy } = await mount();
  assert.deepEqual(api.reads, [41], "the reader lands on the tail, so the pointer legitimately moves");
  destroy();
});

test("messages arriving while the reader is in history do not move the read pointer", async () => {
  const { api, deliver, scrollTo, destroy } = await mount();
  await scrollTo(0); // 2000 - 0 - 200 = 1800 px below the fold: unmistakably not the tail
  const beforeBurst = api.reads.length;

  await deliver(message(42));
  await deliver(message(43));

  assert.deepEqual(
    api.reads.slice(beforeBurst), [],
    "on the device this is where unread_count became 0 for messages 965 px below the fold",
  );
  destroy();
});

test("returning to the newest message releases the held-back pointer once", async () => {
  const { api, deliver, scrollTo, destroy } = await mount();
  await scrollTo(0);
  await deliver(message(42));
  await deliver(message(43));

  await scrollTo(1800); // scrollHeight - clientHeight: the reader is back on the tail

  assert.deepEqual(
    api.reads.slice(1), [43],
    "arriving at the bottom clears the whole backlog in one request, not one per message",
  );

  // ...and it must not keep firing while the reader stays there, or every idle scroll becomes a write
  await scrollTo(1800);
  assert.deepEqual(api.reads.slice(1), [43], "an already-flushed pointer is not re-sent");
  destroy();
});

test("a reader parked on the tail is unaffected: receipts stay immediate", async () => {
  const { api, deliver, scrollTo, destroy } = await mount();
  await scrollTo(1800);
  await deliver(message(42));
  assert.deepEqual(api.reads.slice(-1), [42], "the common case must behave exactly as before the fix");
  destroy();
});
