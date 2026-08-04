// clients/ui/test/bots_races_v168.test.ts — V168 regression guard.
//
// The owner can open the create form while the initial GET /v1/bots is still in flight. After POST
// succeeds, createBot starts a newer list read. A late old initial response used to replace that newer
// list, so the freshly created bot disappeared as soon as the owner returned from its detail card.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createBotsScreen, type OwnedBotView } from "../src/screens/bots_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

class NetworkError extends Error {
  override name = "NetworkError";
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const bot = (id: number, name: string, username: string): OwnedBotView => ({
  id,
  bot_user_id: id,
  username,
  name,
  description: "",
  avatar_file_id: null,
  suspended: false,
  created_at: 1_700_000_000 + id,
  webhook: {
    configured: false,
    enabled: false,
    url: null,
    fail_streak: 0,
    next_retry_at: null,
    last_error: null,
    updated_at: null,
  },
  commands: [],
});

class CreateRaceApi implements ApiLike {
  readonly initialList = new Deferred<{ bots: OwnedBotView[] }>();
  readonly freshList = new Deferred<{ bots: OwnedBotView[] }>();
  readonly detail = new Deferred<OwnedBotView>();
  getCalls: string[] = [];
  postCalls = 0;
  readonly created = bot(101, "Новый бот", "new_helper_bot");

  get<T>(path: string): Promise<T> {
    this.getCalls.push(path);
    if (path === "/v1/bots") {
      const ordinal = this.getCalls.filter((item) => item === path).length;
      if (ordinal === 1) return this.initialList.promise as Promise<T>;
      if (ordinal === 2) return this.freshList.promise as Promise<T>;
    }
    if (path === "/v1/bots/101") return this.detail.promise as Promise<T>;
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(path: string): Promise<T> {
    assert.equal(path, "/v1/bots");
    this.postCalls += 1;
    return Promise.resolve({
      bot_user_id: 101,
      username: this.created.username,
      token: "one-time-token",
      bot: this.created,
    } as T);
  }

  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const byClass = (root: StubNode, cls: string): StubNode[] => root.findAll((node) => node.hasClass(cls));

function enterCreate(root: StubNode): void {
  byClass(root, "gc-bot-create-btn")[0]!.dispatch("click");
  const inputs = root.findAll((node) => node.tag === "input");
  inputs[0]!.value = "new_helper_bot";
  inputs[0]!.dispatch("input");
  inputs[1]!.value = "Новый бот";
  inputs[1]!.dispatch("input");
  root.findAll((node) => node.tag === "form")[0]!.dispatch("submit");
}

async function mountAfterInitial(api: CreateRaceApi): Promise<{ root: StubNode; destroy(): void }> {
  const screen = createBotsScreen({ api, i18n, onBack: () => {} });
  await settle();
  api.initialList.resolve({ bots: [] });
  await settle();
  return { root: screen.root as unknown as StubNode, destroy: () => screen.destroy() };
}

test("V168: a late initial bot-list response cannot erase a bot proven by a successful create", async () => {
  const api = new CreateRaceApi();
  const screen = createBotsScreen({ api, i18n, onBack: () => {} });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.deepEqual(api.getCalls, ["/v1/bots"], "the initial list read is pending");

  enterCreate(root);
  await settle();
  assert.equal(api.postCalls, 1, "the create committed");
  assert.deepEqual(api.getCalls, ["/v1/bots", "/v1/bots"], "create starts a newer list read");

  api.freshList.resolve({ bots: [api.created] });
  await settle();
  assert.deepEqual(api.getCalls, ["/v1/bots", "/v1/bots", "/v1/bots/101"]);
  api.detail.resolve(api.created);
  await settle();
  assert.equal(byClass(root, "gc-bot-token-card").length, 1, "the one-time token remains visible in detail");

  api.initialList.resolve({ bots: [] });
  await settle();

  // Return from detail to the list. The old pre-create snapshot must not make the bot disappear.
  byClass(root, "gc-bot-header")[0]!.findAll((node) => node.tag === "button")[0]!.dispatch("click");
  await settle();
  assert.equal(byClass(root, "gc-bot-row").length, 1, "the created bot remains in the owner list");
  assert.ok(root.textContent.includes("Новый бот"));
  screen.destroy();
});


test("V168: a failed post-create list refresh keeps the bot proven by the POST response", async () => {
  const api = new CreateRaceApi();
  const screen = await mountAfterInitial(api);

  enterCreate(screen.root);
  await settle();
  api.freshList.reject(new NetworkError("offline list"));
  await settle();
  assert.deepEqual(api.getCalls, ["/v1/bots", "/v1/bots", "/v1/bots/101"]);
  api.detail.resolve(api.created);
  await settle();

  byClass(screen.root, "gc-bot-header")[0]!.findAll((node) => node.tag === "button")[0]!.dispatch("click");
  await settle();
  assert.equal(byClass(screen.root, "gc-bot-row").length, 1, "a read failure cannot undo a successful create");
  assert.ok(screen.root.textContent.includes(i18n.t("state.staleOffline")), "the retained list is marked stale");
  screen.destroy();
});

test("V168: failed post-create detail refresh is a stale read, never a queued create", async () => {
  const api = new CreateRaceApi();
  const screen = await mountAfterInitial(api);

  enterCreate(screen.root);
  await settle();
  api.freshList.resolve({ bots: [api.created] });
  await settle();
  api.detail.reject(new NetworkError("offline detail"));
  await settle();

  assert.equal(byClass(screen.root, "gc-bot-token-card").length, 1, "the token from the successful POST stays visible");
  assert.ok(screen.root.textContent.includes(i18n.t("bots.created")), "the successful create verdict remains visible");
  assert.ok(screen.root.textContent.includes(i18n.t("state.staleOffline")), "only the follow-up read is marked stale");
  assert.ok(!screen.root.textContent.includes(i18n.t("errors.network")), "a completed create was never queued");
  screen.destroy();
});


class WebhookProjectionApi implements ApiLike {
  readonly current: OwnedBotView;
  putCalls = 0;
  deleteCalls = 0;

  constructor(configured: boolean) {
    this.current = {
      ...bot(7, "Webhook bot", "webhook_bot"),
      webhook: configured
        ? {
            configured: true,
            enabled: true,
            url: "https://old.example/hook",
            fail_streak: 0,
            next_retry_at: null,
            last_error: null,
            updated_at: 1_700_000_100,
          }
        : bot(7, "Webhook bot", "webhook_bot").webhook,
    };
  }

  get<T>(path: string): Promise<T> {
    if (path === "/v1/bots") return Promise.resolve({ bots: [this.current] } as T);
    if (path === "/v1/bots/7") return Promise.resolve(this.current as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  put<T>(path: string): Promise<T> {
    assert.equal(path, "/v1/bots/7/webhook");
    this.putCalls += 1;
    return Promise.resolve({
      configured: true,
      enabled: true,
      url: "https://new.example/hook",
      fail_streak: 0,
      next_retry_at: null,
      last_error: null,
      updated_at: 1_700_000_200,
    } as T);
  }

  delete<T>(path: string): Promise<T> {
    assert.equal(path, "/v1/bots/7/webhook");
    this.deleteCalls += 1;
    return Promise.resolve({ deleted: true } as T);
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function mountWebhook(api: WebhookProjectionApi): Promise<{ root: StubNode; destroy(): void }> {
  const screen = createBotsScreen({ api, i18n, onBack: () => {} });
  await settle();
  const root = screen.root as unknown as StubNode;
  byClass(root, "gc-bot-row")[0]!.dispatch("click");
  await settle();
  return { root, destroy: () => screen.destroy() };
}

function backFromBot(root: StubNode): void {
  byClass(root, "gc-bot-header")[0]!.findAll((node) => node.tag === "button")[0]!.dispatch("click");
}

test("V170: saving a webhook updates the owner-list mode before the next reload", async () => {
  const api = new WebhookProjectionApi(false);
  const screen = await mountWebhook(api);
  const webhookForm = screen.root.findAll((node) =>
    node.tag === "form" && node.findAll((child) => child.attrs.type === "url").length === 1,
  )[0]!;
  const url = webhookForm.findAll((node) => node.attrs.type === "url")[0]!;
  const secret = webhookForm.findAll((node) => node.attrs.type === "password")[0]!;
  url.value = "https://new.example/hook";
  url.dispatch("input");
  secret.value = "strong-secret";
  secret.dispatch("input");
  webhookForm.dispatch("submit");
  await settle();
  assert.equal(api.putCalls, 1);

  backFromBot(screen.root);
  await settle();
  const row = byClass(screen.root, "gc-bot-row")[0]!;
  assert.ok(row.textContent.includes(i18n.t("bots.webhookActive")), "the list must show webhook mode immediately");
  assert.ok(!row.textContent.includes(i18n.t("bots.longPollMode")));
  screen.destroy();
});

test("V170: removing a webhook updates the owner-list mode before the next reload", async () => {
  const api = new WebhookProjectionApi(true);
  const screen = await mountWebhook(api);
  const remove = screen.root.findAll((node) =>
    node.tag === "button" && node.textContent.includes(i18n.t("bots.removeWebhook")),
  )[0]!;
  remove.dispatch("click");
  const confirm = screen.root.findAll((node) =>
    node.tag === "button" && node.textContent.includes(i18n.t("bots.confirmRemoveWebhook")),
  )[0]!;
  confirm.dispatch("click");
  await settle();
  assert.equal(api.deleteCalls, 1);

  backFromBot(screen.root);
  await settle();
  const row = byClass(screen.root, "gc-bot-row")[0]!;
  assert.ok(row.textContent.includes(i18n.t("bots.longPollMode")), "the list must return to long-poll immediately");
  assert.ok(!row.textContent.includes(i18n.t("bots.webhookActive")));
  screen.destroy();
});

class LifecycleApi implements ApiLike {
  readonly current = bot(7, "Управляемый бот", "managed_helper_bot");
  tokenRotations = 0;
  botDeletes = 0;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/bots") return Promise.resolve({ bots: [this.current] } as T);
    if (path === "/v1/bots/7") return Promise.resolve(this.current as T);
    if (path === "/v1/bots/7/analytics?days=30") {
      return Promise.resolve({
        days: 30,
        since: 1,
        until: 2,
        sent_messages: 0,
        active_chats: 0,
        memberships: 1,
        media_messages: 0,
        polls_created: 0,
        callbacks_received: 0,
        reactions_received: 0,
      } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(path: string): Promise<T> {
    assert.equal(path, "/v1/bots/7/token");
    this.tokenRotations += 1;
    return Promise.resolve({ bot_user_id: 7, token: `gc_${"x".repeat(48)}` } as T);
  }

  delete<T>(path: string): Promise<T> {
    assert.equal(path, "/v1/bots/7");
    this.botDeletes += 1;
    return Promise.resolve({ deleted: true } as T);
  }

  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const buttonByText = (root: StubNode, text: string): StubNode => {
  const button = root.findAll((node) => node.tag === "button" && node.textContent.trim() === text)[0];
  assert.ok(button, `button not found: ${text}`);
  return button;
};

test("bot settings use explicit confirmations and show the rotated token beside security actions", async () => {
  const api = new LifecycleApi();
  const screen = createBotsScreen({ api, i18n, onBack: () => {} });
  await settle();
  const root = screen.root as unknown as StubNode;
  byClass(root, "gc-bot-row")[0]!.dispatch("click");
  await settle();

  buttonByText(root, i18n.t("bots.rotateToken")).dispatch("click");
  assert.equal(api.tokenRotations, 0, "the first click opens a visible confirmation instead of rotating silently");
  assert.ok(root.textContent.includes(i18n.t("bots.rotateWarning")));
  assert.ok(root.textContent.includes(i18n.t("common.cancel")));

  buttonByText(root, i18n.t("bots.confirmRotate")).dispatch("click");
  await settle();
  assert.equal(api.tokenRotations, 1);
  const tokenCard = byClass(root, "gc-bot-token-card")[0]!;
  const security = byClass(root, "gc-bot-danger-zone")[0]!;
  assert.ok(tokenCard, "the newly issued token remains visible in this bot's settings");
  assert.ok(root.children.indexOf(tokenCard) < root.children.indexOf(security), "the token is placed next to the security section");

  buttonByText(root, i18n.t("bots.delete")).dispatch("click");
  assert.equal(api.botDeletes, 0, "delete also requires an explicit confirmation choice");
  assert.ok(root.textContent.includes(i18n.t("bots.deleteWarning")));
  buttonByText(root, i18n.t("bots.confirmDelete")).dispatch("click");
  await settle();
  assert.equal(api.botDeletes, 1);
  assert.equal(byClass(root, "gc-bot-row").length, 0, "the deleted bot disappears from the owner list immediately");
  assert.ok(root.textContent.includes(i18n.t("bots.deleted")));
  screen.destroy();
});
