// clients/ui/test/visual_tab_label_fit_v103.test.ts — V103: the fitter dropped the very labels it
// was supposed to fit (owner pre-beta P0-5: "клавиатура, safe area, поворот, системный масштаб
// шрифта и экраны 320/390/430 px").
//
// Evidence (signed direct APK app.greenchat versionCode 1000012 on redroid 15, 1080x2400,
// `wm density 540` = 320 dp, system font_scale 2.0, raw CDP against the device WebView, route
// #/chats, pristine page after `am force-stop`, 2026-07-31):
//
//   .gc-tab-label "Archived": scrollWidth 97 px inside clientWidth 75 px, inline style EMPTY,
//   computed font-size 30 px  ->  the word was painted through the tab's own edge, read as
//   "Archive" — i.e. V102 had wired the fitter to this label and the fitter never ran on it.
//
// Cause, pinned by the first two tests: a screen constructs its DOM and tracks its labels BEFORE
// the router mounts the node. At track time the label is not connected and has no box. The old
// sweep `targets = targets.filter(t => t.isConnected)` therefore deleted exactly those elements on
// the first retry frame, so when the label finally got a width there was nothing left to measure.
//
// The rule this file pins: an element is dropped only after it HAS had a box and then left the
// document; until then it is pending, not garbage. And the observer that watches for the box
// watches the PARENT, because the fitter's own remedy (`zoom` on the target) changes the target's
// reported box and self-observation would make the fix re-trigger itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWidthFitter } from "../src/fit_width.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fitWidth = readFileSync(resolve(here, "../src/fit_width.ts"), "utf8");

interface FakeStyle {
  zoom: string;
  removeProperty(name: string): void;
}

/**
 * A label as the fitter sees it: measurable, zoomable, and mountable after the fact. `reads` counts
 * the measurements so "was it measured at all" is an observation and not an inference.
 */
class FakeEl {
  isConnected: boolean;
  scrollWidth: number;
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  reads = 0;
  style: FakeStyle;
  private classes = new Set<string>();
  classList = {
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
  };
  private box: number;

  constructor(opts: { connected: boolean; box: number; text: number }) {
    this.isConnected = opts.connected;
    this.scrollWidth = opts.text;
    this.box = opts.box;
    const self = this;
    this.style = {
      zoom: "",
      removeProperty(): void {
        self.style.zoom = "";
      },
    };
  }

  get clientWidth(): number {
    this.reads += 1;
    return this.box;
  }

  set clientWidth(v: number) {
    this.box = v;
  }

  has(c: string): boolean {
    return this.classes.has(c);
  }
}

const fakeLabel = (opts: { connected: boolean; box: number; text: number }): FakeEl =>
  new FakeEl(opts);

const asHtml = (el: FakeEl): HTMLElement => el as unknown as HTMLElement;

test("a label tracked before its screen is mounted is still fitted once it gets a box", () => {
  // Exactly the production order: chat_list_screen builds the tabs and tracks them, the router
  // mounts the node afterwards.
  const label = fakeLabel({ connected: false, box: 0, text: 97 });
  const fitter = createWidthFitter();
  fitter.track(asHtml(label));
  assert.equal(label.style.zoom, "", "nothing to fit while the label has no box");

  // The router mounts the screen: 320 dp tab slot, "Archived" at system font 2.0.
  label.isConnected = true;
  label.clientWidth = 75;
  fitter.refit();

  const zoom = Number(label.style.zoom);
  assert.ok(zoom > 0 && zoom < 1, `the label must be scaled down, got zoom=${label.style.zoom}`);
  // 75/97 = 0.773; the fitter is allowed to under-shoot for safety but never to overflow.
  assert.ok(zoom * 97 <= 75 + 0.5, `97 px scaled by ${zoom} still exceeds the 75 px box`);
  fitter.destroy();
});

test("a label that had a box and then left the document is dropped, not measured forever", () => {
  const label = fakeLabel({ connected: true, box: 75, text: 97 });
  const fitter = createWidthFitter();
  fitter.track(asHtml(label));
  label.isConnected = false;
  fitter.refit();
  const after = label.reads;
  fitter.refit();
  assert.equal(label.reads, after, "a removed element must not be measured again");
  fitter.destroy();
});

test("the box observer watches the parent, so the zoom it applies cannot re-trigger it", () => {
  const observed: FakeEl[] = [];
  let disconnects = 0;
  class FakeRO {
    constructor(_cb: () => void) {}
    observe(el: unknown): void {
      observed.push(el as FakeEl);
    }
    disconnect(): void {
      disconnects += 1;
    }
  }
  const g = globalThis as { ResizeObserver?: unknown };
  const prev = g.ResizeObserver;
  g.ResizeObserver = FakeRO;
  try {
    const label = fakeLabel({ connected: false, box: 0, text: 97 });
    const slot = fakeLabel({ connected: false, box: 0, text: 0 });
    label.parentElement = slot;
    const fitter = createWidthFitter();
    fitter.track(asHtml(label));
    assert.equal(observed.length, 1, "the fitter must observe exactly one node per tracked label");
    assert.equal(observed[0], slot, "it must be the constraining parent, never the zoomed target");
    fitter.destroy();
    assert.equal(disconnects, 1, "destroy must release the observer");
  } finally {
    if (prev === undefined) delete g.ResizeObserver;
    else g.ResizeObserver = prev;
  }
});

test("the pending sweep is written as 'had a box and left', not as 'is connected'", () => {
  // The regression was one filter expression; pin it so a later refactor cannot quietly restore it.
  assert.doesNotMatch(
    fitWidth,
    /targets\s*=\s*targets\.filter\(\(t\)\s*=>\s*t\.isConnected\)/,
    "the unconditional isConnected sweep is the V103 defect itself",
  );
  assert.match(fitWidth, /everBoxed/);
});
