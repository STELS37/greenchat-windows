import test from "node:test";
import assert from "node:assert/strict";

import {
  IDLE_CONFERENCE_STATE,
  type ConferenceController,
  type ConferenceState,
} from "../src/screens/conference_model.ts";
import type { ChatMember } from "../src/screens/types.ts";
import { createConferenceOverlay } from "../../web/src/conference_overlay.ts";
import { installDomStub, settle, StubNode } from "./dom_stub.ts";

installDomStub();

const controller = {
  setMuted: () => {}, setCameraOn: () => {}, startScreenShare: async () => {},
  stopScreenShare: async () => {}, raiseHand: async () => {}, leave: async () => {},
  dismiss: () => {}, endConference: async () => {}, changeParticipantRole: async () => {},
  removeParticipant: async () => {}, resumeAudio: async () => {},
  deviceSnapshot: async () => ({
    devices: [],
    selected: { audiooutput: "", audioinput: "", videoinput: "" },
    outputSelectionSupported: false,
    labelsHidden: false,
  }),
  selectDevice: async () => ({
    devices: [],
    selected: { audiooutput: "", audioinput: "", videoinput: "" },
    outputSelectionSupported: false,
    labelsHidden: false,
  }),
  subscribeDevices: () => () => {},
} as unknown as ConferenceController;

class InviteApi {
  posts: Array<{ path: string; body: unknown }> = [];
  private readonly members: ChatMember[] = [
    { id: 1, username: "owner", name: "Иван", avatar_file_id: 101 },
    { id: 2, username: "bob", name: "Борис", avatar_file_id: 102 },
    { id: 3, username: "carol", name: "Карина", avatar_file_id: 103 },
    { id: 4, username: "dave", name: "Денис", avatar_file_id: 104 },
    { id: 5, username: "erin", name: "Елена", avatar_file_id: 105 },
    { id: 6, username: "frank", name: "Фёдор", avatar_file_id: 106 },
    { id: 7, username: "helper_bot", name: "Бот-помощник", is_bot: true, avatar_file_id: 107 },
  ];

  get<T>(path: string): Promise<T> {
    const profile = path.match(/^\/v1\/users\/(\d+)$/);
    if (profile) {
      const member = this.members.find((row) => row.id === Number(profile[1]));
      if (!member) return Promise.reject(new Error("profile not found"));
      return Promise.resolve(member as T);
    }
    if (path === "/v1/chats/8/members?limit=50") return Promise.resolve(this.members as T);
    const file = path.match(/^\/v1\/files\/(\d+)\/url$/);
    if (file) return Promise.resolve({ url: `https://cdn.test/avatar-${file[1]}.jpg`, expires_at: 9999999999 } as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    this.posts.push({ path, body });
    return Promise.resolve({
      invited_user_ids: [3, 4, 5],
      expires_at: Math.floor(Date.now() / 1000) + 120,
      available_slots: 0,
      max_participants: 5,
    } as T);
  }
}

const activeState = (): ConferenceState => ({
  ...IDLE_CONFERENCE_STATE,
  phase: "active",
  conferenceId: "11111111-1111-1111-1111-111111111111",
  chatId: 8,
  mode: "conversation",
  role: "owner",
  video: true,
  muted: false,
  cameraOn: false,
  connectedAt: Date.now(),
  participants: [
    { userId: 1, role: "owner", moderator: true, joinedAt: 1, handRaised: false },
    { userId: 2, role: "speaker", moderator: false, joinedAt: 2, handRaised: false },
  ],
});

test("the conference picker filters bots/current participants, caps selection and renders profile avatars", async () => {
  const document = globalThis.document as unknown as { body: StubNode };
  document.body = new StubNode("body");
  const api = new InviteApi();
  const overlay = createConferenceOverlay({ controller, locale: "ru", selfUserId: 1, title: "Команда", api });
  const root = overlay.root as unknown as StubNode;
  document.body.append(root);
  overlay.render(activeState());
  await settle();
  await settle();
  await settle();

  assert.match(root.textContent, /Иван/);
  assert.match(root.textContent, /Борис/);
  const avatarImages = root.findAll((node) => node.tag === "img" && node.hasClass("gc-avatar-photo"));
  assert.ok(avatarImages.length >= 2, "real signed profile images replace initials in participant tiles");
  assert.ok(avatarImages.some((node) => String(node.attrs.src).includes("avatar-101")));

  const trigger = root.find((node) => node.tag === "button" && node.hasClass("gc-conference-invite-trigger"));
  assert.ok(trigger);
  assert.equal(trigger.attrs.hidden, undefined);
  trigger.click();
  await settle();
  await settle();

  const sheet = root.find((node) => node.hasClass("gc-conference-invite-sheet"));
  assert.ok(sheet, "the picker opens inside the active call");
  assert.doesNotMatch(sheet.textContent, /Бот-помощник/, "bots are never offered as call participants");
  assert.doesNotMatch(sheet.textContent, /Борис/, "people already in the call are not offered again");
  for (const name of ["Карина", "Денис", "Елена", "Фёдор"]) assert.match(sheet.textContent, new RegExp(name));

  const boxes = sheet.findAll((node) => node.tag === "input" && node.hasClass("gc-conference-invite-checkbox"));
  assert.equal(boxes.length, 4);
  for (const box of boxes) {
    box.checked = true;
    box.dispatch("change", {});
  }
  assert.equal(boxes[3]!.checked, false, "only the three remaining seats can be selected");
  assert.match(sheet.textContent, /уже 5 участников/i);

  const submit = sheet.find((node) => node.tag === "button" && node.hasClass("gc-conference-invite-submit"));
  assert.ok(submit);
  submit.dispatch("click", {});
  await settle();
  await settle();
  assert.deepEqual(api.posts, [{
    path: "/v1/conferences/11111111-1111-1111-1111-111111111111/invites",
    body: { user_ids: [3, 4, 5] },
  }]);
  assert.match(sheet.textContent, /Приглашения отправлены/);
  assert.equal(trigger.disabled, true, "the add button becomes unavailable when all five places are occupied or reserved");

  overlay.destroy();
});
