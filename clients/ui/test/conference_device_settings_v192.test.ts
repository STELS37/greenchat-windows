import test from "node:test";
import assert from "node:assert/strict";

import {
  ConferenceController,
  IDLE_CONFERENCE_STATE,
  type ConferenceMediaSession,
  type ConferenceState,
} from "../src/screens/conference_model.ts";
import type {
  CallDeviceSnapshot,
  CallMediaDeviceKind,
} from "../src/screens/call_model.ts";
import { createConferenceOverlay } from "../../web/src/conference_overlay.ts";
import { createBrowserConferenceDevices } from "../../web/src/conference_devices.ts";
import { installDomStub, settle, StubNode } from "./dom_stub.ts";

const SNAPSHOT: CallDeviceSnapshot = {
  devices: [
    { kind: "audiooutput", deviceId: "out-a", groupId: "desk", label: "Studio Speakers" },
    { kind: "audiooutput", deviceId: "out-b", groupId: "headset", label: "USB Headset" },
    { kind: "audioinput", deviceId: "mic-a", groupId: "desk", label: "Web Camera Mic" },
    { kind: "audioinput", deviceId: "mic-b", groupId: "headset", label: "USB Headset Mic" },
    { kind: "videoinput", deviceId: "cam-a", groupId: "desk", label: "Web Camera" },
  ],
  selected: { audiooutput: "out-a", audioinput: "mic-a", videoinput: "cam-a" },
  outputSelectionSupported: true,
  labelsHidden: false,
};

function apiStub() {
  return {
    join: async () => { throw new Error("not needed"); },
    screenShareGrant: async () => { throw new Error("not needed"); },
    leave: async () => {},
    raiseHand: async () => {},
    changeRole: async () => {},
    removeParticipant: async () => {},
    end: async () => {},
  };
}

test("V192: ConferenceController delegates device settings and releases the media router", async () => {
  const selected: Array<[CallMediaDeviceKind, string]> = [];
  let subscribed = 0;
  let unsubscribed = 0;
  let destroyed = 0;
  const controller = new ConferenceController({
    api: apiStub(),
    media: {
      devices: {
        snapshot: async () => SNAPSHOT,
        select: async (kind, id) => { selected.push([kind, id]); return SNAPSHOT; },
        subscribe: () => { subscribed += 1; return () => { unsubscribed += 1; }; },
      },
      destroy: () => { destroyed += 1; },
      async open(): Promise<ConferenceMediaSession> { throw new Error("not needed"); },
    },
    selfUserId: 1,
    onState: () => {},
  });

  assert.deepEqual(await controller.deviceSnapshot(), SNAPSHOT);
  assert.deepEqual(await controller.selectDevice("audioinput", "mic-b"), SNAPSHOT);
  assert.deepEqual(selected, [["audioinput", "mic-b"]]);
  const off = controller.subscribeDevices(() => {});
  assert.equal(subscribed, 1);
  off();
  assert.equal(unsubscribed, 1);
  controller.destroy();
  assert.equal(destroyed, 1);
});

test("V192: group video calls expose output, microphone and camera settings", async () => {
  installDomStub();
  const document = globalThis.document as unknown as { body: StubNode };
  document.body = new StubNode("body");
  const selected: Array<[CallMediaDeviceKind, string]> = [];
  let subscribed = 0;
  let unsubscribed = 0;
  const controller = {
    setMuted: () => {}, setCameraOn: () => {}, startScreenShare: async () => {},
    stopScreenShare: async () => {}, raiseHand: async () => {}, leave: async () => {},
    dismiss: () => {}, endConference: async () => {}, changeParticipantRole: async () => {},
    removeParticipant: async () => {}, resumeAudio: async () => {},
    deviceSnapshot: async () => SNAPSHOT,
    selectDevice: async (kind: CallMediaDeviceKind, id: string) => {
      selected.push([kind, id]);
      return { ...SNAPSHOT, selected: { ...SNAPSHOT.selected, [kind]: id } };
    },
    subscribeDevices: () => { subscribed += 1; return () => { unsubscribed += 1; }; },
  } as unknown as ConferenceController;
  const overlay = createConferenceOverlay({ controller, locale: "ru", selfUserId: 1, title: "Команда" });
  const root = overlay.root as unknown as StubNode;
  document.body.append(root);
  const active: ConferenceState = {
    ...IDLE_CONFERENCE_STATE,
    phase: "active",
    conferenceId: "conf-1",
    chatId: 8,
    mode: "conversation",
    role: "owner",
    video: true,
    muted: false,
    cameraOn: true,
    connectedAt: Date.now(),
    participants: [{ userId: 1, role: "owner", moderator: true, joinedAt: 1, handRaised: false }],
  };
  overlay.render(active);

  const trigger = root.findAll((node) => node.hasClass("gc-conference-settings-trigger"))[0];
  assert.ok(trigger, "the group call has a settings trigger");
  trigger.click();
  await settle();

  const sheet = root.findAll((node) => node.hasClass("gc-call-settings"))[0];
  assert.ok(sheet, "the device sheet opens inside the conference");
  assert.match(sheet.textContent, /Настройки звонка/);
  const rows = sheet.findAll((node) => node.hasClass("gc-call-device-row"));
  assert.deepEqual(rows.map((row) => row.attrs["data-kind"]), ["audiooutput", "audioinput", "videoinput"]);
  assert.match(sheet.textContent, /Studio Speakers/);
  assert.match(sheet.textContent, /Web Camera Mic/);
  assert.match(sheet.textContent, /Web Camera/);
  assert.equal(subscribed, 1);

  const mic = sheet.findAll((node) => node.tag === "select" && node.attrs["data-kind"] === "audioinput")[0];
  assert.ok(mic);
  mic.value = "mic-b";
  mic.dispatch("change", {});
  await settle();
  assert.deepEqual(selected, [["audioinput", "mic-b"]]);

  const close = sheet.findAll((node) => node.hasClass("gc-call-settings-close"))[0];
  assert.ok(close);
  close.click();
  assert.equal(root.findAll((node) => node.hasClass("gc-call-settings-layer")).length, 0);
  assert.equal(unsubscribed, 1);
  overlay.destroy();
});

test("V192: LiveKit conference device router applies, persists and restores shared choices", async () => {
  const listed = [
    { kind: "audiooutput", deviceId: "out-a", groupId: "a", label: "Speakers" },
    { kind: "audiooutput", deviceId: "out-b", groupId: "b", label: "Headset" },
    { kind: "audioinput", deviceId: "mic-a", groupId: "a", label: "Desk Mic" },
    { kind: "audioinput", deviceId: "mic-b", groupId: "b", label: "Headset Mic" },
    { kind: "videoinput", deviceId: "cam-a", groupId: "a", label: "Desk Cam" },
    { kind: "videoinput", deviceId: "cam-b", groupId: "b", label: "USB Cam" },
  ] as unknown as MediaDeviceInfo[];
  const storage = new Map<string, string>();
  const calls: Array<[MediaDeviceKind, string, boolean | undefined]> = [];
  const manager = createBrowserConferenceDevices({
    mediaDevices: {
      enumerateDevices: async () => listed,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
    },
    outputSelectionSupported: () => true,
  });
  const room = {
    getActiveDevice: () => undefined,
    async switchActiveDevice(kind: MediaDeviceKind, id: string, exact?: boolean) {
      calls.push([kind, id, exact]);
      return true;
    },
  };
  await manager.bind(room);
  await manager.select("audioinput", "mic-b");
  await manager.select("videoinput", "cam-b");
  await manager.select("audiooutput", "out-b");
  assert.deepEqual(calls.slice(-3), [
    ["audioinput", "mic-b", true],
    ["videoinput", "cam-b", true],
    ["audiooutput", "out-b", true],
  ]);
  const stored = [...storage.values()][0] ?? "";
  assert.match(stored, /mic-b/);
  assert.match(stored, /cam-b/);
  assert.match(stored, /out-b/);
  assert.deepEqual((await manager.snapshot()).selected, {
    audioinput: "mic-b", audiooutput: "out-b", videoinput: "cam-b",
  });
  manager.unbind(room);
  manager.destroy();
});
