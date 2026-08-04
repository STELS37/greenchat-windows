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

class GroupHeaderApi implements ApiLike {
  active: { id: string; chat_id: number; video: boolean } | null = null;

  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 9,
        kind: "group",
        title: "Команда",
        username: null,
        photo_file_id: null,
        last_message: null,
        unread_count: 0,
        muted_until: 0,
        pinned: false,
        archived: false,
        my_role: "owner",
        message_ttl_sec: 0,
        draft: null,
        updated_at: 1,
      }] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Алиса" },
        { id: 2, username: "bob", name: "Боб" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    if (path === "/v1/chats/9/conference") return Promise.resolve({ conference: this.active } as T);
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

function eventFeed(): { feed: EventFeed; emit(type: string, payload: unknown): void } {
  let listener: ((event: { type: string; payload: unknown }) => void | Promise<void>) | null = null;
  return {
    feed: {
      subscribe(next) {
        listener = next;
        return () => { listener = null; };
      },
    },
    emit(type, payload) { void listener?.({ type, payload }); },
  };
}

test("a group header starts audio/video calls and turns into a join button for an active room", async (t) => {
  const api = new GroupHeaderApi();
  const events = eventFeed();
  const opened: Array<[number, boolean]> = [];
  const view = createFeedScreen({
    api,
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Алиса" },
    outbox,
    events: events.feed,
    onBack() {},
    onOpenConference: (chatId, video) => { opened.push([chatId, video]); },
  });
  t.after(() => view.destroy());
  await settle();
  await settle();
  const root = view.root as unknown as StubNode;
  const call = root.find((node) => node.tag === "button" && node.hasClass("gc-feed-group-call"));
  assert.ok(call, "a group has one call button in the conversation header");
  assert.equal(call.attrs.hidden, undefined, "the group call action is visible after chat metadata loads");
  assert.match(String(call.attrs.title), /групповой звонок/i);

  call.dispatch("click", { stopPropagation() {} });
  const video = root.find((node) => node.tag === "button" && node.attrs["data-action"] === "group-call-video");
  assert.ok(video, "the single call button offers an explicit video choice");
  video.dispatch("click", {});
  await settle();
  assert.deepEqual(opened, [[9, true]]);

  events.emit("conference.started", {
    conference: { id: "11111111-1111-1111-1111-111111111111", chat_id: 9, video: true },
  });
  assert.equal(call.hasClass("is-live"), true, "an active room is visually distinct");
  assert.match(String(call.attrs.title), /войти/i);
  call.dispatch("click", { stopPropagation() {} });
  await settle();
  assert.deepEqual(opened, [[9, true], [9, false]], "joining never turns the camera on implicitly");

  events.emit("conference.ended", { chat_id: 9, conference_id: "11111111-1111-1111-1111-111111111111" });
  assert.equal(call.hasClass("is-live"), false);
});
