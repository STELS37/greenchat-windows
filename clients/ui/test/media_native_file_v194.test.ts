// V194 regression guard: Capacitor WebViews cannot be trusted to download blob: anchors. A received
// document must use the native save/open seam, expose its filename, and make the whole Telegram-style
// card tappable while preserving the existing busy/error/retry contract.
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
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const env: MediaEnv = {
  policy: () => "none",
  dataSaver: () => false,
  network: () => "wifi",
  speed: () => 1,
  setSpeed: () => {},
};

const message: Message = {
  id: 194,
  chat_id: 9,
  file: { id: 88, name: "", mime: "application/pdf", size: 54_200, meta: null },
};

class NativeMedia implements MediaPort {
  opens: Array<{ fileId: number; name: string; mime: string }> = [];
  objectUrlCalls = 0;
  outcomes: Array<"resolve" | "reject" | "hold"> = [];
  pending = deferred<{ saved: boolean; opened: boolean }>();

  upload(): Promise<UploadedFile> {
    return Promise.reject(new Error("unused"));
  }
  objectUrl(): Promise<string> {
    this.objectUrlCalls += 1;
    return Promise.reject(new Error("blob fallback must not run in the native shell"));
  }
  openFile(fileId: number, options: { name: string; mime: string }): Promise<{ saved: boolean; opened: boolean }> {
    this.opens.push({ fileId, ...options });
    const outcome = this.outcomes.shift() ?? "resolve";
    if (outcome === "reject") return Promise.reject(new Error("native save failed"));
    if (outcome === "hold") {
      this.pending = deferred<{ saved: boolean; opened: boolean }>();
      return this.pending.promise;
    }
    return Promise.resolve({ saved: true, opened: true });
  }
  revoke(): void {}
  setCacheLimit(): void {}
}

function deps(media: MediaPort): AttachmentDeps {
  return { i18n, media, env, onOpenViewer: () => {} };
}

const byClass = (root: StubNode, cls: string): StubNode[] => root.findAll((node) => node.hasClass(cls));
const one = (root: StubNode, cls: string): StubNode => {
  const found = byClass(root, cls);
  assert.equal(found.length, 1, `expected exactly one .${cls}`);
  return found[0]!;
};

function render(media: MediaPort): StubNode {
  return renderAttachment(message, deps(media)) as unknown as StubNode;
}

test("V194: blank metadata still renders a filename and the whole file card opens natively", async () => {
  const media = new NativeMedia();
  const root = render(media);
  const card = one(root, "gc-file");
  const name = one(root, "gc-file-name");

  assert.equal(name.textContent, "file-88.pdf", "a received file must not collapse to only its byte count");
  assert.equal(card.attrs.role, "button");
  assert.equal(card.attrs.tabindex, "0");

  card.dispatch("click");
  await settle();

  assert.deepEqual(media.opens, [{ fileId: 88, name: "file-88.pdf", mime: "application/pdf" }]);
  assert.equal(media.objectUrlCalls, 0, "Android/iOS never falls back to a blob: anchor");
  assert.ok(card.hasClass("is-ready"), "the card remembers that a native copy now exists");
});

test("V194: the trailing action and Enter key use the same native open path", async () => {
  const media = new NativeMedia();
  const root = render(media);
  const card = one(root, "gc-file");
  const action = one(root, "gc-file-dl");

  action.dispatch("click");
  await settle();
  card.dispatch("keydown", { key: "Enter" });
  await settle();

  assert.equal(media.opens.length, 2);
  assert.equal(media.objectUrlCalls, 0);
});

test("V194: a slow native save shows progress and impatient taps do not duplicate it", async () => {
  const media = new NativeMedia();
  media.outcomes = ["hold"];
  const root = render(media);
  const card = one(root, "gc-file");
  const action = one(root, "gc-file-dl");

  card.dispatch("click");
  await settle();
  assert.ok(card.hasClass("is-loading"));
  assert.ok(action.hasClass("is-busy"));

  action.dispatch("click");
  card.dispatch("click");
  await settle();
  assert.equal(media.opens.length, 1, "one user intent owns one native transfer");

  media.pending.resolve({ saved: true, opened: true });
  await settle();
  assert.ok(!card.hasClass("is-loading"));
  assert.ok(!action.hasClass("is-busy"));
});

test("V194: a failed native save remains retryable", async () => {
  const media = new NativeMedia();
  media.outcomes = ["reject", "resolve"];
  const root = render(media);
  const card = one(root, "gc-file");
  const action = one(root, "gc-file-dl");

  card.dispatch("click");
  await settle();
  assert.ok(card.hasClass("is-error"));
  assert.ok(action.hasClass("is-error"));
  assert.notEqual(byClass(root, "gc-media-error").map((node) => node.textContent).join(""), "");

  action.dispatch("click");
  await settle();
  assert.equal(media.opens.length, 2);
  assert.ok(!card.hasClass("is-error"));
  assert.ok(!action.hasClass("is-error"));
});
