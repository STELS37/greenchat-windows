import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { avatarText } from "../src/screens/avatar_media.ts";
import { createChatInfoOverlay } from "../src/screens/chat_info.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

test("private-channel owner can approve a pending request directly in chat info", async () => {
  installDomStub();
  const approved: number[] = [];
  const denied: number[] = [];
  const sheet = createChatInfoOverlay({
    i18n,
    title: "Закрытый канал",
    subtitle: "1 подписчик",
    kind: "channel",
    peerId: null,
    members: [{ id: 1, username: "owner", name: "Владелец", role: "owner" }],
    loadChat: async () => ({
      kind: "channel",
      title: "Закрытый канал",
      username: null,
      join_mode: "approve",
      my_role: "owner",
      my_rights: { can_invite: true, can_edit_chat: true },
      members_count: 1,
    }),
    loadUser: async () => ({}),
    loadJoinRequests: async () => [{
      id: 42,
      username: "applicant",
      name: "Заявитель",
      avatar_file_id: null,
      requested_at: 1_700_000_000,
    }],
    approveJoinRequest: async (id) => { approved.push(id); },
    denyJoinRequest: async (id) => { denied.push(id); },
  });
  await settle();
  await settle();
  const root = sheet.root as unknown as StubNode;
  const requestRows = root.findAll((node) => node.hasClass("gc-info-request"));
  assert.equal(requestRows.length, 1);
  assert.match(root.textContent, /Заявитель/);

  const approve = root.findAll((node) => node.tag === "button")
    .find((node) => node.textContent === avatarText("ru", "approve"));
  assert.ok(approve);
  approve.dispatch("click");
  await settle();

  assert.deepEqual(approved, [42]);
  assert.deepEqual(denied, []);
  assert.equal(root.findAll((node) => node.hasClass("gc-info-request")).length, 0);
  assert.match(root.textContent, new RegExp(avatarText("ru", "empty")));
  sheet.close();
});

test("ordinary channel members never receive moderation controls", async () => {
  installDomStub();
  let loads = 0;
  const sheet = createChatInfoOverlay({
    i18n,
    title: "Закрытый канал",
    subtitle: "канал",
    kind: "channel",
    peerId: null,
    members: [],
    loadChat: async () => ({ join_mode: "approve", my_role: "member", my_rights: {} }),
    loadUser: async () => ({}),
    loadJoinRequests: async () => { loads += 1; return []; },
    approveJoinRequest: async () => {},
    denyJoinRequest: async () => {},
  });
  await settle();
  assert.equal(loads, 0);
  assert.equal((sheet.root as unknown as StubNode).findAll((node) => node.hasClass("gc-info-requests")).length, 1);
  assert.doesNotMatch((sheet.root as unknown as StubNode).textContent, /Заявки на вступление/);
  sheet.close();
});
