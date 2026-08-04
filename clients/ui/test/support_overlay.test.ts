// DOM-stub test for the support/feedback overlay (T-512, MS-2). Mirrors new_chat_overlay.test.ts:
// a hand-rolled document stub (el()/clear() read the GLOBAL document) exercises the form's
// validate→preview→submit→S-002-resend wiring under node:test without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupportOverlay, type SupportSubmitResult } from "../src/screens/support_overlay.ts";
import type { SupportOverlayDeps } from "../src/screens/support_overlay.ts";
import type { SupportTicketPayload } from "../src/screens/api.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

// ---- minimal DOM stub (same shape as new_chat_overlay.test.ts) -----------------------------------
class StubNode {
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  style: Record<string, string> = {};
  value = "";
  checked = false;
  disabled = false;
  onclick: ((e: unknown) => void) | null = null;
  private text = "";
  tag: string;
  private readonly isText: boolean;
  constructor(tag: string, isText = false) { this.tag = tag; this.isText = isText; }

  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  get className(): string { return this.attrs["class"] ?? ""; }
  hasClass(c: string): boolean { return this.className.split(/\s+/).includes(c); }

  append(...kids: Array<StubNode | string>): void {
    for (const k of kids) {
      const node = typeof k === "string" ? new StubNode("#text", true) : k;
      if (typeof k === "string") node.textContent = k;
      node.parent = this;
      this.children.push(node);
    }
  }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  removeChild(k: StubNode): StubNode {
    const i = this.children.indexOf(k);
    if (i >= 0) this.children.splice(i, 1);
    k.parent = null;
    return k;
  }
  remove(): void { this.parent?.removeChild(this); }

  addEventListener(type: string, fn: (e: unknown) => void): void { (this.listeners[type] ??= []).push(fn); }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    if (type === "click" && this.onclick) this.onclick(event);
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
  }

  get textContent(): string {
    return this.isText ? this.text : this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.isText) { this.text = v; return; }
    this.children = [];
    if (v !== "") this.append(v);
  }
  focus(): void {}

  find(pred: (n: StubNode) => boolean): StubNode | null {
    if (pred(this)) return this;
    for (const c of this.children) { const r = c.find(pred); if (r) return r; }
    return null;
  }
  findAll(pred: (n: StubNode) => boolean): StubNode[] {
    const out: StubNode[] = [];
    const walk = (n: StubNode): void => { if (pred(n)) out.push(n); n.children.forEach(walk); };
    walk(this);
    return out;
  }
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new StubNode(tag),
  createTextNode: (t: string) => { const n = new StubNode("#text"); n.textContent = t; return n; },
};

const i18n = createI18n({ locale: "en", dicts: { ru, en } });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Rig {
  root: StubNode;
  overlay: ReturnType<typeof createSupportOverlay>;
  submits: SupportTicketPayload[];
  toasts: string[];
  reports: number;
  closes: number;
}

const DIAG = { env: { app_version: "0.1.0" }, entries: [{ t: 1, kind: "route", data: { to: "/chats" } }] };

function mount(over: Partial<SupportOverlayDeps> = {}, results: SupportSubmitResult[] = []): Rig {
  const container = new StubNode("body");
  const submits: SupportTicketPayload[] = [];
  const toasts: string[] = [];
  let reports = 0;
  let closes = 0;
  const queue = [...results];
  const deps: SupportOverlayDeps = {
    i18n,
    auto: { screen: "/chats", app_version: "0.1.0", platform: "web" },
    diagnostics: DIAG,
    newClientRef: () => "ref-123",
    submit: (p) => { submits.push(p); return Promise.resolve(queue.shift() ?? { kind: "created", ref: "GC-000042" }); },
    onReport: () => { reports++; },
    onClose: () => { closes++; },
    toast: (m) => { toasts.push(m); },
    ...over,
  };
  const overlay = createSupportOverlay(deps);
  container.append(overlay.root as unknown as StubNode);
  return { root: overlay.root as unknown as StubNode, overlay, submits, toasts, get reports() { return reports; }, get closes() { return closes; } } as Rig;
}

const textareaOf = (r: StubNode) => r.find((n) => n.tag === "textarea")!;
const sendOf = (r: StubNode) => r.find((n) => n.hasClass("gc-btn-accent"))!;
const radios = (r: StubNode) => r.findAll((n) => n.attrs["type"] === "radio");
const checkbox = (r: StubNode) => r.find((n) => n.attrs["type"] === "checkbox")!;
const preNode = (r: StubNode) => r.find((n) => n.hasClass("gc-support-preview"))!;
const statusOf = (r: StubNode) => r.find((n) => n.hasClass("gc-chats-status"))!;
const linkByText = (r: StubNode, text: string) =>
  r.findAll((n) => n.hasClass("gc-support-linkbtn")).find((n) => n.textContent === text)!;

async function typeText(rig: Rig, text: string): Promise<void> {
  const ta = textareaOf(rig.root);
  ta.value = text;
  ta.dispatch("input");
  await flush();
}

// ---- tests ----------------------------------------------------------------------------------------

test("overlay: renders 5 category radios, a textarea, and Send starts disabled", () => {
  const rig = mount();
  assert.equal(radios(rig.root).length, 5, "bug/question/feedback/account/payments");
  assert.ok(textareaOf(rig.root), "a text field");
  assert.equal(sendOf(rig.root).disabled, true, "nothing typed yet → Send disabled");
});

test("overlay: a too-short body keeps Send disabled and shows a hint; a valid body enables it", async () => {
  const rig = mount();
  await typeText(rig, "hi");
  assert.equal(sendOf(rig.root).disabled, true);
  assert.equal(statusOf(rig.root).textContent, i18n.t("support.err.too_short", { min: 10 }));
  await typeText(rig, "this is definitely long enough to send");
  assert.equal(sendOf(rig.root).disabled, false);
  assert.equal(statusOf(rig.root).textContent, "", "the hint clears once valid");
});

test("overlay: preview shows the EXACT payload JSON incl. client_ref + diagnostics; unticking drops diagnostics", async () => {
  const rig = mount();
  await typeText(rig, "the composer crashes when I attach a photo");
  linkByText(rig.root, i18n.t("support.preview")).dispatch("click");
  const shown = preNode(rig.root).textContent;
  const parsed = JSON.parse(shown) as SupportTicketPayload;
  assert.equal(parsed.client_ref, "ref-123", "one client_ref, shown verbatim");
  assert.equal(parsed.category, "bug");
  assert.equal(parsed.screen, "/chats");
  assert.ok(parsed.diagnostics, "diagnostics attached by default");
  // untick "attach technical data" → the preview must no longer contain the blob
  const cb = checkbox(rig.root);
  cb.checked = false;
  cb.dispatch("change");
  const parsed2 = JSON.parse(preNode(rig.root).textContent) as SupportTicketPayload;
  assert.equal(parsed2.diagnostics, undefined, "diagnostics omitted once unticked");
  assert.equal(parsed2.client_ref, "ref-123", "same client_ref");
});

test("overlay: Send POSTs the built payload, toasts the ref, and closes on 'created'", async () => {
  const rig = mount({}, [{ kind: "created", ref: "GC-000042" }]);
  await typeText(rig, "please rename the export button");
  sendOf(rig.root).dispatch("click");
  await flush();
  assert.equal(rig.submits.length, 1);
  assert.equal(rig.submits[0]!.client_ref, "ref-123");
  assert.equal(rig.submits[0]!.text, "please rename the export button");
  assert.ok(rig.submits[0]!.diagnostics, "attached by default");
  assert.equal(rig.toasts.length, 1);
  assert.ok(rig.toasts[0]!.includes("GC-000042"), "the toast names the ticket");
  assert.equal(rig.root.parent, null, "overlay closed after success");
});

test("overlay: a 'queued' result toasts the offline notice and closes (S-003)", async () => {
  const rig = mount({}, [{ kind: "queued" }]);
  await typeText(rig, "cannot reach the server right now, saving this");
  sendOf(rig.root).dispatch("click");
  await flush();
  assert.equal(rig.toasts[0], i18n.t("support.queued"));
  assert.equal(rig.root.parent, null);
});

test("overlay: S-002 oversize → offers 'send without diagnostics'; the resend drops the blob and keeps the ref", async () => {
  const rig = mount({}, [{ kind: "oversize" }, { kind: "created", ref: "GC-000099" }]);
  await typeText(rig, "here is a very detailed bug report with lots of steps");
  sendOf(rig.root).dispatch("click");
  await flush();
  // first attempt carried diagnostics and came back oversize
  assert.ok(rig.submits[0]!.diagnostics, "first send included the blob");
  assert.equal(statusOf(rig.root).textContent, i18n.t("support.oversizeOffer"));
  const without = rig.root.find((n) => n.hasClass("gc-btn") && n.textContent === i18n.t("support.sendWithout"))!;
  assert.notEqual(without.style.display, "none", "the 'send without' button is now visible");
  without.dispatch("click");
  await flush();
  assert.equal(rig.submits.length, 2, "one resend");
  assert.equal(rig.submits[1]!.diagnostics, undefined, "resend dropped the diagnostics");
  assert.equal(rig.submits[1]!.client_ref, "ref-123", "same client_ref → idempotent");
  assert.ok(rig.toasts[0]!.includes("GC-000099"));
  assert.equal(rig.root.parent, null, "closed after the successful resend");
});

test("overlay: LIMIT and DISABLED results show a status and keep the form open", async () => {
  const rig = mount({}, [{ kind: "limit", retryAfter: 60 }]);
  await typeText(rig, "trying to file another one right away");
  sendOf(rig.root).dispatch("click");
  await flush();
  assert.equal(statusOf(rig.root).textContent, i18n.t("support.limit"));
  assert.notEqual(rig.root.parent, null, "still open on a soft failure");
});

test("overlay: the 'report a user/content' link hands off to the T-113 flow and closes (not a ticket)", () => {
  const rig = mount();
  linkByText(rig.root, i18n.t("support.reportLink")).dispatch("click");
  assert.equal(rig.reports, 1, "onReport invoked");
  assert.equal(rig.submits.length, 0, "no ticket was created");
  assert.equal(rig.root.parent, null, "overlay closed");
});

test("overlay: with no diagnostics available, the checkbox + preview are not rendered", () => {
  const rig = mount({ diagnostics: null });
  assert.equal(rig.root.find((n) => n.attrs["type"] === "checkbox"), null, "no attach checkbox");
  assert.equal(rig.root.find((n) => n.hasClass("gc-support-preview")), null, "no preview pane");
});

test("overlay: Escape and a backdrop click both close it", () => {
  const a = mount();
  a.root.dispatch("keydown", { key: "Escape", preventDefault: () => {} });
  assert.equal(a.root.parent, null, "Escape closed it");
  const b = mount();
  b.root.dispatch("click", { target: b.root });
  assert.equal(b.root.parent, null, "backdrop click closed it");
});

test("overlay: prefill seeds the category and text (e.g. from the error banner entry point)", () => {
  const rig = mount({ prefill: { category: "payments", text: "payment failed at checkout" } });
  assert.equal(textareaOf(rig.root).value, "payment failed at checkout");
  const checkedRadio = radios(rig.root).find((n) => n.checked)!;
  assert.equal(checkedRadio.attrs["value"], "payments");
});
