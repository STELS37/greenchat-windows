// clients/ui/test/visual_keyboard_autofocus_v92.test.ts — V92 regression guard.
//
// Defect, measured on the signed direct APK (version code 1000010) running on redroid 15, driven
// through the Chrome DevTools Protocol against the app's WebView (probe /tmp/ime2.mjs, 2026-07-30):
//
//   chats list   innerWidth x innerHeight = 820x343   document.activeElement = BODY
//   chat opened  innerWidth x innerHeight = 820x113   document.activeElement = gc-composer-input
//
// Opening a conversation moved the focus into the composer by itself, the on-screen keyboard came up
// with it, and 230 of the 343 available pixels — 67% of the window in landscape — were taken by the
// keyboard before the user had read a single message. The same happens in portrait; landscape only
// makes the arithmetic impossible to argue with.
//
// The cause is one unconditional line in the feed's boot block:
//   if (typeof deps.focusMessageId === "number") void jumpTo(deps.focusMessageId);
//   else composer.focus();
// It was written for a desktop shell, where focusing a field costs nothing and saves a click.
//
// Reference: Telegram for Android (ChatActivity) opens the keyboard on entry only when the chat was
// opened TO WRITE — a share/forward target or a restored draft — never on a plain open.
//
// The guard pins the behaviour on both shells, because the fix must not turn into "nobody ever gets
// a focused field": with a fine pointer (mouse/trackpad) the composer must still be focused.
import test from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type { ChatEntry, ChatMember, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const msg: Message = {
  id: 41,
  chat_id: 9,
  sender: { id: 2, username: "bob", name: "Bob" },
  kind: "text",
  text: "hi",
  created_at: 1_700_000_000,
};

class FeedApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([msg] as T);
    if (path === "/v1/chats?filter=all")
      return Promise.resolve([
        {
          id: 9, kind: "dialog", title: "Bob", username: "bob", photo_file_id: null,
          last_message: null, unread_count: 0, muted_until: 0, pinned: false, archived: false,
          my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1,
        },
      ] as ChatEntry[] as T);
    if (path === "/v1/chats/9/members")
      return Promise.resolve([{ id: 1, username: "alice", name: "Alice" }] as ChatMember[] as T);
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

/** Installs the media query the fix reads; `coarse` = finger = on-screen keyboard. */
function usePointer(kind: "coarse" | "fine"): void {
  (globalThis as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({
    matches: q.includes("pointer: coarse") ? kind === "coarse" : kind === "fine",
  });
}

const doc = (): { activeElement: StubNode | null } =>
  (globalThis as unknown as { document: { activeElement: StubNode | null } }).document;

async function openChat(): Promise<{ destroy(): void; root: StubNode }> {
  doc().activeElement = null;
  const view = createFeedScreen({
    api: new FeedApi(), i18n, chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox, events, onBack() {},
  });
  await settle();
  return { destroy: () => view.destroy(), root: view.root as unknown as StubNode };
}

test("V92: on a touch shell, opening a chat does not summon the keyboard", async () => {
  usePointer("coarse");
  const view = await openChat();
  const focused = doc().activeElement;
  assert.ok(
    !focused || !focused.hasClass("gc-composer-input"),
    `the composer grabbed focus on a touch shell, so the keyboard covers the history (focused: ${focused?.tag}.${focused?.attrs.class})`,
  );
  // …and the field is still there, ready for the tap that actually asks for it.
  assert.ok(view.root.find((n) => n.hasClass("gc-composer-input")), "the composer is rendered");
  view.destroy();
});

test("V92: on a pointer shell, opening a chat still focuses the composer", async () => {
  usePointer("fine");
  const view = await openChat();
  const focused = doc().activeElement;
  assert.ok(
    focused?.hasClass("gc-composer-input"),
    `a mouse shell loses nothing by focusing, and the old behaviour must survive (focused: ${focused?.tag}.${focused?.attrs.class})`,
  );
  view.destroy();
});

test("V92: a shell without matchMedia keeps the desktop behaviour", async () => {
  delete (globalThis as unknown as { matchMedia?: unknown }).matchMedia;
  const view = await openChat();
  assert.ok(
    doc().activeElement?.hasClass("gc-composer-input"),
    "feature detection must fail towards the historical behaviour, not towards a dead field",
  );
  view.destroy();
});
