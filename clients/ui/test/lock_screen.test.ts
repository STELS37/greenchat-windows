// T-523 (DS-05): the lock screen must be generic and account-data-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createLockScreen, type AppLockUiPort, type AppLockUiState } from "../src/screens/lock_screen.ts";

class StubNode {
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(event: { preventDefault(): void }) => void>> = {};
  value = "";
  disabled = false;
  private text = "";
  readonly tag: string;
  private readonly isText: boolean;
  constructor(tag: string, isText = false) {
    this.tag = tag;
    this.isText = isText;
  }
  setAttribute(key: string, value: string): void {
    this.attrs[key] = value;
    if (key === "disabled") this.disabled = true;
  }
  removeAttribute(key: string): void {
    delete this.attrs[key];
    if (key === "disabled") this.disabled = false;
  }
  append(...children: Array<StubNode | string>): void {
    for (const child of children) {
      const node = typeof child === "string" ? new StubNode("#text", true) : child;
      if (typeof child === "string") node.textContent = child;
      node.parent = this;
      this.children.push(node);
    }
  }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  removeChild(node: StubNode): StubNode {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parent = null;
    return node;
  }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  focus(): void {}

  contains(node: StubNode): boolean {
    return this === node || this.children.some((child) => child.contains(node));
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

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new StubNode(tag),
  createTextNode: (text: string) => {
    const node = new StubNode("#text", true);
    node.textContent = text;
    return node;
  },
};

const i18n = createI18n({ locale: "en", dicts: { ru, en } });
function port(opts: {
  biometric?: { available: boolean; enabled: boolean; ready: boolean; codeRequired: boolean; failures: number };
  biometricError?: { problem: string };
} = {}): AppLockUiPort & {
  setState(state: AppLockUiState): void;
  biometricCalls(): number;
} {
  let state: AppLockUiState = "LOCKED";
  let biometric = opts.biometric ?? {
    available: false,
    enabled: false,
    ready: false,
    codeRequired: false,
    failures: 0,
  };
  let biometricCalls = 0;
  const listeners = new Set<(state: AppLockUiState) => void>();
  return {
    get state() { return state; },
    enabled: true,
    policy: { wipeAfter: 10, requirePassphrase: false },
    attempts: { failures: 1, blockedUntil: 0 },
    get biometric() { return { ...biometric }; },

    cold: { profile: "default", codeRequired: false, reason: null },

    duress: { enabled: false, signal: false },
    retryAfterSeconds: () => 0,
    estimate: () => ({ valid: true, problem: null, score: 2, kind: "pin" }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async unlock() {},
    async unlockBiometric() {
      biometricCalls++;
      if (opts.biometricError) throw opts.biometricError;
    },
    async enable() {}, async changeCode() {}, async setWipeAfter() {}, async setProfile() {},
    async configureDuress() {}, async disableDuress() {},
    async setBiometricEnabled(enabled) {
      biometric = { ...biometric, enabled, ready: enabled, codeRequired: false };
    },
    async disableAndWipe() {}, async resetAfterWipe() {}, lock() {},
    setState(next) { state = next; for (const listener of [...listeners]) listener(next); },
    biometricCalls: () => biometricCalls,
  };
}


function descendants(root: StubNode): StubNode[] {
  return [root, ...root.children.flatMap(descendants)];
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("lock screen DOM is generic in LOCKED and WIPED states", () => {
  const lock = port();
  const view = createLockScreen({ i18n, lock });
  const root = view.root as unknown as StubNode;
  const forbidden = [
    "Alice Secret Owner",
    "Board meeting — confidential",
    "FORENSIC_MESSAGE_CANARY",
    "avatar-file-441",
    "unread=99",
  ];

  assert.ok(root.textContent.includes("Green Chat"));
  assert.ok(root.textContent.includes(i18n.t("lock.subtitle")));
  for (const value of forbidden) assert.ok(!root.textContent.includes(value));

  lock.setState("WIPED");
  assert.ok(root.textContent.includes(i18n.t("lock.wipedTitle")));
  assert.ok(root.textContent.includes(i18n.t("lock.wiped")));
  for (const value of forbidden) assert.ok(!root.textContent.includes(value));

  view.destroy();
  assert.equal(root.textContent, "");
});


test("ready biometrics auto-prompts once; cancellation leaves the code form usable", async () => {
  const lock = port({
    biometric: { available: true, enabled: true, ready: true, codeRequired: false, failures: 0 },
    biometricError: { problem: "cancelled" },
  });
  const view = createLockScreen({ i18n, lock });
  const root = view.root as unknown as StubNode;
  await flushMicrotasks();

  assert.equal(lock.biometricCalls(), 1);
  assert.ok(root.textContent.includes(i18n.t("lock.biometricCancelled")));
  const input = descendants(root).find((node) => node.tag === "input");
  assert.ok(input);
  assert.equal(input.disabled, false, "cancelled biometric prompt must never disable code recovery");

  lock.setState("LOCKED");
  await flushMicrotasks();
  assert.equal(lock.biometricCalls(), 1, "rerendering the same locked state must not loop prompts");
  view.destroy();

  const remounted = createLockScreen({ i18n, lock });
  await flushMicrotasks();
  assert.equal(lock.biometricCalls(), 1, "a full shell remount in the same lock cycle must not prompt again");
  lock.setState("UNLOCKED"); // successful recovery clears the port-level guard
  remounted.destroy();

  lock.setState("LOCKED");
  const nextCycle = createLockScreen({ i18n, lock });
  await flushMicrotasks();
  assert.equal(lock.biometricCalls(), 2, "a later genuine lock cycle gets one new automatic prompt");
  nextCycle.destroy();
});

test("code-required state never invokes biometrics and explains the one-code recovery", async () => {
  const lock = port({
    biometric: { available: true, enabled: true, ready: false, codeRequired: true, failures: 1 },
  });
  const view = createLockScreen({ i18n, lock });
  const root = view.root as unknown as StubNode;
  await flushMicrotasks();

  assert.equal(lock.biometricCalls(), 0);
  assert.ok(root.textContent.includes(i18n.t("lock.codeRequired")));
  assert.ok(!root.textContent.includes(i18n.t("lock.biometricUnlock")));
  view.destroy();
});
