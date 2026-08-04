// clients/ui/test/visual_tab_strip_uniform_v144.test.ts — V144: one filter strip drew its two words
// in two different sizes (owner pre-beta P0-5: "клавиатура, safe area, поворот, системный масштаб
// шрифта и экраны 320/390/430 px").
//
// Evidence (stand `gc-ui-stand`, own GC_DATA_DIR, port 9320; Chromium reproducing the Android
// WebView system font the way this project measured it on 2026-07-31 — `--enable-text-autosizing`
// plus `-webkit-text-size-adjust`, mobile context, deviceScaleFactor 2; ru-RU, signed in, route
// #/calls; every frame self-checked against the app's own published `--gc-sys-text-zoom`,
// 2026-08-02):
//
//   320 dp, system font 2.0   «Все»         font-size 30 px x zoom 1.00 = 30.0 px on screen
//                             «Пропущенные» font-size 30 px x zoom 0.48 = 14.4 px on screen  x2.08
//   360 dp, system font 2.0   30.0 px  vs  16.8 px                                           x1.79
//   320 dp, system font 1.3   19.5 px  vs  14.4 px                                           x1.35
//
// So on a phone whose owner had asked for the LARGEST text, one half of a control was smaller than
// the app's default 15 px while the half beside it was double size. Confirmed with eyes on the
// captured frames, not only by numbers: `evidence/` of the outbox package holds the before/after
// pair at 320 dp / 2.0.
//
// Two independent causes, both measured, and this file pins the one that lives in the fitter:
//
//   1. layout — `.gc-tab { flex: 1 }` is `1 1 0%`, an exact 50/50 split, so «Все» sat in an 86 px
//      box it filled to 86 while «Пропущенные» needed 185 of its 120. One slot idle, its neighbour
//      65 px short. Fixed in redesign.css (`flex: 1 1 auto`), pinned by its own structural test
//      below.
//   2. fitting — the fitter measured every label ON ITS OWN. Right for the wallet headline (one
//      line, one box), wrong for a strip, whose boxes are siblings a reader compares side by side.
//
// The rule this file pins: one fitter is one GROUP. Members share the SMALLEST factor any member
// needs, so a strip shrinks as one thing; a fitter with a single target keeps behaving exactly as
// before (the wallet headline must not be touched by this).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWidthFitter,
  groupFactor,
  FIT_MIN_ZOOM,
} from "../src/fit_width.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const redesignCss = readFileSync(
  resolve(here, "../../web/src/redesign.css"),
  "utf8",
);

interface FakeStyle {
  zoom: string;
  removeProperty(name: string): void;
}

/** A label as the fitter sees it. `writes` counts zoom writes so "was it levelled" is observed. */
class StripLabel {
  isConnected: boolean;
  scrollWidth: number;
  children: StripLabel[] = [];
  parentElement: StripLabel | null = null;
  style: FakeStyle;
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
    return this.box;
  }

  set clientWidth(v: number) {
    this.box = v;
  }

  /** The factor actually in force, as the browser would read it. */
  get zoom(): number {
    const z = Number(this.style.zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }
}

const asHtml = (el: StripLabel): HTMLElement => el as unknown as HTMLElement;

test("the strip ends on ONE size: the roomy label takes the cramped one's factor", () => {
  // The measured device case in its own numbers: «Все» fits its box, «Пропущенные» needs 185 of 120.
  const all = new StripLabel({ connected: true, box: 86, text: 86 });
  const missed = new StripLabel({ connected: true, box: 120, text: 185 });

  const fitter = createWidthFitter();
  fitter.track(asHtml(all));
  fitter.track(asHtml(missed));

  assert.equal(
    all.zoom,
    missed.zoom,
    `two words of one control must be one size; got «Все» ${all.zoom} vs «Пропущенные» ${missed.zoom}`,
  );
  // And the shared size is the one the cramped word needs, not an average that still overflows.
  assert.ok(
    missed.zoom * missed.scrollWidth <= missed.clientWidth + 0.5,
    `«Пропущенные» ${missed.scrollWidth} px at zoom ${missed.zoom} still exceeds its ${missed.clientWidth} px box`,
  );
  assert.ok(missed.zoom < 1, "the cramped word must actually be scaled down");
  fitter.destroy();
});

test("levelling happens at track time too — a strip that never gets a resize is still even", () => {
  // The production order: the strip is built, both labels are tracked, and on a phone that never
  // rotates no resize, observer notification or settle frame may ever follow.
  const all = new StripLabel({ connected: true, box: 86, text: 86 });
  const missed = new StripLabel({ connected: true, box: 120, text: 185 });
  const fitter = createWidthFitter();
  fitter.track(asHtml(all));
  // After the FIRST track the roomy label is untouched: a group of one is not a group.
  assert.equal(all.style.zoom, "", "a single tracked label must not be scaled");
  fitter.track(asHtml(missed));
  assert.equal(
    all.zoom,
    missed.zoom,
    "the second track must level the strip without waiting for an event",
  );
  fitter.destroy();
});

test("a single-target fitter is untouched: the wallet headline keeps its own factor", () => {
  // #/wallet builds ONE fitter for ONE headline; V144 must not change that path at all.
  const headline = new StripLabel({ connected: true, box: 200, text: 400 });
  const fitter = createWidthFitter();
  fitter.track(asHtml(headline));
  fitter.refit();
  const own = headline.zoom;
  assert.ok(own < 1 && own >= FIT_MIN_ZOOM, `expected a real fit, got ${own}`);
  assert.ok(
    own * headline.scrollWidth <= headline.clientWidth + 0.5,
    "the headline must still fit its own box",
  );
  fitter.destroy();
});

test("repeated passes do not ratchet the group down", () => {
  // The risk of sharing a factor: if the shared write fed back into the next measurement, every
  // pass would shrink the strip a little more. It must not — the factor is re-derived at zoom 1.
  const all = new StripLabel({ connected: true, box: 86, text: 86 });
  const missed = new StripLabel({ connected: true, box: 120, text: 185 });
  const fitter = createWidthFitter();
  fitter.track(asHtml(all));
  fitter.track(asHtml(missed));
  const first = missed.zoom;
  for (let i = 0; i < 5; i += 1) fitter.refit();
  assert.equal(
    missed.zoom,
    first,
    `five more passes moved the strip from ${first} to ${missed.zoom}`,
  );
  assert.equal(all.zoom, missed.zoom, "and the strip is still even");
  fitter.destroy();
});

test("a label that is not laid out yet cannot shrink the ones that are", () => {
  // A pending element reports 1 (fitZoom returns 1 on an unusable measurement). 1 must never drag
  // a group down — otherwise a mounted strip would flicker whenever a third tab was added.
  const shown = new StripLabel({ connected: true, box: 120, text: 185 });
  const pending = new StripLabel({ connected: false, box: 0, text: 300 });
  const fitter = createWidthFitter();
  fitter.track(asHtml(shown));
  const alone = shown.zoom;
  fitter.track(asHtml(pending));
  assert.equal(
    shown.zoom,
    alone,
    "an unmounted neighbour must not change a fitted label",
  );
  assert.equal(pending.style.zoom, "", "and it must not be scaled itself");
  fitter.destroy();
});

test("groupFactor: the smallest measured factor wins, and the floor still holds", () => {
  assert.equal(groupFactor([1, 0.48]), 0.48, "the group takes the smallest");
  assert.equal(groupFactor([0.9, 0.6, 0.75]), 0.6);
  assert.equal(groupFactor([1, 1]), 1, "nothing to do when nobody needs a fit");
  assert.equal(groupFactor([]), 1, "an empty group is not a reason to scale");
  // Unusable readings are ignored, not treated as "needs everything".
  assert.equal(groupFactor([Number.NaN, 0.8]), 0.8);
  assert.equal(groupFactor([0, 0.8]), 0.8);
  assert.equal(groupFactor([-3, 0.8]), 0.8);
  assert.equal(groupFactor([1.4, 0.8]), 0.8);
  // The readability floor is the same one a single line gets.
  assert.equal(groupFactor([0.05, 0.9]), FIT_MIN_ZOOM);
  assert.equal(groupFactor([0.2], 0.5), 0.5, "an explicit floor is honoured");
});

test("the tab slot sizes itself from its content, so a word is not squeezed by an idle neighbour", () => {
  // The layout half of the fix, pinned structurally because it lives in CSS: `flex: 1` is `1 1 0%`
  // (an exact equal split regardless of content), `flex: 1 1 auto` is content width first plus an
  // equal share of the spare — which is the formula the sheet's own V67 note quotes from Telegram's
  // FilterTabsView (additionalTabWidth = (width - trueTabsWidth) / tabs.size(), Tabs.java:1554).
  const tabRule = /\.gc-chats-header \.gc-tab,[\s\S]{0,400}?\.gc-call-log-tabs \.gc-tab \{[\s\S]*?\}/.exec(
    redesignCss,
  );
  assert.ok(tabRule, "the tab rule must still exist in redesign.css");
  const body = tabRule[0];
  assert.match(
    body,
    /flex:\s*1\s+1\s+auto/,
    "the tab slot must size itself from its content (flex: 1 1 auto)",
  );
  assert.doesNotMatch(
    body,
    /flex:\s*1\s*;/,
    "`flex: 1` is `1 1 0%` — the exact 50/50 split this defect came from",
  );
  // The touch target must survive the change: 44 px is the minimum tappable height this UI keeps.
  assert.match(body, /min-height:\s*44px/, "the tab must stay tappable");
});
