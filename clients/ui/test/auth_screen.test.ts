// WCAG 1.3.5 / 3.3.8 (a11y audit, campaign 11): the persistent password input must re-point its
// autocomplete token whenever the auth screen toggles modes — "current-password" on sign-in (so
// password managers autofill) and "new-password" on sign-up (so they offer to generate instead).
//
// Campaign 12 adds the sign-up detail work: a server error that names one input (USERNAME_TAKEN)
// must land under THAT input and survive the re-render that follows the failed submit, the consent
// gate must say why the button is disabled, and the reveal button must flip the input type.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createAuthScreen } from "../src/screens/auth_screen.ts";
import type { Session } from "../src/screens/session.ts";

class StubNode {
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(event: { preventDefault(): void }) => void>> = {};
  value = "";
  checked = false;
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
  // `disabled` reflects into the content attribute on real elements — the screen sets the property
  // (button.disabled = false) while the assertions read the attribute, so model both directions.
  get disabled(): boolean { return this.attrs["disabled"] !== undefined; }
  set disabled(value: boolean) {
    if (value) this.attrs["disabled"] = "";
    else delete this.attrs["disabled"];
  }
  get textContent(): string {
    return this.isText ? this.text : this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    if (this.isText) { this.text = value; return; }
    this.children = [];
    if (value) this.append(value);
  }
  // Depth-first lookup over the stub tree (querySelector stand-in for these tests).
  find(match: (node: StubNode) => boolean): StubNode | null {
    if (match(this)) return this;
    for (const child of this.children) {
      const hit = child.find(match);
      if (hit) return hit;
    }
    return null;
  }
  click(): void { this.fire("click"); }
  fire(type: string): void {
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {} });
  }
  findAll(match: (node: StubNode) => boolean, out: StubNode[] = []): StubNode[] {
    if (match(this)) out.push(this);
    for (const child of this.children) child.findAll(match, out);
    return out;
  }
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new StubNode(tag),
  createElementNS: (_namespace: string, tag: string) => new StubNode(tag),
  createTextNode: (text: string) => {
    const node = new StubNode("#text", true);
    node.textContent = text;
    return node;
  },
};

const i18n = createI18n({ locale: "en", dicts: { ru, en } });
const session = { async register() {}, async login() {} } as unknown as Session;

// Shape apiErrorCode() recognises: name === "ApiError" plus a string code.
function apiError(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.name = "ApiError";
  err.code = code;
  return err;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Probe {
  root: StubNode;
  destroy(): void;
  byClass(cls: string): StubNode | null;
  allByClass(cls: string): StubNode[];
  input(autocomplete: string): StubNode | null;
  toggleMode(): void;
  submitForm(): void;
}

function mount(session_: Session): Probe {
  const screen = createAuthScreen({ session: session_, i18n, onAuthed: () => {} });
  const root = screen.root as unknown as StubNode;
  const has = (node: StubNode, cls: string): boolean => (node.attrs["class"] ?? "").split(" ").includes(cls);
  return {
    root,
    destroy: () => screen.destroy(),
    byClass: (cls) => root.find((n) => has(n, cls)),
    allByClass: (cls) => root.findAll((n) => has(n, cls)),
    input: (autocomplete) => root.find((n) => n.tag === "input" && n.attrs["autocomplete"] === autocomplete),
    toggleMode: () => root.find((n) => n.tag === "button" && n.attrs["class"] === "gc-link")?.click(),
    submitForm: () => root.find((n) => n.tag === "form")?.fire("submit"),
  };
}

test("password autocomplete follows the auth mode (login <-> register)", () => {
  const screen = createAuthScreen({ session, i18n, onAuthed: () => {} });
  const root = screen.root as unknown as StubNode;
  const password = () => root.find((n) => n.tag === "input" && n.attrs["type"] === "password");
  // Without onChangeServer the only .gc-link is the mode toggle.
  const toggle = () => root.find((n) => n.tag === "button" && n.attrs["class"] === "gc-link");

  assert.equal(password()?.attrs["autocomplete"], "current-password"); // initial sign-in
  toggle()?.click();
  assert.equal(password()?.attrs["autocomplete"], "new-password"); // sign-up: offer generation
  toggle()?.click();
  assert.equal(password()?.attrs["autocomplete"], "current-password"); // back to sign-in
  screen.destroy();
});

test("USERNAME_TAKEN is shown under the username field, not in the form-wide banner", async () => {
  const failing = {
    async register() { throw apiError("USERNAME_TAKEN"); },
    async login() {},
  } as unknown as Session;
  const ui = mount(failing);
  ui.toggleMode(); // -> sign-up

  const username = ui.input("username")!;
  username.value = "stels37";
  ui.input("new-password")!.value = "Qwerty12345!";
  ui.input("name")!.value = "Ivan";
  for (const box of ui.allByClass("gc-check")) box.find((n) => n.tag === "input")!.checked = true;

  ui.submitForm();
  await flush();

  const taken = en["errors.USERNAME_TAKEN"] as string;
  // The message survived the busy -> idle re-render and sits on the field, which is now aria-invalid.
  const usernameError = ui.root.find((n) => n.attrs["id"]?.endsWith("-username-err") === true);
  assert.equal(usernameError?.textContent, taken);
  assert.equal(username.attrs["aria-invalid"], "true");
  assert.equal(username.attrs["aria-describedby"]?.includes(usernameError!.attrs["id"]!), true);
  assert.equal(ui.byClass("gc-auth-error")?.textContent, "");

  // Editing the field retracts the stale verdict immediately.
  username.fire("input");
  assert.equal(ui.root.find((n) => n.attrs["id"]?.endsWith("-username-err") === true)?.textContent, "");
  assert.equal(username.attrs["aria-invalid"], undefined);
  ui.destroy();
});

test("an error about a field the current mode does not show stays in the banner", async () => {
  const failing = {
    async register() {},
    async login() { throw apiError("EMAIL_TAKEN"); },
  } as unknown as Session;
  const ui = mount(failing); // sign-in has no email input
  ui.input("username")!.value = "stels37";
  ui.input("current-password")!.value = "Qwerty12345!";
  ui.submitForm();
  await flush();
  assert.equal(ui.byClass("gc-auth-error")?.textContent, en["errors.EMAIL_TAKEN"]);
  ui.destroy();
});

test("consent gate: the reason is visible until both boxes are ticked", () => {
  const ui = mount(session);
  ui.toggleMode();
  const gate = () => ui.byClass("gc-auth-gate");
  const submit = () => ui.byClass("gc-auth-submit");
  assert.equal(gate()?.textContent, en["auth.consentRequired"]);
  assert.equal(gate()?.attrs["hidden"], undefined); // shown while blocked
  assert.equal(submit()?.attrs["disabled"], "");
  assert.equal(submit()?.attrs["aria-describedby"], gate()?.attrs["id"]);

  const boxes = ui.allByClass("gc-check").map((label) => label.find((n) => n.tag === "input")!);
  assert.equal(boxes.length, 2);
  for (const box of boxes) { box.checked = true; box.fire("change"); }
  assert.equal(gate()?.attrs["hidden"], "");
  assert.equal(submit()?.attrs["disabled"], undefined);
  ui.destroy();
});

test("reveal button flips the password input type and its own pressed state", () => {
  const ui = mount(session);
  const password = () => ui.root.find((n) => n.tag === "input" && n.attrs["autocomplete"]?.endsWith("password") === true)!;
  const eye = () => ui.byClass("gc-field-eye")!;
  assert.equal(password().attrs["type"], "password");
  assert.equal(eye().attrs["aria-pressed"], "false");
  assert.equal(eye().attrs["aria-label"], en["auth.showPassword"]);
  eye().click();
  assert.equal(password().attrs["type"], "text");
  assert.equal(eye().attrs["aria-pressed"], "true");
  assert.equal(eye().attrs["aria-label"], en["auth.hidePassword"]);
  eye().click();
  assert.equal(password().attrs["type"], "password");
  ui.destroy();
});

test("sign-up hints and the strength meter are wired to what the user types", () => {
  const ui = mount(session);
  ui.toggleMode();
  const hints = ui.allByClass("gc-field-hint").map((n) => n.textContent);
  assert.deepEqual(hints, [
    en["auth.usernameHint"],
    en["auth.nameHint"],
    en["auth.emailHint"],
  ]);
  const meterText = () => ui.byClass("gc-pw-text")!.textContent;
  const lit = () => ui.allByClass("gc-pw-seg").filter((n) => (n.attrs["class"] ?? "").includes("is-on")).length;
  assert.equal(meterText(), en["auth.passwordHint"]); // empty field: rules, not a verdict
  assert.equal(lit(), 0);

  const password = ui.input("new-password")!;
  password.value = "Qwerty12345!";
  password.fire("input");
  assert.equal(lit(), 3);
  assert.equal(meterText(), `${en["auth.pwStrength"]}: ${en["auth.pwGood"]}`);

  // The username feeds the "don't put your handle in your password" rule, so editing it re-scores.
  const username = ui.input("username")!;
  username.value = "qwerty12345";
  username.fire("input");
  assert.equal(lit(), 1);
  assert.equal(meterText(), `${en["auth.pwStrength"]}: ${en["auth.pwWeak"]} — ${en["auth.pwContainsUsername"]}`);
  ui.destroy();
});


test("desktop QR sign-in is local and aborts the pending attempt when the screen closes", async () => {
  let aborted = false;
  let started = false;
  const token = "e".repeat(96);
  const qrSession = {
    async register() {},
    async login() {},
    loginWithQr(opts: {
      signal?: AbortSignal;
      onReady?: (attempt: { token: string; link: string; expiresAt: number }) => void;
      onStatus?: (status: "starting" | "waiting" | "offline") => void;
    }): Promise<never> {
      started = true;
      opts.onReady?.({ token, link: `greenchat://auth/qr/${token}`, expiresAt: Date.now() + 120_000 });
      opts.onStatus?.("waiting");
      return new Promise<never>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  } as unknown as Session;

  const screen = createAuthScreen({
    session: qrSession,
    i18n,
    allowQrLogin: true,
    onAuthed() {},
  });
  const root = screen.root as unknown as StubNode;
  const qrButton = root.find((node) => (node.attrs["class"] ?? "").split(" ").includes("gc-auth-qr-toggle"));
  assert.ok(qrButton, "desktop shell exposes the QR entry point");
  qrButton.click();
  await flush();

  assert.equal(started, true);
  const svg = root.find((node) => node.tag === "svg" && node.attrs["class"] === "gc-connector-qr");
  assert.ok(svg, "the one-time token is rendered locally as SVG");
  assert.equal(svg.attrs["aria-label"], en["auth.qrLabel"]);
  assert.match(root.textContent, /Waiting for approval/);

  screen.destroy();
  await flush();
  assert.equal(aborted, true, "destroy aborts polling so Session can cancel the server attempt");
});

test("ordinary web/mobile auth does not advertise desktop QR generation", () => {
  const screen = createAuthScreen({ session, i18n, onAuthed() {} });
  const root = screen.root as unknown as StubNode;
  assert.equal(
    root.find((node) => (node.attrs["class"] ?? "").split(" ").includes("gc-auth-qr-toggle")),
    null,
  );
  screen.destroy();
});
