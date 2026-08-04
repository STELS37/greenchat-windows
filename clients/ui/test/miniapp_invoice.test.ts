import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMiniAppInvoiceCode,
  parseMiniAppInvoiceRequest,
  parseMiniAppInvoiceResult,
} from "../src/screens/miniapps_model.ts";

const CODE = "0123456789abcdef0123456789abcdef";

test("Mini App invoice requests accept only one canonical 32-byte-hex field", () => {
  assert.deepEqual(parseMiniAppInvoiceRequest({ code: CODE.toUpperCase() }), { code: CODE });
  assert.equal(parseMiniAppInvoiceRequest({ code: CODE, amount: "1" }), null);
  assert.equal(parseMiniAppInvoiceRequest({ code: "g".repeat(32) }), null);
  assert.equal(parseMiniAppInvoiceRequest({ code: CODE.slice(1) }), null);
  assert.equal(parseMiniAppInvoiceRequest([CODE]), null);
  assert.equal(normalizeMiniAppInvoiceCode(` ${CODE.toUpperCase()} `), CODE);
});

test("Mini App invoice preview is a strict open bot invoice with canonical money fields", () => {
  const raw = {
    invoice: {
      code: CODE,
      creator_kind: "bot",
      creator_id: 42,
      asset: "GUSD",
      amount: "12.50",
      description: "Order 17",
      status: "open",
      expires_at: 2_000_000_000,
      paid_by: null,
      extra_server_field: "ignored",
    },
    link: `gcpay://invoice/${CODE}`,
  };
  assert.deepEqual(parseMiniAppInvoiceResult(raw, CODE), {
    code: CODE,
    creator_kind: "bot",
    creator_id: 42,
    asset: "GUSD",
    amount: "12.50",
    description: "Order 17",
    status: "open",
    expires_at: 2_000_000_000,
  });

  assert.equal(
    parseMiniAppInvoiceResult({ invoice: { ...raw.invoice, asset: "tUSDT" } }, CODE)?.asset,
    "tUSDT",
    "mixed-case canonical asset identifiers from the wallet API are accepted",
  );

  assert.equal(parseMiniAppInvoiceResult({ invoice: { ...raw.invoice, creator_kind: "user" } }, CODE), null);
  assert.equal(parseMiniAppInvoiceResult({ invoice: { ...raw.invoice, status: "paid" } }, CODE), null);
  assert.equal(parseMiniAppInvoiceResult({ invoice: { ...raw.invoice, amount: "12.5000000000" } }, CODE), null);
  assert.equal(parseMiniAppInvoiceResult({ invoice: { ...raw.invoice, amount: "0.00" } }, CODE), null);
  assert.equal(parseMiniAppInvoiceResult(raw, "f".repeat(32)), null);
});

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createMiniAppHost } from "../src/screens/miniapp_host.ts";
import type { MiniAppLaunch } from "../src/screens/miniapps_model.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });
const OTHER_CODE = "fedcba9876543210fedcba9876543210";

const launch: MiniAppLaunch = {
  app: {
    id: 42,
    bot_user_id: 42,
    bot: { id: 42, username: "ordersbot", name: "Orders Bot", avatar_file_id: null },
    title: "Orders",
    description: "Order console",
    launch_url: "https://mini.example/app",
    launch_origin: "https://mini.example",
    icon_file_id: null,
    requested_scopes: ["user.basic", "theme", "payments.invoice"],
    status: "active",
    version: 1,
    created_at: 1,
    updated_at: 1,
    published_at: 1,
  },
  launch_id: "123e4567-e89b-42d3-a456-426614174000",
  launch_url: "https://mini.example/app",
  launch_origin: "https://mini.example",
  init_data: "app_id=42&hash=abc",
  expires_at: 2_000_000_000,
  scopes: ["user.basic", "theme", "payments.invoice"],
  bridge: {
    version: 1,
    methods: ["ready", "openInvoice"],
  },
};

function apiFailure(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.name = "ApiError";
  error.code = code;
  return error;
}

class InvoiceApi implements ApiLike {
  readonly payBodies: Array<Record<string, unknown>> = [];

  get<T>(path: string): Promise<T> {
    const code = path.split("/").at(-1);
    if (code !== CODE && code !== OTHER_CODE) return Promise.reject(new Error(`unexpected GET ${path}`));
    return Promise.resolve({
      invoice: {
        code,
        creator_kind: "bot",
        creator_id: code === CODE ? 42 : 99,
        asset: "GUSD",
        amount: "12.50",
        description: "Order 17",
        status: "open",
        expires_at: 2_000_000_000,
      },
    } as T);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    if (path === "/v1/miniapps/42/launch") return Promise.resolve(launch as T);
    if (path === `/v1/invoices/${CODE}/pay`) {
      const value = body as Record<string, unknown>;
      this.payBodies.push(value);
      if (typeof value.pin !== "string") return Promise.reject(apiFailure("PIN_REQUIRED"));
      if (value.pin !== "8642") return Promise.reject(apiFailure("PIN_INVALID"));
      return Promise.resolve({ invoice: { code: CODE, status: "paid" } } as T);
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }

  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.resolve({ revoked: true } as T); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

type FrameMessage = {
  type?: string;
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: unknown;
};

test("Mini App invoice uses a GreenChat-owned sheet, same-bot binding and never returns the PIN to the frame", async () => {
  const api = new InvoiceApi();
  const frameMessages: FrameMessage[] = [];
  const frameWindow = { postMessage(message: FrameMessage): void { frameMessages.push(message); } };
  const listeners = new Set<(event: MessageEvent) => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
        if (type === "message") listeners.delete(listener);
      },
      open(): object { return {}; },
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://greenchat.example" },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userActivation: { isActive: true }, clipboard: { writeText: () => Promise.resolve() } },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ getPropertyValue: () => "" }),
  });

  const doc = globalThis.document as unknown as {
    createElement(tag: string): StubNode;
    documentElement: { dataset: Record<string, string> };
  };
  doc.documentElement = { dataset: {} };
  const createElement = doc.createElement.bind(doc);
  doc.createElement = (tag: string): StubNode => {
    const node = createElement(tag);
    if (tag === "iframe") (node as unknown as { contentWindow: unknown }).contentWindow = frameWindow;
    return node;
  };

  const host = createMiniAppHost({ api, i18n, appId: 42, onBack() {} });
  await settle();
  const root = host.root as unknown as StubNode;
  const iframe = root.find((node) => node.tag === "iframe");
  assert.ok(iframe);
  const send = (data: unknown): void => {
    for (const listener of listeners) {
      listener({ data, origin: launch.launch_origin, source: frameWindow } as unknown as MessageEvent);
    }
  };

  send({ type: "greenchat:miniapp", version: 1, id: "open-1", method: "openInvoice", payload: { code: CODE } });
  await settle();
  const sheet = root.find((node) => node.hasClass("gc-miniapp-invoice-sheet"));
  assert.ok(sheet, "the trusted host, not the iframe, renders the payment sheet");
  assert.match(sheet.textContent, /Orders Bot/);
  assert.match(sheet.textContent, /12\.50 GUSD/);
  assert.equal(frameMessages.find((message) => message.id === "open-1")?.ok, true);

  const pay = sheet.find((node) => node.tag === "button" && node.textContent === "Pay");
  assert.ok(pay);
  pay.dispatch("click");
  await settle();
  assert.equal(api.payBodies.length, 1);
  assert.equal("pin" in api.payBodies[0]!, false, "the first attempt lets the server decide whether a PIN is required");

  const pin = sheet.find((node) => node.tag === "input" && node.hasClass("gc-miniapp-invoice-pin"));
  assert.ok(pin);
  pin.value = "8642";
  pay.dispatch("click");
  await settle();
  assert.equal(api.payBodies[1]?.pin, "8642", "the PIN goes only to GreenChat's payment endpoint");
  const paid = frameMessages.find((message) => message.event === "invoicePaid");
  assert.deepEqual(paid?.payload, { code: CODE, status: "paid" });
  assert.equal(JSON.stringify(frameMessages).includes("8642"), false, "no host response or event leaks the PIN into the frame");
  assert.equal(root.find((node) => node.hasClass("gc-miniapp-invoice-sheet")), null);

  const paymentsBeforeCancel = api.payBodies.length;
  send({ type: "greenchat:miniapp", version: 1, id: "open-cancel", method: "openInvoice", payload: { code: CODE } });
  await settle();
  const cancelSheet = root.find((node) => node.hasClass("gc-miniapp-invoice-sheet"));
  assert.ok(cancelSheet);
  const cancel = cancelSheet.find((node) => node.tag === "button" && node.textContent === "Cancel");
  assert.ok(cancel);
  cancel.dispatch("click");
  const closed = frameMessages.find((message) => message.event === "invoiceClosed");
  assert.deepEqual(closed?.payload, { code: CODE, status: "cancelled" });
  assert.equal(api.payBodies.length, paymentsBeforeCancel, "cancelling the system sheet never calls the payment endpoint");
  assert.equal(root.find((node) => node.hasClass("gc-miniapp-invoice-sheet")), null);

  send({ type: "greenchat:miniapp", version: 1, id: "wrong-bot", method: "openInvoice", payload: { code: OTHER_CODE } });
  await settle();
  assert.equal(frameMessages.find((message) => message.id === "wrong-bot")?.ok, false);
  assert.equal(root.find((node) => node.hasClass("gc-miniapp-invoice-sheet")), null, "another bot's invoice is never shown");

  host.destroy();
});
