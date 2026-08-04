// clients/ui/test/modal_focus_v153.test.ts — V153: the three overlays that are modal in paint only.
//
// V152 gave the focus contract to every surface that DECLARES `role="dialog" aria-modal="true"`.
// This file measures the other half of the same census: surfaces that behave modally and never say so.
//
// `.gc-overlay` is `position: fixed; inset: 0` over a scrim with `backdrop-filter: blur(4px)`
// (web/src/styles.css). Everything behind it is blurred out, and a click on it closes the surface
// rather than reaching the page — so for a sighted person the app underneath is gone. Three surfaces
// use it: «Новый чат», «Сообщить о проблеме» (support) and «Пожаловаться» (report). support_overlay.ts
// says so in its own header — "The overlay never leaves the current screen (it is a modal layer)" —
// and still ships no role, no aria-modal, no focus management beyond the opening focus() call.
//
// Two people pay for that:
//   * a screen-reader user is never told a dialog opened, and the blurred page behind stays in the
//     accessibility tree, so swiping walks into content that cannot be tapped (the scrim eats it);
//   * anyone on a keyboard — the whole web/desktop build — tabs straight out of the form into that
//     same unreachable page, and gets the caret dropped on the document root when the form closes.
//
// The contract is V152's, applied to the surfaces that were out of its scope by declaration only.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createNewChatOverlay } from "../src/screens/new_chat_overlay.ts";
import { createSupportOverlay } from "../src/screens/support_overlay.ts";
import { createReportOverlay } from "../src/screens/report_overlay.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { installDomStub, settle, StubNode } from "./dom_stub.ts";

const i18n = createI18n({ locale: "en", dicts: { en, ru } });

interface Doc { body: StubNode; activeElement: StubNode | null }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;
const active = (): StubNode | null => doc().activeElement;

/** A document with a body and one focusable control standing in for the button that opened the sheet. */
function stage(): { body: StubNode; opener: StubNode } {
  installDomStub();
  const body = new StubNode("body");
  doc().body = body;
  const opener = new StubNode("button");
  body.append(opener);
  opener.focus();
  return { body, opener };
}

const focusables = (root: StubNode): StubNode[] =>
  root.findAll((n) => (n.tag === "button" || n.tag === "input" || n.tag === "textarea" || n.tag === "select") && !n.disabled);

function press(node: StubNode, key: string, shiftKey = false): boolean {
  let prevented = false;
  node.dispatch("keydown", { key, shiftKey, preventDefault: () => { prevented = true; } });
  return prevented;
}

/**
 * Every one of these surfaces must announce itself before anything else can be asserted about it.
 *
 * The role goes on the PANEL, not on the scrim — the same shape chat_info.ts uses since V152. The
 * scrim is paint; the dialog is the box with the content in it.
 */
function assertDeclaresModal(root: StubNode, what: string): void {
  const dialogs = root.findAll((n) => n.getAttribute("role") === "dialog");
  assert.equal(
    dialogs.length,
    1,
    `${what} covers the app with a blurred scrim, so exactly one node in it must carry ` +
      'role="dialog" — with none, a screen reader announces nothing at all and the person is left ' +
      "inside a form they were never told opened",
  );
  const dialog = dialogs[0]!;
  assert.equal(
    dialog.getAttribute("aria-modal"),
    "true",
    `${what} must declare aria-modal="true"; without it the blurred page behind stays in the ` +
      "accessibility tree and swiping walks into content the scrim makes untappable",
  );
  assert.ok(
    (dialog.getAttribute("aria-label") ?? "").trim().length > 0,
    `${what} must have a name: "dialog" on its own tells the person a box opened and nothing about ` +
      "which one",
  );
}

// ---- 1. «Новый чат» --------------------------------------------------------------------------------
function newChat(): { body: StubNode; opener: StubNode; overlay: ReturnType<typeof createNewChatOverlay> } {
  const { body, opener } = stage();
  const overlay = createNewChatOverlay({
    i18n,
    self: { id: 1, name: "Me", username: "me" },
    // The full shape, not a cast: this probe never types into the box, so what matters is only that
    // the seam satisfies GlobalSearchResult without `as`, which would let a real API drift past it.
    search: () => Promise.resolve({ users: [], chats: [], messages: [] }),
    createDialog: () => Promise.reject(new Error("not used")),
    onOpenChat: () => {},
    debounceMs: 0,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  body.append(overlay.root as unknown as StubNode);
  overlay.focus();
  return { body, opener, overlay };
}

test("V153: «New chat» announces itself as a dialog", () => {
  const { overlay } = newChat();
  assertDeclaresModal(overlay.root as unknown as StubNode, "the new-chat sheet");
});

test("V153: «New chat» keeps Tab inside the search sheet", () => {
  const { overlay } = newChat();
  const root = overlay.root as unknown as StubNode;
  const items = focusables(root);
  assert.ok(items.length > 0, "the sheet has controls (the query box, the Saved Messages row)");
  items[items.length - 1]!.focus();
  assert.ok(press(root, "Tab"), "Tab off the last control must be claimed by the sheet");
  assert.equal(active(), items[0], "…and wrap to the first, not step into the blurred chat list");
});

test("V153: closing «New chat» puts the caret back on the button that opened it", () => {
  const { opener, overlay } = newChat();
  assert.notEqual(active(), opener, "the sheet takes focus when it opens");
  overlay.close();
  assert.equal(
    active(),
    opener,
    "the + button (and «Start a chat» on the empty state) is what opens this sheet; leaving the caret " +
      "in a removed subtree makes the next Tab restart from the top of the document",
  );
});

// ---- 2. «Report a problem» (support) ---------------------------------------------------------------
function support(): { body: StubNode; opener: StubNode; overlay: ReturnType<typeof createSupportOverlay> } {
  const { body, opener } = stage();
  const overlay = createSupportOverlay({
    i18n,
    auto: { screen: "settings", app_version: "1.0.0-beta.5", platform: "android" },
    newClientRef: () => "ref-1",
    submit: () => Promise.resolve({ kind: "created", ref: "R-1" }),
  });
  body.append(overlay.root as unknown as StubNode);
  overlay.focus();
  return { body, opener, overlay };
}

test("V153: the support form announces itself as a dialog", () => {
  const { overlay } = support();
  assertDeclaresModal(overlay.root as unknown as StubNode, "the support form");
});

test("V153: the support form keeps Tab off the blurred settings behind it", () => {
  const { overlay } = support();
  const root = overlay.root as unknown as StubNode;
  const items = focusables(root);
  assert.ok(items.length > 2, "the form has category radios, a text field, a checkbox and two buttons");
  items[0]!.focus();
  assert.ok(press(root, "Tab", true), "Shift+Tab off the first control must be claimed");
  assert.equal(active(), items[items.length - 1], "…and wrap to the last");
});

test("V153: closing the support form returns the keyboard to the screen that opened it", () => {
  const { opener, overlay } = support();
  overlay.close();
  assert.equal(active(), opener, "this form is reached from a settings row; that row gets the caret back");
});

// ---- 3. «Report» -----------------------------------------------------------------------------------
class QuietApi implements ApiLike {
  get<T>(): Promise<T> { return Promise.reject(new Error("unexpected GET")); }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function report(): Promise<{ opener: StubNode; overlay: ReturnType<typeof createReportOverlay> }> {
  const { body, opener } = stage();
  const overlay = createReportOverlay({ i18n, api: new QuietApi() });
  body.append(overlay.root as unknown as StubNode);
  overlay.focus();
  await settle();
  return { opener, overlay };
}

test("V153: the report form announces itself as a dialog", async () => {
  const { overlay } = await report();
  assertDeclaresModal(overlay.root as unknown as StubNode, "the report form");
});

test("V153: closing the report form gives the keyboard back", async () => {
  const { opener, overlay } = await report();
  overlay.close();
  assert.equal(
    active(),
    opener,
    "a report is opened from a message menu or a profile; the caret belongs back where it started, " +
      "not on the document root",
  );
});
