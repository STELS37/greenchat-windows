// clients/ui/test/visual_calls_billboard_v69.test.ts — V69 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile (probes
// var/ux-audit/tools/m_calls_v69.mjs and m_above_v69.mjs, 2026-07-30):
//
//   .gc-calls-hero      358 x 211   y=119    — a quarter of the phone, above the real list
//   first .gc-call-dialog          y=372     — the first person began at 44% of the viewport
//
// The card was permanent: it stood there whether the list held ten people or none. Of its four
// children three were decoration that restated the header two rows above it —
// «Прямое защищённое соединение» / «Готово к звонкам» / «Выберите человека и откройте диалог…» —
// and the fourth was the screen's only actual fact, TURN/STUN readiness plus the ring timeout. That
// one was hidden by `@media (max-width: 760px) { .gc-calls-readiness { display: none } }`, so on
// every phone the 211px card carried exactly zero information.
//
// Reference (Telegram for Android master, CallLogActivity.java read 2026-07-30): the call log has a
// billboard too, and it is the EMPTY view — `listView.setEmptyView(emptyView)` (:847), a full-content
// panel (:844) shown only when there is nothing to list. The permanent chrome above the list is the
// action bar plus an animated, dismissible top panel (`checkUi_listViewPadding`, :1530); no card is
// ever wedged between the bar and the first row.
//
// The fix follows that split: the readiness sentence moves into `.gc-calls-status`, the aria-live row
// the header already reserves for «загрузка» and errors, and the card is deleted from the markup and
// from both stylesheets. `.gc-finance-empty` keeps playing the reference's empty view. Measured after:
// the first person sits at y=179.2, against y=174.0 for the same people on the chat list — 5px apart,
// where before the two screens disagreed by 198px.
//
// The guard is behavioural for the screen (mount it and read the tree) and textual for the sheets and
// dictionaries, so a re-added card, a lost readiness fact, or a resurrected orphan rule all fail.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import { createCallsScreen } from "../src/screens/calls_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(here, relative), "utf8");
const sheets = { redesign: read("../../web/src/redesign.css"), legacy: read("../../web/src/styles.css") };
const screen = read("../src/screens/calls_screen.ts");

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

const person = (id: number): ChatEntry => ({
  id,
  kind: "dialog",
  title: `Человек ${id}`,
  username: `user${id}`,
  photo_file_id: null,
  last_message: null,
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: false,
  my_role: "member",
  message_ttl_sec: 0,
  draft: null,
  updated_at: 0,
});

class CallsApi implements ApiLike {
  // Node's type stripping runs this file as-is, so no constructor parameter properties.
  private readonly opts: { turn: boolean; people: number };
  constructor(opts: { turn: boolean; people: number }) {
    this.opts = opts;
  }
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/calls/config")) {
      return Promise.resolve({
        ice_servers: this.opts.turn
          ? [{ urls: "stun:stun.example:3478" }, { urls: ["turn:turn.example:3478"], username: "u" }]
          : [{ urls: "stun:stun.example:3478" }],
        ring_sec: 40,
      } as T);
    }
    // V146 made call history an independent data source. This V69 fixture tests the billboard/people
    // layout, not history failures, so it must answer the now-normal history request with a genuine
    // empty page; rejecting it creates a second error state and invalidates the fixture itself.
    if (path.startsWith("/v1/calls/history")) {
      return Promise.resolve({ items: [], next_before: null } as T);
    }
    if (path.startsWith("/v1/chats")) {
      return Promise.resolve(Array.from({ length: this.opts.people }, (_, i) => person(i + 1)) as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const mount = async (opts: { turn: boolean; people: number }): Promise<StubNode> => {
  const view = createCallsScreen({ api: new CallsApi(opts), i18n, onBack() {}, onOpenChat() {}, atShellRoot: true });
  await settle();
  return view.root as unknown as StubNode;
};

const byClass = (root: StubNode, name: string): StubNode[] => root.findAll((node) => node.hasClass(name));

test("V69: nothing stands between the header and the list of people", async () => {
  const root = await mount({ turn: true, people: 3 });
  for (const dead of ["gc-calls-hero", "gc-calls-hero-icon", "gc-calls-readiness"]) {
    assert.deepEqual(byClass(root, dead), [], `${dead} must not be rendered again`);
  }
  const body = byClass(root, "gc-calls-body")[0];
  assert.ok(body, "the screen still has its scrolling body");
  // V74 gave the screen a second real section (the call log above the people list), so the V69
  // invariant is no longer "exactly one child" — it is "every child is content". A decorative plate
  // pushed between the header and the data is exactly what V69 removed, and it would appear here as
  // a child that is not a .gc-calls-section.
  assert.ok(body.children.length >= 1, "the body still carries its sections");
  for (const child of body.children) {
    assert.ok(
      child.hasClass("gc-calls-section"),
      `only content sections may sit in the body, found: ${String(child.attrs.class ?? child.tag)}`,
    );
  }
  assert.equal(byClass(root, "gc-call-dialog").length, 3, "every dialog is still listed");
});

test("V69: the readiness fact is not lost — it is the status line", async () => {
  const withTurn = await mount({ turn: true, people: 3 });
  const status = byClass(withTurn, "gc-calls-status")[0];
  assert.ok(status, "the header still reserves its status row");
  assert.equal(status.attrs.role, "status", "it stays a live region…");
  assert.equal(status.attrs["aria-live"], "polite", "…announced politely, not assertively");
  assert.equal(
    status.textContent,
    `${i18n.t("calls.turnReady")} · ${i18n.t("calls.ringTime", { seconds: "40" })}`,
    "one sentence: how the media is relayed, and how long a call rings",
  );
  const stunOnly = await mount({ turn: false, people: 3 });
  assert.equal(
    byClass(stunOnly, "gc-calls-status")[0]!.textContent,
    `${i18n.t("calls.stunOnly")} · ${i18n.t("calls.ringTime", { seconds: "40" })}`,
    "the STUN-only wording still reaches the user",
  );
});

test("V69: the empty list keeps the reference's banner", async () => {
  const root = await mount({ turn: true, people: 0 });
  // V85 renamed the block: the shared `.gc-state` replaced the screen-local `.gc-finance-empty`.
  // The claim is unchanged — with nobody to call, the list is replaced by exactly one empty view.
  assert.equal(byClass(root, "gc-state").length, 1, "no people => the empty view, as CallLogActivity does");
  assert.equal(byClass(root, "gc-call-dialog").length, 0, "and no rows behind it");
});

test("V69: neither stylesheet keeps an orphan rule for the deleted card", () => {
  for (const [name, css] of Object.entries(sheets)) {
    const live = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(live, /\.gc-calls-(?:hero|readiness)\b/, `${name} still styles a card nobody renders`);
  }
});

test("V69: the card's decorative copy is gone from both dictionaries", () => {
  const dead = ["calls.encrypted", "calls.readyTitle", "calls.readyLead"];
  for (const key of dead) {
    assert.equal((ru as Record<string, string>)[key], undefined, `ru still ships ${key}`);
    assert.equal((en as Record<string, string>)[key], undefined, `en still ships ${key}`);
    assert.ok(!screen.includes(key), `the screen still asks for ${key}`);
  }
  // The facts stayed: the three keys the status line needs are still translated in both locales.
  for (const key of ["calls.turnReady", "calls.stunOnly", "calls.ringTime"]) {
    assert.equal(typeof (ru as Record<string, string>)[key], "string", `ru must keep ${key}`);
    assert.equal(typeof (en as Record<string, string>)[key], "string", `en must keep ${key}`);
  }
});
