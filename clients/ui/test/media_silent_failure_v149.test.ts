// clients/ui/test/media_silent_failure_v149.test.ts — V149 regression guard.
//
// Measured 2026-08-03 in clients/ui/src/screens/media.ts. A photo or a video that fails to load
// degrades to a visible "tap to load" chip, and the full-screen viewer prints errors.network. The two
// remaining attachment kinds swallow the identical failure:
//
//   voice: catch { /* autoplay/codec refusal — leave in the idle state */ }
//   file:  catch { /* offline — leave the chip as-is */ }
//
// So on a dropped connection the play button does nothing observable at all — and it does nothing
// twice, because the blob fetch inside ensureAudio() runs with no busy state, so the user cannot tell
// "still loading" from "failed" and taps again, starting one more parallel fetch of the same file.
// That is the least smooth path in the message bubble, and it is invisible to every existing test:
// before this file, no test in clients/ui/test touched media.ts at all.
//
// What is asserted here is the behaviour the same file already gives photos and videos: a busy state
// while the bytes are fetched, one fetch per intent, a readable failure, and a retry that clears it.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { Message } from "../src/screens/types.ts";
import type { AttachmentDeps, MediaEnv, MediaPort, UploadedFile } from "../src/screens/media.ts";
import { renderAttachment } from "../src/screens/media.ts";
import { installDomStub, deferred, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
// downloadFile() mounts a temporary <a> on document.body to trigger the save. The stub has no body of
// its own, so the test owns one — without it the success path would throw instead of downloading.
const documentStub = globalThis.document as unknown as { body: StubNode; createElement(tag: string): StubNode };
documentStub.body = documentStub.createElement("body");

const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

class NetworkError extends Error {
  override name = "NetworkError";
}

// The <audio> element the voice player constructs on first play. Only what media.ts touches.
class AudioStub {
  static created: AudioStub[] = [];
  static playRejects = false;
  paused = true;
  currentTime = 0;
  duration = 5;
  playbackRate = 1;
  readonly src: string;
  constructor(src: string) {
    this.src = src;
    AudioStub.created.push(this);
  }
  addEventListener(): void {}
  play(): Promise<void> {
    if (AudioStub.playRejects) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}
(globalThis as unknown as { Audio: unknown }).Audio = AudioStub;

// A MediaPort whose fetch is scripted per test: reject to simulate offline, hold to simulate a slow
// link. Every call is counted, because "how many times did one intent fetch the file" is the question.
class ScriptedMedia implements MediaPort {
  calls = 0;
  outcomes: Array<"reject" | "resolve" | "hold"> = [];
  pending = deferred<string>();
  revoked: string[] = [];

  upload(): Promise<UploadedFile> {
    return Promise.reject(new Error("unused"));
  }
  objectUrl(fileId: number): Promise<string> {
    this.calls += 1;
    const outcome = this.outcomes.shift() ?? "resolve";
    if (outcome === "reject") return Promise.reject(new NetworkError("offline"));
    if (outcome === "hold") {
      this.pending = deferred<string>();
      return this.pending.promise;
    }
    return Promise.resolve(`blob:file-${fileId}`);
  }
  revoke(url: string): void {
    this.revoked.push(url);
  }
  setCacheLimit(): void {}
}

const env: MediaEnv = {
  policy: () => "none",
  dataSaver: () => false,
  network: () => "wifi",
  speed: () => 1,
  setSpeed: () => {},
};

function deps(media: MediaPort): AttachmentDeps {
  return { i18n, media, env, onOpenViewer: () => {} };
}

const voiceMessage: Message = {
  id: 1,
  chat_id: 9,
  file: { id: 77, name: "voice.ogg", mime: "audio/ogg", size: 24_000, meta: { duration: 5, waveform: [1, 4, 9, 3] } },
};

const fileMessage: Message = {
  id: 2,
  chat_id: 9,
  file: { id: 88, name: "report.pdf", mime: "application/pdf", size: 1_240_000, meta: null },
};

const byClass = (root: StubNode, cls: string): StubNode[] => root.findAll((node) => node.hasClass(cls));
const one = (root: StubNode, cls: string): StubNode => {
  const found = byClass(root, cls);
  assert.equal(found.length, 1, `expected exactly one .${cls}`);
  return found[0]!;
};
const errorText = (root: StubNode): string => byClass(root, "gc-media-error").map((n) => n.textContent).join("");

test("V149: a voice note that cannot be fetched says so instead of ignoring the tap", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["reject"];
  const root = renderAttachment(voiceMessage, deps(media)) as unknown as StubNode;
  const play = one(root, "gc-voice-play");

  assert.equal(errorText(root), "", "a freshly rendered voice note carries no failure text");

  play.dispatch("click");
  await settle();

  assert.equal(media.calls, 1, "the tap fetched the voice file once");
  assert.equal(
    errorText(root),
    i18n.t("errors.network"),
    "a failed voice fetch must be visible; today the catch block leaves the row untouched",
  );
  assert.ok(play.hasClass("is-error"), "the transport control shows it is in a failed state");
  assert.ok(!play.hasClass("is-busy"), "the busy state is cleared once the fetch settled");
  assert.equal(play.attrs["aria-label"], i18n.t("common.retry"), "the control now offers a retry, not a play");
  assert.equal(play.disabled, false, "the retry must stay reachable");
});

test("V149: tapping the failed voice note again retries and clears the failure", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["reject", "resolve"];
  AudioStub.created = [];
  AudioStub.playRejects = false;
  const root = renderAttachment(voiceMessage, deps(media)) as unknown as StubNode;
  const play = one(root, "gc-voice-play");

  play.dispatch("click");
  await settle();
  assert.equal(errorText(root), i18n.t("errors.network"), "the first tap failed visibly");

  play.dispatch("click");
  await settle();

  assert.equal(media.calls, 2, "the second tap really retried the fetch");
  assert.equal(errorText(root), "", "a successful retry removes the failure text");
  assert.equal(AudioStub.created.length, 1, "playback started after the retry");
  assert.equal(AudioStub.created[0]!.paused, false, "the audio element is playing");
  assert.equal(play.attrs["aria-label"], i18n.t("media.pause"), "the control went back to being a transport");
});

test("V149: a slow voice fetch shows it is working and does not multiply fetches", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["hold"];
  AudioStub.created = [];
  const root = renderAttachment(voiceMessage, deps(media)) as unknown as StubNode;
  const play = one(root, "gc-voice-play");

  play.dispatch("click");
  await settle();

  assert.ok(play.hasClass("is-busy"), "while the bytes are being fetched the control shows a busy state");
  assert.equal(play.attrs["aria-busy"], "true", "assistive technology is told the control is working");

  play.dispatch("click");
  play.dispatch("click");
  await settle();
  assert.equal(media.calls, 1, "impatient taps during a slow fetch must not start parallel downloads");

  media.pending.resolve("blob:file-77");
  await settle();
  assert.ok(!play.hasClass("is-busy"), "the busy state ends with the fetch");
  assert.equal(play.attrs["aria-busy"], undefined, "aria-busy is removed, not left set forever");
  assert.equal(AudioStub.created.length, 1, "exactly one audio element was created");
});

test("V149: a voice note the platform refuses to play reports it", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["resolve"];
  AudioStub.created = [];
  AudioStub.playRejects = true;
  const root = renderAttachment(voiceMessage, deps(media)) as unknown as StubNode;
  const play = one(root, "gc-voice-play");

  play.dispatch("click");
  await settle();
  AudioStub.playRejects = false;

  assert.notEqual(errorText(root), "", "a refused play() is a failure the user must see");
  assert.ok(!play.hasClass("is-playing"), "a refused play() must not leave a pause glyph pretending to play");
});

test("V149: a file download that fails says so instead of silently returning to idle", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["reject"];
  const root = renderAttachment(fileMessage, deps(media)) as unknown as StubNode;
  const dl = one(root, "gc-file-dl");

  dl.dispatch("click");
  await settle();

  assert.equal(media.calls, 1, "the click fetched the file once");
  assert.equal(
    errorText(root),
    i18n.t("errors.network"),
    "a failed download must be visible; today the chip just returns to its download icon",
  );
  assert.ok(dl.hasClass("is-error"), "the download control shows it is in a failed state");
  assert.ok(!dl.hasClass("is-busy"), "the busy state is cleared once the fetch settled");
  assert.equal(dl.attrs["aria-label"], i18n.t("common.retry"), "the control now offers a retry");
});

test("V149: retrying a failed download clears the failure and saves the file", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["reject", "resolve"];
  const root = renderAttachment(fileMessage, deps(media)) as unknown as StubNode;
  const dl = one(root, "gc-file-dl");

  dl.dispatch("click");
  await settle();
  assert.equal(errorText(root), i18n.t("errors.network"), "the first attempt failed visibly");

  dl.dispatch("click");
  await settle();

  assert.equal(media.calls, 2, "the second click really retried");
  assert.equal(errorText(root), "", "a successful retry removes the failure text");
  assert.equal(dl.attrs["aria-label"], i18n.t("media.download"), "the control went back to being a download button");
});

test("V149: a second click during a running download does not start a second one", async () => {
  const media = new ScriptedMedia();
  media.outcomes = ["hold"];
  const root = renderAttachment(fileMessage, deps(media)) as unknown as StubNode;
  const dl = one(root, "gc-file-dl");

  dl.dispatch("click");
  await settle();
  assert.ok(dl.hasClass("is-busy"), "the download control shows it is working");

  dl.dispatch("click");
  await settle();
  assert.equal(media.calls, 1, "a download already in flight is not duplicated");

  media.pending.resolve("blob:file-88");
  await settle();
  assert.ok(!dl.hasClass("is-busy"), "the busy state ends with the download");
});
