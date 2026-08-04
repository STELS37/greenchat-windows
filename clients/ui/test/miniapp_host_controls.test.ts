import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createMiniAppHost } from "../src/screens/miniapp_host.ts";
import type { MiniAppLaunch } from "../src/screens/miniapps_model.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const launch: MiniAppLaunch = {
  app: {
    id: 42,
    bot_user_id: 42,
    bot: { id: 42, username: "ordersbot", name: "Orders Bot", avatar_file_id: null },
    title: "Orders",
    description: "Order console",
    launch_url: "https://mini.example/app",
    launch_origin: "https://mini.example",
    icon_file_id: null,
    requested_scopes: ["user.basic", "theme"],
    status: "active",
    version: 1,
    created_at: 1,
    updated_at: 1,
    published_at: 1,
  },
  launch_id: "123e4567-e89b-42d3-a456-426614174000",
  launch_url: "https://mini.example/app",
  launch_origin: "https://mini.example",
  init_data: "app_id=42&hash=abc",
  expires_at: 2_000_000_000,
  scopes: ["user.basic", "theme"],
  bridge: {
    version: 1,
    methods: [
      "ready",
      "close",
      "expand",
      "requestTheme",
      "openLink",
      "setMainButton",
      "setBackButton",
      "setSettingsButton",
    ],
  },
};

class MiniAppApi implements ApiLike {
  get<T>(): Promise<T> { return Promise.reject(new Error("unused GET")); }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/miniapps/42/launch") return Promise.resolve(launch as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.resolve({ revoked: true } as T); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

type WindowMessage = { type?: string; event?: string; id?: string; ok?: boolean };

test("Mini App host renders system controls without replacing the iframe and emits trusted press events", async () => {
  const frameMessages: WindowMessage[] = [];
  const frameWindow = {
    postMessage(message: WindowMessage): void { frameMessages.push(message); },
  };
  const listeners = new Set<(event: MessageEvent) => void>();
  const fakeWindow = {
    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
      if (type === "message") listeners.delete(listener);
    },
    open(): object { return {}; },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://greenchat.example" },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userActivation: { isActive: true },
      clipboard: { writeText: () => Promise.resolve() },
    },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ getPropertyValue: () => "" }),
  });

  const doc = globalThis.document as unknown as {
    createElement(tag: string): StubNode;
    documentElement: { dataset: Record<string, string> };
  };
  doc.documentElement = { dataset: {} };
  const createElement = doc.createElement.bind(doc);
  doc.createElement = (tag: string): StubNode => {
    const node = createElement(tag);
    if (tag === "iframe") (node as unknown as { contentWindow: unknown }).contentWindow = frameWindow;
    return node;
  };

  const host = createMiniAppHost({ api: new MiniAppApi(), i18n, appId: 42, onBack() {} });
  await settle();
  const root = host.root as unknown as StubNode;
  const iframe = root.find((node) => node.tag === "iframe");
  assert.ok(iframe, "launch mounts exactly one frame");
  iframe.dispatch("load");
  assert.equal(frameMessages.some((message) => message.type === "greenchat:init"), true);

  const send = (data: unknown, origin = launch.launch_origin): void => {
    for (const listener of [...listeners]) {
      listener({ data, origin, source: frameWindow } as unknown as MessageEvent);
    }
  };

  send({
    type: "greenchat:miniapp",
    version: 1,
    id: "main-1",
    method: "setMainButton",
    payload: { visible: true, text: "Pay securely", enabled: true, loading: false },
  });
  const main = root.find((node) => node.tag === "button" && node.hasClass("gc-miniapp-main"));
  assert.ok(main, "host paints the main action outside the iframe");
  assert.equal(main.textContent, "Pay securely");
  assert.equal(root.findAll((node) => node.tag === "iframe").length, 1, "control changes never remount the frame");
  main.dispatch("click");
  assert.equal(frameMessages.at(-1)?.event, "mainButtonPressed");

  send({
    type: "greenchat:miniapp",
    version: 1,
    id: "back-1",
    method: "setBackButton",
    payload: { visible: true },
  });
  send({
    type: "greenchat:miniapp",
    version: 1,
    id: "settings-1",
    method: "setSettingsButton",
    payload: { visible: true },
  });
  root.find((node) => node.hasClass("gc-miniapp-control-back"))?.dispatch("click");
  assert.equal(frameMessages.at(-1)?.event, "backButtonPressed");
  root.find((node) => node.hasClass("gc-miniapp-control-settings"))?.dispatch("click");
  assert.equal(frameMessages.at(-1)?.event, "settingsButtonPressed");

  const responsesBeforeForgery = frameMessages.length;
  send({
    type: "greenchat:miniapp",
    version: 1,
    id: "forged",
    method: "setBackButton",
    payload: { visible: false },
  }, "https://evil.example");
  assert.equal(frameMessages.length, responsesBeforeForgery, "a foreign origin cannot mutate controls or receive a response");

  host.destroy();
  assert.equal(listeners.size, 0, "destroy removes the frame bridge listener");
});
