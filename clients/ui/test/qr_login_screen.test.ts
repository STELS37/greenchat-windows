import test from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createQrLoginScreen } from "../src/screens/qr_login_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
const TOKEN = "d".repeat(96);

class Api implements ApiLike {
  calls: Array<{ path: string; body: unknown }> = [];
  post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    if (path === "/v1/auth/qr/info") return Promise.resolve({
      device: "GreenChat Desktop macOS aarch64 1.0.0",
      device_label: "Green Chat on macOS",
      ip: "203.0.113.7",
      started_at: 1_700_000_000,
      expires_at: 1_700_000_120,
    } as T);
    if (path === "/v1/auth/qr/approve") return Promise.resolve({ approved: true } as T);
    if (path === "/v1/auth/qr/deny") return Promise.resolve({ denied: true } as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  get<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

function action(root: StubNode, name: string): StubNode {
  const found = root.find((node) => node.tag === "button" && node.attrs["data-action"] === name);
  assert.ok(found, `action ${name} not found in ${root.textContent}`);
  return found;
}

test("QR approval previews device/IP and never approves merely by opening the link", async () => {
  const api = new Api();
  const screen = createQrLoginScreen({ api, i18n, token: TOKEN, onDone() {} });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.match(root.textContent, /Green Chat on macOS/);
  assert.match(root.textContent, /203\.0\.113\.7/);
  assert.deepEqual(api.calls, [{ path: "/v1/auth/qr/info", body: { qr_token: TOKEN } }]);

  action(root, "approve").dispatch("click");
  await settle();
  assert.deepEqual(api.calls[1], { path: "/v1/auth/qr/approve", body: { qr_token: TOKEN } });
  assert.match(root.textContent, /Вход подтверждён/);
  screen.destroy();
});

test("QR denial is a visible explicit mutation", async () => {
  const api = new Api();
  const screen = createQrLoginScreen({ api, i18n, token: TOKEN, onDone() {} });
  await settle();
  const root = screen.root as unknown as StubNode;
  action(root, "deny").dispatch("click");
  await settle();
  assert.deepEqual(api.calls[1], { path: "/v1/auth/qr/deny", body: { qr_token: TOKEN } });
  assert.match(root.textContent, /Вход отклонён/);
  screen.destroy();
});
