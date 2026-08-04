import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import { createComposer } from "../src/screens/composer.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

const i18n = () => createI18n({ locale: "ru", dicts: { ru, en }, fallbackLocale: "en" });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("V188: empty composer toggles microphone/video, text shows send, and send returns to microphone", () => {
  installDomStub();
  const submitted: unknown[] = [];
  const composer = createComposer({
    i18n: i18n(),
    members: () => [],
    onSubmit: (payload) => submitted.push(payload),
    onDraft: () => {},
    onVoiceNote: () => {},
    onVideoNote: () => {},
  });
  const root = composer.root as unknown as StubNode;
  const action = root.find((node) => node.hasClass("gc-composer-send"));
  const input = root.find((node) => node.hasClass("gc-composer-input"));
  assert.ok(action);
  assert.ok(input);
  assert.equal(action!.attrs["data-action"], "voice");
  assert.equal(root.find((node) => node.hasClass("gc-composer-video-note")), null, "no duplicate camera button inside the pill");

  action!.dispatch("click");
  assert.equal(action!.attrs["data-action"], "video");
  action!.dispatch("click");
  assert.equal(action!.attrs["data-action"], "voice");

  input!.value = "Привет";
  input!.dispatch("input");
  assert.equal(action!.attrs["data-action"], "send");
  action!.dispatch("click");
  assert.deepEqual(submitted, [{ mode: "send", text: "Привет", replyToId: null }]);
  assert.equal(action!.attrs["data-action"], "voice");
  composer.destroy();
});

test("V188: a deliberate hold records the selected mode and suppresses the following click", async () => {
  installDomStub();
  let voice = 0;
  let video = 0;
  const composer = createComposer({
    i18n: i18n(),
    members: () => [],
    onSubmit: () => {},
    onDraft: () => {},
    onVoiceNote: () => { voice += 1; },
    onVideoNote: () => { video += 1; },
    recordHoldMs: 1,
  });
  const action = (composer.root as unknown as StubNode).find((node) => node.hasClass("gc-composer-send"));
  assert.ok(action);

  action!.dispatch("pointerdown");
  await pause(8);
  action!.dispatch("pointerup");
  action!.dispatch("click");
  assert.equal(voice, 1);
  assert.equal(video, 0);
  assert.equal(action!.attrs["data-action"], "voice", "the synthetic click after a hold must not switch mode");

  action!.dispatch("click");
  assert.equal(action!.attrs["data-action"], "video");
  action!.dispatch("pointerdown");
  await pause(8);
  action!.dispatch("pointerup");
  action!.dispatch("click");
  assert.equal(video, 1);
  assert.equal(action!.attrs["data-action"], "video");
  composer.destroy();
});

test("V188: staged media keeps the send plane visible even with an empty caption", () => {
  installDomStub();
  let staged = false;
  const composer = createComposer({
    i18n: i18n(),
    members: () => [],
    onSubmit: () => {},
    onDraft: () => {},
    onVoiceNote: () => {},
    onVideoNote: () => {},
    hasStaged: () => staged,
  });
  const action = (composer.root as unknown as StubNode).find((node) => node.hasClass("gc-composer-send"));
  assert.equal(action!.attrs["data-action"], "voice");
  staged = true;
  composer.refreshAction();
  assert.equal(action!.attrs["data-action"], "send");
  staged = false;
  composer.refreshAction();
  assert.equal(action!.attrs["data-action"], "voice");
  composer.destroy();
});
