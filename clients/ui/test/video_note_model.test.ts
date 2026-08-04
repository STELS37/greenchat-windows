import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextVideoNoteFacing,
  pickVideoNoteMime,
  videoNoteConstraints,
  videoNoteDuration,
  videoNoteExtension,
  videoNoteFileName,
  videoNoteLayoutEdge,
  videoNoteRecorderOptionCandidates,
} from "../src/screens/video_note_model.ts";

test("video notes prefer the most efficient supported browser codec and fall back safely", () => {
  assert.equal(pickVideoNoteMime((mime) => mime.includes("vp8")), "video/webm;codecs=vp8,opus");
  assert.equal(pickVideoNoteMime((mime) => mime === "video/mp4"), "video/mp4");
  assert.equal(pickVideoNoteMime(() => false), "");
  assert.equal(pickVideoNoteMime(() => { throw new Error("partial WebView"); }), "");
});

test("video note names and extensions match the negotiated container", () => {
  assert.equal(videoNoteExtension("video/mp4;codecs=avc1"), "mp4");
  assert.equal(videoNoteExtension("video/webm;codecs=vp8"), "webm");
  assert.match(videoNoteFileName("video/webm", 0), /^video-note-1970-01-01T00-00-00-000Z\.webm$/);
});

test("MediaRecorder options degrade from explicit codec and bitrates to browser defaults", () => {
  assert.deepEqual(videoNoteRecorderOptionCandidates("video/mp4"), [
    { videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 48_000, mimeType: "video/mp4" },
    { mimeType: "video/mp4" },
    { videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 48_000 },
    {},
  ]);
  assert.deepEqual(videoNoteRecorderOptionCandidates(""), [
    { videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 48_000 },
    {},
  ]);
});

test("video note duration is integral, positive and bounded by the product limit", () => {
  assert.equal(videoNoteDuration(1_000, 1_001), 1);
  assert.equal(videoNoteDuration(1_000, 3_050), 3);
  assert.equal(videoNoteDuration(0, 90_000), 60);
  assert.equal(videoNoteDuration(2_000, 1_000), 0);
});

test("camera constraints preserve speech and request a square, bounded capture", () => {
  const front = videoNoteConstraints("user");
  const rear = videoNoteConstraints("environment");
  assert.equal(((front.video as MediaTrackConstraints).facingMode as ConstrainDOMStringParameters).ideal, "user");
  assert.equal(((rear.video as MediaTrackConstraints).facingMode as ConstrainDOMStringParameters).ideal, "environment");
  assert.equal(((front.video as MediaTrackConstraints).aspectRatio as ConstrainDoubleRange).ideal, 1);
  assert.equal((front.audio as MediaTrackConstraints).echoCancellation, true);
  assert.equal(nextVideoNoteFacing("user"), "environment");
  assert.equal(nextVideoNoteFacing("environment"), "user");
});

test("round layout uses the smaller real edge and a deterministic fallback", () => {
  assert.equal(videoNoteLayoutEdge(1920, 1080), 720);
  assert.equal(videoNoteLayoutEdge(480, 640), 480);
  assert.equal(videoNoteLayoutEdge(0, Number.NaN), 720);
});
