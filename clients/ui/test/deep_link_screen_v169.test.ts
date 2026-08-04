// V169: canonical user / join / invoice links are real screens, not Home under a foreign address.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike, DialogChat, ResolvedUser } from "../src/screens/api.ts";
import {
  createDeepLinkScreen,
  createPublicUserLinkScreen,
  publicUserAppHref,
} from "../src/screens/deep_link_screen.ts";
import { WEB_ROUTES, matchRoutes } from "../src/router.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

class Api implements ApiLike {
  gets: string[] = [];
  posts: Array<{ path: string; body: unknown }> = [];
  user: ResolvedUser = { id: 7, username: "alice", name: "Алиса", avatar_file_id: null, is_bot: false };

  publicProfile = {
    username: "alice",
    name: "Алиса",
    bio: "Публичное описание",
    is_bot: false,
    emoji_status: null,
  };
  invoice = {
    id: 8,
    code: "invoice-code",
    asset: "tUSDT",
    amount: "1250000000",
    description: "Тестовый счёт",
    status: "open",
    expires_at: 2_000_000_000,
  };
  joinResult: unknown = { id: 42 };
  payNeedsPin = false;

  get<T>(path: string): Promise<T> {
    this.gets.push(path);

    if (path.startsWith("/v1/public/users/")) return Promise.resolve({ ...this.publicProfile } as T);
    if (path.startsWith("/v1/invoices/")) return Promise.resolve({ invoice: { ...this.invoice } } as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    this.posts.push({ path, body });
    if (path.startsWith("/v1/join/")) return Promise.resolve(this.joinResult as T);
    if (path.endsWith("/pay")) {
      const pin = (body as Record<string, unknown> | undefined)?.pin;
      if (this.payNeedsPin && pin !== "1234") {
        const error = new Error("pin required");
        error.name = "ApiError";
        (error as Error & { code?: string }).code = "PIN_REQUIRED";
        return Promise.reject(error);
      }
      this.invoice = { ...this.invoice, status: "paid" };
      return Promise.resolve({ invoice: { ...this.invoice } } as T);
    }
    if (path === "/v1/chats/dialog") return Promise.resolve({ id: 91 } as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
  resolveUser(): Promise<ResolvedUser> { return Promise.resolve(this.user); }
  createDialog(): Promise<DialogChat> {
    return Promise.resolve({ id: 91, kind: "dialog", title: "Алиса", username: "alice", my_role: "member", message_ttl_sec: 0, updated_at: 0 });
  }
}

const nodes = (root: StubNode, cls: string): StubNode[] => root.findAll((node) => node.hasClass(cls));
const button = (root: StubNode, text: string): StubNode => {
  const found = root.find((node) => node.tag === "button" && node.textContent.includes(text));
  assert.ok(found, `button «${text}» not found in ${root.textContent}`);
  return found;
};

test("V169: all three canonical links resolve to routes the shell explicitly handles", () => {
  assert.equal(matchRoutes(WEB_ROUTES, "/user/alice")?.name, "user");
  assert.equal(matchRoutes(WEB_ROUTES, "/join/invite-code")?.name, "join");
  assert.equal(matchRoutes(WEB_ROUTES, "/pay/invoice/invoice-code")?.name, "pay");

  const here = fileURLToPath(new URL(".", import.meta.url));
  const app = readFileSync(resolve(here, "../src/screens/app.ts"), "utf8");
  assert.match(app, /r\.name === "user" \|\| r\.name === "join" \|\| r\.name === "pay"/);
  assert.match(app, /createDeepLinkScreen\(/);
});

test("copied user links show a public profile before login and keep an explicit native action", async () => {
  const api = new Api();
  let continued = 0;
  const screen = createPublicUserLinkScreen({
    api,
    i18n,
    value: "@alice",
    onBack() {},
    onContinueWeb() { continued += 1; },
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  assert.deepEqual(api.gets, ["/v1/public/users/alice"]);
  assert.match(root.textContent, /Алиса/);
  assert.match(root.textContent, /Публичное описание/);
  assert.equal(continued, 0, "opening a copied link must not start authentication by itself");

  const openApp = root.find((node) => node.tag === "a" && node.textContent.includes("Открыть в GreenChat"));
  assert.ok(openApp, "the public landing must expose a native GreenChat action");
  assert.equal(openApp.getAttribute("href"), "greenchat://user/alice");
  assert.equal(publicUserAppHref("@alice"), "greenchat://user/alice");

  button(root, "Войти и написать").dispatch("click");
  assert.equal(continued, 1, "web authentication begins only after an explicit press");
  screen.destroy();
});

test("the app shell keeps copied-link destinations through authentication", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const app = readFileSync(resolve(here, "../src/screens/app.ts"), "utf8");
  assert.match(app, /createPublicUserLinkScreen\(/);
  assert.match(app, /r\.name === "user" && authRequestedForPublicPath !== r\.path/);
  assert.match(app, /r\.name === "authQr" \|\| r\.name === "user" \|\| r\.name === "join" \|\| r\.name === "pay"/);
});

test("V169: a user link loads a profile and opens its dialog only after a press", async () => {
  const api = new Api();
  let opened = 0;
  const screen = createDeepLinkScreen({ api, i18n, kind: "user", value: "@alice", onBack() {}, onOpenChat(id) { opened = id; } });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.match(root.textContent, /Алиса/);
  assert.equal(opened, 0, "loading a profile must not create/open a dialog automatically");
  button(root, "Открыть диалог").dispatch("click");
  await settle();
  assert.equal(opened, 91);
  screen.destroy();
});



test("V169: a deleted profile is a final honest state, not a generic retry loop", async () => {
  const api = new Api();
  api.user = { id: 7, deleted: true };
  const screen = createDeepLinkScreen({ api, i18n, kind: "user", value: "gone", onBack() {}, onOpenChat() {} });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.match(root.textContent, /Этот аккаунт удалён/);
  assert.doesNotMatch(root.textContent, /Повторить/);
  screen.destroy();
});

test("V169: an invitation never mutates membership until the visible Join button is pressed", async () => {
  const api = new Api();
  let opened = 0;
  const screen = createDeepLinkScreen({ api, i18n, kind: "join", value: "invite-code", onBack() {}, onOpenChat(id) { opened = id; } });
  const root = screen.root as unknown as StubNode;
  assert.equal(api.posts.length, 0, "opening the link is read-only");
  assert.match(root.textContent, /никогда не делает это автоматически/);
  button(root, "Вступить").dispatch("click");
  await settle();
  assert.deepEqual(api.posts[0], { path: "/v1/join/invite-code", body: {} });
  assert.equal(opened, 42);
  screen.destroy();
});

test("V169: an approval-only invite reports a pending request instead of opening a chat", async () => {
  const api = new Api();
  api.joinResult = { ok: true, pending: true, chat_id: 44 };
  let opened = 0;
  const screen = createDeepLinkScreen({ api, i18n, kind: "join", value: "approve", onBack() {}, onOpenChat(id) { opened = id; } });
  const root = screen.root as unknown as StubNode;
  button(root, "Вступить").dispatch("click");
  await settle();
  assert.equal(opened, 0);
  assert.match(root.textContent, /Заявка отправлена/);
  screen.destroy();
});

test("V169: an invoice is previewed first, pays the exact nano amount, and retries with a requested PIN", async () => {
  const api = new Api();
  api.payNeedsPin = true;
  const screen = createDeepLinkScreen({
    api,
    i18n,
    kind: "pay",
    value: "invoice-code",
    onBack() {},
    onOpenChat() {},
    makeClientRef: () => "deep-invoice-1",
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.deepEqual(api.gets, ["/v1/invoices/invoice-code"]);
  assert.match(root.textContent, /1\.25 tUSDT/);
  assert.equal(api.posts.length, 0, "previewing a payment link is read-only");

  button(root, "Оплатить").dispatch("click");
  await settle();
  assert.deepEqual(api.posts[0], {
    path: "/v1/invoices/invoice-code/pay",
    body: { amount: "1250000000", client_op_id: "deep-invoice-1" },
  });
  assert.match(root.textContent, /Введите платёжный PIN/);
  const pin = nodes(root, "gc-input")[0];
  assert.ok(pin, "PIN field appears only after the server requests it");
  pin.value = "1234";
  pin.dispatch("input");
  button(root, "Оплатить").dispatch("click");
  await settle();
  assert.deepEqual(api.posts[1], {
    path: "/v1/invoices/invoice-code/pay",
    body: { amount: "1250000000", client_op_id: "deep-invoice-1", pin: "1234" },
  });
  assert.match(root.textContent, /Счёт оплачен/);
  screen.destroy();
});


test("V169: an expired invoice is visibly expired and cannot issue a payment request", async () => {
  const api = new Api();
  const screen = createDeepLinkScreen({
    api,
    i18n,
    kind: "pay",
    value: "invoice-code",
    onBack() {},
    onOpenChat() {},
    now: () => 2_000_000_001,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.match(root.textContent, /Истёк/);
  const pay = button(root, "Оплатить");
  assert.equal(pay.disabled, true);
  pay.dispatch("click");
  await settle();
  assert.equal(api.posts.length, 0);
  screen.destroy();
});
