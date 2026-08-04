// V177 — a brand-new account saw two unrelated-looking empty states on the Calls tab:
// «Звонков ещё не было» in a compact text block and «Пока некому звонить» in a centred icon state.
// They were two renderers describing one first-use condition (no history AND no dialog peers).
// Collapse only that intersection; history failures and partially populated screens remain separate.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createCallsScreen } from "../src/screens/calls_screen.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

const person = (id: number): ChatEntry => ({
  id,
  kind: "dialog",
  title: `Человек ${id}`,
  username: `user${id}`,
  photo_file_id: null,
  last_message: null,
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: false,
  my_role: "member",
  message_ttl_sec: 0,
  draft: null,
  updated_at: 0,
});

const historyItem = {
  id: 71,
  chat_id: 11,
  direction: "out",
  status: "ok",
  duration_sec: 12,
  video: false,
  peer: { id: 7, name: "Анна", username: "anna" },
  created_at: 1_700_000_000,
};

type HistoryMode = "empty" | "one" | "failure";
class CallsApi implements ApiLike {
  private readonly historyMode: HistoryMode;
  private readonly chats: ChatEntry[];

  constructor(historyMode: HistoryMode, chats: ChatEntry[]) {
    this.historyMode = historyMode;
    this.chats = chats;
  }

  get<T>(path: string): Promise<T> {
    if (path === "/v1/calls/config") {
      return Promise.resolve({ ice_servers: [{ urls: "stun:example.test" }], ring_sec: 40 } as T);
    }
    if (path === "/v1/chats?filter=all") return Promise.resolve(this.chats as T);
    if (path.startsWith("/v1/calls/history")) {
      if (this.historyMode === "failure") return Promise.reject(new Error("history unavailable"));
      return Promise.resolve({
        items: this.historyMode === "one" ? [historyItem] : [],
        next_before: null,
      } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unused POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const byClass = (root: StubNode, className: string): StubNode[] =>
  root.findAll((node) => node.hasClass(className));

const mount = async (historyMode: HistoryMode, chats: ChatEntry[]): Promise<{ root: StubNode; destroy(): void }> => {
  const screen = createCallsScreen({
    api: new CallsApi(historyMode, chats),
    i18n,
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
    now: () => 1_700_000_100_000,
  });
  await settle();
  return { root: screen.root as unknown as StubNode, destroy: () => screen.destroy() };
};

test("V177: no history and no callable people become one first-use state", async () => {
  const screen = await mount("empty", []);
  const body = byClass(screen.root, "gc-calls-body")[0]!;

  assert.equal(byClass(body, "gc-state").length, 1, "first use needs one centred explanation");
  assert.equal(
    byClass(body, "gc-call-log-empty").length,
    0,
    "the compact «Звонков ещё не было» block must not compete with the full first-use state",
  );
  assert.equal(body.children.length, 1, "the one state owns the free call-screen area");
  assert.ok(body.textContent.includes(i18n.t("calls.noDialogs")));
  assert.ok(body.textContent.includes(i18n.t("calls.noDialogsLead")));
  assert.ok(!body.textContent.includes(i18n.t("calls.logEmpty")));
  screen.destroy();
});

test("V177: an empty history remains compact when callable people exist", async () => {
  const screen = await mount("empty", [person(1)]);
  assert.equal(byClass(screen.root, "gc-call-log-empty").length, 1, "the empty log still labels its own populated screen");
  assert.equal(byClass(screen.root, "gc-call-dialog").length, 1, "the callable person remains visible");
  assert.equal(byClass(screen.root, "gc-state").length, 0, "a populated people list is not a whole-screen empty state");
  screen.destroy();
});

test("V177: real history remains visible when no current dialogs exist", async () => {
  const screen = await mount("one", []);
  assert.equal(byClass(screen.root, "gc-call-log-row").length, 1, "past calls remain useful independently of current chats");
  assert.equal(byClass(screen.root, "gc-call-log-empty").length, 0);
  assert.equal(byClass(screen.root, "gc-state").length, 1, "the people subsection may still explain that nobody is callable");
  assert.ok(screen.root.textContent.includes("Анна"));
  screen.destroy();
});

test("V177: a history failure is never merged with a genuinely empty people list", async () => {
  const screen = await mount("failure", []);
  const states = byClass(screen.root, "gc-state");
  assert.equal(states.length, 2, "unknown history and empty people are different facts with different recovery");
  assert.equal(byClass(screen.root, "gc-call-log-empty").length, 0, "a failed read never claims the log is empty");
  assert.ok(states.some((state) => state.attrs["data-tone"] === "error"));
  assert.ok(states.some((state) => state.attrs["data-tone"] === "empty"));
  assert.ok(screen.root.textContent.includes(i18n.t("common.retry")), "the failed history remains retryable");
  screen.destroy();
});

test("bot dialogs are excluded from callable people", async () => {
  const bot = { ...person(9), title: "Помощник", username: "helper_bot", peer_is_bot: true };
  const screen = await mount("empty", [bot]);
  assert.equal(byClass(screen.root, "gc-call-dialog").length, 0, "a bot must never appear as a callable person");
  assert.equal(byClass(screen.root, "gc-state").length, 1, "a bot-only account still has no callable people");
  screen.destroy();
});
