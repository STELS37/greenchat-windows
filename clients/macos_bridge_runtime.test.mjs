import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const bridgeSource = readFileSync(resolve(root, "desktop/src-tauri/src/bridge.js"), "utf8");

function runtime() {
  let focused = true;
  const calls = [];
  const listeners = {};
  const fetches = [];
  let socketUrl = null;
  const values = new Map([["gc.session", "STALE-PLAINTEXT"], ["theme", "dark"]]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  function FakeWebSocket(url) { socketUrl = String(url); }
  FakeWebSocket.OPEN = 1; FakeWebSocket.CONNECTING = 0; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype = {};
  const window = {
    __TAURI__: {
      core: { invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "update_target") return ["darwin", "aarch64", "1.2.3"];
        if (command === "must_force_update") return false;
        if (command === "check_update") return { availableVersion: null };
        if (command === "desktop_identity") return { platform: "desktop", os: "macos", arch: "aarch64" };
        if (command === "notification_permission") return "granted";
        if (command === "request_notification_permission") return "granted";
        if (command === "autostart_get") return false;
        if (command === "autostart_set") return null;
        return null;
      } },
      event: { listen: async (name, listener) => { listeners[name] = listener; return () => delete listeners[name]; } },
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      fetches.push({ url: String(input instanceof Request ? input.url : input), headers });
      return { ok: false, json: async () => null };
    },
    WebSocket: FakeWebSocket,
    localStorage: storage,
    location: { href: "tauri://localhost/", origin: "tauri://localhost", hash: "" },
  };
  window.window = window;
  const navigator = {};
  const document = {
    readyState: "loading", hasFocus: () => focused, addEventListener: () => {},
    body: { appendChild: () => {} }, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }),
    getElementById: () => null,
  };
  const context = vm.createContext({ window, navigator, document, URL, Request, Headers, Promise, console, setTimeout, clearTimeout, location: window.location });
  const source = bridgeSource
    .replace("__GC_SESSION_SEED__", JSON.stringify('{"access":"a","refresh":"r"}'))
    .replace("__GC_SERVER_ORIGIN__", JSON.stringify("https://api.example.test"))
    .replace("__GC_DESKTOP_OS__", JSON.stringify("macos"))
    .replace("__GC_DESKTOP_ARCH__", JSON.stringify("aarch64"))
    .replace("__GC_DESKTOP_VERSION__", JSON.stringify("1.2.3"));
  vm.runInContext(source, context);
  return { window, navigator, values, calls, listeners, fetches, socket: () => socketUrl, setFocused: (value) => { focused = value; } };
}

test("macOS bridge owns an independent session, routes only GreenChat traffic and persists refresh in Keychain", async () => {
  const r = runtime();
  assert.equal(r.window.__GC_NATIVE.os, "macos");
  assert.equal(r.window.__GC_NATIVE.deviceLabel, "GreenChat Desktop macOS aarch64 1.2.3");
  assert.equal(r.window.localStorage.getItem("gc.session"), '{"access":"a","refresh":"r"}');
  assert.equal(r.values.has("gc.session"), false, "stale plaintext session must be purged");
  assert.equal(r.window.localStorage.getItem("theme"), "dark");

  await r.window.fetch("/v1/chats");
  assert.equal(r.fetches.at(-1).url, "https://api.example.test/v1/chats");
  assert.equal(r.fetches.at(-1).headers.get("x-gc-client"), "desktop/1.2.3");
  assert.equal(r.fetches.at(-1).headers.get("x-device"), "GreenChat Desktop macOS aarch64 1.2.3");
  await r.window.fetch("https://foreign.example/v1/chats");
  assert.equal(r.fetches.at(-1).url, "https://foreign.example/v1/chats");
  assert.equal(r.fetches.at(-1).headers.get("x-device"), null);

  new r.window.WebSocket("/v1/ws");
  assert.equal(r.socket(), "wss://api.example.test/v1/ws");
  r.window.localStorage.setItem("gc.session", "NEW-SESSION");
  r.window.localStorage.removeItem("gc.session");
  await r.window.__gcFlushSessionStorage();
  assert.ok(r.calls.some((x) => x.command === "keyring_set" && x.args.value === "NEW-SESSION"));
  assert.ok(r.calls.some((x) => x.command === "keyring_delete"));
  assert.equal(r.window.localStorage.getItem("gc.session"), null);
  assert.equal(r.window.localStorage.getItem("theme"), "dark");

  await Promise.resolve();
  r.listeners["gc://navigate"]?.({ payload: "#/chat/42" });
  assert.equal(r.window.location.hash, "#/chat/42");
  r.navigator.setAppBadge(3);
  assert.ok(r.calls.some((x) => x.command === "set_unread" && x.args.count === 3));
});


test("desktop notification opt-in, exact-chat target and autostart are native local controls", async () => {
  const r = runtime();
  r.setFocused(false);

  // Default is an explicit local opt-out: unread still updates the Dock/tray, but no OS prompt or
  // notification is produced merely by launching the app.
  await r.navigator.setAppBadge(1);
  assert.ok(r.calls.some((x) => x.command === "set_unread" && x.args.count === 1));
  assert.equal(r.calls.some((x) => x.command === "notify_unread"), false);

  await r.window.__GC_NATIVE.desktopSystem.setNotifications(true);
  assert.ok(r.calls.some((x) => x.command === "request_notification_permission"));
  assert.equal(r.values.get("gc.desktop.notifications.enabled"), "1");
  assert.equal(await r.window.__GC_NATIVE.desktopSystem.getNotifications(), true);

  r.window.__GC_NATIVE.notifications.markChat(42);
  await r.navigator.setAppBadge(3);
  assert.ok(r.calls.some((x) => x.command === "notify_unread" && x.args.count === 3 && x.args.chatId === 42));

  // A later badge increase without a fresh incoming-message marker must not reuse chat 42.
  await r.navigator.setAppBadge(4);
  assert.ok(r.calls.some((x) => x.command === "notify_unread" && x.args.count === 4 && x.args.chatId === null));

  assert.equal(await r.window.__GC_NATIVE.desktopSystem.getAutostart(), false);
  await r.window.__GC_NATIVE.desktopSystem.setAutostart(true);
  assert.ok(r.calls.some((x) => x.command === "autostart_set" && x.args.enabled === true));

  await r.window.__GC_NATIVE.desktopSystem.setNotifications(false);
  assert.equal(r.values.get("gc.desktop.notifications.enabled"), "0");
});
