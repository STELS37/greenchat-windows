// V162 regression guard — a freshly filtered chat list must start at its first row, and leaving the
// filter must put the reader back where they were.
//
// Browser evidence (headless Chromium 141, VirtualList's own container/sizer/slab geometry replayed
// at the list's 72px row and a 640px viewport, 2026-08-03): with 100 chats and the reader scrolled to
// `scrollTop = 3000` the first visible row is #41. Typing a query that leaves 20 matches shrinks the
// scroll height to 1440, and the browser does the only thing it can — it CLAMPS scrollTop to the new
// maximum, 800. The list then opens at match #12 of 20: eleven of the reader's best matches sit above
// the top edge, with no hint that they exist. 12 matches land on match #4, 3 matches finally reach the
// top by accident. Nothing in the client ever asked for a position; every one of those numbers is a
// leftover offset trimmed to fit.
//
// That clamp is reproduced here, not stubbed away: the harness derives the scroll height from the
// sizer VirtualList maintains and clamps writes to it. Without it the first attempt at this fix — one
// that read the outgoing offset AFTER the new items were installed, i.e. after the clamp had already
// eaten it — passed every assertion below while a phone restored 800 instead of 2880.
//
// The same leftover governs the tab switch: «Архив», a list the reader has never scrolled, opens at
// whatever the clamp leaves of the offset from «Все».
//
// What the fix must NOT do is reset the position on every repaint: a chat list repaints whenever a
// message arrives, and a list that jumps to the top under an incoming message is worse than the bug.
// Hence the last two cases here — the offset moves when the VIEW changes, never when its CONTENT does.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createChatListScreen, type ChatListEventFeed } from "../src/screens/chat_list_screen.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const NOW = 1_700_000_000;
const ROW = 72;          // the classic shell's chat row, and VirtualList's item height here
const VIEWPORT = 640;    // a phone's list box
const DEEP = 2880;       // the reader is 40 rows down — a position they chose

const chat = (id: number, title: string, over: Partial<ChatEntry> = {}): ChatEntry => ({
  id,
  kind: "dialog",
  title,
  username: `peer${id}`,
  photo_file_id: null,
  last_message: { id: id * 10, sender_id: 2, kind: "text", text: `Сообщение ${id}`, created_at: NOW - id },
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: false,
  my_role: "member",
  message_ttl_sec: 0,
  draft: null,
  updated_at: NOW - id,
  ...over,
});

// 60 open chats — 50 of them noise, 10 matching «Ключ» — plus 5 archived ones so the other tab is a
// real list and not an empty state.
const CHATS: ChatEntry[] = [
  ...Array.from({ length: 50 }, (_, i) => chat(i + 1, `Коллега ${i + 1}`)),
  ...Array.from({ length: 10 }, (_, i) => chat(i + 51, `Ключевой партнёр ${i + 1}`)),
  ...Array.from({ length: 5 }, (_, i) => chat(i + 61, `Архивный ${i + 1}`, { archived: true })),
];
const UNREAD_ID = 3; // the row a live event will visibly change

class ListApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/badge")) {
      return Promise.resolve({ total_unread: 1, unread_chats: 1, mentions: 0 } as T);
    }
    return Promise.resolve(CHATS.map((c) => (c.id === UNREAD_ID ? { ...c, unread_count: 4 } : c)) as T);
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

interface Mounted {
  root: StubNode;
  list: StubNode;
  search: StubNode;
  tabs: StubNode[];
  emit: (evt: { type: string; payload: unknown }) => void;
  destroy(): void;
}

// VirtualList renders on scroll through requestAnimationFrame, which node does not have; the class
// falls back to a 16ms timer, so a rendered window costs one real wait.
const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

async function mount(): Promise<Mounted> {
  let handler: ((evt: { type: string; payload: unknown }) => void) | null = null;
  const events: ChatListEventFeed = {
    subscribe(fn) { handler = fn as typeof handler; return () => { handler = null; }; },
  };
  const screen = createChatListScreen({
    api: new ListApi(),
    i18n,
    events,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    self: { id: 1, name: "Владелец", username: "owner" },
    now: () => NOW,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  const list = root.findAll((n) => n.hasClass("gc-chat-list"))[0]!;
  // What a browser would have measured for a mounted list box; the stub cannot lay anything out.
  // The first paint happened before this line, i.e. against a box of zero height — exactly the boot
  // order of a real mount — so the window is drawn by the scroll below.
  list.clientHeight = VIEWPORT;
  list.dispatch("scroll");
  await frame();
  return {
    root,
    list,
    search: root.findAll((n) => n.hasClass("gc-chats-search-input"))[0]!,
    tabs: root.findAll((n) => n.hasClass("gc-tab")),
    emit: (evt) => handler?.(evt),
    destroy: () => screen.destroy(),
  };
}

const type = (m: Mounted, value: string): void => {
  m.search.value = value;
  m.search.dispatch("input");
};

// The reader scrolls: the offset moves and the list redraws its window, the way a finger does it.
const scrollTo = async (m: Mounted, offset: number): Promise<void> => {
  m.list.scrollTop = offset;
  m.list.dispatch("scroll");
  await frame();
};

test("V162: a filtered chat list opens at its first match, and clearing the filter restores the position", async () => {
  const m = await mount();
  assert.equal(m.list.style.display, "block", "the fixture really renders a populated list");
  await scrollTo(m, DEEP);

  type(m, "Ключ");
  // The result set is 10 rows = 720px, so the deep offset cannot survive in it whatever happens: the
  // question this test answers is whether what remains is the FIRST match or the clamp's leftover 80.
  assert.equal(m.list.scrollHeight, 10 * ROW, "the filtered list really is shorter than the viewport worth of scroll");
  assert.equal(
    m.list.scrollTop,
    0,
    "a result set the reader has never scrolled must start at its first match, not at a trimmed leftover offset",
  );

  type(m, "");
  assert.equal(
    m.list.scrollTop,
    DEEP,
    "leaving the search returns to the place in the list the reader had chosen",
  );
  m.destroy();
});

test("V162: each tab keeps its own place", async () => {
  const m = await mount();
  await scrollTo(m, DEEP);

  const archive = m.tabs.find((n) => n.textContent.includes(i18n.t("chat.tabArchived")))!;
  const all = m.tabs.find((n) => n.textContent.includes(i18n.t("chat.tabAll")))!;
  archive.dispatch("click");
  assert.equal(m.list.scrollTop, 0, "«Архив» is a list of its own; it opens at the top");

  all.dispatch("click");
  assert.equal(m.list.scrollTop, DEEP, "coming back to «Все» returns to where the reader was");
  m.destroy();
});

test("V162: an incoming update repaints the list without moving it", async () => {
  const m = await mount();
  await scrollTo(m, DEEP);

  // Proof that a repaint happened without depending on which rows the window holds: every repaint
  // builds fresh row nodes, so the node that was first before the event cannot still be first.
  const firstRow = (): StubNode | undefined => m.list.findAll((n) => n.hasClass("gc-chat-row"))[0];
  const before = firstRow();
  assert.ok(before, "the fixture really renders rows at this offset");
  m.emit({ type: "chat.read", payload: { chat_id: UNREAD_ID } });
  assert.notEqual(firstRow(), before, "the live event really repainted the list");
  assert.equal(m.list.scrollTop, DEEP, "a message arriving must never take the reader's place away");

  // Tapping the tab that is already selected is a repaint of the same view, not a new one.
  m.tabs.find((n) => n.textContent.includes(i18n.t("chat.tabAll")))!.dispatch("click");
  assert.equal(m.list.scrollTop, DEEP, "re-selecting the active tab is not a new view");
  m.destroy();
});
