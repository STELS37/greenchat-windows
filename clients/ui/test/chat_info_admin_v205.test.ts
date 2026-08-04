import test from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createChatInfoOverlay, type ChatInfoDetail } from "../src/screens/chat_info.ts";
import type { ChatMember } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

const members: ChatMember[] = [
  { id: 1, username: "owner", name: "Владелец", role: "owner" },
  {
    id: 2,
    username: "admin",
    name: "Администратор",
    role: "admin",
    custom_title: "Модератор",
    rights: {
      can_post: true,
      can_edit_chat: true,
      can_invite: true,
      can_pin: true,
      can_delete_others: true,
      can_manage_admins: false,
    },
  },
  { id: 3, username: "member", name: "Участник", role: "member" },
];

const detail: ChatInfoDetail = {
  kind: "group",
  title: "Команда",
  about: "Рабочая группа",
  members_count: 3,
  my_role: "owner",
  my_rights: {
    can_edit_chat: true,
    can_invite: true,
    can_delete_others: true,
    can_manage_admins: true,
  },
  join_mode: "open",
  slow_mode_sec: 0,
  history_for_new: "visible",
  noforwards: false,
};

function action(root: StubNode, name: string, userId?: number): StubNode {
  const found = root.find((node) => node.tag === "button"
    && node.attrs["data-action"] === name
    && (userId === undefined || node.attrs["data-user-id"] === String(userId)));
  assert.ok(found, `${name} was not rendered for ${userId ?? "screen"}: ${root.textContent}`);
  return found;
}

test("V205: owner edits real group settings without leaving the info sheet", async () => {
  const saves: Array<Record<string, unknown>> = [];
  const titles: string[] = [];
  const overlay = createChatInfoOverlay({
    i18n,
    title: "Команда",
    subtitle: "3 участника",
    kind: "group",
    peerId: null,
    members,
    selfId: 1,
    loadChat: async () => ({ ...detail }),
    loadUser: async () => ({}),
    saveGroup: async (payload) => {
      saves.push(payload);
      return { ...detail, ...payload };
    },
    onTitleChanged: (title) => titles.push(title),
  });
  try {
    await settle();
    const root = overlay.root as unknown as StubNode;
    assert.match(root.textContent, /Настройки группы/);
    const name = root.find((node) => node.tag === "input" && node.attrs["aria-label"] === i18n.t("chatInfo.groupTitle"));
    const about = root.find((node) => node.tag === "textarea" && node.attrs["aria-label"] === i18n.t("chatInfo.groupAbout"));
    const slow = root.find((node) => node.tag === "select" && node.attrs["aria-label"] === i18n.t("chatInfo.slowMode"));
    const join = root.find((node) => node.tag === "select" && node.attrs["aria-label"] === i18n.t("chatInfo.joinMode"));
    const history = root.find((node) => node.tag === "select" && node.attrs["aria-label"] === i18n.t("chatInfo.history"));
    assert.ok(name && about && slow && join && history);
    name.value = "Новая команда";
    about.value = "Обновлённое описание";
    slow.value = "30";
    join.value = "approve";
    history.value = "hidden";
    const form = root.find((node) => node.tag === "form" && node.hasClass("gc-info-group-settings"));
    assert.ok(form);
    form.dispatch("submit");
    await settle();
    assert.deepEqual(saves, [{
      title: "Новая команда",
      about: "Обновлённое описание",
      slow_mode_sec: 30,
      join_mode: "approve",
      history_for_new: "hidden",
      noforwards: false,
    }]);
    assert.deepEqual(titles, ["Новая команда"]);
    assert.match(root.textContent, /Сохранено/);
  } finally {
    overlay.close();
  }
});

test("V205: owner promotes, configures, demotes and removes members from the roster", async () => {
  const promoted: Array<{ userId: number; payload: unknown }> = [];
  const demoted: number[] = [];
  const removed: number[] = [];
  const overlay = createChatInfoOverlay({
    i18n,
    title: "Команда",
    subtitle: "3 участника",
    kind: "group",
    peerId: null,
    members,
    selfId: 1,
    loadChat: async () => ({ ...detail }),
    loadUser: async () => ({}),
    saveGroup: async () => ({ ...detail }),
    saveAdmin: async (userId, payload) => { promoted.push({ userId, payload }); },
    removeAdmin: async (userId) => { demoted.push(userId); },
    removeMember: async (userId) => { removed.push(userId); },
  });
  try {
    await settle();
    const root = overlay.root as unknown as StubNode;

    action(root, "manage-member", 3).dispatch("click");
    const title = root.find((node) => node.tag === "input" && node.attrs["aria-label"] === i18n.t("chatInfo.adminTitle"));
    assert.ok(title);
    title.value = "Помощник";
    action(root, "save-admin").dispatch("click");
    await settle();
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]?.userId, 3);
    assert.equal((promoted[0]?.payload as { custom_title?: string }).custom_title, "Помощник");
    assert.equal(Object.keys((promoted[0]?.payload as { rights: Record<string, boolean> }).rights).length, 6);

    action(root, "manage-member", 2).dispatch("click");
    action(root, "remove-admin").dispatch("click");
    await settle();
    assert.deepEqual(demoted, [2]);

    action(root, "manage-member", 3).dispatch("click");
    action(root, "remove-member").dispatch("click");
    await settle();
    assert.deepEqual(removed, [3]);
    assert.doesNotMatch(root.textContent, /@member/);
  } finally {
    overlay.close();
  }
});
