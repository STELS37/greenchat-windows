// clients/ui/test/visual_states_v76.test.ts — V76 regression guard.
//
// Defect, measured on the running client at 390x844 with the network cut, signed in as an account
// that HAS six chats (probe var/ux-audit/tools/m_states_v76.mjs, 2026-07-30):
//
//   offline-chats → «Пока нет чатов» + a full-width accent CTA «Начать первый чат»
//                   + a red line «Нет соединения. Действие поставлено в очередь.»
//
// Three lies in one screen. The account is not empty — the client simply never got an answer; nothing
// was queued, because a failed LOAD is a read; and the only offered move created a seventh chat
// instead of retrying. The same probe found the calls screen using ONE block (`.gc-finance-empty`)
// for an empty result AND for a 500 with no retry at all, and the settings account card drawing a
// green disc containing a literal "?" while /v1/me was in flight.
//
// Pinned here: "no data" and "no answer" are different states with different wording, glyph and
// action; a load in flight shows the silhouette of the content, not a blank page or a question mark;
// and the state block owns the space the content would have taken instead of floating at the top.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createChatListScreen } from "../src/screens/chat_list_screen.ts";
import { failureState, failureLine, stateView, skeletonList } from "../src/screens/state_view.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const here = fileURLToPath(new URL(".", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const redesign = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));
const legacy = strip(readFileSync(resolve(here, "../../web/src/styles.css"), "utf8"));
const listSource = readFileSync(resolve(here, "../src/screens/chat_list_screen.ts"), "utf8");
const callsSource = readFileSync(resolve(here, "../src/screens/calls_screen.ts"), "utf8");
const settingsSource = readFileSync(resolve(here, "../src/screens/settings_screen.ts"), "utf8");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = [...rules(legacy), ...rules(redesign)];
const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1]!.trim() : null;
};

// A transport drop as clients/core reports it: the classifier reads `.name`, never instanceof.
class NetworkError extends Error {
  override name = "NetworkError";
}
class ServerError extends Error {
  override name = "ApiError";
  code = "INTERNAL";
}

class FailingApi implements ApiLike {
  private readonly err: () => unknown;
  constructor(err: () => unknown) { this.err = err; }
  get<T>(): Promise<T> { return Promise.reject(this.err()); }
  post<T>(): Promise<T> { return Promise.reject(this.err()); }
  patch<T>(): Promise<T> { return Promise.reject(this.err()); }
  put<T>(): Promise<T> { return Promise.reject(this.err()); }
  delete<T>(): Promise<T> { return Promise.reject(this.err()); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

function mountList(err: () => unknown) {
  return createChatListScreen({
    api: new FailingApi(err),
    i18n,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    self: { id: 1, name: "Owner", username: "owner" },
    now: () => 1_700_000_000,
  });
}
const nodes = (root: StubNode, cls: string): StubNode[] => root.findAll((n) => n.hasClass(cls));
const visible = (n: StubNode | undefined): boolean => !!n && n.style.display !== "none";

test("V76: a list that could not load never claims the account is empty", async () => {
  const screen = mountList(() => new NetworkError("offline"));
  await settle();
  const root = screen.root as unknown as StubNode;

  const empty = nodes(root, "gc-chats-empty")[0];
  assert.ok(empty, "the empty state still exists for a genuinely empty account");
  assert.equal(visible(empty), false, "but it must not be shown when the load FAILED");

  const state = nodes(root, "gc-state")[0];
  assert.ok(state, "a failed load paints the failure state");
  assert.equal(state.attrs["data-tone"], "offline", "a transport drop is 'offline', not a server error");
  const text = state.textContent;
  assert.ok(text.includes(i18n.t("state.offlineTitle")), `honest title missing: ${text}`);
  assert.ok(!text.includes(i18n.t("chat.emptyList")), "the words «Пока нет чатов» must not appear");
  assert.ok(text.includes(i18n.t("common.retry")), "the offered move is retry");
  screen.destroy();
});

test("V76: the retry button is wired to the loader, not decoration", async () => {
  let calls = 0;
  const screen = mountList(() => { calls += 1; return new NetworkError("offline"); });
  await settle();
  const before = calls;
  const root = screen.root as unknown as StubNode;
  const action = nodes(root, "gc-state-action")[0];
  assert.ok(action, "the failure state carries an action button");
  action.dispatch("click");
  await settle();
  assert.ok(calls > before, "clicking retry issues a new request");
  screen.destroy();
});

test("V76: the create-a-chat call to action is withheld while the client has no data", async () => {
  const screen = mountList(() => new NetworkError("offline"));
  await settle();
  const root = screen.root as unknown as StubNode;
  const fab = nodes(root, "gc-fab")[0];
  assert.ok(fab, "the floating button still exists");
  assert.equal(fab.style.display, "none", "an offline client cannot promise a new chat");
  screen.destroy();
});

test("V76: a read failure never borrows the write-side «action was queued» wording", () => {
  // errors.network describes a QUEUED WRITE. Reusing it for a failed GET told the user an action was
  // pending when nothing was.
  const queued = i18n.t("errors.network");
  assert.ok(queued.includes("очеред"), "precondition: errors.network is still the queued-write line");
  assert.ok(!failureLine(new NetworkError("x"), i18n).includes("очеред"), "stale-data line must not claim a queue");
  const offline = failureState(new NetworkError("x"), i18n, () => {}) as unknown as StubNode;
  assert.ok(!offline.textContent.includes("очеред"), "the offline state must not claim a queue");
});

test("V76: a lost connection and a server failure are told apart", () => {
  const offline = failureState(new NetworkError("x"), i18n, () => {}) as unknown as StubNode;
  const broken = failureState(new ServerError("x"), i18n, () => {}) as unknown as StubNode;
  assert.equal(offline.attrs["data-tone"], "offline");
  assert.equal(broken.attrs["data-tone"], "error");
  assert.notEqual(offline.textContent, broken.textContent, "two different failures, two different answers");
  assert.ok(broken.textContent.includes(i18n.t("state.errorTitle")));
  // The glyph differs too: reusing the warning triangle for a dropped link is what made the two
  // failures indistinguishable on screen.
  const glyph = (n: StubNode): string => JSON.stringify(n.findAll((x) => x.tag === "svg" || x.tag === "path").map((x) => x.attrs.d ?? ""));
  assert.notEqual(glyph(offline), glyph(broken), "offline and error must not draw the same icon");
});

test("V76: a loading list has the silhouette of the list, not a blank page", () => {
  const skeleton = skeletonList(7, { height: 72 }) as unknown as StubNode;
  const rows = skeleton.findAll((n) => n.hasClass("gc-skeleton-row"));
  assert.equal(rows.length, 7, "one placeholder per row the list will show");
  assert.ok(rows[0]!.findAll((n) => n.hasClass("gc-skeleton-avatar")).length === 1, "the disc is part of the silhouette");
  assert.equal(rows[0]!.findAll((n) => n.hasClass("gc-skeleton-line")).length, 2, "title + preview, like a real row");
  assert.equal(String(skeleton.attrs["aria-hidden"]), "true", "a screen reader is told 'busy', not read eight fake rows");
});

test("V76: the account card shimmers instead of printing a question mark", () => {
  assert.ok(!/gc-account-card-avatar[^)]*\}, \["\?"\]/.test(settingsSource), 'the literal "?" avatar is gone');
  assert.ok(/accountAvatar[\s\S]{0,400}is-loading/.test(settingsSource), "the avatar starts in a loading state");
  assert.ok(settingsSource.includes("skeletonLine"), "and the name is a placeholder bar, not the word «Загрузка…»");
  assert.ok(/accountAvatar\.classList\.remove\("is-loading"\)/.test(settingsSource), "and it leaves that state once /v1/me answers");
});

test("V76: every data screen answers a failure with the same shape", () => {
  for (const [name, src] of [["chat list", listSource], ["calls", callsSource]] as const) {
    assert.ok(src.includes("failureState("), `${name} must use the shared failure state`);
  }
  // The calls screen used to end at the error message with no way forward.
  assert.ok(/failureState\(err, i18n, \(\) => \{ void load\(\); \}\)/.test(callsSource), "calls offers a retry that reloads");
});

test("V76: the state block owns the space the content would have taken", () => {
  const stateRules = all.filter(([sel]) => /\.gc-state(?![-\w])/.test(sel));
  assert.ok(stateRules.length > 0, ".gc-state is styled");
  const base = stateRules.find(([sel]) => sel === ".gc-state");
  assert.ok(base, "the base block exists");
  assert.equal(decl(base![1], "min-height"), "100%", "a state that is the whole screen fills it (V70)");
  assert.equal(decl(base![1], "text-align"), "center");
  // Inside a populated section it must NOT stretch — that was the V70/V69 billboard mistake.
  const nested = stateRules.find(([sel]) => sel.includes(":not(:only-child)"));
  assert.ok(nested, "a state block inside a populated screen is constrained");
  assert.equal(decl(nested![1], "min-height"), "0");
});

test("V76: the three tones are visually distinct, and none of them is decoration-only", () => {
  const tones = ["offline", "error"].map((t) => all.find(([sel]) => sel.includes(`[data-tone="${t}"]`)));
  for (const rule of tones) assert.ok(rule, "each failure tone has its own paint");
  const colours = tones.map((r) => decl(r![1], "color"));
  assert.notEqual(colours[0], colours[1], "offline and error do not share one colour");
  for (const c of colours) assert.ok(c && c.includes("var(--gc-"), `tones use palette tokens, got ${c}`);
});

test("V76: the shimmer is decoration and stops for reduced motion", () => {
  const shimmer = all.filter(([sel, body]) => /gc-skeleton/.test(sel) && /animation\s*:/.test(body));
  assert.ok(shimmer.length > 0, "the placeholders animate");
  const reduced = redesign.slice(redesign.indexOf("prefers-reduced-motion"));
  assert.ok(/gc-skeleton[\s\S]{0,400}animation:\s*none/.test(reduced), "and stop when the system asks for less motion");
});

test("V76: zero server chats is still a successful loaded result with system destinations", async () => {
  // V187 deliberately appends Support and Bot Center to the All list before any ordinary dialog exists.
  // A successful [] response therefore remains distinct from a failed read, but is no longer visually empty.
  class EmptyApi implements ApiLike {
    get<T>(path: string): Promise<T> {
      if (path.startsWith("/v1/badge")) return Promise.resolve({ total_unread: 0 } as unknown as T);
      return Promise.resolve([] as unknown as T);
    }
    post<T>(): Promise<T> { return Promise.reject(new Error("no")); }
    patch<T>(): Promise<T> { return Promise.reject(new Error("no")); }
    put<T>(): Promise<T> { return Promise.reject(new Error("no")); }
    delete<T>(): Promise<T> { return Promise.reject(new Error("no")); }
    refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
  }
  const screen = createChatListScreen({
    api: new EmptyApi(), i18n, onOpenChat: () => {}, onOpenSettings: () => {}, onLogout: () => {},
    self: { id: 1, name: "Owner", username: "owner" }, now: () => 1_700_000_000,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.equal(visible(nodes(root, "gc-chats-empty")[0]), false, "useful system rows suppress a false empty-state claim");
  assert.equal(nodes(root, "gc-state").length, 0, "a successful empty server response is still not a failure");
  assert.notEqual(nodes(root, "gc-fab")[0]?.style.display, "none", "new chat remains reachable above the populated list");
  screen.destroy();
});

test("V76: stateView keeps the empty tone's action visually primary", () => {
  const empty = stateView({ tone: "empty", icon: "chats", title: "t", actionLabel: "go", onAction: () => {} }) as unknown as StubNode;
  const btn = empty.findAll((n) => n.hasClass("gc-state-action"))[0]!;
  assert.ok(btn.hasClass("gc-btn-accent"), "an invitation is a primary button");
  const offline = failureState(new NetworkError("x"), i18n, () => {}) as unknown as StubNode;
  const retry = offline.findAll((n) => n.hasClass("gc-state-action"))[0]!;
  assert.ok(!retry.hasClass("gc-btn-accent"), "a retry is a quiet button — it is not the app's goal");
});
