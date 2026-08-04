// V115 — the unlock field's ACCESSIBLE NAME contradicted its visible label.
//
// Measured on the signed direct APK app.greenchat versionCode 1000013 built from 34b71d20 (redroid
// Android 15, dedicated device gc-android-p0 / 127.0.0.1:5557, 2026-07-31, CDP against the device
// WebView). After screen-off the unlock card was internally consistent for a sighted user —
// «Введите парольную фразу…» over a field showing «Парольная фраза» — but the element itself read:
//
//   <input type="password" … aria-label="Код приложения" placeholder="Парольная фраза">
//
// A screen reader announces the aria-label and NEVER the placeholder, so a blind user on this device
// is asked for an "app code" that the very same screen refuses. The visible label already follows
// lock.policy.requirePassphrase; the accessible name has to follow the same flag, or the two names of
// one field keep disagreeing.
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
  selected = false;
  private text = "";
  readonly tag: string;
  private readonly isText: boolean;
  constructor(tag: string, isText = false) {
    this.tag = tag;
    this.isText = isText;
  }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  append(...children: Array<StubNode | string>): void {
    for (const child of children) {
      const node = typeof child === "string" ? new StubNode("#text", true) : child;
      if (typeof child === "string") node.textContent = child;
      node.parent = this;
      this.children.push(node);
    }
  }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  focus(): void {}
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

/** A lock port on a device WITHOUT a hardware key: passphrase mandatory, exactly like the emulator. */
function passphraseOnlyPort(): AppLockUiPort {
  const listeners = new Set<(state: AppLockUiState) => void>();
  return {
    state: "LOCKED",
    enabled: false,
    policy: { wipeAfter: 10, requirePassphrase: true },
    attempts: { failures: 0, blockedUntil: 0 },
    biometric: { available: false, enabled: false, ready: false, codeRequired: false, failures: 0 },
    cold: { profile: "default", codeRequired: false, reason: null },
    duress: { enabled: false, signal: false },
    retryAfterSeconds: () => 0,
    estimate: (code: string) => (code.length === 0
      ? { valid: false, problem: "empty", score: 0, kind: "pin" }
      : { valid: false, problem: "passphrase_required", score: 0, kind: "pin" }),
    subscribe(listener: (state: AppLockUiState) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async unlock() {}, async unlockBiometric() {}, async enable() {}, async changeCode() {},
    async setWipeAfter() {}, async setProfile() {}, async configureDuress() {}, async disableDuress() {},
    async setBiometricEnabled() {}, async disableAndWipe() {}, async resetAfterWipe() {}, lock() {},
  } as unknown as AppLockUiPort;
}


/** Depth-first search for the single password input the unlock card renders. */
function findInput(node: StubNode): StubNode | undefined {
  if (node.tag === "input" && node.attrs.type === "password") return node;
  for (const child of node.children) {
    const hit = findInput(child);
    if (hit) return hit;
  }
  return undefined;
}

/** The same port, but on a device whose hardware key works: a PIN is allowed there. */
function pinAllowedPort(): AppLockUiPort {
  const port = passphraseOnlyPort() as unknown as { policy: { requirePassphrase: boolean } };
  port.policy = { ...port.policy, requirePassphrase: false };
  return port as unknown as AppLockUiPort;
}

for (const locale of ["ru", "en"] as const) {
  test(`V115 (${locale}): the unlock field is announced as the secret it actually accepts`, () => {
    const i18n = createI18n({ locale, dicts: { ru, en } });
    const view = createLockScreen({ i18n, lock: passphraseOnlyPort() });
    const input = findInput(view.root as unknown as StubNode);
    view.destroy(); // the card runs a throttle timer; leave none behind
    assert.ok(input, "the unlock card renders a password field");
    assert.equal(
      input.attrs["aria-label"],
      i18n.t("lock.passphrase"),
      `a screen reader must not ask for an app code the device refuses: ${input.attrs["aria-label"]}`,
    );
    assert.equal(
      input.attrs["aria-label"],
      input.attrs.placeholder,
      "the accessible name and the visible label of one field must be the same words",
    );
  });

  test(`V115 (${locale}): where a PIN is allowed the field keeps its app-code name`, () => {
    const i18n = createI18n({ locale, dicts: { ru, en } });
    const view = createLockScreen({ i18n, lock: pinAllowedPort() });
    const input = findInput(view.root as unknown as StubNode);
    view.destroy();
    assert.ok(input, "the unlock card renders a password field");
    assert.equal(input.attrs["aria-label"], i18n.t("lock.code"), "hardware-backed devices still take a PIN");
    assert.equal(input.attrs["aria-label"], input.attrs.placeholder, "both names stay in step");
  });
}
