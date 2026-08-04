import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type {
  ApiLike,
  ResolvedUser,
  SearchUser,
} from "../src/screens/api.ts";
import { createSafetyScreen } from "../src/screens/safety_screen.ts";
import { deferred, installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class SafetyApi implements ApiLike {
  readonly blocks = deferred<unknown>();
  readonly resolved = deferred<ResolvedUser>();
  postCalls = 0;
  get<T>(path: string): Promise<T> {
    if (path === "/v1/blocks") return this.blocks.promise as Promise<T>;
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  resolveUser(): Promise<ResolvedUser> {
    return this.resolved.promise;
  }
  post<T>(): Promise<T> {
    this.postCalls += 1;
    return Promise.reject(new Error("unexpected POST"));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const bot: SearchUser = {
  id: 9,
  username: "latebot",
  name: "Late Bot",
  avatar_file_id: null,
  is_bot: true,
};

class RemountSafetyApi implements ApiLike {
  readonly firstBlocks = deferred<unknown>();
  readonly secondBlocks = deferred<unknown>();
  readonly resolved = deferred<ResolvedUser>();
  readonly posted = deferred<SearchUser>();
  getCalls = 0;
  postCalls = 0;

  get<T>(path: string): Promise<T> {
    if (path !== "/v1/blocks")
      return Promise.reject(new Error(`unexpected GET ${path}`));
    this.getCalls += 1;
    const result = this.getCalls === 1 ? this.firstBlocks : this.secondBlocks;
    return result.promise as Promise<T>;
  }
  resolveUser(): Promise<ResolvedUser> {
    return this.resolved.promise;
  }
  post<T>(): Promise<T> {
    this.postCalls += 1;
    return this.posted.promise as Promise<T>;
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function blockControls(root: StubNode): {
  input: StubNode;
  button: StubNode;
} {
  const input = root.find(
    (node) => node.tag === "input" && node.attrs.type === "text",
  );
  const button = root.find(
    (node) =>
      node.tag === "button" && node.textContent === i18n.t("safety.block"),
  );
  assert.ok(input && button);
  return { input, button };
}

test("safety central control state blocks actions while the authoritative list loads", async () => {
  const api = new SafetyApi();
  const view = createSafetyScreen({
    api,
    i18n,
    selfId: 1,
    deleteAccount: () => Promise.reject(new Error("unexpected deletion")),
  });
  const root = view.root as unknown as StubNode;
  const block = root.find(
    (node) =>
      node.tag === "button" && node.textContent === i18n.t("safety.block"),
  );
  assert.ok(block);
  assert.equal(block.disabled, true);

  api.blocks.resolve([]);
  await settle();
  assert.equal(block.disabled, false);
  view.destroy();
});

test("safety keeps block actions fail-closed after a malformed blocked-user response", async () => {
  const api = new SafetyApi();
  const view = createSafetyScreen({
    api,
    i18n,
    selfId: 1,
    deleteAccount: () => Promise.reject(new Error("unexpected deletion")),
  });
  const root = view.root as unknown as StubNode;
  const block = root.find(
    (node) =>
      node.tag === "button" && node.textContent === i18n.t("safety.block"),
  );
  const status = root.find((node) => node.attrs.role === "status");
  assert.ok(block && status);

  api.blocks.resolve({ users: [] });
  await settle();

  assert.equal(block.disabled, true);
  // V160: the same fail-closed contract, told in a place that can act on it. The reason moved from
  // the status line into the list — where the missing rows are — and now carries a retry, so the
  // screen is no longer a dead end. The status line is left empty on purpose: both nodes are
  // role="status", and two live regions would announce the same sentence twice.
  assert.equal(status.textContent, "");
  const failure = root.find((node) => node.hasClass("gc-state"));
  assert.ok(failure, "the failed read must be reported inside the list");
  assert.equal(failure.textContent.includes(i18n.t("safety.error.invalid_response")), true);
  assert.ok(
    root.find((node) => node.tag === "button" && node.textContent === i18n.t("common.retry")),
    "and it must offer a way to try again",
  );
  view.destroy();
});

test("safety ignores a late action rejection after destroy", async () => {
  const api = new SafetyApi();
  const view = createSafetyScreen({
    api,
    i18n,
    selfId: 1,
    deleteAccount: () => Promise.reject(new Error("unexpected deletion")),
  });
  const root = view.root as unknown as StubNode;
  api.blocks.resolve([]);
  await settle();

  const input = root.find(
    (node) => node.tag === "input" && node.attrs.type === "text",
  );
  const block = root.find(
    (node) =>
      node.tag === "button" && node.textContent === i18n.t("safety.block"),
  );
  const status = root.find((node) => node.attrs.role === "status");
  assert.ok(input && block && status);
  input.value = "latebot";
  block.dispatch("click");
  view.destroy();
  api.resolved.reject(new Error("late failure"));
  await settle();

  assert.equal(
    status.textContent,
    "",
    "a detached screen must not publish a late error",
  );
});

test("destroyed safety view cannot POST after delayed username resolution", async () => {
  const api = new SafetyApi();
  const view = createSafetyScreen({
    api,
    i18n,
    selfId: 1,
    deleteAccount: () => Promise.reject(new Error("unexpected deletion")),
  });
  api.blocks.resolve([]);
  await settle();
  const { input, button } = blockControls(view.root as unknown as StubNode);
  input.value = bot.username;
  button.dispatch("click");
  view.destroy();

  api.resolved.resolve(bot);
  await settle();

  assert.equal(api.postCalls, 0, "destroyed view must not start a late POST");
});

test("remounted safety waits for the prior mutation before authoritative reload", async () => {
  const api = new RemountSafetyApi();
  const first = createSafetyScreen({
    api,
    i18n,
    selfId: 1,
    deleteAccount: () => Promise.reject(new Error("unexpected deletion")),
  });
  api.firstBlocks.resolve([]);
  await settle();
  const firstControls = blockControls(first.root as unknown as StubNode);
  firstControls.input.value = bot.username;
  firstControls.button.dispatch("click");
  api.resolved.resolve(bot);
  await settle();
  assert.equal(api.postCalls, 1, "the original view started its mutation");
  first.destroy();

  const second = createSafetyScreen({
    api,
    i18n,
    selfId: 1,
    deleteAccount: () => Promise.reject(new Error("unexpected deletion")),
  });
  await settle();
  assert.equal(
    api.getCalls,
    1,
    "remount must not read stale blocks while the previous POST is pending",
  );

  api.posted.resolve(bot);
  await settle();
  assert.equal(api.getCalls, 2, "remount reloads after the mutation settles");
  api.secondBlocks.resolve([bot]);
  await settle();

  const rendered = (second.root as unknown as StubNode).find(
    (node) => node.hasClass("gc-safety-user") && node.textContent.includes("@latebot"),
  );
  assert.ok(rendered, "the authoritative post-mutation block list is rendered");
  second.destroy();
});
