// clients/ui/test/visual_tab_label_fit_v112.test.ts — V112: a label the fitter had already "fitted"
// was still painted through its tab's edge (owner pre-beta P0-5: "клавиатура, safe area, поворот,
// системный масштаб шрифта и экраны 320/390/430 px").
//
// Evidence (signed direct APK app.greenchat versionCode 1000013 on a DEDICATED redroid 15 device
// 127.0.0.1:5557, 1080x2400, `wm density 540` = 320 dp, system font_scale 1.3, ru-RU, signed-in,
// raw CDP against the device WebView, route #/calls, pristine page after `am force-stop`,
// 2026-07-31). The call-log filter strip reported:
//
//   .gc-tab-label "Пропущенные": inline zoom 0.93 (so the fitter HAD run), clientWidth 125,
//   scrollWidth 129, visual rect 116 px  ->  the word still overflowed its box by 4 own px.
//
// Cause: one measurement is not a fixed point. `zoom` rescales the element's own coordinate system
// after layout, so the 116 visual px the parent hands out become 116 / 0.93 = 125 own px, while the
// text — read as an integer 124 at zoom 1 — re-lays out to 129. The plan was computed from numbers
// that stopped being true the instant it was applied.
//
// The rule this file pins: after applying a factor the fitter measures AGAIN and tightens while the
// element still overflows — but only while the environment actually re-lays out, so a DOM double
// that reports frozen numbers keeps its single-pass result instead of being shrunk on stale ones.
import test from "node:test";
import assert from "node:assert/strict";

import { refineZoom, fitToWidth, FIT_MIN_ZOOM } from "../src/fit_width.ts";

/** A label whose box behaves like a real one: `zoom` rescales its own coordinate system. */
class ZoomingEl {
  isConnected = true;
  children: ZoomingEl[] = [];
  style: { zoom: string; removeProperty(name: string): void };
  /** visual px the parent hands out, and the own-px text width keyed by the zoom in force —
   *  exactly the two device readings. (Fields are spelled out: node's strip-only TypeScript
   *  loader, which is what runs these tests, rejects constructor parameter properties.) */
  private visual: number;
  private textAtOne: number;
  private textWhenZoomed: number;
  constructor(visual: number, textAtOne: number, textWhenZoomed: number) {
    this.visual = visual;
    this.textAtOne = textAtOne;
    this.textWhenZoomed = textWhenZoomed;
    const self = this;
    this.style = {
      zoom: "",
      removeProperty(): void {
        self.style.zoom = "";
      },
    };
  }
  private get zoom(): number {
    const z = Number(this.style.zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }
  get clientWidth(): number {
    return Math.round(this.visual / this.zoom);
  }
  get scrollWidth(): number {
    return this.zoom === 1 ? this.textAtOne : this.textWhenZoomed;
  }
}

/** A label whose numbers never move, however the fitter writes `zoom` (the unit-test doubles). */
class FrozenEl {
  isConnected = true;
  children: FrozenEl[] = [];
  clientWidth: number;
  scrollWidth: number;
  style: { zoom: string; removeProperty(name: string): void };
  constructor(box: number, text: number) {
    this.clientWidth = box;
    this.scrollWidth = text;
    const self = this;
    this.style = {
      zoom: "",
      removeProperty(): void {
        self.style.zoom = "";
      },
    };
  }
}

test("«Пропущенные»: the fitted label ends up inside its box, not 4 px past it", () => {
  // The device case, reproduced from its own numbers: 116 visual px of slot, 124 own px of text at
  // zoom 1, 129 own px once a zoom is in force.
  const label = new ZoomingEl(116, 124, 129);
  const applied = fitToWidth(label as unknown as HTMLElement);

  assert.ok(
    applied < 0.93,
    `one pass stopped at 0.93 and still overflowed; got ${applied}`,
  );
  assert.ok(
    label.scrollWidth <= label.clientWidth,
    `text ${label.scrollWidth} still exceeds the box ${label.clientWidth} at zoom ${applied}`,
  );
  // A fit is a correction, not a punishment: the word must stay near full size, not drop to the floor.
  assert.ok(
    applied >= 0.85,
    `over-shrunk to ${applied}; the residue was 4 px, not 15 %`,
  );
});

/** The measured device table for «Пропущенные» at system font 200 % — the readings themselves, not
 *  a curve fitted to them, because a fitted curve converged one pass EARLIER than the device did
 *  and would have let the old bound pass this test. Each row is `zoom -> [scrollWidth, clientWidth]`
 *  in the element's own pixels (redroid 15, 320 dp, ru-RU, signed APK, CDP, 2026-07-31):
 *
 *    1.00 160/116 | 0.72 183/161 | 0.63 194/184 | 0.59 200/197 | 0.58 202/200 | 0.57 204/204 (fits)
 */
const MEASURED_200_PERCENT: ReadonlyMap<string, readonly [number, number]> =
  new Map([
    ["1", [160, 116] as const],
    ["0.72", [183, 161] as const],
    ["0.63", [194, 184] as const],
    ["0.59", [200, 197] as const],
    ["0.58", [202, 200] as const],
    ["0.57", [204, 204] as const],
  ]);

/** A label that answers only with those readings; an unmeasured zoom is a test-authoring error. */
class SlowConvergingEl {
  isConnected = true;
  children: SlowConvergingEl[] = [];
  style: { zoom: string; removeProperty(name: string): void };
  constructor() {
    const self = this;
    this.style = {
      zoom: "",
      removeProperty(): void {
        self.style.zoom = "";
      },
    };
  }
  private row(): readonly [number, number] {
    const key = this.style.zoom === "" ? "1" : this.style.zoom;
    const row = MEASURED_200_PERCENT.get(key);
    if (!row) throw new Error(`no device reading for zoom ${key}`);
    return row;
  }
  get clientWidth(): number {
    return this.row()[1];
  }
  get scrollWidth(): number {
    return this.row()[0];
  }
}

test("«Пропущенные» at system font 200 %: five passes are allowed to finish, not cut off at three", () => {
  const label = new SlowConvergingEl();
  const applied = fitToWidth(label as unknown as HTMLElement);

  assert.ok(
    label.scrollWidth <= label.clientWidth,
    `text ${label.scrollWidth} still exceeds the box ${label.clientWidth} at zoom ${applied}`,
  );
  // The measured fixed point. Stopping early (the old bound of three) left 0.58 — 2 px over.
  assert.equal(
    applied,
    0.57,
    `expected the measured fixed point; got ${applied}`,
  );
  assert.ok(
    applied > FIT_MIN_ZOOM,
    "the case must converge on its own, not be rescued by the readability floor",
  );
});

test("a DOM that does not re-lay out keeps the single-pass result", () => {
  // 75 px slot, 97 px of text ("Archived" at font_scale 2.0, the V103 case). floor(75/97) = 0.77.
  const label = new FrozenEl(75, 97);
  const applied = fitToWidth(label as unknown as HTMLElement);
  assert.equal(
    applied,
    0.77,
    `frozen numbers must not be tightened again; got ${applied}`,
  );
  assert.equal(label.style.zoom, "0.77");
});

test("refineZoom floors, never rounds up, and never passes the readability floor", () => {
  // 0.93 * 125/129 = 0.9012… -> 0.90. Rounding up here is how a "fitted" line overflows by a pixel.
  assert.equal(refineZoom(0.93, 129, 125), 0.9);
  // Already inside the box: nothing to correct.
  assert.equal(refineZoom(0.9, 100, 120), 0.9);
  // The floor still wins over any residue.
  assert.equal(refineZoom(0.45, 400, 100), FIT_MIN_ZOOM);
  // Unusable measurements leave the current factor alone.
  assert.equal(refineZoom(0.8, Number.NaN, 100), 0.8);
  assert.equal(refineZoom(0.8, 100, 0), 0.8);
});
