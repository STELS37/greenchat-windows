import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  BOT_CREATE_INTENT_KEY,
  consumeBotCreateIntent,
  markBotCreateIntent,
  openBotCreateFlow,
  type BotIntentStorage,
} from "../src/screens/bot_center_handoff.ts";
import { createBotsScreen } from "../src/screens/bots_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

class MemoryStorage implements BotIntentStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class BotsApi implements ApiLike {
  get<T>(): Promise<T> { return Promise.resolve({ bots: [] } as T); }
  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("bot-create intent is one-shot and navigation uses the existing /bots route", () => {
  const storage = new MemoryStorage();
  const location = { hash: "#/chats" };
  openBotCreateFlow(storage, location);
  assert.equal(location.hash, "#/bots");
  assert.equal(storage.getItem(BOT_CREATE_INTENT_KEY), "1");
  assert.equal(consumeBotCreateIntent(storage), true);
  assert.equal(consumeBotCreateIntent(storage), false, "refreshing Bot Center does not reopen the form forever");
});

test("storage restrictions never block navigation to Bot Center", () => {
  const blocked: BotIntentStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const location = { hash: "#/chats" };
  assert.doesNotThrow(() => openBotCreateFlow(blocked, location));
  assert.equal(location.hash, "#/bots");
  assert.equal(consumeBotCreateIntent(blocked), false);
});

test("Bot Center consumes the chat-hub intent and opens its real creation form immediately", async () => {
  installDomStub();
  const storage = new MemoryStorage();
  markBotCreateIntent(storage);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  try {
    const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
    const screen = createBotsScreen({ api: new BotsApi(), i18n, onBack: () => {} });
    await settle();
    const root = screen.root as unknown as StubNode;
    assert.ok(root.querySelector(".gc-bot-form"), "the existing new-bot form is open, not the bot list");
    assert.match(root.textContent, /Новый бот/);
    assert.equal(storage.getItem(BOT_CREATE_INTENT_KEY), null, "intent is consumed exactly once");
    screen.destroy();
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});
