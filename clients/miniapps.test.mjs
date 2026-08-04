import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  miniAppFramePolicy,
  miniAppNeedsConsentData,
  parseMiniAppBridgeMessage,
  safeMiniAppExternalUrl,
  validateMiniAppOrigin,
} from "./ui/src/screens/miniapps_model.ts";
import { WEB_ROUTES } from "./ui/src/router.ts";

test("Mini Apps routes are canonical and separate from bots", () => {
  assert.ok(WEB_ROUTES.some((route) => route.name === "miniapps" && route.pattern === "/miniapps"));
  assert.ok(WEB_ROUTES.some((route) => route.name === "miniapp" && route.pattern === "/miniapp/:id"));
});

test("Mini App frame policy is sandboxed and denies sensitive browser capabilities", () => {
  const policy = miniAppFramePolicy();
  assert.match(policy.sandbox, /allow-scripts/);
  assert.match(policy.sandbox, /allow-same-origin/);
  assert.doesNotMatch(policy.sandbox, /allow-top-navigation/);
  assert.doesNotMatch(policy.sandbox, /allow-downloads/);

  assert.doesNotMatch(policy.sandbox, /allow-popups/);
  assert.match(policy.allow, /camera 'none'/);
  assert.match(policy.allow, /microphone 'none'/);
  assert.match(policy.allow, /geolocation 'none'/);
  assert.match(policy.allow, /payment 'none'/);
  assert.equal(policy.referrerPolicy, "no-referrer");

  assert.equal(policy.credentialless, true);
  assert.match(policy.csp, /script-src 'self'/);
  assert.match(policy.csp, /frame-src 'none'/);
  assert.match(policy.csp, /object-src 'none'/);

  const withOfficialSdk = miniAppFramePolicy("https://greenchat.example");
  assert.match(withOfficialSdk.csp, /script-src 'self' https:\/\/greenchat\.example/);
});

test("Mini App bridge accepts only the versioned allowlist", () => {
  assert.deepEqual(parseMiniAppBridgeMessage({
    type: "greenchat:miniapp",
    version: 1,
    id: "r1",
    method: "requestTheme",
  }), {
    type: "greenchat:miniapp",
    version: 1,
    id: "r1",
    method: "requestTheme",
  });
  assert.equal(parseMiniAppBridgeMessage({ type: "greenchat:miniapp", version: 1, id: "x", method: "eval" }), null);
  assert.equal(parseMiniAppBridgeMessage({ type: "greenchat:miniapp", version: 2, id: "x", method: "ready" }), null);
});

test("Mini App URLs are HTTPS-only and bound to the published origin", () => {
  assert.equal(validateMiniAppOrigin("https://app.example/path", "https://app.example"), "https://app.example/path");
  assert.equal(validateMiniAppOrigin("https://evil.example/path", "https://app.example"), null);
  assert.equal(validateMiniAppOrigin("http://app.example/path", "http://app.example"), null);

  assert.equal(
    validateMiniAppOrigin("https://greenchat.example/app", "https://greenchat.example", "https://greenchat.example"),
    null,
    "a same-origin frame cannot combine allow-scripts with allow-same-origin",
  );
  assert.equal(safeMiniAppExternalUrl("https://docs.example/help"), "https://docs.example/help");
  assert.equal(safeMiniAppExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeMiniAppExternalUrl("http://docs.example/help"), null);
});

test("Mini App consent data is extracted only from an explicit structured verdict", () => {
  const app = {
    id: 9, bot_user_id: 9,
    bot: { id: 9, username: "shopbot", name: "Shop", avatar_file_id: null },
    title: "Shop", description: "", launch_url: "https://shop.example/", launch_origin: "https://shop.example",
    icon_file_id: null, requested_scopes: ["user.basic", "theme"], status: "active", version: 1,
    created_at: 1, updated_at: 1, published_at: 1,
  };
  const parsed = miniAppNeedsConsentData({ data: { consent_required: true, app, scopes: ["theme", "user.basic"] } });
  assert.deepEqual(parsed?.scopes, ["user.basic", "theme"]);
  assert.equal(miniAppNeedsConsentData({ data: { app, scopes: [] } }), null);
});

test("published Mini App SDK contains no dynamic code execution and exposes the native namespace", async () => {
  const source = await readFile(new URL("./web/public/miniapp-sdk.js", import.meta.url), "utf8");
  assert.match(source, /GreenChat/);
  assert.match(source, /MiniApp/);
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new\s+Function\s*\(/);
  assert.match(source, /greenchat:init/);
  assert.match(source, /greenchat:host-response/);
  assert.match(source, /document\.currentScript/);
  assert.match(source, /event\.origin !== sdkOrigin/);
  assert.match(source, /MainButton/);
  assert.match(source, /BackButton/);
  assert.match(source, /SettingsButton/);
  assert.match(source, /mainButtonPressed/);
  assert.match(source, /setMainButton/);
  assert.match(source, /openInvoice/);
  assert.match(source, /invoicePaid/);
});


test("Mini App SDK synchronises controls and accepts press events only from the pinned host", async () => {
  const source = await readFile(new URL("./web/public/miniapp-sdk.js", import.meta.url), "utf8");
  const outbound = [];
  let onMessage = null;
  const parent = {
    postMessage(message, origin) { outbound.push({ message, origin }); },
  };
  const document = { currentScript: { src: "https://greenchat.example/miniapp-sdk.js" } };
  const sdkSetTimeout = (handler, delay) => {
    const timer = setTimeout(handler, delay);
    timer.unref();
    return timer;
  };
  const window = {
    parent,
    document,
    setTimeout: sdkSetTimeout,
    clearTimeout,
    addEventListener(type, handler) { if (type === "message") onMessage = handler; },
    GreenChat: undefined,
  };
  vm.runInNewContext(source, {
    window,
    URL,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    Array,
    setTimeout: sdkSetTimeout,
    clearTimeout,
  });
  assert.equal(typeof onMessage, "function");
  onMessage({
    source: parent,
    origin: "https://greenchat.example",
    data: {
      type: "greenchat:init",
      version: 1,
      initData: "app_id=1&hash=x",
      initDataUnsafe: {},
      themeParams: {},
      bridge: { version: 1, methods: ["setMainButton", "setBackButton", "setSettingsButton", "openInvoice"] },
    },
  });

  const answerLast = async (promise) => {
    const request = outbound.at(-1).message;
    onMessage({
      source: parent,
      origin: "https://greenchat.example",
      data: { type: "greenchat:host-response", version: 1, id: request.id, ok: true, result: { applied: true } },
    });
    await promise;
    return request;
  };

  const setText = window.GreenChat.MiniApp.MainButton.setText("Pay");
  const first = await answerLast(setText);
  assert.equal(first.method, "setMainButton");
  assert.deepEqual(
    JSON.parse(JSON.stringify(first.payload)),
    { visible: false, text: "Pay", enabled: true, loading: false },
  );

  const show = window.GreenChat.MiniApp.MainButton.show();
  const second = await answerLast(show);
  assert.equal(second.payload.visible, true);

  let presses = 0;
  const unsubscribe = window.GreenChat.MiniApp.MainButton.onClick(() => { presses += 1; });
  onMessage({
    source: {},
    origin: "https://evil.example",
    data: { type: "greenchat:event", version: 1, event: "mainButtonPressed" },
  });
  assert.equal(presses, 0);
  onMessage({
    source: parent,
    origin: "https://greenchat.example",
    data: { type: "greenchat:event", version: 1, event: "mainButtonPressed" },
  });
  assert.equal(presses, 1);
  const invoiceCode = "0123456789abcdef0123456789abcdef";
  const opened = window.GreenChat.MiniApp.openInvoice(invoiceCode.toUpperCase());
  const invoiceRequest = outbound.at(-1).message;
  assert.equal(invoiceRequest.method, "openInvoice");
  assert.deepEqual(JSON.parse(JSON.stringify(invoiceRequest.payload)), { code: invoiceCode });
  onMessage({
    source: parent,
    origin: "https://greenchat.example",
    data: { type: "greenchat:host-response", version: 1, id: invoiceRequest.id, ok: true, result: { opened: true } },
  });
  await opened;
  await assert.rejects(() => window.GreenChat.MiniApp.openInvoice("not-a-code"), /32 hexadecimal/);

  let invoicePaid = null;
  window.GreenChat.MiniApp.onInvoicePaid((payload) => { invoicePaid = payload; });
  onMessage({
    source: {},
    origin: "https://evil.example",
    data: { type: "greenchat:event", version: 1, event: "invoicePaid", payload: { code: invoiceCode, status: "paid" } },
  });
  assert.equal(invoicePaid, null);
  onMessage({
    source: parent,
    origin: "https://greenchat.example",
    data: {
      type: "greenchat:event",
      version: 1,
      event: "invoicePaid",
      payload: { code: invoiceCode, status: "paid", pin: "8642" },
    },
  });
  assert.equal(invoicePaid, null, "even the pinned host cannot deliver an invoice event with extra fields");
  onMessage({
    source: parent,
    origin: "https://greenchat.example",
    data: { type: "greenchat:event", version: 1, event: "invoicePaid", payload: { code: invoiceCode, status: "paid" } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(invoicePaid)), { code: invoiceCode, status: "paid" });

  unsubscribe();
});
