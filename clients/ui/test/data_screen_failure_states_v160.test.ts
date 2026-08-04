// clients/ui/test/data_screen_failure_states_v160.test.ts — V160.
//
// A screen whose data failed to load owes the person two things: the truth about what happened, and a
// way out. `state_view.ts` was written for exactly that (V76) and the chats, calls and finance screens
// use it. Three screens never got it. Measured against an API that fails every request
// (var/ux-audit/v160/witness-before.txt, 2026-08-03):
//
//   • Settings → «Профиль» / «Общие» / «Приватность»: the whole panel is replaced by ONE line of text
//     from `describeError`. Offline that line is `errors.network` — «Нет соединения. Действие
//     поставлено в очередь.» — which ru.ts itself flags as "true for a write and a lie for a read":
//     a failed LOAD queues nothing. No retry: the only way to try again is to leave Settings and
//     come back.
//   • Bot Center: a failed GET /v1/bots renders the EMPTY state — «У вас пока нет ботов» with
//     «Создать первого бота» as the only offer. An owner of three bots with no network is told the
//     bots do not exist. Same false-empty defect V146 removed from the calls log.
//   • «Приватность и безопасность»: a failed GET /v1/blocks leaves `.gc-safety-list` with zero
//     children — indistinguishable from "nobody is blocked" — and, because `blockedLoaded` stays
//     false, «Заблокировать» is disabled forever with nothing on screen saying why or offering a
//     retry. A dead end inside a live screen.
//
// The contract pinned here: a failed READ shows the read-side failure block (`.gc-state`) with a
// working «Повторить», never the empty state, and never the write-side "queued" wording.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createBotsScreen } from "../src/screens/bots_screen.ts";
import { createSafetyScreen } from "../src/screens/safety_screen.ts";
import { createSettingsScreen } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

class NetworkError extends Error { override name = "NetworkError"; }

/** Fails every GET until `answers` is filled in for that path; records what was asked for. */
class ScriptedApi implements ApiLike {
  seen: string[] = [];
  answers = new Map<string, unknown>();
  private failWith: () => Error;

  constructor(kind: "offline" | "server" = "offline") {
    this.failWith = kind === "offline"
      ? () => new NetworkError("offline")
      : () => Object.assign(new Error("INTERNAL"), { name: "HttpError", status: 500, code: "INTERNAL" });
  }

  get<T>(path: string): Promise<T> {
    this.seen.push(path);
    if (this.answers.has(path)) return Promise.resolve(this.answers.get(path) as T);
    return Promise.reject(this.failWith());
  }
  post<T>(): Promise<T> { return Promise.reject(this.failWith()); }
  put<T>(): Promise<T> { return Promise.reject(this.failWith()); }
  patch<T>(): Promise<T> { return Promise.reject(this.failWith()); }
  delete<T>(): Promise<T> { return Promise.reject(this.failWith()); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
  /** How many times a path was requested — the only honest proof that a retry actually retried. */
  count(path: string): number { return this.seen.filter((p) => p === path).length; }
}

const buttons = (root: StubNode): StubNode[] => root.findAll((n) => n.tag === "button");
const text = (root: StubNode): string => root.textContent.replace(/\s+/g, " ").trim();
const retryButton = (root: StubNode): StubNode | undefined =>
  buttons(root).find((b) => b.textContent.includes(i18n.t("common.retry")));
const stateBlocks = (root: StubNode): StubNode[] => root.findAll((n) => n.hasClass("gc-state"));
const QUEUED_LIE = i18n.t("errors.network"); // «Нет соединения. Действие поставлено в очередь.»

const mountSettings = (api: ApiLike): StubNode =>
  (createSettingsScreen({ api, i18n, onBack: () => {} }) as unknown as { root: StubNode }).root;

const openSection = async (root: StubNode, label: string): Promise<void> => {
  const entry = buttons(root).find((b) => b.textContent.trim() === label);
  assert.ok(entry, `no «${label}» entry in Settings`);
  entry.click();
  await settle();
  await settle();
};

test("V160: Settings «Профиль» offers a retry instead of a dead one-liner", async () => {
  const api = new ScriptedApi("offline");
  const root = mountSettings(api);
  await settle();
  await openSection(root, "Профиль");

  assert.equal(stateBlocks(root).length, 1, "a failed profile read must render one failure block");
  assert.equal(stateBlocks(root)[0]?.getAttribute("data-tone"), "offline");
  assert.ok(!text(root).includes(QUEUED_LIE), `a failed READ must not claim the action was queued: ${text(root)}`);

  const retry = retryButton(root);
  assert.ok(retry, "the failure block must carry «Повторить»");
  const before = api.count("/v1/users/me");
  api.answers.set("/v1/users/me", { id: 1, username: "ivan", name: "Иван", bio: "", display_currency: "RUB" });
  retry.click();
  await settle();
  await settle();
  assert.ok(api.count("/v1/users/me") > before, "«Повторить» must actually re-read the profile");
  assert.equal(stateBlocks(root).length, 0, "a successful retry must replace the failure block with the form");
  assert.ok(text(root).includes("Иван"), "the profile that finally loaded must be on screen");
});

test("V160: Settings «Приватность» reports a server failure as a failure, with a way back", async () => {
  const api = new ScriptedApi("server");
  const root = mountSettings(api);
  await settle();
  await openSection(root, "Приватность");

  const block = stateBlocks(root)[0];
  assert.ok(block, "a failed privacy read must render a failure block");
  assert.equal(block.getAttribute("data-tone"), "error", "a 500 is a server error, not an offline state");
  const retry = retryButton(root);
  assert.ok(retry, "the failure block must carry «Повторить»");
  const before = api.count("/v1/privacy");
  retry.click();
  await settle();
  await settle();
  assert.ok(api.count("/v1/privacy") > before, "«Повторить» must actually re-read the privacy map");
});

test("V160: a failed bot list is not rendered as «у вас пока нет ботов»", async () => {
  const api = new ScriptedApi("offline");
  const root = (createBotsScreen({ api, i18n, onBack: () => {} }) as unknown as { root: StubNode }).root;
  await settle();
  await settle();

  assert.ok(
    !text(root).includes(i18n.t("bots.emptyTitle")),
    `a failed read must not claim the account owns no bots: ${text(root)}`,
  );
  assert.ok(
    !buttons(root).some((b) => b.textContent.includes(i18n.t("bots.createFirst"))),
    "«Создать первого бота» is an answer to an empty account, not to a failed read",
  );
  assert.equal(stateBlocks(root).length, 1, "a failed bot read must render the shared failure block");

  const retry = retryButton(root);
  assert.ok(retry, "the failure block must carry «Повторить»");
  const before = api.count("/v1/bots");
  api.answers.set("/v1/bots", { bots: [{
    id: 7, username: "my_service_bot", name: "Мой бот", description: "", suspended: false,
    commands: [], webhook: { configured: false, url: null },
  }] });
  retry.click();
  await settle();
  await settle();
  assert.ok(api.count("/v1/bots") > before, "«Повторить» must actually re-read the bot list");
  assert.ok(text(root).includes("Мой бот"), "the bot that finally loaded must be on screen");
  assert.equal(stateBlocks(root).length, 0, "a successful retry must clear the failure block");
});

test("V160: a bot that will not open leaves the list standing and no queued-write lie", async () => {
  // The narrow read: tapping a row. The rows must stay (the tap itself is the retry) and the notice
  // must not promise a queue — GET /v1/bots/:id enqueues nothing when it fails.
  const api = new ScriptedApi("offline");
  api.answers.set("/v1/bots", { bots: [{
    id: 7, username: "my_service_bot", name: "Мой бот", description: "", suspended: false,
    commands: [], webhook: { configured: false, url: null },
  }] });
  const root = (createBotsScreen({ api, i18n, onBack: () => {} }) as unknown as { root: StubNode }).root;
  await settle();
  await settle();
  assert.ok(text(root).includes("Мой бот"), "precondition: the list loaded");

  const row = root.findAll((n) => n.hasClass("gc-bot-row"))[0];
  assert.ok(row, "precondition: the bot has a row");
  row.click();
  await settle();
  await settle();

  assert.ok(text(root).includes("Мой бот"), "a failed open must not take the list away");
  assert.equal(stateBlocks(root).length, 0, "a loaded list is not replaced by a failure block");
  assert.ok(!text(root).includes(QUEUED_LIE), `a failed READ must not claim the action was queued: ${text(root)}`);
});

test("V160: a failed block list says so inside the list and can be retried", async () => {
  const api = new ScriptedApi("offline");
  const root = (createSafetyScreen({
    api, i18n, selfId: 1, deleteAccount: () => Promise.resolve({ ok: true } as never),
  }) as unknown as { root: StubNode }).root;
  await settle();
  await settle();

  const list = root.findAll((n) => n.hasClass("gc-safety-list"))[0];
  assert.ok(list, "precondition: the list container exists");
  assert.ok(list.children.length > 0, "a failed block read must not leave the list silently empty");
  assert.ok(
    !text(list).includes(i18n.t("safety.noneBlocked")),
    "a failed read must not claim nobody is blocked",
  );

  const retry = retryButton(root);
  assert.ok(retry, "the failed block list must carry «Повторить»");
  const blockBtn = buttons(root).find((b) => b.textContent.trim() === i18n.t("safety.block"));
  assert.ok(blockBtn, "precondition: the block button exists");
  assert.equal(blockBtn.getAttribute("disabled") !== null || (blockBtn as unknown as { disabled?: boolean }).disabled === true, true,
    "precondition: blocking is held back while the list is unknown");

  const before = api.count("/v1/blocks");
  api.answers.set("/v1/blocks", []);
  retry.click();
  await settle();
  await settle();
  assert.ok(api.count("/v1/blocks") > before, "«Повторить» must actually re-read the block list");
  assert.equal((blockBtn as unknown as { disabled?: boolean }).disabled, false,
    "after a successful retry the screen must stop holding «Заблокировать» back");
});
