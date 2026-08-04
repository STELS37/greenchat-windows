// V105 — the conversation header gave 18% of its width to the only line that says who you are
// talking to.
//
// Measured on the signed superapp APK (versionCode 1000013) through the device WebView
// (redroid 15, 391 dp viewport, route #/chat/17, probe var/ux-audit/tools/m_feedhdr_v105.mjs,
// 2026-07-31) in a 1:1 dialog, at the DEFAULT system font size:
//
//   .gc-feed-header          391.2   padding-inline 16, gap 10
//   back button               44
//   .gc-feed-identity        135.2   (38 avatar + 26 gaps/padding  =>  71 px left for the names)
//   .gc-feed-header-actions  176.0   = 4 x 44  (call, video, search, overflow), flex 0 0 auto
//   .gc-feed-title            71 wide / 111 needed  ->  «Артём Волков»  painted «Артём Вол…»
//   .gc-feed-subtitle         71 wide /  80 needed  ->  «был(а) в 10:49» painted «был(а) в 10:4…»
//
// The arithmetic of that bar is names = vw − 144 − 44·actions. With four actions a 12-character
// name needs a 431 dp viewport, so EVERY phone in portrait (320–430 dp) truncated the peer's name
// and their presence line by default — not only at an enlarged system font, where the same bar
// showed «Ар…». The four icons never yield because the actions row is `flex: 0 0 auto`, so the
// identity block absorbs the whole shortfall.
//
// Search in a conversation is the least-used of the four and it is the one every phone messenger
// keeps in the overflow menu (WhatsApp for Android: video, call, ⋮ in the bar, "Search" inside the
// menu). Folding it there is worth 44 dp of name at every phone width and removes no capability:
// the menu is already in the bar and already carries the support destination and the cache modes.
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
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

class DialogApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([{
        id: 9, kind: "dialog", title: "Артём Волков", username: "artem", photo_file_id: null,
        last_message: null, unread_count: 0, muted_until: 0, pinned: false, archived: false,
        my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1,
      }] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice" },
        { id: 2, username: "artem", name: "Артём Волков" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/users/2") return Promise.resolve({ last_seen: 1_700_000_000 } as T);
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

function cachePolicyStub(): CachePolicyPort {
  let chatMode: ChatCacheMode = "7d";
  return {
    getGlobal: () => "forever" as CacheRetentionMode,
    setGlobal: () => Promise.resolve(),
    getChat: () => chatMode,
    setChat: (_chatId, mode) => { chatMode = mode; return Promise.resolve(); },
    shouldPersist: () => true,
    recordMedia: () => Promise.resolve(),
    subscribe: () => () => {},
  };
}

/** The viewport class the header reads. `listeners` records the rotation/resize wiring. */
function useViewport(narrow: boolean): { fire(next: boolean): void; listeners(): number } {
  let matches = narrow;
  const subs = new Set<() => void>();
  (globalThis as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
    media: q,
    get matches() { return q.includes("max-width") ? matches : false; },
    addEventListener: (_type: string, cb: () => void) => { subs.add(cb); },
    removeEventListener: (_type: string, cb: () => void) => { subs.delete(cb); },
  });
  return {
    fire(next: boolean) { matches = next; for (const cb of [...subs]) cb(); },
    listeners: () => subs.size,
  };
}

function openDialog(): Promise<{ destroy(): void; root: StubNode }> {
  const view = createFeedScreen({
    api: new DialogApi(),
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
    cachePolicy: cachePolicyStub(),
    onStartCall() {},
  });
  return settle().then(() => ({ destroy: () => view.destroy(), root: view.root as unknown as StubNode }));
}

const shown = (root: StubNode): StubNode[] => {
  const actions = root.find((n) => n.hasClass("gc-feed-header-actions"));
  assert.ok(actions, "the header exposes its actions row");
  return actions.children.filter((n) => n.tag === "button" && !n.hidden && n.attrs.hidden === undefined);
};

test("V105/V205: on a phone the chat header keeps both call actions and folds only search", async (t) => {
  useViewport(true);
  const view = await openDialog();
  t.after(() => view.destroy());

  const buttons = shown(view.root);
  assert.equal(
    buttons.length,
    3,
    // V205 intentionally restores video as a first-class phone action. Search alone folds; CSS owns
    // the remaining identity-width pressure instead of hiding a call capability.
    `a phone bar must keep audio, video and overflow: got ${buttons.length} actions`,
  );

  // Both calls are primary actions; only search moves into the already-present menu.
  const titles = buttons.map((b) => b.attrs.title);
  assert.ok(titles.includes(i18n.t("call.startAudio")), "the audio call stays in the bar");
  assert.ok(titles.includes(i18n.t("call.startVideo")), "the video call stays visible on phones");
  assert.ok(
    buttons.some((b) => b.hasClass("gc-feed-overflow")),
    "the overflow menu stays in the bar",
  );

  // Nothing is lost: search moved INTO the menu that is already there.
  const overflow = view.root.find((n) => n.tag === "button" && n.hasClass("gc-feed-overflow"));
  assert.ok(overflow, "the overflow button exists");
  overflow.dispatch("click", { stopPropagation() {} });
  const item = view.root.find((n) => n.tag === "button" && n.attrs["data-action"] === "chat-search");
  assert.ok(item, "the folded search is offered by the header menu");
  assert.equal(item.textContent.includes(i18n.t("feed.searchAction")), true, "the item is labelled");

  // And it works: choosing it reveals the in-chat search panel and puts the caret in its field,
  // which is exactly what the header icon did.
  const panel = view.root.find((n) => n.hasClass("gc-feed-search"));
  assert.ok(panel, "the search panel exists in the screen");
  item.dispatch("click", {});
  await settle();
  assert.equal(panel.hidden, false, "the menu item opens the in-chat search");
  const focused = (globalThis as unknown as { document: { activeElement: StubNode | null } })
    .document.activeElement;
  assert.ok(focused?.hasClass("gc-input"), "opening search focuses its field, as the icon did");

});

test("V105: a wide window keeps the search icon in the bar", async (t) => {
  useViewport(false);
  const view = await openDialog();
  t.after(() => view.destroy());
  const titles = shown(view.root).map((b) => b.attrs.title);
  assert.equal(titles.length, 4, "a desktop bar has room for all four actions");
  assert.ok(titles.includes(i18n.t("common.search")), "search stays a first-class icon on desktop");
});

test("V105/V205: rotating into a phone width folds search but keeps both calls", async (t) => {
  const vp = useViewport(false);
  const view = await openDialog();
  t.after(() => view.destroy());
  assert.equal(shown(view.root).length, 4, "starts wide");
  assert.ok(vp.listeners() > 0, "the header listens for the viewport changing under it");

  vp.fire(true);
  assert.equal(shown(view.root).length, 3, "turning the phone upright folds search, not video");
  vp.fire(false);
  assert.equal(shown(view.root).length, 4, "and turning back restores them");

  view.destroy();
  assert.equal(vp.listeners(), 0, "destroy() leaves no listener behind on the media query");
});

test("V105: a shell without matchMedia keeps every action visible", async (t) => {
  delete (globalThis as unknown as { matchMedia?: unknown }).matchMedia;
  const view = await openDialog();
  t.after(() => view.destroy());
  assert.equal(shown(view.root).length, 4, "an unknown viewport must not hide an action");
});
