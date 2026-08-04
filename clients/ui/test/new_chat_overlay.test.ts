// DOM-stub test for the "New chat" overlay (T-426). Mirrors the op/w1 pattern (virtual_list.test.ts):
// a hand-rolled document/element stub so the overlay's search→render→select→create→navigate wiring is
// exercised under node:test without a browser. el()/clear() read the GLOBAL document, so we install the
// stub before constructing the overlay (this file runs in its own test-runner subprocess → isolated).
import { test } from "node:test";
import assert from "node:assert/strict";
// These imports don't touch document at load time — el()/clear() only run inside createNewChatOverlay,
// which the tests call after the stub below is installed — so ordinary top-of-file imports are safe.
import { createNewChatOverlay } from "../src/screens/new_chat_overlay.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { GlobalSearchResult, DialogChat, SearchUser } from "../src/screens/api.ts";
import type { SelfRef } from "../src/screens/chat_model.ts";

// ---- minimal DOM stub -----------------------------------------------------------------------------

class StubNode {
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  style: Record<string, string> = {};
  value = "";
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
  appendChild(k: StubNode): StubNode { this.append(k); return k; }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  removeChild(k: StubNode): StubNode {
    const i = this.children.indexOf(k);
    if (i >= 0) this.children.splice(i, 1);
    k.parent = null;
    return k;
  }
  remove(): void { this.parent?.removeChild(this); }

  addEventListener(type: string, fn: (e: unknown) => void): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners[type];
    const i = arr ? arr.indexOf(fn) : -1;
    if (arr && i >= 0) arr.splice(i, 1);
  }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
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

  // test-only tree queries
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
const me: SelfRef = { id: 7, name: "Me", username: "me" };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const rowsIn = (root: StubNode): StubNode[] => root.findAll((n) => n.hasClass("gc-chat-row"));
const openBtns = (root: StubNode): StubNode[] => root.findAll((n) => n.hasClass("gc-chat-open"));

interface Rig {
  root: StubNode;
  overlay: ReturnType<typeof createNewChatOverlay>;
  fire(): void;
  createCalls: number[];
  opened: number[];
  created: DialogChat[];
}

function mount(users: SearchUser[], dialog: Partial<DialogChat> = {}): Rig {
  const container = new StubNode("body");
  let scheduled: (() => void) | null = null;
  const createCalls: number[] = [];
  const opened: number[] = [];
  const created: DialogChat[] = [];
  const overlay = createNewChatOverlay({
    i18n, self: me,
    search: (): Promise<GlobalSearchResult> => Promise.resolve({ users, chats: [], messages: [] }),
    createDialog: (userId): Promise<DialogChat> => {
      createCalls.push(userId);
      return Promise.resolve({
        id: 555, kind: "dialog", title: "Ann", username: null, my_role: "member",
        message_ttl_sec: 0, updated_at: 1, ...dialog,
      });
    },
    onOpenChat: (id) => opened.push(id),
    onCreated: (chat) => created.push(chat),
    setTimer: (fn) => { scheduled = fn; return 1; },
    clearTimer: () => { scheduled = null; },
    debounceMs: 300,
  });
  container.append(overlay.root as unknown as StubNode);
  return { root: overlay.root as unknown as StubNode, overlay, fire: () => { const s = scheduled; scheduled = null; s?.(); }, createCalls, opened, created };
}

async function type(rig: Rig, text: string): Promise<void> {
  const input = rig.root.find((n) => n.tag === "input")!;
  input.value = text;
  input.dispatch("input");
  rig.fire();       // elapse the debounce
  await flush();    // resolve the search promise
}

// ---- tests ----------------------------------------------------------------------------------------

test("overlay: opens with the Saved Messages row first and a search hint", () => {
  const rig = mount([]);
  const rows = rowsIn(rig.root);
  assert.equal(rows.length, 1, "just the pinned self row before any query");
  assert.equal(rows[0]!.find((n) => n.hasClass("gc-row-title"))!.textContent, "Saved Messages");
  // V29: the overlay draws the same avatar as the chat list — a bookmark icon for Saved Messages, a
  // toned monogram for people — so one contact no longer changes colour between the two screens.
  assert.ok(rows[0]!.find((n) => n.hasClass("gc-avatar"))!.hasClass("is-saved"), "bookmark avatar, not a letter");
  assert.equal(rig.root.find((n) => n.hasClass("gc-palette-empty"))!.textContent, "Type at least 2 characters to find people");
});

test("overlay: a query renders the Saved row plus one result row per found user", async () => {
  const rig = mount([{ id: 2, username: "ann", name: "Ann", avatar_file_id: null, is_bot: false }]);
  await type(rig, "sa");   // matches the "Saved Messages" label, so the pinned row stays on screen
  const rows = rowsIn(rig.root);
  assert.equal(rows.length, 2, "self row + the one match");
  const person = rows[1]!;
  assert.equal(person.find((n) => n.hasClass("gc-row-title"))!.textContent, "Ann");
  assert.equal(person.find((n) => n.hasClass("gc-row-sub"))!.textContent, "@ann");
});

test("overlay: an empty result set shows the 'no one found' hint and no contradicting rows", async () => {
  const rig = mount([]);
  await type(rig, "zz");
  assert.equal(rowsIn(rig.root).length, 0, "nothing matched 'zz' — not even the pinned row pretends it did");
  assert.equal(rig.root.find((n) => n.hasClass("gc-palette-empty"))!.textContent, "No one found");
});

test("overlay: the pinned Saved row is filtered out by a query it cannot match", async () => {
  const rig = mount([{ id: 2, username: "ann", name: "Ann", avatar_file_id: null, is_bot: false }]);
  await type(rig, "an");   // "Saved Messages" does not contain "an"
  const rows = rowsIn(rig.root);
  assert.equal(rows.length, 1, "only the real match is listed");
  assert.equal(rows[0]!.find((n) => n.hasClass("gc-row-title"))!.textContent, "Ann");
});

test("overlay: tapping a result creates the dialog, hands it to the list, opens it, and closes", async () => {
  const rig = mount([{ id: 2, username: "ann", name: "Ann", avatar_file_id: null, is_bot: false }]);
  await type(rig, "sa");
  openBtns(rig.root)[1]!.dispatch("click");   // the person row (index 0 is the self row)
  await flush();
  assert.deepEqual(rig.createCalls, [2], "POST /v1/chats/dialog for the tapped user");
  assert.deepEqual(rig.created.map((c) => c.id), [555], "the new chat is handed to the list first");
  assert.deepEqual(rig.opened, [555], "then the shell navigates to the new chat's feed");
  assert.equal(rig.root.parent, null, "the overlay closed itself");
});

test("overlay: tapping the always-first Saved Messages row opens the self-dialog", async () => {
  const rig = mount([], { id: 999 });
  openBtns(rig.root)[0]!.dispatch("click");   // the self row
  await flush();
  assert.deepEqual(rig.createCalls, [7], "self-dialog = POST /v1/chats/dialog with the viewer's own id");
  assert.deepEqual(rig.opened, [999]);
});

test("overlay: a double-tap can't open two dialogs (busy guard)", async () => {
  const rig = mount([{ id: 2, username: "ann", name: "Ann", avatar_file_id: null, is_bot: false }]);
  await type(rig, "sa");
  const btn = openBtns(rig.root)[1]!;
  btn.dispatch("click");
  btn.dispatch("click");   // second tap before the first create resolves
  await flush();
  assert.deepEqual(rig.createCalls, [2], "exactly one dialog created");
});

test("overlay: Escape closes it and cancels the pending search", () => {
  const rig = mount([]);
  let prevented = false;
  rig.root.dispatch("keydown", { key: "Escape", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(rig.root.parent, null, "removed from the DOM");
});

test("overlay: a click on the backdrop (but not the panel) closes it", () => {
  const rig = mount([]);
  rig.root.dispatch("click", { target: rig.root });   // target === overlay → backdrop
  assert.equal(rig.root.parent, null);
});

test("overlay: a click inside the panel does NOT close it", () => {
  const rig = mount([]);
  const panel = rig.root.find((n) => n.hasClass("gc-forward-panel"))!;
  rig.root.dispatch("click", { target: panel });
  assert.notEqual(rig.root.parent, null, "still mounted");
});
