// clients/ui/test/feed_jump_to_newest_v166b.test.ts — an honest unread badge needs a door.
//
// V166 stopped the chat screen from confirming, on the reader's behalf, messages they had never
// reached. That is the correct receipt, but it changes what the reader is left holding: before the
// fix a backlog silently erased itself, and after it the backlog persists — which is only an
// improvement if there is a way back to it.
//
// Evidence that there was not (deployed build, https://greenchat.globalsystem.cc, 2026-08-03,
// CloakBrowser 412x915 ru-RU, dialog chat 27, reader account 67 parked at scrollTop 0 with 965 px
// below the fold):
//
//   controls enumerated on the open chat screen        23
//   of those that scroll the feed to the newest message  0
//   call sites of scrollToBottom() reachable by a person 0  (all internal: send, open, resize)
//   anything on screen announcing "new messages below"   none
//
// So a reader who scrolled up to re-read something had exactly two ways back: drag the whole
// history down by hand, or leave the chat and re-enter it. This file pins the missing affordance,
// and pins it to the SAME flag the read pointer now obeys (`pinnedToBottom`), so the button and the
// receipt can never disagree about where the reader is.
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

const self = { id: 1, username: "alice", name: "Alice" };
const peer = { id: 2, username: "bob", name: "Bob" };
const message = (id: number, from = peer): Message => ({
  id,
  chat_id: 9,
  sender: from,
  kind: "text",
  text: `m${id}`,
  created_at: 1_700_000_000 + id,
});

class FeedApi implements ApiLike {
  readonly reads: number[] = [];
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) {
      return Promise.resolve((path.includes("before_id=") ? [] : [message(41)]) as T);
    }
    if (path === "/v1/chats/9/members") return Promise.resolve([self, peer] as ChatMember[] as T);
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
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
  jump: StubNode;
  deliver: (m: Message) => Promise<void>;
  scrollTo: (top: number) => Promise<void>;
  destroy: () => void;
}> => {
  const api = new FeedApi();
  let handler: Handler = () => {};
  const events: EventFeed = { subscribe: (h) => { handler = h; return () => {}; } };
  const view = createFeedScreen({ api, i18n, chatId: 9, self, outbox, events, onBack() {} });
  await settle();
  const root = view.root as unknown as StubNode;
  const list = root.find((node) => node.hasClass("gc-feed-list"));
  assert.ok(list, "the feed must expose its scroll box");
  const jump = root.find((node) => node.hasClass("gc-feed-jump"));
  assert.ok(jump, "the chat screen must offer a control that returns the reader to the newest message");
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
  return { api, list, jump, deliver, scrollTo, destroy: () => view.destroy() };
};

test("a reader already on the newest message is not offered a way to go there", async () => {
  const { jump, destroy } = await mount();
  assert.equal(jump.hidden, true, "the button must not clutter the tail, where every reader starts");
  destroy();
});

test("scrolling into history reveals the way back", async () => {
  const { jump, scrollTo, destroy } = await mount();
  await scrollTo(0); // 1800 px below the fold
  assert.equal(jump.hidden, false, "this is the state the device run was recorded in");
  assert.equal(
    jump.getAttribute("aria-label"),
    i18n.t("feed.jumpNewest"),
    "a bare icon needs a name a screen reader can say",
  );
  destroy();
});

test("the badge counts what the reader missed, not the length of the chat", async () => {
  const { jump, deliver, scrollTo, destroy } = await mount();
  const count = jump.find((node) => node.hasClass("gc-feed-jump-count"));
  assert.ok(count, "the button must be able to carry a count");
  await scrollTo(0);
  assert.equal(count.hidden, true, "nothing arrived yet: a bare arrow, no number");

  await deliver(message(42));
  await deliver(message(43));
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, "2", "two messages arrived behind the reader's back");
  assert.equal(jump.getAttribute("aria-label"), i18n.t("feed.jumpNew", { count: "2" }));

  // The reader's own message, echoed back from another device, is not something they "missed".
  await deliver(message(44, self));
  assert.equal(count.textContent, "2", "own messages must not inflate the unread badge");
  destroy();
});

test("pressing it returns the reader to the tail, clears the badge and releases the read pointer", async () => {
  const { api, jump, list, deliver, scrollTo, destroy } = await mount();
  await scrollTo(0);
  await deliver(message(42));
  await deliver(message(43));
  assert.deepEqual(api.reads.slice(1), [], "V166: nothing is confirmed while the reader is in history");

  jump.dispatch("click", {});
  await settle();

  // A scroll box clamps: the furthest down it can be is scrollHeight - clientHeight, and both the
  // browser and the stub report that, not the value written.
  assert.equal(
    list.scrollTop, list.scrollHeight - list.clientHeight,
    "the press must actually move the feed to the newest message",
  );
  assert.equal(jump.hidden, true, "having arrived, the reader is not offered the trip again");
  assert.deepEqual(
    api.reads.slice(1), [43],
    "pressing it IS arriving, so the held-back pointer is released here too — a platform that fires no scroll event must not strand the backlog",
  );
  destroy();
});

test("returning by hand hides the button just as pressing it does", async () => {
  const { jump, deliver, scrollTo, destroy } = await mount();
  await scrollTo(0);
  await deliver(message(42));
  assert.equal(jump.hidden, false);

  await scrollTo(1800); // dragged back by hand, the only route that existed before this change
  assert.equal(jump.hidden, true, "the affordance follows the reader's position, not the press");

  const count = jump.find((node) => node.hasClass("gc-feed-jump-count"));
  assert.ok(count);
  assert.equal(count.hidden, true, "and the backlog it counted is over");
  destroy();
});
