// DOM-stub test for the "Мои обращения" Settings→Help view (T-512, §3.3). Same hand-rolled document stub
// as new_chat_overlay.test.ts: exercises list → detail → "open dialog" and the contact button without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupportHelp } from "../src/screens/support_help.ts";
import type { ApiLike, SupportTicketList, SupportTicketDetail } from "../src/screens/api.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

class StubNode {
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  style: Record<string, string> = {};
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
      node.parent = this; this.children.push(node);
    }
  }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  removeChild(k: StubNode): StubNode { const i = this.children.indexOf(k); if (i >= 0) this.children.splice(i, 1); k.parent = null; return k; }
  remove(): void { this.parent?.removeChild(this); }
  addEventListener(type: string, fn: (e: unknown) => void): void { (this.listeners[type] ??= []).push(fn); }
  dispatch(type: string, event: Record<string, unknown> = {}): void { for (const fn of [...(this.listeners[type] ?? [])]) fn(event); }
  get textContent(): string { return this.isText ? this.text : this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { if (this.isText) { this.text = v; return; } this.children = []; if (v !== "") this.append(v); }
  find(pred: (n: StubNode) => boolean): StubNode | null {
    if (pred(this)) return this;
    for (const c of this.children) { const r = c.find(pred); if (r) return r; }
    return null;
  }
  findAll(pred: (n: StubNode) => boolean): StubNode[] {
    const out: StubNode[] = [];
    const walk = (n: StubNode): void => { if (pred(n)) out.push(n); n.children.forEach(walk); };
    walk(this); return out;
  }
}
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new StubNode(tag),
  createTextNode: (t: string) => { const n = new StubNode("#text"); n.textContent = t; return n; },
};

const i18n = createI18n({ locale: "en", dicts: { ru, en } });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LIST: SupportTicketList = {
  tickets: [
    { ref: "GC-000001", category: "bug", status: "answered", created_at: 1, updated_at: 2 },
    { ref: "GC-000002", category: "payments", status: "open", created_at: 3, updated_at: 4 },
  ],
  next_before_id: null,
};
const DETAIL: SupportTicketDetail = {
  ref: "GC-000001", category: "bug", status: "answered", screen: "/chats", app_version: "0.1.0",
  platform: "web", text: "the composer crashes", chat_id: 77, created_at: 1, updated_at: 2,
  events: [{ actor: "@support", kind: "status", payload: { from: "open", to: "answered" }, created_at: 2 }],
};

interface Rig { root: StubNode; opened: number[]; contacts: number; listCalls: Array<[number | undefined, number | undefined]>; getCalls: string[]; }
function mount(over: Partial<{ list: SupportTicketList; detail: SupportTicketDetail; onContact: boolean }> = {}): Rig {
  const opened: number[] = [];
  let contacts = 0;
  const listCalls: Array<[number | undefined, number | undefined]> = [];
  const getCalls: string[] = [];
  const api = {
    listSupportTickets: (limit?: number, before?: number) => { listCalls.push([limit, before]); return Promise.resolve(over.list ?? LIST); },
    getSupportTicket: (ref: string) => { getCalls.push(ref); return Promise.resolve(over.detail ?? DETAIL); },
  } as unknown as ApiLike;
  const view = createSupportHelp({
    api, i18n,
    onOpenChat: (id) => opened.push(id),
    ...(over.onContact ? { onContact: () => { contacts++; } } : {}),
  });
  return { root: view.root as unknown as StubNode, opened, get contacts() { return contacts; }, listCalls, getCalls } as Rig;
}
const rows = (r: StubNode) => r.findAll((n) => n.hasClass("gc-support-ticket"));

test("help: lists one row per ticket with ref, category, and status", async () => {
  const rig = mount();
  await flush();
  assert.equal(rig.listCalls.length, 1, "loads on mount");
  const rr = rows(rig.root);
  assert.equal(rr.length, 2);
  assert.ok(rr[0]!.textContent.includes("GC-000001"), "ref shown");
  assert.ok(rr[0]!.textContent.includes(i18n.t("support.category.bug")), "category label shown");
  assert.ok(rr[0]!.textContent.includes(i18n.t("support.status.answered")), "status label shown");
});

test("help: empty list shows the 'no tickets' hint", async () => {
  const rig = mount({ list: { tickets: [], next_before_id: null } });
  await flush();
  assert.equal(rows(rig.root).length, 0);
  assert.ok(rig.root.find((n) => n.textContent === i18n.t("support.noTickets")), "empty hint");
});

test("help: tapping a ticket opens its detail with the status line, text, and events", async () => {
  const rig = mount();
  await flush();
  rows(rig.root)[0]!.dispatch("click");
  await flush();
  assert.deepEqual(rig.getCalls, ["GC-000001"], "GET the ticket by ref");
  assert.ok(rig.root.find((n) => n.textContent === i18n.t("support.statusLine", { ref: "GC-000001", status: i18n.t("support.status.answered") })), "§3.3 status line");
  assert.ok(rig.root.find((n) => n.hasClass("gc-support-detail-text") && n.textContent === "the composer crashes"), "original text via textContent");
  assert.ok(rig.root.find((n) => n.hasClass("gc-support-event")), "an event line is rendered");
});

test("help: 'open dialog' navigates to the @support chat", async () => {
  const rig = mount();
  await flush();
  rows(rig.root)[0]!.dispatch("click");
  await flush();
  const openBtn = rig.root.find((n) => n.hasClass("gc-btn-accent") && n.textContent === i18n.t("support.openDialog"))!;
  openBtn.dispatch("click");
  assert.deepEqual(rig.opened, [77], "onOpenChat(chat_id)");
});

test("help: back returns from detail to the list", async () => {
  const rig = mount();
  await flush();
  rows(rig.root)[0]!.dispatch("click");
  await flush();
  const back = rig.root.find((n) => n.hasClass("gc-btn") && n.textContent === i18n.t("common.back"))!;
  back.dispatch("click");
  assert.equal(rows(rig.root).length, 2, "list is shown again");
});

test("help: the contact button (when wired) opens the support form", async () => {
  const rig = mount({ onContact: true });
  await flush();
  const contact = rig.root.find((n) => n.hasClass("gc-btn-accent") && n.textContent === i18n.t("support.contact"))!;
  contact.dispatch("click");
  assert.equal(rig.contacts, 1);
});

test("help: 'load more' appears only with a next page and fetches the next keyset window", async () => {
  const rig = mount({ list: { tickets: LIST.tickets, next_before_id: 5 } });
  await flush();
  const more = rig.root.find((n) => n.hasClass("gc-btn") && n.textContent === i18n.t("common.loadMore"))!;
  assert.ok(more, "load-more button present when next_before_id is set");
  more.dispatch("click");
  await flush();
  assert.deepEqual(rig.listCalls[1], [50, 5], "second page uses (limit, before)");
});
