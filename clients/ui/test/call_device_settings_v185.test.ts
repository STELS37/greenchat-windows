import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createCallOverlay } from "../src/screens/call_overlay.ts";
import {
  CallController,
  IDLE_STATE,
  type CallDeviceSnapshot,
  type CallMediaDeviceKind,
  type CallMediaSession,
  type CallState,
} from "../src/screens/call_model.ts";
import { createBrowserCallDevices } from "../../web/src/call_devices.ts";
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

test("V185: CallController delegates device reads, switches and hot-plug subscriptions", async () => {
  const selected: Array<[CallMediaDeviceKind, string]> = [];
  let subscribed = 0;
  let unsubscribed = 0;
  const controller = new CallController({
    signal: { send: () => true, subscribe: () => () => {} },
    media: {
      devices: {
        snapshot: async () => SNAPSHOT,
        select: async (kind, id) => { selected.push([kind, id]); return SNAPSHOT; },
        subscribe: () => { subscribed += 1; return () => { unsubscribed += 1; }; },
      },
      async open(): Promise<CallMediaSession> { throw new Error("not needed"); },
    },
    iceServers: async () => [],
    resolvePeer: async (id) => ({ id, name: "Peer" }),
    onState: () => {},
  });

  assert.deepEqual(await controller.deviceSnapshot(), SNAPSHOT);
  assert.deepEqual(await controller.selectDevice("audioinput", "mic-b"), SNAPSHOT);
  assert.deepEqual(selected, [["audioinput", "mic-b"]]);
  const off = controller.subscribeDevices(() => {});
  assert.equal(subscribed, 1);
  off();
  assert.equal(unsubscribed, 1);
});

test("V185: a video call exposes output, microphone and camera settings and applies selection", async () => {
  installDomStub();
  const document = globalThis.document as unknown as { body: StubNode };
  document.body = new StubNode("body");
  const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
  const selected: Array<[CallMediaDeviceKind, string]> = [];
  let subscribed = 0;
  let unsubscribed = 0;
  const controller = {
    accept: async () => {}, decline: () => {}, dismiss: () => {}, hangUp: () => {},
    place: async () => {}, setMuted: () => {}, setCameraOn: () => {}, attachVideo: () => {},
    deviceSnapshot: async () => SNAPSHOT,
    selectDevice: async (kind: CallMediaDeviceKind, id: string) => {
      selected.push([kind, id]);
      return { ...SNAPSHOT, selected: { ...SNAPSHOT.selected, [kind]: id } };
    },
    subscribeDevices: () => { subscribed += 1; return () => { unsubscribed += 1; }; },
  } as unknown as CallController;
  const overlay = createCallOverlay({ controller, i18n, setInterval: () => 1, clearInterval: () => {} });
  const root = overlay.root as unknown as StubNode;
  document.body.append(root);
  const active: CallState = {
    ...IDLE_STATE,
    phase: "active",
    direction: "out",
    callId: "call-1",
    peer: { id: 7, name: "Анна" },
    video: true,
    cameraOn: true,
    connectedAt: Date.now(),
  };
  overlay.render(active);

  const trigger = root.findAll((node) => node.hasClass("gc-call-settings-trigger"))[0];
  assert.ok(trigger, "the live call has a settings trigger");
  trigger.click();
  await settle();

  const sheet = root.findAll((node) => node.hasClass("gc-call-settings"))[0];
  assert.ok(sheet, "the settings sheet opens inside the call surface");
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

class FakeTrack {
  enabled = true;
  contentHint = "";
  stopped = false;
  readonly kind: "audio" | "video";
  readonly deviceId: string;
  constructor(kind: "audio" | "video", deviceId: string) {
    this.kind = kind;
    this.deviceId = deviceId;
  }
  stop(): void { this.stopped = true; }
}

class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) { this.tracks = tracks; }
  getTracks(): FakeTrack[] { return [...this.tracks]; }
  getAudioTracks(): FakeTrack[] { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks(): FakeTrack[] { return this.tracks.filter((track) => track.kind === "video"); }
  addTrack(track: FakeTrack): void { this.tracks.push(track); }
  removeTrack(track: FakeTrack): void {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }
}

function exactDevice(constraint: boolean | MediaTrackConstraints | undefined): string {
  if (!constraint || constraint === true) return "";
  const value = constraint.deviceId;
  if (typeof value === "object" && value && "exact" in value) return String(value.exact ?? "");
  return typeof value === "string" ? value : "";
}

test("V185: browser device manager replaces live capture tracks, routes output and persists choices", async () => {
  const devices = [
    { kind: "audiooutput", deviceId: "out-a", groupId: "a", label: "Speakers" },
    { kind: "audiooutput", deviceId: "out-b", groupId: "b", label: "Headset" },
    { kind: "audioinput", deviceId: "mic-a", groupId: "a", label: "Desk Mic" },
    { kind: "audioinput", deviceId: "mic-b", groupId: "b", label: "Headset Mic" },
    { kind: "videoinput", deviceId: "cam-a", groupId: "a", label: "Desk Cam" },
    { kind: "videoinput", deviceId: "cam-b", groupId: "b", label: "USB Cam" },
  ] as unknown as MediaDeviceInfo[];
  const storage = new Map<string, string>();
  const mediaDevices = {
    enumerateDevices: async () => devices,
    async getUserMedia(constraints: MediaStreamConstraints = {}) {
      const tracks: FakeTrack[] = [];
      if (constraints.audio) tracks.push(new FakeTrack("audio", exactDevice(constraints.audio) || "mic-a"));
      if (constraints.video) tracks.push(new FakeTrack("video", exactDevice(constraints.video) || "cam-a"));
      return new FakeStream(tracks) as unknown as MediaStream;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const manager = createBrowserCallDevices({
    mediaDevices,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
    },
    outputSelectionSupported: () => true,
  });
  const local = await manager.acquire(true) as unknown as FakeStream;
  const audioSender = {
    track: local.getAudioTracks()[0],
    async replaceTrack(track: FakeTrack) { this.track = track; },
  };
  const videoSender = {
    track: local.getVideoTracks()[0],
    async replaceTrack(track: FakeTrack) { this.track = track; },
  };
  const sinkIds: string[] = [];
  const sink = { setSinkId: async (id: string) => { sinkIds.push(id); } };
  const binding = {
    local: local as unknown as MediaStream,
    pc: { getSenders: () => [audioSender, videoSender] } as unknown as RTCPeerConnection,
    sink: sink as unknown as HTMLMediaElement,
    video: true,
  };
  await manager.bind(binding);
  const oldMic = local.getAudioTracks()[0]!;
  await manager.select("audioinput", "mic-b");
  assert.equal(audioSender.track.deviceId, "mic-b");
  assert.equal(oldMic.stopped, true, "the previous microphone track is released");
  await manager.select("videoinput", "cam-b");
  assert.equal(videoSender.track.deviceId, "cam-b");
  await manager.select("audiooutput", "out-b");
  assert.equal(sinkIds.at(-1), "out-b");
  assert.match([...storage.values()][0] ?? "", /mic-b/);
  assert.match([...storage.values()][0] ?? "", /cam-b/);
  assert.match([...storage.values()][0] ?? "", /out-b/);
  manager.unbind(binding);
  manager.destroy();
});
