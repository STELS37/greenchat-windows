import test from "node:test";
import assert from "node:assert/strict";

import {
  IDLE_CONFERENCE_STATE,
  type ConferenceController,
  type ConferenceState,
} from "../src/screens/conference_model.ts";
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

class AvatarApi {
  signedUrlReads = 0;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/users/1") {
      return Promise.resolve({
        id: 1,
        username: "ivan",
        name: "Иван",
        avatar_file_id: 501,
      } as T);
    }
    if (path === "/v1/files/501/url") {
      this.signedUrlReads += 1;
      return Promise.resolve({
        url: "https://cdn.test/avatar-501.jpg",
        expires_at: 9999999999,
      } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected POST"));
  }
}

const activeState = (speaking: boolean): ConferenceState => ({
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
  activeSpeakerId: speaking ? 1 : null,
  participants: [{
    userId: 1,
    role: "owner",
    moderator: true,
    joinedAt: 1,
    handRaised: false,
    muted: false,
    speaking,
  }],
});

test("V200: active-speaker updates keep the same loaded avatar nodes", async () => {
  const document = globalThis.document as unknown as { body: StubNode };
  document.body = new StubNode("body");
  const api = new AvatarApi();
  const overlay = createConferenceOverlay({
    controller,
    locale: "ru",
    selfUserId: 1,
    title: "Команда",
    api,
  });
  const root = overlay.root as unknown as StubNode;
  document.body.append(root);

  overlay.render(activeState(false));
  await settle();
  await settle();
  await settle();

  const stageAvatarBefore = root.find((node) => node.hasClass("gc-conference-avatar"));
  const listAvatarBefore = root.find((node) => node.hasClass("gc-conference-person-avatar"));
  assert.ok(stageAvatarBefore);
  assert.ok(listAvatarBefore);
  const stageImageBefore = stageAvatarBefore.find((node) => node.tag === "img" && node.hasClass("gc-avatar-photo"));
  const listImageBefore = listAvatarBefore.find((node) => node.tag === "img" && node.hasClass("gc-avatar-photo"));
  assert.ok(stageImageBefore);
  assert.ok(listImageBefore);
  const readsAfterLoad = api.signedUrlReads;
  assert.equal(readsAfterLoad, 1, "stage and participant list share one signed-URL lookup for the same immutable file id");

  overlay.render(activeState(true));
  await settle();

  const stageAvatarSpeaking = root.find((node) => node.hasClass("gc-conference-avatar"));
  const listAvatarSpeaking = root.find((node) => node.hasClass("gc-conference-person-avatar"));
  assert.strictEqual(stageAvatarSpeaking, stageAvatarBefore, "speaking reuses the stage avatar element");
  assert.strictEqual(listAvatarSpeaking, listAvatarBefore, "speaking reuses the sidebar avatar element");
  assert.strictEqual(
    stageAvatarSpeaking?.find((node) => node.tag === "img" && node.hasClass("gc-avatar-photo")),
    stageImageBefore,
    "the already decoded stage image is not removed and re-created",
  );
  assert.strictEqual(
    listAvatarSpeaking?.find((node) => node.tag === "img" && node.hasClass("gc-avatar-photo")),
    listImageBefore,
    "the already decoded sidebar image is not removed and re-created",
  );
  assert.equal(api.signedUrlReads, readsAfterLoad, "active-speaker frames do not request a new signed avatar URL");
  assert.equal(
    root.find((node) => node.hasClass("gc-conference-tile") && node.attrs["data-user-id"] === "1")?.hasClass("is-speaking"),
    true,
  );
  assert.equal(
    root.find((node) => node.hasClass("gc-conference-person") && node.attrs["data-user-id"] === "1")?.hasClass("is-speaking"),
    true,
  );

  overlay.render(activeState(false));
  await settle();
  assert.strictEqual(root.find((node) => node.hasClass("gc-conference-avatar")), stageAvatarBefore);
  assert.strictEqual(root.find((node) => node.hasClass("gc-conference-person-avatar")), listAvatarBefore);
  assert.equal(api.signedUrlReads, readsAfterLoad);

  overlay.destroy();
});
