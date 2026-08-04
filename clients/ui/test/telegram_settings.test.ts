import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import {
  createTelegramSettings,
  type TelegramConnectionPort,
  type TelegramConnectionView,
} from "../src/screens/telegram_settings.ts";

interface StubEvent { key?: string; preventDefault(): void }

class StubNode {
  readonly tag: string;
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(event: StubEvent) => void>> = {};
  value = "";
  checked = false;
  private text = "";
  private readonly isText: boolean;

  constructor(tag: string, isText = false) {
    this.tag = tag;
    this.isText = isText;
  }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  hasAttribute(key: string): boolean { return key in this.attrs; }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  append(...children: Array<StubNode | string>): void {
    for (const child of children) {
      const node = typeof child === "string" ? textNode(child) : child;
      node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(child: StubNode): StubNode { this.append(child); return child; }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  removeChild(child: StubNode): StubNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  addEventListener(type: string, listener: (event: StubEvent) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  focus(): void {}
  click(): void {
    for (const listener of this.listeners["click"] ?? []) listener({ preventDefault() {} });
  }
  keydown(key: string): void {
    for (const listener of this.listeners["keydown"] ?? []) listener({ key, preventDefault() {} });
  }
  find(match: (node: StubNode) => boolean): StubNode | null {
    if (match(this)) return this;
    for (const child of this.children) {
      const found = child.find(match);
      if (found) return found;
    }
    return null;
  }
  findAll(match: (node: StubNode) => boolean): StubNode[] {
    const result: StubNode[] = match(this) ? [this] : [];
    for (const child of this.children) result.push(...child.findAll(match));
    return result;
  }
  get textContent(): string {
    return this.isText ? this.text : this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    if (this.isText) { this.text = value; return; }
    this.children = [];
    if (value) this.append(value);
  }
}

function textNode(text: string): StubNode {
  const node = new StubNode("#text", true);
  node.textContent = text;
  return node;
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new StubNode(tag),
  createElementNS: (_namespace: string, tag: string) => new StubNode(tag),
  createTextNode: textNode,
};

type TelegramAccountInput = Omit<NonNullable<TelegramConnectionView["accounts"]>[number], "syncState" | "unreadCount"> &
  Partial<Pick<NonNullable<TelegramConnectionView["accounts"]>[number], "syncState" | "unreadCount">>;
type TelegramConnectionInput = Omit<TelegramConnectionView,
  "activeSlot" | "accounts" | "canAddAccount" | "totalUnreadCount" | "backgroundReadyCount"> & {
    activeSlot?: string | null;
    accounts?: readonly TelegramAccountInput[];
    canAddAccount?: boolean;
    totalUnreadCount?: number;
    backgroundReadyCount?: number;
  };

function completeView(view: TelegramConnectionInput): TelegramConnectionView {
  const activeSlot = view.activeSlot === undefined ? (view.configured ? "primary" : null) : view.activeSlot;
  const readyId = view.login.status === "ready" ? view.login.account.accountId : undefined;
  const accounts = view.accounts ?? (activeSlot
    ? [{ slot: activeSlot, ...(readyId ? { accountId: readyId } : {}), login: view.login }]
    : []);
  const completeAccounts = accounts.map((account) => ({
    ...account,
    syncState: account.syncState ?? (account.slot === activeSlot ? "active" as const : "background" as const),
    unreadCount: account.unreadCount ?? 0,
  }));
  return {
    ...view,
    activeSlot,
    accounts: completeAccounts,
    canAddAccount: view.canAddAccount ?? view.configured,
    totalUnreadCount: view.totalUnreadCount ?? completeAccounts.reduce((sum, account) => sum + account.unreadCount, 0),
    backgroundReadyCount: view.backgroundReadyCount
      ?? completeAccounts.filter((account) => account.syncState === "background").length,
  };
}

class FakePort implements TelegramConnectionPort {
  view: TelegramConnectionView;
  readonly listeners = new Set<(snapshot: TelegramConnectionView) => void>();
  initializeCalls = 0;
  disconnectCalls = 0;
  removeCalls = 0;
  qrCalls = 0;
  addCalls = 0;
  readonly selectedSlots: string[] = [];
  disconnectGate: Promise<void> | null = null;

  constructor(view: TelegramConnectionInput) { this.view = completeView(view); }
  snapshot(): TelegramConnectionView { return this.view; }
  subscribe(listener: (snapshot: TelegramConnectionView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }
  emit(view: TelegramConnectionInput): void {
    this.view = completeView(view);
    for (const listener of [...this.listeners]) listener(this.view);
  }
  async initialize(): Promise<void> { this.initializeCalls += 1; }
  async addAccount(): Promise<string> { this.addCalls += 1; return "slot.added"; }
  async selectAccount(slot: string): Promise<void> { this.selectedSlots.push(slot); }
  async connectQr(): Promise<void> { this.qrCalls += 1; }
  async connectPhone(): Promise<void> {}
  async submitCode(_code: string): Promise<void> {}
  async submitPassword(_password: string): Promise<void> {}
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    if (this.disconnectGate) await this.disconnectGate;
  }
  async remove(): Promise<void> { this.removeCalls += 1; }
}

const i18n = createI18n({ locale: "en", dicts: { en, ru } });
const ready: TelegramConnectionView = {
  available: true,
  configured: true,
  busy: false,
  runtimeVersion: "1.8.66",
  login: { status: "ready", account: { provider: "telegram", accountId: "9007199254740993" } },
  activeSlot: "primary",
  accounts: [{
    slot: "primary",
    accountId: "9007199254740993",
    login: { status: "ready", account: { provider: "telegram", accountId: "9007199254740993" } },
    syncState: "active",
    unreadCount: 0,
  }],
  canAddAccount: true,
  totalUnreadCount: 0,
  backgroundReadyCount: 0,
};

function button(root: StubNode, label: string): StubNode {
  const found = root.find((node) => node.tag === "button" && node.textContent === label);
  assert.ok(found, `button ${label} exists`);
  return found;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Telegram QR is rendered locally as an accessible SVG and the auth link is not exposed as text", () => {
  const payload = "tg://login?token=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY";
  const port = new FakePort({
    available: true,
    configured: true,
    busy: false,
    login: { status: "awaiting_qr", qrPayload: payload, expiresAt: "2026-07-18T16:00:00.000Z" },
  });
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const root = view.root as unknown as StubNode;
  const svg = root.find((node) => node.tag === "svg" && node.attrs["class"] === "gc-connector-qr");
  assert.ok(svg);
  assert.equal(svg.attrs["role"], "img");
  assert.equal(svg.attrs["aria-label"], en["telegram.qrLabel"]);
  assert.ok(svg.find((node) => node.tag === "path" && (node.attrs["d"]?.length ?? 0) > 100));
  assert.equal(root.textContent.includes(payload), false, "one-time auth payload is not copied into visible text");
  assert.equal(root.find((node) => node.tag === "code"), null);
  assert.equal(root.find((node) => node.tag === "a"), null, "one-time token is not retained in a link attribute");
  assert.equal(
    root.find((node) => Object.values(node.attrs).some((value) => value.includes(payload))),
    null,
    "one-time token is absent from every live DOM attribute",
  );
  view.destroy();
  assert.equal(root.textContent, "", "destroy removes the QR tree from the live DOM");
});

test("rejected Telegram 2FA is scrubbed from the live input before the provider call settles", async () => {
  class RejectingPasswordPort extends FakePort {
    submitted = "";
    override async submitPassword(value: string): Promise<void> {
      this.submitted = value;
      throw new Error("rejected");
    }
  }
  const port = new RejectingPasswordPort({
    available: true,
    configured: true,
    busy: false,
    login: { status: "awaiting_password", passwordHint: "hint" },
  });
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const root = view.root as unknown as StubNode;
  const input = root.find((node) => node.tag === "input" && node.attrs["type"] === "password");
  assert.ok(input);
  input.value = "SUPER-SECRET-2FA";
  button(root, en["telegram.continue"]).click();
  assert.equal(input.value, "", "secret is removed synchronously before await/rejection");
  await nextTurn();
  await nextTurn();
  assert.equal(port.submitted, "SUPER-SECRET-2FA", "provider receives the one-time value exactly once");
  assert.equal(root.textContent.includes("SUPER-SECRET-2FA"), false);
  view.destroy();
  assert.equal(root.textContent, "");
});

test("disconnect and local removal require distinct confirmations", async () => {
  const port = new FakePort(ready);
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const root = view.root as unknown as StubNode;

  button(root, en["telegram.disconnect"]).click();
  assert.equal(port.disconnectCalls, 0);
  assert.ok(root.find((node) => node.attrs["role"] === "alert"));
  button(root, en["telegram.disconnectConfirm"]).click();
  await nextTurn();
  assert.equal(port.disconnectCalls, 1);

  port.emit({ ...ready, login: { status: "revoked", reason: "logged_out" } });
  button(root, en["telegram.removeData"]).click();
  assert.equal(port.removeCalls, 0);
  button(root, en["telegram.removeConfirm"]).click();
  await nextTurn();
  assert.equal(port.removeCalls, 1);
  view.destroy();
});

test("pending destructive action ignores repeated activation and disables the confirmation controls", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const port = new FakePort(ready);
  port.disconnectGate = pending;
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const root = view.root as unknown as StubNode;
  button(root, en["telegram.disconnect"]).click();
  const confirm = button(root, en["telegram.disconnectConfirm"]);
  confirm.click();
  confirm.click();
  assert.equal(port.disconnectCalls, 1);
  assert.ok(root.findAll((node) => node.tag === "button").every((node) => node.hasAttribute("disabled")));
  release();
  await nextTurn();
  view.destroy();
});

test("multi-account selector masks provider ids and never renders protected slot values", async () => {
  const firstSlot = `slot.${"a".repeat(36)}`;
  const secondSlot = `slot.${"b".repeat(36)}`;
  const firstId = "9007199254740993";
  const secondId = "1234567890123456";
  const port = new FakePort({
    ...ready,
    activeSlot: firstSlot,
    accounts: [
      { slot: firstSlot, accountId: firstId, login: ready.login, syncState: "active", unreadCount: 2 },
      { slot: secondSlot, accountId: secondId, login: ready.login, syncState: "background", unreadCount: 7 },
    ],
    totalUnreadCount: 9,
    backgroundReadyCount: 1,
  });
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const root = view.root as unknown as StubNode;

  assert.equal(root.textContent.includes(firstId), false);
  assert.equal(root.textContent.includes(secondId), false);
  assert.equal(root.textContent.includes(firstSlot), false);
  assert.equal(root.textContent.includes(secondSlot), false);
  assert.equal(
    root.find((node) => Object.values(node.attrs).some((value) => value.includes(firstSlot) || value.includes(secondSlot))),
    null,
    "random account slots stay in event-handler closures only",
  );
  const accountButtons = root.findAll((node) => node.tag === "button" && node.attrs["class"]?.includes("gc-connector-account"));
  assert.equal(accountButtons.length, 2);
  assert.equal(accountButtons[0]?.attrs["aria-pressed"], "true");
  assert.equal(accountButtons[1]?.attrs["aria-pressed"], "false");
  assert.ok(root.textContent.includes(en["telegram.sync.background"]));
  assert.ok(root.textContent.includes("7"));
  assert.ok(root.textContent.includes(en["telegram.backgroundSummary"].replace("{count}", "1")));
  assert.ok(root.textContent.includes(en["telegram.totalUnread"].replace("{count}", "9")));
  assert.ok(accountButtons[1]?.attrs["aria-label"]?.includes(en["telegram.unread"].replace("{count}", "7")));
  assert.equal(accountButtons[1]?.attrs["aria-label"]?.includes(secondId), false);
  accountButtons[1]?.click();
  await nextTurn();
  assert.deepEqual(port.selectedSlots, [secondSlot]);

  button(root, en["telegram.addAccount"]).click();
  await nextTurn();
  assert.equal(port.addCalls, 1);
  view.destroy();
});

test("empty protected catalogue offers account creation without exposing auth forms", async () => {
  const port = new FakePort({
    available: true, configured: true, busy: false,
    login: { status: "revoked", reason: "not_connected" },
    activeSlot: null, accounts: [], canAddAccount: true,
  });
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const root = view.root as unknown as StubNode;
  assert.ok(root.textContent.includes(en["telegram.noAccounts"]));
  assert.equal(root.find((node) => node.tag === "input"), null);
  assert.equal(root.find((node) => node.tag === "button" && node.textContent.includes(en["telegram.connectQr"])), null);
  button(root, en["telegram.addAccount"]).click();
  await nextTurn();
  assert.equal(port.addCalls, 1);
  view.destroy();
});

test("native-not-configured state does not disclose credential field names", () => {
  const port = new FakePort({
    available: false,
    configured: false,
    busy: false,
    login: { status: "revoked", reason: "not_connected" },
    reason: "not_configured",
  });
  const status = new StubNode("div");
  const view = createTelegramSettings({ port, i18n, status: status as unknown as HTMLElement });
  const text = (view.root as unknown as StubNode).textContent;
  assert.doesNotMatch(text, /api[_-](?:id|hash)/iu);
  view.destroy();
});
