import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const composer = read("../src/screens/composer.ts");
const voice = read("../src/screens/voice_note_recorder.ts");
const video = read("../src/screens/video_note_recorder.ts");
const feed = read("../src/screens/feed_screen.ts");

const voiceCss = read("../../web/public/assets/voice-note.css");

test("V188: composer uses one Telegram-style action slot instead of a second camera button", () => {
  assert.match(composer, /sendBtn\.dataset\.action = send \? "send" : recordMode/);
  assert.match(composer, /recordMode === "voice" \? "mic" : "video"/);
  assert.match(composer, /pointerdown[\s\S]*beginHold/);
  assert.match(composer, /holdTriggered[\s\S]*recordHandler\(\)\?\.\(\)/);
  assert.doesNotMatch(composer, /gc-composer-video-note/);
});

test("V188: voice capture uploads a server-native voice message with duration, waveform and reply", () => {
  assert.match(voice, /getUserMedia\(voiceNoteConstraints\(\)\)/);
  assert.match(voice, /voiceNoteRecorderOptionCandidates/);
  assert.match(voice, /voiceNoteWaveform\(meterSamples\)/);
  assert.match(voice, /for \(const track of target\.getTracks\(\)\) track\.stop\(\)/);
  assert.match(voice, /document\.visibilityState === "hidden"/);
  assert.match(feed, /meta: \{ duration: note\.duration, waveform: note\.waveform \}/);
  assert.match(feed, /kind: "voice"/);
  assert.match(feed, /reply_to_id: replyToId/);
});

test("V188: recorder code and styling stay lazy while the built asset is cacheable", () => {
  assert.doesNotMatch(feed, /^import .*voice_note_recorder/m);
  assert.doesNotMatch(feed, /^import .*video_note_recorder/m);
  assert.match(feed, /import\("\.\/voice_note_recorder\.ts"\)/);
  assert.match(feed, /import\("\.\/video_note_recorder\.ts"\)/);
  assert.match(voice, /assets\/voice-note\.css/);
  assert.match(voice, /link\.rel = "stylesheet"/);
  assert.match(voiceCss, /\.gc-voice-note-overlay/);
  assert.match(voiceCss, /\.gc-voice-note-record\.is-recording/);
});

test("V188: holding video mode opens the existing round recorder and starts automatically", () => {
  assert.match(video, /autoStart\?: boolean/);
  assert.match(video, /autoStartPending = deps\.autoStart === true/);
  assert.match(video, /if \(autoStartPending\)[\s\S]*startRecording\(\)/);
  assert.match(feed, /onVideoNote: \(\) => openVideoNote\(true\)/);
  assert.match(feed, /round: true/);
});
