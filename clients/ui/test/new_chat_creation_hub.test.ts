import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createNewChatOverlay, type NewChannelInput, type NewGroupInput } from "../src/screens/new_chat_overlay.ts";
import type { ApiLike, DialogChat, GlobalSearchResult, SearchUser } from "../src/screens/api.ts";
import { createChatListScreen } from "../src/screens/chat_list_screen.ts";
import type { ContactRow } from "../src/screens/contacts_model.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import { installDomStub, settle, StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
const self = { id: 1, name: "Владелец", username: "owner" };
const ann: SearchUser = { id: 2, name: "Анна", username: "anna", avatar_file_id: null, is_bot: false };
const annContact: ContactRow = { ...ann, alias: "Анна из контактов" };

const chat = (id: number, kind: "dialog" | "group" | "channel", title: string): DialogChat => ({
  id,
  kind,
  title,
  username: null,
  my_role: "owner",
  message_ttl_sec: 0,
  updated_at: 1_700_000_000,
});

interface HubRig {
  root: StubNode;
  overlay: ReturnType<typeof createNewChatOverlay>;
  runTimers(): void;
  groups: NewGroupInput[];
  channels: NewChannelInput[];
  memberAdds: Array<{ chatId: number; userIds: number[] }>;
  opened: number[];
  created: number[];
  botOpens: number;
}

function mount(): HubRig {
  installDomStub();
  const host = new StubNode("body");
  let timers: Array<() => void> = [];
  const groups: NewGroupInput[] = [];
  const channels: NewChannelInput[] = [];
  const memberAdds: Array<{ chatId: number; userIds: number[] }> = [];
  const opened: number[] = [];
  const created: number[] = [];
  let botOpens = 0;
  const result: GlobalSearchResult = { users: [ann], chats: [], messages: [] };
  const overlay = createNewChatOverlay({
    i18n,
    self,
    search: () => Promise.resolve(result),
    listContacts: () => Promise.resolve([annContact]),
    createDialog: () => Promise.resolve(chat(10, "dialog", "Анна")),
    createGroup: (input) => {
      groups.push(input);
      return Promise.resolve(chat(20, "group", input.title));
    },
    createChannel: (input) => {
      channels.push(input);
      return Promise.resolve(chat(30 + channels.length, "channel", input.title));
    },
    addMembers: (chatId, userIds) => {
      memberAdds.push({ chatId, userIds });
      return Promise.resolve(chat(chatId, "channel", "Рассылка"));
    },
    onCreateBot: () => { botOpens += 1; },
    onOpenChat: (id) => opened.push(id),
    onCreated: (createdChat) => created.push(createdChat.id),
    setTimer: (fn) => { timers.push(fn); return fn; },
    clearTimer: (handle) => { timers = timers.filter((fn) => fn !== handle); },
    debounceMs: 1,
  });
  host.append(overlay.root as unknown as StubNode);
  return {
    root: overlay.root as unknown as StubNode,
    overlay,
    runTimers() {
      const pending = timers;
      timers = [];
      for (const fn of pending) fn();
    },
    groups,
    channels,
    memberAdds,
    opened,
    created,
    get botOpens() { return botOpens; },
  };
}

function action(root: StubNode, name: string): StubNode {
  const node = root.querySelector(`.gc-new-chat-action[data-action="${name}"]`);
  assert.ok(node, `action ${name} exists`);
  return node;
}

async function selectAnn(rig: HubRig): Promise<void> {
  await settle();
  const row = rig.root.querySelector('.gc-new-chat-member-row[data-user-id="2"]');
  assert.ok(row, "contact is selectable without typing a search query");
  assert.match(row.textContent, /Анна из контактов/, "the owner's contact alias is preserved");
  row.dispatch("click");
}

function setName(root: StubNode, value: string): void {
  const input = root.querySelector(".gc-new-chat-name");
  assert.ok(input);
  input.value = value;
}

function submit(root: StubNode): void {
  const form = root.querySelector(".gc-new-chat-form");
  assert.ok(form);
  form.dispatch("submit");
}

test("creation hub presents direct message, group, broadcast, channel and bot without hiding people search", () => {
  const rig = mount();
  assert.deepEqual(
    rig.root.querySelectorAll(".gc-new-chat-action").map((node) => node.getAttribute("data-action")),
    ["direct", "group", "broadcast", "channel", "bot"],
  );
  assert.ok(rig.root.querySelector(".gc-new-chat-search-input"), "people search remains on the first screen");
  assert.match(rig.root.textContent, /Сохранённые сообщения|Избранное/);
  rig.overlay.close();
});

test("opening the hub does not raise the mobile keyboard until direct-message search is chosen", () => {
  const rig = mount();
  rig.overlay.focus();
  const doc = (globalThis as unknown as { document: { activeElement: unknown } }).document;
  assert.equal(doc.activeElement, rig.root, "the dialog receives focus without focusing a text field");
  const search = rig.root.querySelector(".gc-new-chat-search-input");
  assert.ok(search);
  action(rig.root, "direct").dispatch("click");
  assert.equal(doc.activeElement, search, "direct-message action intentionally opens the search keyboard");
  rig.overlay.close();
});

test("group, broadcast and channel show address-book contacts before any search", async () => {
  for (const target of ["group", "broadcast", "channel"] as const) {
    const rig = mount();
    action(rig.root, target).dispatch("click");
    await settle();
    const row = rig.root.querySelector('.gc-new-chat-member-row[data-user-id="2"]');
    assert.ok(row, `${target} shows contacts immediately`);
    assert.match(row.textContent, /Анна из контактов/);
    assert.match(rig.root.querySelector(".gc-new-chat-member-status")?.textContent ?? "", /1/);
    rig.overlay.close();
  }
});

test("directory search merges with contacts without duplicating the same person", async () => {
  const rig = mount();
  action(rig.root, "group").dispatch("click");
  await settle();
  const search = rig.root.querySelector(".gc-new-chat-member-search");
  assert.ok(search);
  search.value = "ан";
  search.dispatch("input");
  rig.runTimers();
  await settle();
  assert.equal(rig.root.querySelectorAll('.gc-new-chat-member-row[data-user-id="2"]').length, 1);
  assert.match(rig.root.querySelector('.gc-new-chat-member-row[data-user-id="2"]')?.textContent ?? "", /Анна из контактов/);
  rig.overlay.close();
});

test("group flow selects people, creates atomically, adds the list row and opens the chat", async () => {
  const rig = mount();
  action(rig.root, "group").dispatch("click");
  await settle();
  setName(rig.root, "Команда проекта");
  await selectAnn(rig);
  submit(rig.root);
  await settle();

  assert.deepEqual(rig.groups, [{ title: "Команда проекта", about: "", memberIds: [2] }]);
  assert.deepEqual(rig.created, [20]);
  assert.deepEqual(rig.opened, [20]);
  assert.equal(rig.root.parent, null, "successful creation closes the sheet");
});

test("channel flow makes visibility explicit and sends a normalized public username", async () => {
  const rig = mount();
  action(rig.root, "channel").dispatch("click");
  await settle();
  setName(rig.root, "GreenChat Новости");
  await selectAnn(rig);
  const publicChoice = rig.root.querySelectorAll(".gc-new-chat-choice")[1];
  assert.ok(publicChoice);
  publicChoice.dispatch("click");
  const username = rig.root.querySelector(".gc-new-chat-username");
  assert.ok(username);
  username.value = "@greenchat_news";
  submit(rig.root);
  await settle();

  assert.deepEqual(rig.channels, [{
    title: "GreenChat Новости", about: "", username: "greenchat_news", joinMode: "open",
  }]);
  assert.deepEqual(rig.opened, [31]);

  assert.deepEqual(rig.memberAdds, [{ chatId: 31, userIds: [2] }], "selected contacts are enrolled in the channel");
});

test("broadcast flow creates a private channel and enrolls selected recipients before opening", async () => {
  const rig = mount();
  action(rig.root, "broadcast").dispatch("click");
  await settle();
  setName(rig.root, "Новости компании");
  await selectAnn(rig);
  submit(rig.root);
  await settle();

  assert.deepEqual(rig.channels, [{
    title: "Новости компании", about: "", username: null, joinMode: "approve",
  }]);
  assert.deepEqual(rig.memberAdds, [{ chatId: 31, userIds: [2] }]);
  assert.deepEqual(rig.created, [31], "the created broadcast becomes visible immediately");
  assert.deepEqual(rig.opened, [31]);
});

test("bot action closes the sheet and hands control to Bot Center", () => {
  const rig = mount();
  action(rig.root, "bot").dispatch("click");
  assert.equal(rig.botOpens, 1);
  assert.equal(rig.root.parent, null);
});

test("Escape inside a sub-flow returns to the creation hub before it dismisses the sheet", async () => {
  const rig = mount();
  action(rig.root, "group").dispatch("click");
  await settle();
  assert.ok(rig.root.querySelector(".gc-new-chat-form"));
  rig.root.dispatch("keydown", { key: "Escape" });
  assert.ok(rig.root.parent, "first Escape keeps the sheet open");
  assert.ok(rig.root.querySelector('.gc-new-chat-action[data-action="group"]'));
  rig.root.dispatch("keydown", { key: "Escape" });
  assert.equal(rig.root.parent, null, "second Escape closes the hub");
});


const recentDialog: ChatEntry = {
  id: 90,
  kind: "dialog",
  title: ann.name,
  username: ann.username,
  photo_file_id: null,
  peer_is_bot: false,
  peer_user_id: ann.id,
  last_message: null,
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: false,
  my_role: "member",
  message_ttl_sec: 0,
  draft: null,
  updated_at: 1_700_000_000,
};

class HubWiringApi implements ApiLike {
  readonly posts: Array<{ path: string; body: unknown }> = [];
  readonly gets: string[] = [];
  private readonly contacts: ContactRow[];
  private readonly chats: ChatEntry[];
  constructor(contacts: ContactRow[] = [annContact], chats: ChatEntry[] = []) {
    this.contacts = contacts;
    this.chats = chats;
  }
  get<T>(path: string): Promise<T> {
    this.gets.push(path);
    if (path.startsWith("/v1/badge")) return Promise.resolve({ total_unread: 0, unread_chats: 0, mentions: 0 } as T);
    if (path === "/v1/contacts") return Promise.resolve(this.contacts as T);
    if (path === "/v1/chats?filter=all") return Promise.resolve(this.chats as T);
    return Promise.resolve([] as unknown as T);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    this.posts.push({ path, body });
    return Promise.resolve(chat(77, "group", "Команда") as T);
  }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
  searchGlobal(): Promise<GlobalSearchResult> { return Promise.resolve({ users: [], chats: [], messages: [] }); }
  createDialog(): Promise<DialogChat> { return Promise.resolve(chat(10, "dialog", "Диалог")); }
}

test("chat-list + button wires group creation to the real API endpoint and opens the result", async () => {
  installDomStub();
  const api = new HubWiringApi();
  const opened: number[] = [];
  const screen = createChatListScreen({
    api,
    i18n,
    self,
    onOpenChat: (id) => opened.push(id),
    onOpenSettings: () => {},
    onLogout: () => {},
    now: () => 1_700_000_100,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  const start = root.findAll((node) => node.hasClass("gc-btn-accent"))
    .find((node) => node.textContent.includes(i18n.t("chatList.startFirst")));
  assert.ok(start);
  start.dispatch("click");
  const group = root.querySelector('.gc-new-chat-action[data-action="group"]');
  assert.ok(group);
  group.dispatch("click");
  await settle();
  assert.ok(root.querySelector('.gc-new-chat-member-row[data-user-id="2"]'), "the wired overlay loads /v1/contacts");
  setName(root, "Команда");
  submit(root);
  await settle();

  assert.deepEqual(api.posts, [{
    path: "/v1/chats/group",
    body: { title: "Команда", about: "", member_ids: [] },
  }]);
  assert.ok(api.gets.includes("/v1/contacts"));
  assert.deepEqual(opened, [77]);
  screen.destroy();
});

test("chat-list participant picker supplements an empty address book with recent dialog peers", async () => {
  installDomStub();
  const api = new HubWiringApi([], [recentDialog]);
  const screen = createChatListScreen({
    api,
    i18n,
    self,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    now: () => 1_700_000_100,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  const fab = root.querySelector(".gc-fab");
  assert.ok(fab, "a populated chat list exposes the new-chat action");
  fab.dispatch("click");
  action(root, "group").dispatch("click");
  await settle();

  const row = root.querySelector('.gc-new-chat-member-row[data-user-id="2"]');
  assert.ok(row, "the recent dialog peer appears without typing even when /v1/contacts is empty");
  assert.match(row.textContent, /Анна/);
  assert.ok(api.gets.includes("/v1/contacts"), "the explicit address book is still loaded and merged");
  screen.destroy();
});
