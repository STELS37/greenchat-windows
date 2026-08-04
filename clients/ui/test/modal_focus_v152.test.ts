// clients/ui/test/modal_focus_v152.test.ts — V152: a modal must own the keyboard, and give it back.
//
// V151 fixed this for the media viewer alone («просмотрщик объявлен `role="dialog" aria-modal="true"`,
// но клавиатура оставалась в ленте»). This file measures the same contract across EVERY surface in
// the client that declares itself modal, because the defect was never viewer-specific: it is what
// happens when a surface announces `aria-modal="true"` and then does nothing about focus.
//
// `aria-modal="true"` is not decoration — it tells assistive technology that everything outside this
// node no longer exists. So a surface that raises the flag and leaves the keyboard behind is worse
// than one that never raised it: the screen reader has hidden the page the caret is still standing
// on. On a phone that is TalkBack; on the desktop/web build and on an Android tablet with a keyboard
// it is plain Tab.
//
// The contract, one line each:
//   1. opening moves focus INTO the surface;
//   2. Tab and Shift+Tab stay inside while it is open;
//   3. closing returns focus to whatever opened it;
//   4. a repaint of an already-open surface must NOT move focus (or a mute tap would fight the user).
//
// Harness note: the stub fires listeners on the node they were registered on (no bubbling), so key
// events are dispatched on the container that owns the handler. What is being measured here is the
// product's focus bookkeeping, not the browser's event path.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { CommandPalette } from "../src/command_palette.ts";
import { presentUpdateStatus } from "../src/update_banner.ts";
import { createCallOverlay } from "../src/screens/call_overlay.ts";
import { IDLE_STATE, type CallController, type CallState } from "../src/screens/call_model.ts";
import { createChatInfoOverlay } from "../src/screens/chat_info.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { installDomStub, settle, StubNode } from "./dom_stub.ts";

const i18n = createI18n({ locale: "en", dicts: { en, ru } });

interface Doc {
  body: StubNode;
  activeElement: StubNode | null;
}
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;

/** A fresh document with a body and one focusable control standing in for "the screen behind". */
function stage(): { body: StubNode; opener: StubNode } {
  installDomStub();
  const body = new StubNode("body");
  doc().body = body;
  const opener = new StubNode("button");
  body.append(opener);
  opener.focus();
  return { body, opener };
}

const active = (): StubNode | null => doc().activeElement;
const within = (root: StubNode, node: StubNode | null): boolean => root.contains(node);
const focusables = (root: StubNode): StubNode[] =>
  root.findAll((n) => (n.tag === "button" || n.tag === "input" || n.tag === "select") && !n.disabled);

/** Press a key on a node, reporting whether the handler claimed it. */
function press(node: StubNode, key: string, shiftKey = false): boolean {
  let prevented = false;
  node.dispatch("keydown", { key, shiftKey, preventDefault: () => { prevented = true; } });
  return prevented;
}

// ---- 1. the command palette ---------------------------------------------------------------------
// The palette is the ONE surface that already uses createFocusTrap, which is why it is measured
// first: if the shared helper is used wrongly here, every surface that adopts it inherits the bug.
test("V152: the palette hands the keyboard back to the screen it covered", () => {
  const { body, opener } = stage();
  const palette = new CommandPalette({
    commands: () => [{ id: "a", title: "Alpha", run: () => {} }],
    placeholder: "Search",
  });
  palette.show();
  const overlay = body.children.find((n) => n.hasClass("gc-palette-overlay"));
  assert.ok(overlay, "the palette mounts an overlay");
  assert.ok(within(overlay, active()), "the palette must take the keyboard when it opens");

  palette.close();
  assert.equal(
    active(),
    opener,
    "closing the palette must return focus to the control that opened it — otherwise the caret is " +
      "left inside a display:none overlay and the next Tab starts from the top of the document",
  );
});

// ---- 2. the blocking update screen ----------------------------------------------------------------
test("V152: the blocking update screen puts the keyboard on its only way out", () => {
  const { body } = stage();
  const handle = presentUpdateStatus(
    { state: "force", latest: "1.4.0", url: "https://example.invalid/app.apk", sha256: null, minSupported: "1.3.0" },
    { i18n, host: body as unknown as HTMLElement, current: "1.0.0", openUrl: () => {} },
  );
  assert.ok(handle, "a force verdict mounts the blocking screen");
  const screen = handle.root as unknown as StubNode;
  assert.ok(
    within(screen, active()),
    "the force screen covers the app and hides it from assistive tech (aria-modal); leaving focus " +
      "behind it means the only affordance — the download button — is reachable only by tabbing " +
      "through a page the screen reader has just declared nonexistent",
  );
  // One control, so the trap has to wrap onto itself rather than let Tab walk out.
  const claimed = press(screen, "Tab");
  assert.ok(claimed, "Tab inside a blocking dialog must not leave it");
  assert.ok(within(screen, active()), "…and focus must still be on the download button");
});

// ---- 3. the live-call surface ---------------------------------------------------------------------
function callController(): CallController {
  const noop = (): void => {};
  return {
    accept: () => Promise.resolve(),
    decline: noop,
    dismiss: noop,
    hangUp: noop,
    place: () => Promise.resolve(),
    setMuted: noop,
    setCameraOn: noop,
    attachVideo: noop,
  } as unknown as CallController;
}
const incoming: CallState = { ...IDLE_STATE, phase: "incoming", direction: "in", callId: "c1", peer: { id: 7, name: "Ann" } };
const talking: CallState = { ...IDLE_STATE, phase: "active", direction: "in", callId: "c1", peer: { id: 7, name: "Ann" }, connectedAt: 1_800_000_000_000 };

test("V152: an incoming call takes the keyboard, and hangs it back on the screen behind", () => {
  const { body, opener } = stage();
  const overlay = createCallOverlay({ controller: callController(), i18n, now: () => 1_800_000_060_000 });
  body.append(overlay.root as unknown as StubNode);
  const root = overlay.root as unknown as StubNode;

  overlay.render(incoming);
  assert.ok(
    within(root, active()),
    "a ringing phone is the most urgent modal in the app; the keyboard has to be on it",
  );
  assert.notEqual(
    active()?.tag,
    "#text",
    "focus must land on an element, not a text node",
  );
  // Answering must never be one blind Enter away: the surface itself takes focus, not «Отклонить».
  const landed = active();
  assert.ok(
    landed === root || landed?.hasClass("gc-call"),
    "focus belongs on the dialog itself — parking it on a destructive round button (decline/hang up) " +
      "turns a stray Enter into a dropped call",
  );

  overlay.render(IDLE_STATE);
  assert.equal(active(), opener, "when the call is over the keyboard goes back where it was");
});

test("V152: repainting a live call does not yank focus off the button being pressed", () => {
  const { body } = stage();
  const overlay = createCallOverlay({ controller: callController(), i18n, now: () => 1_800_000_060_000, setInterval: () => 1, clearInterval: () => {} });
  body.append(overlay.root as unknown as StubNode);
  const root = overlay.root as unknown as StubNode;

  overlay.render(talking);
  const mute = focusables(root)[0];
  assert.ok(mute, "the talking phase has controls");
  mute.focus();
  overlay.render({ ...talking, muted: true }); // the repaint a mute tap causes
  assert.ok(
    within(root, active()),
    "a repaint inside the same phase must leave the keyboard where the person put it",
  );
});

// ---- 4. the money sheets --------------------------------------------------------------------------
const WALLET = {
  total_usd: "12500000000",
  assets: [{
    id: "tUSDT", name: "Test USDT", kind: "demo", enabled: true, balance: "12500000000",
    hold: "0", available: "12500000000", usd_value: "12500000000", usd_rate: "1000000000",
  }],
  payment_settings: { has_pin: false, two_factor_enabled: false, security_hold_until: 0 },
};

class WalletApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path === "/v1/config") return Promise.resolve({ features: { payments: true, cards: false } } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(WALLET as unknown as T);
    if (path === "/v1/wallet/history?limit=8") return Promise.resolve({ items: [], next_before_id: null } as unknown as T);
    if (path === "/v1/envelopes") return Promise.resolve({ envelopes: [] } as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.resolve({ ok: true } as unknown as T); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function walletScreen(): Promise<{ body: StubNode; root: StubNode }> {
  const { body } = stage();
  const screen = createFinanceScreen({ api: new WalletApi(), i18n, view: "wallet", onNavigate: () => {}, onBack: () => {} });
  const root = screen.root as unknown as StubNode;
  body.append(root);
  await settle();
  return { body, root };
}
const actionNamed = (root: StubNode, label: string): StubNode | undefined =>
  root.findAll((n) => n.hasClass("gc-finance-action")).find((n) => n.textContent.includes(label));
const layerOf = (body: StubNode): StubNode | undefined =>
  body.children.find((n) => n.hasClass("gc-sheet-layer"));

test("V152: a money sheet keeps the keyboard, closes on Escape and gives focus back", async () => {
  const { body, root } = await walletScreen();
  const receive = actionNamed(root, en["finance.receive"]);
  assert.ok(receive, "the wallet offers «Receive»");
  receive.focus();
  receive.click();
  await settle();

  const layer = layerOf(body);
  assert.ok(layer, "the sheet mounts");
  assert.ok(
    within(layer, active()),
    "every money sheet declares role=dialog aria-modal=true; opening one must move the keyboard " +
      "into it, or Tab keeps walking the wallet underneath",
  );

  const claimed = press(layer, "Escape");
  assert.ok(claimed, "Escape is how a sheet is dismissed everywhere else in this client");
  assert.equal(layerOf(body), undefined, "…and the sheet actually leaves the tree");
  assert.equal(active(), receive, "focus returns to the action that opened the sheet");
});

test("V152: the send sheet traps Tab instead of leaking into the wallet behind it", async () => {
  const { body, root } = await walletScreen();
  const send = actionNamed(root, en["finance.send"]);
  assert.ok(send, "the wallet offers «Send»");
  send.focus();
  send.click();
  await settle();

  const layer = layerOf(body);
  assert.ok(layer, "the send sheet mounts");
  const items = focusables(layer);
  assert.ok(items.length > 1, "the sheet has several controls");
  items[items.length - 1]!.focus();
  assert.ok(press(layer, "Tab"), "Tab off the last control must be claimed by the sheet");
  assert.equal(active(), items[0], "…and wrap round to the first, not step behind the sheet");
  items[0]!.focus();
  assert.ok(press(layer, "Tab", true), "Shift+Tab off the first control must be claimed too");
  assert.equal(active(), items[items.length - 1], "…and wrap to the last");
});

// ---- 5. the chat-info sheet -----------------------------------------------------------------------
test("V152: closing chat info returns the keyboard to the header that opened it", async () => {
  const { body, opener } = stage();
  const overlay = createChatInfoOverlay({
    i18n,
    title: "Ann",
    subtitle: "@ann",
    kind: "dialog",
    peerId: 7,
    members: [],
    loadChat: () => Promise.resolve({ kind: "dialog", title: "Ann" }),
    loadUser: () => Promise.resolve({ username: "ann", name: "Ann" }),
    onClose: () => {},
  });
  body.append(overlay.root as unknown as StubNode);
  overlay.focus();
  await settle();
  const root = overlay.root as unknown as StubNode;
  assert.ok(within(root, active()), "the sheet takes the keyboard");

  overlay.close();
  assert.equal(
    active(),
    opener,
    "the identity block in the chat header is what opens this sheet; closing must put the caret back " +
      "on it, otherwise the next Tab restarts from the top of the conversation",
  );
});
