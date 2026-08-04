// clients/ui/test/modal_layer.test.ts — V178. The contract of the thing that owns modals.
//
// Why this exists at all: `modalRoot()` mounts overlays on `document.body`, which means a screen's
// `destroy()` — which only unmounts its own subtree — can no longer reach them. Every screen was left to
// remember two facts by hand, and on 2026-08-03 a count of the client found seven such mount points in
// three hand-rolled shapes, four of them wrong in at least one half. This file pins the two facts once:
//
//   1. asking twice gives you the modal you already have, not a second one;
//   2. closeAll() leaves nothing behind, whoever closed what.
import test from "node:test";
import assert from "node:assert/strict";

import { createModalLayer } from "../src/modal_layer.ts";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import { el } from "../src/dom.ts";

installDomStub();

function fakeModal(log: string[], name: string) {
  const node = el("div", { class: `gc-overlay ${name}` });
  let closed = 0;
  let focused = 0;
  return {
    node,
    get closed() { return closed; },
    get focused() { return focused; },
    present(release: () => void) {
      return {
        node,
        focus: () => { focused += 1; },
        close: () => {
          // Real modals are idempotent, and so is this one — the layer must not depend on that.
          if (closed === 0) log.push(`close:${name}`);
          closed += 1;
          release();
        },
      };
    },
  };
}

test("asking twice hands back the modal already on screen", () => {
  const owner = el("div", {}) as unknown as StubNode;
  const modals = createModalLayer(owner as unknown as HTMLElement);
  const log: string[] = [];
  let built = 0;

  const open = (): void => {
    modals.open("sheet", (release) => {
      built += 1;
      return fakeModal(log, "sheet").present(release);
    });
  };
  open(); open(); open();

  assert.equal(built, 1, "three taps must build one sheet");
  assert.equal(owner.children.filter((n) => n.hasClass("gc-overlay")).length, 1, "and mount one node");
  assert.equal(modals.isOpen("sheet"), true);
});

test("a modal that closes itself frees its key for the next open", () => {
  const owner = el("div", {}) as unknown as StubNode;
  const modals = createModalLayer(owner as unknown as HTMLElement);
  const log: string[] = [];
  let release: () => void = () => {};

  modals.open("sheet", (r) => { release = r; return fakeModal(log, "a").present(r); });
  assert.equal(modals.isOpen("sheet"), true);
  // Escape, the scrim, or a finished job: the modal announces its own departure.
  release();
  assert.equal(modals.isOpen("sheet"), false, "the layer stops holding a modal that is gone");

  let rebuilt = 0;
  modals.open("sheet", (r) => { rebuilt += 1; return fakeModal(log, "b").present(r); });
  assert.equal(rebuilt, 1, "the key is reusable, otherwise the sheet becomes unopenable");
});

test("closeAll takes everything down, newest first, and only once each", () => {
  const owner = el("div", {}) as unknown as StubNode;
  const modals = createModalLayer(owner as unknown as HTMLElement);
  const log: string[] = [];
  const sheet = fakeModal(log, "sheet");
  const menu = fakeModal(log, "menu");

  modals.open("sheet", (r) => sheet.present(r));
  modals.open("menu", (r) => menu.present(r));
  modals.closeAll();

  assert.deepEqual(log, ["close:menu", "close:sheet"], "unwound newest first");
  assert.equal(sheet.closed, 1, "each modal is closed exactly once by the layer");
  assert.equal(menu.closed, 1);
  assert.equal(modals.isOpen("sheet"), false);
  assert.equal(modals.isOpen("menu"), false);

  // The screen is gone; a stray close arriving late must not resurrect anything or throw.
  modals.closeAll();
  assert.equal(sheet.closed, 1, "closeAll on an empty layer is a no-op");
});

test("close(key) replaces rather than stacks — the shape a menu needs", () => {
  const owner = el("div", {}) as unknown as StubNode;
  const modals = createModalLayer(owner as unknown as HTMLElement);
  const log: string[] = [];
  const first = fakeModal(log, "first");
  const second = fakeModal(log, "second");

  modals.open("menu", (r) => first.present(r));
  modals.close("menu");
  modals.open("menu", (r) => second.present(r));

  assert.equal(first.closed, 1, "the first menu is taken down, not left under the second");
  assert.equal(second.closed, 0);
  assert.deepEqual(log, ["close:first"]);
});

test("mounted() runs once — a repeat open must not restart a camera", () => {
  const owner = el("div", {}) as unknown as StubNode;
  const modals = createModalLayer(owner as unknown as HTMLElement);
  let starts = 0;
  let focuses = 0;
  const node = el("div", { class: "gc-overlay" });
  const open = (): void => {
    modals.open("video-note", () => ({
      node,
      focus: () => { focuses += 1; },
      mounted: () => { starts += 1; },
      close: () => {},
    }));
  };
  open(); open();

  assert.equal(starts, 1, "the recorder starts on the first open only");
  assert.equal(focuses, 2, "but the caret comes back every time the person asks");
});

test("a getter owner is resolved at mount time, not at creation", () => {
  let owner: StubNode | null = null;
  const modals = createModalLayer(() => owner as unknown as HTMLElement);
  // The feed builds its root AFTER the handlers that open its modals; creating the layer earlier must
  // not capture an undefined element.
  owner = el("div", {}) as unknown as StubNode;
  const node = el("div", { class: "gc-overlay" });
  modals.open("sheet", () => ({ node, close: () => {} }));
  assert.equal(owner!.children.filter((n) => n.hasClass("gc-overlay")).length, 1);
});
