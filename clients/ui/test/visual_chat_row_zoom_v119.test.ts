// clients/ui/test/visual_chat_row_zoom_v119.test.ts — V119: at the largest system font every chat
// list row overflowed its own box, so the next avatar collided with the previous preview line and
// the avatar discs were sliced by the row edge.
//
// Cause (read from the code, then confirmed on the device): the chat list is a FIXED-height
// virtualiser, and `VirtualList.render` wrote that height onto every row as an inline style
// (`node.style.height = "72px"`). An inline style outranks every stylesheet rule, so no CSS could
// repair the row — not even the superapp shell's own `.gc-superapp .gc-chat-row { height: 76px }`,
// which had been silently overridden to 72px all along.
//
// Evidence (emulator redroid Android 15, ru-RU, signed direct APK, CDP against the device WebView,
// probe var/ux-audit/tools/v119_matrix.mjs, 2026-08-01). Row box vs the height the row content
// actually needs, per width (`wm density` 540/480/420 = 320/360/412 dp) and system font size
// (`settings put system font_scale`):
//
//   font_scale 1.0  ->  box 72, natural 54.0   no overflow
//   font_scale 1.3  ->  box 72, natural 58.3   no overflow
//   font_scale 2.0  ->  box 72, natural 87.0   OVERFLOW at 320, 360 AND 412 dp — all four rows
//
// The fix is not a bigger constant: it is to stop dictating the height. The screen measures what
// the stylesheet asks for and what the content needs, takes the larger, and feeds it back into the
// scroll geometry; `refreshItemHeight()` re-asks whenever the platform font may have moved.
import test from "node:test";
import assert from "node:assert/strict";

import { VirtualList, sanitiseHeight } from "../src/virtual_list.ts";
import { chatRowHeight } from "../src/screens/chat_list_screen.ts";

// ── The decision rule, as a pure function ────────────────────────────────────────────────────────

test("V119: a row satisfies both the stylesheet and the content", () => {
  // Default font: the design's comfortable row wins, content has slack (device: 76 vs 54).
  assert.equal(chatRowHeight(76, 54, 72), 76);
  // Largest font: the content wins, and this is exactly the case that used to clip (76 vs 87).
  assert.equal(chatRowHeight(76, 87, 76), 87);
  // Classic shell at the default font keeps the historic 72px byte-for-byte.
  assert.equal(chatRowHeight(72, 54, 72), 72);
});

test("V119: a fractional line box rounds UP, never leaving the last line a pixel short", () => {
  // font_scale 1.3 measured 58.3px of content on the device.
  assert.equal(chatRowHeight(58.3, 58.3, 72), 59);
  assert.equal(sanitiseHeight(58.3, 72), 59);
});

test("V119: a measurement taken while the list is hidden never blanks the list", () => {
  // paint() hides the list for the loading, failed and empty states; every box then measures 0.
  assert.equal(chatRowHeight(0, 0, 76), 76);
  assert.equal(sanitiseHeight(0, 76), 76);
  assert.equal(sanitiseHeight(Number.NaN, 76), 76);
  assert.equal(sanitiseHeight(-10, 76), 76);
});

// ── The virtualiser honours a height it does not own ─────────────────────────────────────────────

const stubDocument = {
  createElement: (_tag: string) => new StubElement(),
  createDocumentFragment: () => new StubFragment(),
};

class StubFragment {
  nodes: StubElement[] = [];
  appendChild(n: StubElement): StubElement { this.nodes.push(n); return n; }
}

class StubElement {
  style: Record<string, string> = {};
  children: StubElement[] = [];
  clientHeight = 0;
  scrollTop = 0;
  ownerDocument = stubDocument;
  get scrollHeight(): number { return parseInt(this.children[0]?.style.height ?? "0", 10) || 0; }
  appendChild(n: StubElement): StubElement { this.children.push(n); return n; }
  replaceChildren(...nodes: Array<StubElement | StubFragment>): void {
    this.children = nodes.flatMap((n) => (n instanceof StubFragment ? n.nodes : [n]));
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const asEl = (n: StubElement): HTMLElement => n as unknown as HTMLElement;

test("V119: rows and scroll geometry follow the measured height, not a constant", () => {
  const container = new StubElement();
  container.clientHeight = 600;
  let measured = 76; // default font, superapp shell
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: () => measured,
    renderItem: () => asEl(stubDocument.createElement("div")),
  });
  vl.setItems([1, 2, 3, 4]);
  const sizer = container.children[0]!;
  const slab = sizer.children[0]!;
  assert.equal(vl.rowHeight, 76);
  assert.equal(slab.children[0]!.style.height, "76px", "the row carries the stylesheet's height");
  assert.equal(sizer.style.height, "304px", "scroll height is 4 rows of 76px");

  // The user raises the system font size to its maximum.
  measured = 87;
  assert.equal(vl.refreshItemHeight(), true, "the change is reported");
  assert.equal(vl.rowHeight, 87);
  assert.equal(slab.children[0]!.style.height, "87px", "the row grew instead of clipping");
  assert.equal(sizer.style.height, "348px", "scroll height followed the taller rows");

  // Re-asking without a change must not churn the DOM.
  assert.equal(vl.refreshItemHeight(), false, "an unchanged height is a no-op");
  vl.destroy();
});

test("V119: a zero measurement is ignored rather than collapsing the list", () => {
  const container = new StubElement();
  container.clientHeight = 600;
  let measured = 76;
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: () => measured,
    renderItem: () => asEl(stubDocument.createElement("div")),
  });
  vl.setItems([1, 2]);
  measured = 0; // the screen hid the list (loading / empty / failed state)
  assert.equal(vl.refreshItemHeight(), false);
  assert.equal(vl.rowHeight, 76, "the last good height survives");
  assert.equal(container.children[0]!.children[0]!.children.length, 2, "rows are still drawn");
  vl.destroy();
});

test("V119: a list constructed with a plain number is untouched by the new path", () => {
  const container = new StubElement();
  container.clientHeight = 600;
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: 68,
    renderItem: () => asEl(stubDocument.createElement("div")),
  });
  vl.setItems([1, 2]);
  assert.equal(vl.rowHeight, 68);
  assert.equal(vl.refreshItemHeight(), false, "there is nothing to re-ask");
  assert.equal(container.children[0]!.children[0]!.children[0]!.style.height, "68px");
  vl.destroy();
});
