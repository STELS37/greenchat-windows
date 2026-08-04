// V199 — incoming group/channel bubbles must show the sender's real profile photo, not initials forever.
// The photo id comes from the viewer-filtered member roster; chat-wide message events intentionally do
// not carry it because one durable payload cannot represent every recipient's privacy view.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type { ChatEntry, ChatMember, ChatReceiptState, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const messages: Message[] = [
  {
    id: 101,
    chat_id: 55,
    sender: { id: 2, username: "donki2", name: "Donki Two" },
    kind: "voice",
    text: "",
    created_at: 1_700_000_001,
  },
  {
    id: 102,
    chat_id: 55,
    sender: { id: 3, username: "noavatar", name: "No Avatar" },
    kind: "text",
    text: "fallback",
    created_at: 1_700_000_002,
  },
  {
    id: 103,
    chat_id: 55,
    sender: { id: 300, username: "latermember", name: "Later Member" },
    kind: "text",
    text: "outside first roster page",
    created_at: 1_700_000_003,
  },
  {
    id: 104,
    chat_id: 55,
    sender: { id: 2, username: "donki2", name: "Donki Two" },
    kind: "text",
    text: "same author, another run",
    created_at: 1_700_000_004,
  },
];

class BubbleAvatarApi implements ApiLike {
  signedUrlCalls = 0;
  profileCalls = 0;

  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/55/messages?")) return Promise.resolve(messages as T);
    if (path === "/v1/chats/55/receipt-state") {
      return Promise.resolve({
        chat_id: 55,
        delivered_up_to_message_id: 0,
        read_up_to_message_id: 0,
      } satisfies ChatReceiptState as T);
    }
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 55,
        kind: "group",
        title: "Drivers",
        username: null,
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
      }] satisfies ChatEntry[] as T);
    }
    if (path === "/v1/chats/55/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice", avatar_file_id: null },
        { id: 2, username: "donki2", name: "Donki Two", avatar_file_id: 77 },
        { id: 3, username: "noavatar", name: "No Avatar", avatar_file_id: null },
      ] satisfies ChatMember[] as T);
    }
    if (path === "/v1/chats/55/pins") return Promise.resolve([] as T);
    if (path === "/v1/chats/55/conference") return Promise.resolve({ conference: null } as T);
    if (path === "/v1/users/300") {
      this.profileCalls += 1;
      return Promise.resolve({ id: 300, avatar_file_id: 88 } as T);
    }
    if (path === "/v1/files/77/url") {
      this.signedUrlCalls += 1;
      return Promise.resolve({ url: "/f/77?e=99&s=sig", expires_at: 99 } as T);
    }
    if (path === "/v1/files/88/url") {
      this.signedUrlCalls += 1;
      return Promise.resolve({ url: "/f/88?e=99&s=profile", expires_at: 99 } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/55/read") return Promise.resolve({ unread_count: 0 } as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  resolveUrl(path: string): string { return `https://api.greenchat.example${path}`; }
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

function bubbleAvatar(root: StubNode, messageId: number): StubNode {
  const row = root.find((node) => node.attrs["data-mid"] === String(messageId));
  assert.ok(row, `message row ${messageId} exists`);
  const avatar = row.find((node) => node.hasClass("gc-bubble-avatar") && !node.hasClass("is-spacer"));
  assert.ok(avatar, `message row ${messageId} has its run-tail avatar`);
  return avatar;
}

test("V199: member roster repaints group bubble with a privacy-filtered signed avatar", async () => {
  const api = new BubbleAvatarApi();
  const view = createFeedScreen({
    api,
    i18n,
    chatId: 55,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
  });
  await settle();
  await settle();
  await settle();

  const root = view.root as unknown as StubNode;
  const withPhoto = bubbleAvatar(root, 101);
  const candidate = withPhoto.querySelector("img.gc-avatar-photo");
  assert.ok(candidate, "roster arrival starts one signed image request for the visible sender photo");
  assert.equal(candidate.hidden, true, "initials stay visible until the photo has loaded");
  assert.equal(
    candidate.getAttribute("src"),
    "https://api.greenchat.example/f/77?e=99&s=sig",
    "native shells resolve the signed path against the configured API origin",
  );
  assert.equal(withPhoto.textContent, "DT", "the zero-network initials fallback remains underneath");

  const withoutPhoto = bubbleAvatar(root, 102);
  assert.equal(withoutPhoto.querySelector("img.gc-avatar-photo"), null);
  assert.equal(withoutPhoto.textContent, "NA", "privacy-hidden/missing photos keep deterministic initials");

  const repeatedAuthor = bubbleAvatar(root, 104);
  const repeatedCandidate = repeatedAuthor.querySelector("img.gc-avatar-photo");
  assert.ok(repeatedCandidate, "a later run by the same author also gets the photo");
  assert.equal(repeatedCandidate.getAttribute("src"), candidate.getAttribute("src"));

  const outsideRosterPage = bubbleAvatar(root, 103);
  const profileCandidate = outsideRosterPage.querySelector("img.gc-avatar-photo");
  assert.ok(profileCandidate, "an author beyond the paged roster is resolved through their public profile");
  assert.equal(profileCandidate.getAttribute("src"), "https://api.greenchat.example/f/88?e=99&s=profile");
  assert.equal(api.profileCalls, 1, "the out-of-page sender profile is loaded once");
  assert.equal(api.signedUrlCalls, 2, "only positive viewer-visible avatar ids are requested");

  candidate.dispatch("load");
  repeatedCandidate.dispatch("load");
  profileCandidate.dispatch("load");
  await settle();
  assert.equal(candidate.hidden, false);
  assert.equal(repeatedCandidate.hidden, false);
  assert.equal(profileCandidate.hidden, false);
  assert.ok(withPhoto.hasClass("has-image"), "the decoded roster photo now covers the initials");
  assert.ok(outsideRosterPage.hasClass("has-image"), "the decoded profile fallback also covers initials");

  view.destroy();
  assert.equal(withPhoto.querySelector("img.gc-avatar-photo"), null, "destroy removes roster avatar bindings");
  assert.equal(repeatedAuthor.querySelector("img.gc-avatar-photo"), null, "destroy removes repeated-author bindings");
  assert.equal(outsideRosterPage.querySelector("img.gc-avatar-photo"), null, "destroy removes profile avatar bindings");
});
