import test from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createDevicesScreen, qrLoginToken, type DeviceSession } from "../src/screens/devices_screen.ts";
import { createSettingsScreen } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

const sessions: DeviceSession[] = [
  {
    id: 11,
    device: "GreenChat Android 1.2.0",
    device_label: "Green Chat на Android",
    ip: "198.51.100.10",
    created_at: 1_720_000_000,
    last_active_at: 1_720_000_100,
    current: true,
    device_bound: true,
    wiped: false,
    wipe_delivered: false,
  },
  {
    id: 12,
    device: "GreenChat Desktop Windows x64 1.2.0",
    device_label: "Green Chat на Windows",
    ip: "203.0.113.12",
    created_at: 1_719_000_000,
    last_active_at: 1_720_000_050,
    current: false,
    device_bound: true,
    wiped: false,
    wipe_delivered: false,
  },
];

class Api implements ApiLike {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  get<T>(path: string): Promise<T> {
    this.calls.push({ method: "GET", path });
    if (path === "/v1/auth/sessions") return Promise.resolve(sessions.map((item) => ({ ...item })) as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ method: "POST", path, body });
    if (path === "/v1/auth/sessions/12/revoke") return Promise.resolve({ revoked: true } as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

function byAction(root: StubNode, action: string): StubNode {
  const found = root.find((node) => node.tag === "button" && node.attrs["data-action"] === action);
  assert.ok(found, `${action} not found in ${root.textContent}`);
  return found;
}

test("Settings exposes a Devices row that opens the live account session inventory", async () => {
  const api = new Api();
  const settings = createSettingsScreen({ api, i18n, onBack() {} });
  await settle();
  const root = settings.root as unknown as StubNode;
  const row = root.find((node) => node.tag === "button" && node.attrs["data-tab"] === "devices");
  assert.ok(row, "the Settings index must expose the Devices section");
  assert.equal(row.textContent, i18n.t("settings.tabDevices"));

  row.dispatch("click");
  await settle();
  const header = root.find((node) => node.hasClass("gc-settings-title"));
  assert.equal(header?.textContent, i18n.t("settings.tabDevices"));
  assert.match(root.textContent, /Твои устройства в Green Chat/);
  assert.match(root.textContent, /Green Chat на Windows/);
  settings.destroy();
});

test("devices page lists the current and remote sessions, and only a remote one can be detached", async () => {
  const api = new Api();
  const screen = createDevicesScreen({ api, i18n });
  await settle();
  const root = screen.root as unknown as StubNode;

  assert.match(root.textContent, /Green Chat на Android/);
  assert.match(root.textContent, /Green Chat на Windows/);
  const disconnects = root.findAll((node) => node.tag === "button" && node.attrs["data-action"] === "disconnect-device");
  assert.equal(disconnects.length, 1, "the current session must not expose a detach action");
  assert.equal(disconnects[0].attrs["data-session-id"], "12");
  screen.destroy();
});

test("detaching a device asks for the account password and sends it only on confirmation", async () => {
  const api = new Api();
  const screen = createDevicesScreen({ api, i18n });
  await settle();
  const root = screen.root as unknown as StubNode;

  byAction(root, "disconnect-device").dispatch("click");
  const password = root.find((node) => node.tag === "input" && node.attrs.type === "password");
  assert.ok(password, "password reauthentication input is visible after detach is requested");
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0, "opening confirmation is read-only");

  password.value = "Secret account password";
  const form = root.find((node) => node.tag === "form" && node.hasClass("gc-device-confirm"));
  assert.ok(form);
  form.dispatch("submit");
  await settle();
  await settle();

  assert.deepEqual(api.calls.at(-1), {
    method: "POST",
    path: "/v1/auth/sessions/12/revoke",
    body: { password: "Secret account password" },
  });
  assert.doesNotMatch(root.textContent, /Green Chat на Windows/);
  assert.match(root.textContent, /Green Chat на Android/);
  screen.destroy();
});

test("QR parser accepts the native deep link, a web route and a raw token, but rejects arbitrary text", () => {
  const token = "a".repeat(96);
  assert.equal(qrLoginToken(token), token);
  assert.equal(qrLoginToken(`greenchat://auth/qr/${token}`), token);
  assert.equal(qrLoginToken(`https://chat.example/#/auth/qr/${token}`), token);
  assert.equal(qrLoginToken("not a QR login"), null);
});
