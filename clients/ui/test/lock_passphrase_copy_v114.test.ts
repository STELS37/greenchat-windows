// V114 — the setup hint and the unlock subtitle promised a six-digit code on a device that rejects it.
//
// Measured on the signed direct APK app.greenchat versionCode 1000013 built from 14fc6d0c (redroid
// Android 15, dedicated device gc-android-p0 / 127.0.0.1:5557, 2026-07-31, CDP against the device
// WebView):
//   * `SecureKey.ensure()` rejects here ("SecureKey: аппаратно защищённый HMAC недоступен"), so the
//     app lock correctly falls back to a mandatory passphrase and writes a "web-user-only" container;
//   * Settings → «Общие» → «Замок приложения» nevertheless printed «Минимум 6 цифр или парольная
//     фраза от 8 символов» under an empty field. Typing 593817 replaced it with «На этой платформе
//     требуется парольная фраза, а не цифровой PIN» — the app first invited a PIN and then refused it;
//   * after screen-off the unlock card read «Введите код приложения…» above a field labelled
//     «Парольная фраза» — the two lines of the same card disagreed.
//
// The refusal wording is wrong too: nothing about the PLATFORM forbids a PIN. The same Android build
// on a phone with a working TEE gets the PIN. What is missing is a hardware-backed key ON THIS DEVICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createLockScreen, type AppLockUiPort, type AppLockUiState } from "../src/screens/lock_screen.ts";
import { createLockSettings } from "../src/screens/lock_settings.ts";

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

const DIGIT_PROMISE = /6 цифр|6 digits/i;

for (const locale of ["ru", "en"] as const) {
  test(`V114 (${locale}): the empty setup field never advertises a PIN when the device forbids one`, () => {
    const i18n = createI18n({ locale, dicts: { ru, en } });
    const status = new StubNode("p") as unknown as HTMLElement;
    const section = createLockSettings({
      i18n, lock: passphraseOnlyPort(), status, rerender: () => {},
    }) as unknown as StubNode;
    const text = section.textContent;
    assert.ok(!DIGIT_PROMISE.test(text), `setup copy must not offer a PIN this device rejects: ${text}`);
    assert.ok(
      text.includes(i18n.t("lock.codeHintPassphrase")),
      "the passphrase-only hint must be the one shown next to an empty field",
    );
  });

  test(`V114 (${locale}): the unlock card asks for the same secret its own field is labelled with`, () => {
    const i18n = createI18n({ locale, dicts: { ru, en } });
    const view = createLockScreen({ i18n, lock: passphraseOnlyPort() });
    const text = (view.root as unknown as StubNode).textContent;
    view.destroy(); // the card runs a throttle timer; leave none behind
    assert.ok(
      text.includes(i18n.t("lock.subtitlePassphrase")),
      `the subtitle must name a passphrase when the field is one: ${text}`,
    );
    assert.ok(!text.includes(i18n.t("lock.subtitle")), "the PIN wording must not survive on that card");
  });
}

test("V114: the refusal blames the missing hardware key, not the platform", () => {
  for (const dict of [ru, en] as const) {
    const message = (dict as Record<string, string>)["lock.problem.passphrase_required"];
    assert.ok(message, "the refusal string exists in both dictionaries");
    assert.ok(
      !/платформе|platform/i.test(message),
      `the same platform grants a PIN on hardware-backed devices: ${message}`,
    );
    assert.ok(
      /устройств|device/i.test(message),
      `the refusal must point at this device: ${message}`,
    );
  }
});

test("V114: both dictionaries carry the new keys", () => {
  for (const key of ["lock.codeHintPassphrase", "lock.subtitlePassphrase"]) {
    for (const [name, dict] of [["ru", ru], ["en", en]] as const) {
      const value = (dict as Record<string, string>)[key];
      assert.ok(value && value.length > 0, `${name} must define ${key}`);
    }
  }
});
