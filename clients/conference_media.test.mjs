import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionQuality } from "livekit-client";
import {
  conferenceIsScreenPublisher,
  conferenceParticipantMediaSnapshot,
  conferenceQuality,
  conferenceUserId,
} from "./web/src/conference_media.ts";

test("V178: LiveKit identity parsing trusts an explicit valid metadata user id first", () => {
  assert.equal(conferenceUserId("gc-user-7", JSON.stringify({ user_id: 42 })), 42);
  assert.equal(conferenceUserId("gc-user-7", "not-json"), 7);
  assert.equal(conferenceUserId("guest", JSON.stringify({ user_id: -1 })), null);
  assert.equal(conferenceUserId("gc-user-0"), null);
  assert.equal(conferenceUserId("gc-user-9007199254740992"), null);
  assert.equal(conferenceUserId("gc-screen-42"), 42);
  assert.equal(conferenceIsScreenPublisher("gc-screen-42"), true);
});

test("V184: screen-only identity cannot overwrite primary microphone and camera state", () => {
  const primary = {
    identity: "gc-user-42",
    metadata: JSON.stringify({ user_id: 42 }),
    isMicrophoneEnabled: true,
    isCameraEnabled: true,
    isScreenShareEnabled: false,
  };
  const screen = {
    identity: "gc-screen-42",
    metadata: JSON.stringify({ user_id: 42, screen_share: true }),
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    isScreenShareEnabled: true,
  };
  const expected = [{ userId: 42, state: { muted: false, cameraOn: true, screenSharing: true } }];
  assert.deepEqual(conferenceParticipantMediaSnapshot([primary, screen]), expected);
  assert.deepEqual(conferenceParticipantMediaSnapshot([screen, primary]), expected, "merge is independent of LiveKit map order");
  assert.deepEqual(conferenceParticipantMediaSnapshot([primary]), [
    { userId: 42, state: { muted: false, cameraOn: true, screenSharing: false } },
  ]);
});

test("V178: LiveKit connection quality maps to audio-first GreenChat degradation levels", () => {
  assert.equal(conferenceQuality(ConnectionQuality.Excellent), "high");
  assert.equal(conferenceQuality(ConnectionQuality.Good), "medium");
  assert.equal(conferenceQuality(ConnectionQuality.Unknown), "medium");
  assert.equal(conferenceQuality(ConnectionQuality.Poor), "low");
  assert.equal(conferenceQuality(ConnectionQuality.Lost), "critical");
});
