// Re-consent program (client half) — the APP-LEVEL blocking contract, red-first:
//   reconsent_required=true  ⇒ every authenticated screen is replaced by the blocking consent screen
//                              until POST /v1/legal/accept succeeds with the DISPLAYED edition;
//   reconsent_required=false ⇒ no consent screen, the ordinary app;
//   status unreachable       ⇒ FAIL-OPEN: sign-in is not blocked (account state, not a security gate);
//   decline                  ⇒ sign-out (auth screen), never a silent continue;
//   403 from accept          ⇒ status re-fetched, the NEW edition shown, no self-retry loop.
// Full createApp over the hand-rolled document stub (support_help.test.ts pattern, extended with the
// classList/ownerDocument/fragment surface the chat list's VirtualList needs) — no browser.
import { test } from "node:test";
import assert from "node:assert/strict";

class StubNode {
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(e: { preventDefault(): void }) => void>> = {};
  style: Record<string, string> = {};
  value = "";
  checked = false;
  disabled = false;
  scrollTop = 0;
  readonly clientHeight = 0;
  readonly scrollHeight = 0;
  tag: string;
  private readonly isText: boolean;
  private text = "";
  constructor(tag: string, isText = false) { this.tag = tag; this.isText = isText; }
  get ownerDocument(): unknown { return stubDocument; }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === "disabled") this.disabled = true;
    if (k === "checked") this.checked = true;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
    if (k === "disabled") this.disabled = false;
  }
  get className(): string { return this.attrs["class"] ?? ""; }
  hasClass(c: string): boolean { return this.className.split(/\s+/).includes(c); }
  readonly classList = {
    add: (...cs: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of cs) set.add(c);
      this.attrs["class"] = [...set].join(" ");
    },
    remove: (...cs: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of cs) set.delete(c);
      this.attrs["class"] = [...set].join(" ");
    },
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.hasClass(c);
      if (on) this.classList.add(c); else this.classList.remove(c);
      return on;
    },
    contains: (c: string) => this.hasClass(c),
  };
  private adopt(child: StubNode | string): StubNode[] {
    const node = typeof child === "string" ? new StubNode("#text", true) : child;
    if (typeof child === "string") node.textContent = child;
    if (node.tag === "#fragment") { const kids = [...node.children]; node.children = []; return kids; }
    return [node];
  }
  append(...kids: Array<StubNode | string>): void {
    for (const k of kids) for (const node of this.adopt(k)) { node.parent = this; this.children.push(node); }
  }
  appendChild(k: StubNode): StubNode { this.append(k); return k; }
  replaceChildren(...kids: Array<StubNode | string>): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...kids);
  }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  removeChild(k: StubNode): StubNode { const i = this.children.indexOf(k); if (i >= 0) this.children.splice(i, 1); k.parent = null; return k; }
  remove(): void { this.parent?.removeChild(this); }
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void {
    const arr = this.listeners[type];
    if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
  }
  dispatch(type: string): void { for (const fn of [...(this.listeners[type] ?? [])]) fn({ preventDefault() {} }); }
  focus(): void {}
  contains(n: StubNode): boolean { return this === n || this.children.some((c) => c.contains(n)); }
  get textContent(): string { return this.isText ? this.text : this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { if (this.isText) { this.text = v; return; } this.children = []; if (v !== "") this.append(v); }
  find(pred: (n: StubNode) => boolean): StubNode | null {
    if (pred(this)) return this;
    for (const c of this.children) { const r = c.find(pred); if (r) return r; }
    return null;
  }
}
const stubDocument = {
  createElement: (tag: string) => new StubNode(tag),
  // V4 shell icons are SVG (icons.ts createElementNS) — the same StubNode covers them here.
  createElementNS: (_ns: string, tag: string) => new StubNode(tag),
  createTextNode: (text: string) => { const n = new StubNode("#text", true); n.textContent = text; return n; },
  createDocumentFragment: () => new StubNode("#fragment"),
};
(globalThis as unknown as { document: unknown }).document = stubDocument;

import { createApp } from "../src/screens/app.ts";
import { Session } from "../src/screens/session.ts";
import type { TokenHolder, SessionStorage, PersistedSession } from "../src/screens/session.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { OutboxPort, EventFeed } from "../src/screens/feed_screen.ts";
import type { ServerPort } from "../src/screens/server_screen.ts";
import { HashRouter, WEB_ROUTES } from "../src/router.ts";
import type { HashEnv } from "../src/router.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (): Promise<void> => { await flush(); await flush(); await flush(); };

// A path-keyed scriptable ApiLike: handlers throw/return per path; every call is recorded.
interface Call { method: string; path: string; body?: unknown }
class FakeApi implements ApiLike {
  calls: Call[] = [];
  handlers = new Map<string, (body?: unknown) => unknown>();
  private dispatch<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const h = this.handlers.get(path);
    if (!h) return Promise.reject(new Error(`unhandled ${method} ${path}`));
    return Promise.resolve().then(() => h(body) as T);
  }
  get<T>(path: string): Promise<T> { return this.dispatch("GET", path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.dispatch("POST", path, body); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.dispatch("PUT", path, body); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.dispatch("PATCH", path, body); }
  delete<T>(path: string): Promise<T> { return this.dispatch("DELETE", path); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(true); }
  count(path: string): number { return this.calls.filter((c) => c.path === path).length; }
}

class FakeStorage implements SessionStorage {
  value: PersistedSession | null = { refresh: "ref-1", user: { id: 7, username: "ann", name: "Ann" } };
  load(): PersistedSession | null { return this.value; }
  save(v: PersistedSession): void { this.value = v; }
  clear(): void { this.value = null; }
}

const fakeHashEnv = (initialHash = ""): HashEnv => {
  let hash = initialHash;
  const subs = new Set<() => void>();
  return {
    getHash: () => hash,
    setHash: (h: string) => { hash = h; for (const s of [...subs]) s(); },
    listen: (cb: () => void) => { subs.add(cb); return () => subs.delete(cb); },
  };
};

const doc = (doc: string, version: number): unknown => ({ version, doc, markdown: `# ${doc} v${version}\n\ntext of edition ${version}` });

// Assemble the full app over fakes. `status` scripts GET /v1/legal/status (throw = offline).
function harness(
  status: () => unknown,
  options: { initialHash?: string; withServer?: boolean } = {},
) {
  const api = new FakeApi();
  api.handlers.set("/v1/legal/status", status);
  api.handlers.set("/v1/legal/tos", () => doc("tos", 2));
  api.handlers.set("/v1/legal/privacy", () => doc("privacy", 2));
  api.handlers.set("/v1/legal/accept", () => ({ version: 2, accepted_at: 1 }));
  api.handlers.set("/v1/chats?filter=all", () => []);
  api.handlers.set("/v1/badge", () => ({ total_unread: 0 }));
  api.handlers.set("/v1/auth/logout", () => null);
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const storage = new FakeStorage();
  const session = new Session({ api, tokens, storage });
  const host = new StubNode("div") as unknown as HTMLElement;
  const i18n = createI18n({ locale: "en", dicts: { ru, en } });
  const server: ServerPort | undefined = options.withServer ? {
    current: () => "",
    isDefault: () => true,
    authed: () => session.isAuthed(),
    save: () => Promise.resolve(),
    failover: { get: () => true, set: () => {} },
  } : undefined;
  const app = createApp({
    host, api, session, i18n,
    router: new HashRouter(WEB_ROUTES, fakeHashEnv(options.initialHash ?? "")),
    outbox: { subscribe: () => () => {} } as unknown as OutboxPort,
    events: { subscribe: () => () => {} } as EventFeed,
    ...(server ? { server } : {}),
  });
  return { api, session, host: host as unknown as StubNode, app };
}

const findScreen = (host: StubNode, cls: string): StubNode | null => host.find((n) => n.hasClass(cls));

test("reconsent_required=true: the app blocks on the consent screen; accept sends the DISPLAYED version and unblocks", async () => {
  const h = harness(() => ({ accepted_version: 1, current_version: 2, reconsent_required: true }));
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();

  // Blocked: the consent screen is the ONLY authenticated surface; no chat list behind it.
  assert.ok(findScreen(h.host, "gc-reconsent"), "the blocking re-consent screen must be mounted");
  assert.equal(findScreen(h.host, "gc-chats"), null, "no ordinary screen may mount while consent is owed");
  // The current documents were fetched for display.
  assert.equal(h.api.count("/v1/legal/tos"), 1);
  assert.equal(h.api.count("/v1/legal/privacy"), 1);

  // Explicit consent: tick the checkbox, press accept.
  const agree = h.host.find((n) => n.tag === "input" && n.attrs["type"] === "checkbox")!;
  agree.checked = true;
  agree.dispatch("change");
  const acceptBtn = h.host.find((n) => n.tag === "button" && n.hasClass("gc-reconsent-accept"))!;
  assert.equal(acceptBtn.disabled, false, "accept becomes actionable once consent is ticked");
  acceptBtn.dispatch("click");
  await settle();

  // The accept carried EXACTLY the displayed edition — from the server payloads, never a hardcode.
  const accept = h.api.calls.find((c) => c.path === "/v1/legal/accept");
  assert.ok(accept, "accept must be posted");
  assert.deepEqual(accept!.body, { legal_accepted: true, version: 2 });
  // …and the app proceeded to the ordinary screen.
  assert.ok(findScreen(h.host, "gc-chats"), "after accept the ordinary app resumes");
  assert.equal(findScreen(h.host, "gc-reconsent"), null);
  h.app.destroy();
});

test("reconsent_required=false: no consent screen, no accept call — the ordinary app boots", async () => {
  const h = harness(() => ({ accepted_version: 2, current_version: 2, reconsent_required: false }));
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  assert.ok(findScreen(h.host, "gc-chats"));
  assert.equal(findScreen(h.host, "gc-reconsent"), null);
  assert.equal(h.api.count("/v1/legal/accept"), 0);
  h.app.destroy();
});

test("fail-open: status unreachable (offline/5xx) must NOT block sign-in — the ordinary app boots", async () => {
  const h = harness(() => { throw Object.assign(new Error("offline"), { name: "NetworkError" }); });
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  assert.ok(findScreen(h.host, "gc-chats"), "account-state probe failure must not lock the user out");
  assert.equal(findScreen(h.host, "gc-reconsent"), null);
  h.app.destroy();
});

test("non-transient status failure blocks on retry/logout instead of silently continuing", async () => {
  let attempt = 0;
  const h = harness(() => {
    if (++attempt === 1) {
      throw Object.assign(new Error("bad legal status"), {
        name: "ApiError", code: "VALIDATION_FAILED", httpStatus: 400, data: {},
      });
    }
    return { accepted_version: 2, current_version: 2, reconsent_required: false };
  });
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  assert.ok(findScreen(h.host, "gc-reconsent-error"));
  assert.equal(findScreen(h.host, "gc-chats"), null);

  h.host.find((n) => n.tag === "button" && n.hasClass("gc-reconsent-retry"))!.dispatch("click");
  await settle();
  assert.equal(findScreen(h.host, "gc-reconsent-error"), null);
  assert.ok(findScreen(h.host, "gc-chats"), "a valid retry reopens the ordinary app");
  h.app.destroy();
});

test("authenticated #/connect cannot bypass an owed legal edition", async () => {
  const h = harness(
    () => ({ accepted_version: 1, current_version: 2, reconsent_required: true }),
    { initialHash: "#/connect", withServer: true },
  );
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  assert.ok(findScreen(h.host, "gc-reconsent"));
  assert.equal(findScreen(h.host, "gc-server"), null, "server settings remain behind the legal gate");
  h.app.destroy();
});

test("document version mismatch never enables consent for unseen text", async () => {
  const h = harness(() => ({ accepted_version: 1, current_version: 2, reconsent_required: true }));
  h.api.handlers.set("/v1/legal/tos", () => doc("tos", 1));
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  assert.ok(findScreen(h.host, "gc-reconsent"));
  assert.ok(h.host.find((n) => n.hasClass("gc-reconsent-retry")), "mismatch is a retryable blocking error");
  assert.equal(h.host.find((n) => n.hasClass("gc-reconsent-accept")), null);
  assert.equal(h.host.find((n) => n.tag === "input" && n.attrs["type"] === "checkbox"), null);
  h.app.destroy();
});

test("decline signs the session out (auth screen) — never a silent continue", async () => {
  const h = harness(() => ({ accepted_version: 1, current_version: 2, reconsent_required: true }));
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  const decline = h.host.find((n) => n.tag === "button" && n.hasClass("gc-reconsent-decline"))!;
  assert.ok(decline, "an explicit decline affordance must exist");
  decline.dispatch("click");
  await settle();
  assert.equal(h.api.count("/v1/auth/logout"), 1, "decline ends the session server-side (best-effort)");
  assert.equal(h.session.isAuthed(), false);
  assert.ok(findScreen(h.host, "gc-auth"), "back to sign-in");
  assert.equal(findScreen(h.host, "gc-reconsent"), null);
  h.app.destroy();
});

test("403 from accept (edition moved): status re-fetched, the NEW edition is shown and re-asked — no self-retry", async () => {
  const h = harness(() => ({ accepted_version: 1, current_version: 2, reconsent_required: true }));
  // First accept refuses (edition bumped to 3 under our feet); the fresh status/documents say 3.
  let accepts = 0;
  h.api.handlers.set("/v1/legal/accept", (body) => {
    accepts++;
    if ((body as { version?: number }).version !== 3) {
      throw Object.assign(new Error("re-consent"), {
        name: "ApiError", code: "LEGAL_RECONSENT", httpStatus: 403, data: { version: 3 },
      });
    }
    return { version: 3, accepted_at: 2 };
  });
  assert.equal(await h.session.restore(), true);
  h.app.start();
  await settle();
  h.api.handlers.set("/v1/legal/status", () => ({ accepted_version: 1, current_version: 3, reconsent_required: true }));
  h.api.handlers.set("/v1/legal/tos", () => doc("tos", 3));
  h.api.handlers.set("/v1/legal/privacy", () => doc("privacy", 3));

  const agree = h.host.find((n) => n.tag === "input" && n.attrs["type"] === "checkbox")!;
  agree.checked = true;
  agree.dispatch("change");
  h.host.find((n) => n.tag === "button" && n.hasClass("gc-reconsent-accept"))!.dispatch("click");
  await settle();

  // Still blocked, showing the NEW edition; consent was NOT auto-retried (that needs a new click).
  assert.equal(accepts, 1, "no self-retry loop after a 403");
  assert.ok(findScreen(h.host, "gc-reconsent"), "still blocked on the new edition");
  assert.ok(h.api.count("/v1/legal/status") >= 2, "the 403 triggers a fresh status read");
  const tosText = h.host.find((n) => n.hasClass("gc-reconsent-doc"));
  assert.ok(tosText?.textContent.includes("edition 3"), "the re-shown documents are the new edition");

  // The person re-consents to the new text: the accept now carries version 3.
  const agree2 = h.host.find((n) => n.tag === "input" && n.attrs["type"] === "checkbox")!;
  assert.equal(agree2.checked, false, "consent tick resets for the new edition");
  agree2.checked = true;
  agree2.dispatch("change");
  h.host.find((n) => n.tag === "button" && n.hasClass("gc-reconsent-accept"))!.dispatch("click");
  await settle();
  assert.equal(accepts, 2);
  const last = h.api.calls.filter((c) => c.path === "/v1/legal/accept").at(-1)!;
  assert.deepEqual(last.body, { legal_accepted: true, version: 3 });
  assert.ok(findScreen(h.host, "gc-chats"), "accepting the new edition unblocks");
  h.app.destroy();
});
