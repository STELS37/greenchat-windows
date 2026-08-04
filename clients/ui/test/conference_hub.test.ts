import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  canStartConference,
  createConferenceHub,
  parseConferenceList,
} from "../src/screens/conference_hub.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
const ROOM = "11111111-1111-4111-8111-111111111111";

const chat = (id: number, kind: ChatEntry["kind"], role: ChatEntry["my_role"]): ChatEntry => ({
  id,
  kind,
  title: `Чат ${id}`,
  username: null,
  photo_file_id: null,
  last_message: null,
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: false,
  my_role: role,
  message_ttl_sec: 0,
  draft: null,
  updated_at: 0,
});

class HubApi implements ApiLike {
  rooms: unknown[];
  gets = 0;
  constructor(rooms: unknown[]) { this.rooms = rooms; }
  get<T>(path: string): Promise<T> {
    assert.equal(path, "/v1/conferences");
    this.gets += 1;
    return Promise.resolve({ enabled: true, items: this.rooms } as T);
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unused POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const byClass = (root: StubNode, name: string): StubNode[] => root.findAll((node) => node.hasClass(name));

const buttonsWith = (root: StubNode, text: string): StubNode[] =>
  root.findAll((node) => node.tag === "button" && node.textContent.includes(text));

test("V178: conference list parsing is fail-closed, normalized and newest-first", () => {
  assert.deepEqual(parseConferenceList({ items: [
    { id: "bad", chat_id: 1, created_at: 99 },
    { id: ROOM, chat_id: 7, mode: "unexpected", video: true, created_at: 20, participants: [{}, {}] },
    { id: "22222222-2222-4222-8222-222222222222", chat_id: 8, mode: "stage", video: false, created_at: 30 },
    { id: "33333333-3333-4333-8333-333333333333", chat_id: 0, created_at: 40 },
  ] }), [
    { id: "22222222-2222-4222-8222-222222222222", chatId: 8, mode: "stage", video: false, createdAt: 30, participantCount: 0 },
    { id: ROOM, chatId: 7, mode: "conversation", video: true, createdAt: 20, participantCount: 2 },
  ]);
});

test("V178: only group/channel owners and admins are offered room creation", () => {
  assert.equal(canStartConference(chat(1, "dialog", "owner")), false);
  assert.equal(canStartConference(chat(2, "group", "member")), false);
  assert.equal(canStartConference(chat(3, "group", "admin")), true);
  assert.equal(canStartConference(chat(4, "channel", "owner")), true);
});

test("V178: active conference joins and owner start actions reach the shell exactly once", async () => {
  const api = new HubApi([{ id: ROOM, chat_id: 10, mode: "conversation", video: true, created_at: 7, participants: [{}] }]);
  const joined: Array<[string, boolean]> = [];
  const created: Array<[number, boolean]> = [];
  const hub = createConferenceHub({
    api,
    i18n,
    onJoin: (id, video) => { joined.push([id, video]); },
    onCreate: (id, video) => { created.push([id, video]); },
  });
  hub.setChats([
    chat(10, "group", "member"),
    chat(20, "group", "owner"),
    chat(30, "channel", "admin"),
    chat(40, "group", "member"),
  ]);
  await settle();
  const root = hub.root as unknown as StubNode;
  assert.equal(byClass(root, "gc-conference-row").length, 1);
  assert.equal(byClass(root, "gc-conference-start-row").length, 2, "member groups must not get a create action");

  buttonsWith(root, "Войти")[0]!.dispatch("click");
  await settle();
  assert.deepEqual(joined, [[ROOM, true]]);

  const videoButtons = buttonsWith(root, "Видео");
  videoButtons[0]!.dispatch("click");
  await settle();
  assert.deepEqual(created, [[20, true]]);
  assert.ok(api.gets >= 3, "successful actions refresh the active-room catalogue");
  hub.destroy();
});

test("V178: an API failure never invents an empty catalogue and remains retryable", async () => {
  class FailingApi extends HubApi {
    override get<T>(): Promise<T> { this.gets += 1; return Promise.reject(new Error("offline")); }
  }
  const api = new FailingApi([]);
  const hub = createConferenceHub({ api, i18n, onJoin: () => {}, onCreate: () => {} });
  await settle();
  const root = hub.root as unknown as StubNode;
  assert.ok(root.textContent.includes("Не удалось"));
  buttonsWith(root, "Повторить")[0]!.dispatch("click");
  await settle();
  assert.equal(api.gets, 2);
  hub.destroy();
});


test("V178: a disabled media plane is explicit and exposes no dead join/create controls", async () => {
  class DisabledApi extends HubApi {
    override get<T>(path: string): Promise<T> {
      assert.equal(path, "/v1/conferences");
      this.gets += 1;
      return Promise.resolve({ enabled: false, items: [] } as T);
    }
  }
  const hub = createConferenceHub({ api: new DisabledApi([]), i18n, onJoin: () => {}, onCreate: () => {} });
  hub.setChats([chat(20, "group", "owner")]);
  await settle();
  const root = hub.root as unknown as StubNode;
  assert.equal(byClass(root, "gc-conference-disabled").length, 1);
  assert.equal(byClass(root, "gc-conference-action").length, 0);
  assert.ok(root.textContent.includes("не включены"));
  hub.destroy();
});
