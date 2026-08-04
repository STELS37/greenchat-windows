import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_NOTE_AUDIO_BITRATE,
  pickVoiceNoteMime,
  voiceNoteConstraints,
  voiceNoteDuration,
  voiceNoteExtension,
  voiceNoteRecorderOptionCandidates,
  voiceNoteWaveform,
} from "../src/screens/voice_note_model.ts";

test("voice note prefers Opus and degrades to browser defaults", () => {
  assert.equal(pickVoiceNoteMime((mime) => mime === "audio/ogg;codecs=opus"), "audio/ogg;codecs=opus");
  assert.equal(pickVoiceNoteMime(() => false), "");
  const options = voiceNoteRecorderOptionCandidates("audio/webm;codecs=opus");
  assert.deepEqual(options[0], { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: VOICE_NOTE_AUDIO_BITRATE });
  assert.deepEqual(options.at(-1), {});
});

test("voice note capture is mono speech with Android audio processing enabled", () => {
  const constraints = voiceNoteConstraints();
  assert.equal(constraints.video, false);
  assert.deepEqual(constraints.audio, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
  });
});

test("voice note metadata clamps duration, chooses extension, and normalizes waveform", () => {
  assert.equal(voiceNoteDuration(1_000, 2_001, 60), 2);
  assert.equal(voiceNoteDuration(1_000, 91_000, 60), 60);
  assert.equal(voiceNoteDuration(2_000, 1_000, 60), 0);
  assert.equal(voiceNoteExtension("audio/ogg;codecs=opus"), "ogg");
  assert.equal(voiceNoteExtension("audio/mp4"), "m4a");
  assert.equal(voiceNoteExtension("audio/webm"), "webm");
  assert.deepEqual(voiceNoteWaveform([0, 0.25, 0.5, 1], 4), [0, 64, 128, 255]);
  assert.deepEqual(voiceNoteWaveform([0, 0, 0], 2), [0, 0]);
});
