// clients/ui/src/fit_width.ts — fit one unbreakable line (a money amount) into the box it was
// given, by measuring it and scaling it, because CSS cannot measure text.
//
// Defect this exists for (owner P0-5, measured on the signed direct APK app.greenchat versionCode
// 1000011 on redroid 15, 1080x2400, CDP against the device WebView, route #/wallet, 2026-07-31 —
// the wrapped lines below are reconstructed per character from Range rects, not guessed):
//
//   width (dp)  system font   .gc-finance-total rendered as
//   320 (d540)  1.0           "5 880 859.2" / "4 USD"       <- the number split between 2 and 4
//   320         1.3           "5 881 45"    / "3.24 USD"
//   320         1.5           "5 882 0" / "47.24" / "USD"
//   320         2.0           "5 882" / "641.2" / "4 USD"
//   390 (d440)  1.5           "5 883 829." / "24 USD"
//   390         2.0           "5 883 8" / "29.24" / "USD"
//   430 (d402)  2.0           "5 885 61" / "1.24 USD"
//
// So the headline balance of a wallet was broken in the middle of the digits — at 320 dp even at
// the DEFAULT system font, with no accessibility setting touched. The cause is a `overflow-wrap:
// anywhere` on a fixed 34px headline: once the string is wider than the box, the browser is allowed
// to break between any two characters, and "5 880 859.24 USD" is one visual word.
//
// Why scaling and not smaller type. Chromium clamps a computed font size up to
// `WebSettings.getMinimumFontSize()` and applies the system multiplier AFTER that clamp (measured
// in this project on 2026-07-31: `calc(14px / 2)` = 7px rendered at 16px under font_scale 2.0), so
// font-size arithmetic cannot undo the multiplier. `zoom` scales the element box after its text is
// laid out and is not clamped — the same correction the bottom bar and the wallet tiles already
// use in styles.css. One number covers every cause at once: a narrow screen, a large system font,
// a long balance and a wide locale, because the input is the measured overflow, not its reason.
//
// A balance is data, so no static breakpoint can be correct: 5 880 859.24 fits where 15 880 859.24
// does not. That is why this measures instead of declaring.

/** Never shrink past this: below it the headline stops being readable, and the ellipsis is honest. */
export const FIT_MIN_ZOOM = 0.4;

/**
 * What to do with a line that does not fit — decided from measurements, never from a breakpoint.
 *
 * V102, measured on the signed direct APK app.greenchat versionCode 1000012 (redroid 15, 1080x2400,
 * `wm density 540` = 320 dp, system font 2.0, route #/wallet, CDP against the device WebView,
 * 2026-07-31): the headline read «6 126 775.24…». The amount needed ~0.34 of its box, the floor is
 * 0.40, so the last resort fired and an ellipsis ate the currency — the wallet's headline no longer
 * said WHICH currency the money was in. Shrinking further is not the answer (the digits stop being
 * readable), and breaking between digits is what V101 exists to forbid.
 *
 * The line is not one word, though: «6 126 775.24» + «USD» are two segments, and the space between
 * them is the one break a reader accepts. So when even the floor cannot fit the whole line on one
 * row, the line is allowed to wrap BETWEEN the segments and the zoom is re-planned against the
 * widest single segment — the amount stays intact, the currency moves under it.
 */
export interface FitPlan {
  /** Zoom to apply to the line (1 = untouched). */
  factor: number;
  /** True when the line must be allowed to break between its segments. */
  wrap: boolean;
}

/**
 * Pure decision: `needed` = width of the whole line on one row, `widest` = width of its widest
 * unbreakable segment, `available` = the box. Both widths are measured at zoom 1.
 */
export function fitPlan(
  needed: number,
  available: number,
  widest: number,
  min: number = FIT_MIN_ZOOM,
): FitPlan {
  const single = fitZoom(needed, available, min);
  // Fits on one row, either untouched or after a scale the floor still allows. `single` alone
  // cannot tell "exactly at the floor and fitting" from "clamped up to the floor and overflowing",
  // so the raw ratio decides.
  const rawFits =
    Number.isFinite(needed) &&
    Number.isFinite(available) &&
    needed > 0 &&
    available > 0 &&
    available / needed >= single;
  if (single >= 1 || rawFits) return { factor: single, wrap: false };
  // The floor was hit. Wrapping only helps if the widest segment is genuinely narrower than the
  // whole line; a single-segment line (no currency suffix) has nothing to gain and keeps the floor.
  if (!Number.isFinite(widest) || widest <= 0 || widest >= needed)
    return { factor: single, wrap: false };
  return { factor: fitZoom(widest, available, min), wrap: true };
}

/**
 * Pure: the zoom factor that fits `needed` CSS px of unbreakable text into `available` px.
 * Returns exactly 1 when it already fits or when either measurement is unusable (an element that
 * is not laid out yet reports 0 — scaling on that would be a guess).
 */
export function fitZoom(
  needed: number,
  available: number,
  min: number = FIT_MIN_ZOOM,
): number {
  if (!Number.isFinite(needed) || !Number.isFinite(available)) return 1;
  if (needed <= 0 || available <= 0) return 1;
  if (needed <= available) return 1;
  const floor = Number.isFinite(min)
    ? Math.min(1, Math.max(0.1, min))
    : FIT_MIN_ZOOM;
  const raw = available / needed;
  // Floor, never round: rounding up by a hundredth is how a "fitted" line overflows by a pixel.
  const stepped = Math.floor(raw * 100) / 100;
  return Math.max(floor, Math.min(1, stepped));
}

/**
 * Pure: tighten an ALREADY APPLIED factor when the element still overflows after it was applied.
 *
 * V112 (owner P0-5, measured on the signed direct APK versionCode 1000013, dedicated redroid device
 * 127.0.0.1:5557, `wm density 540` = 320 dp, system font 1.3, ru-RU, route #/calls, CDP against the
 * device WebView, 2026-07-31): the call-log tab «Пропущенные» was fitted — the element carried
 * `zoom: 0.93`, so the fitter had run and believed it was done — and the word was STILL painted
 * through the tab's edge: clientWidth 125, scrollWidth 129, visual rect 116 px.
 *
 * One measurement is not a fixed point. `zoom` scales the box AFTER layout, so the element's own
 * coordinate system changes with it: the parent keeps handing out 116 visual px, which becomes
 * 116 / 0.93 = 125 own px, while the text — measured as 124 own px at zoom 1, an integer rounded
 * from its real width — re-lays out to 129. The plan was computed against numbers that stopped
 * being true the moment it was applied, and integer `clientWidth`/`scrollWidth` rounding alone can
 * account for a residue of a few px.
 *
 * So the fit is closed as a loop instead of asserted from one pass: measure, apply, measure again,
 * and tighten while the element still overflows. The caller stops when a pass makes no progress,
 * which is also what a DOM double that never re-lays out reports — those keep the single-pass
 * result they had before, rather than being shrunk on stale numbers.
 */
export function refineZoom(
  current: number,
  needed: number,
  available: number,
  min: number = FIT_MIN_ZOOM,
): number {
  if (!Number.isFinite(current) || current <= 0 || current > 1) return 1;
  if (!Number.isFinite(needed) || !Number.isFinite(available)) return current;
  if (needed <= 0 || available <= 0 || needed <= available) return current;
  const floor = Number.isFinite(min)
    ? Math.min(1, Math.max(0.1, min))
    : FIT_MIN_ZOOM;
  // Floor, never round: rounding up by a hundredth is how a "fitted" line overflows by a pixel.
  const stepped = Math.floor(current * (available / needed) * 100) / 100;
  return Math.max(floor, Math.min(current, stepped));
}

/**
 * Pure: the factor a GROUP of lines must share, given the factor each one needs on its own.
 *
 * V144 (owner P0-5, measured on the stand at 320 dp with the system font at 2.0, ru-RU, route
 * #/calls, Chromium reproducing the Android WebView zoom via `-webkit-text-size-adjust` +
 * `--enable-text-autosizing`, 2026-08-02): the call-log filter strip drew
 *
 *   «Все»         font-size 30 px x zoom 1.00 = 30.0 px on screen
 *   «Пропущенные» font-size 30 px x zoom 0.48 = 14.4 px on screen   -> the same strip at x2.08
 *
 * Two words of one control, side by side, in two different sizes — and the second one SMALLER than
 * the app's default 15 px, on a device whose owner had asked for the largest text. Reproduced at
 * 320 dp/2.0 (x2.08), 360 dp/2.0 (x1.79) and 320 dp/1.3 (x1.35); at 390 dp/1.0 and 412 dp/1.3 the
 * fitter does not fire at all and the strip is even.
 *
 * Cause: a fitter measured every label ON ITS OWN. That is right for the wallet headline, which is
 * one line in one box, and wrong for a strip, where the boxes are siblings a reader compares. The
 * remedy is not a different measurement but a shared one: a group takes the SMALLEST factor any of
 * its members needs, so a strip shrinks as one thing.
 *
 * Only factors that were actually measured count. An element that is not laid out yet reports 1
 * (`fitZoom` returns 1 on an unusable measurement), and 1 never drags a group down — a pending
 * label cannot shrink its neighbours before it has a box of its own.
 */
export function groupFactor(
  factors: readonly number[],
  min: number = FIT_MIN_ZOOM,
): number {
  const floor = Number.isFinite(min)
    ? Math.min(1, Math.max(0.1, min))
    : FIT_MIN_ZOOM;
  let smallest = 1;
  for (const f of factors) {
    if (!Number.isFinite(f) || f <= 0 || f > 1) continue;
    if (f < smallest) smallest = f;
  }
  return Math.max(floor, smallest);
}

/** The style surface used here; `zoom` is not in every lib.dom version, so it is declared. */
type ZoomableStyle = CSSStyleDeclaration & { zoom?: string };

/** How many corrective passes a fit gets after its first one.
 *
 *  Three was fitted to the default font size, where one pass closed «Пропущенные». On the signed
 *  APK at system font 200 % (redroid Android 15, 320 dp, ru-RU, CDP against the device WebView,
 *  2026-07-31) the same label needs FIVE, because every pass re-wraps the box it just measured:
 *
 *    box 160 needs 116 -> 0.72 | 183/161 -> 0.63 | 194/184 -> 0.59 | 200/197 -> 0.58 | 202/200 ->
 *    0.57 | box 204 needs 204, converged
 *
 *  With the bound at three the label stopped at 0.58 and still overflowed by 2 px — a visible cut.
 *  Eight is that measured worst case plus headroom; it is only an upper bound, since the loop exits
 *  as soon as the text fits, the factor stops shrinking, or the box does not re-lay out. */
const FIT_REFINE_PASSES = 8;

/**
 * Apply `factor` to `el` and then close the loop: while the element still overflows and the box
 * actually re-laid out, tighten the factor and apply it again. Returns the factor finally applied.
 */
function applyFittedZoom(
  el: HTMLElement,
  style: ZoomableStyle,
  factor: number,
  min: number,
): number {
  let applied = factor;
  let before = el.clientWidth;
  if (applied >= 1) style.removeProperty?.("zoom");
  else style.zoom = String(applied);
  for (let pass = 0; pass < FIT_REFINE_PASSES; pass++) {
    const available = el.clientWidth;
    const needed = el.scrollWidth;
    // A correction is only honest if the environment reflected the previous one. `zoom` scales the
    // element's own coordinate system, so a real box ALWAYS reports a different clientWidth after a
    // factor below 1 was applied (116 visual px became 125 own px on the device). A box that reads
    // exactly the same is a DOM that does not re-lay out — a unit-test double, or a browser that
    // ignored the write — and tightening on its unchanged numbers would shrink the text on evidence
    // that was never re-measured. So that case keeps the single-pass result.
    if (applied < 1 && available === before) break;
    before = available;
    if (!(needed > available)) break;
    const next = refineZoom(applied, needed, available, min);
    if (!(next < applied)) break; // already at the floor: an ellipsis is the honest answer
    applied = next;
    style.zoom = String(applied);
  }
  return applied;
}

/**
 * Measure `el` unscaled and apply the fitting zoom. Returns the applied factor (1 = untouched).
 *
 * The zoom is written through the CSSOM, not a `style="…"` attribute: this app ships
 * `style-src 'self'`, which by spec also covers `style-src-attr`, and Chrome refuses the attribute
 * outright (the same trap text_zoom.ts documents). Property writes are not inline styles.
 */
export function fitToWidth(
  el: HTMLElement,
  min: number = FIT_MIN_ZOOM,
): number {
  const style = el.style as ZoomableStyle;
  // Measure at 1: `scrollWidth` is reported in the element's own (already zoomed) pixels, so a
  // leftover factor would make the next measurement disagree with the previous one.
  style.zoom = "1";
  const needed = el.scrollWidth;
  const available = el.clientWidth;
  return applyFittedZoom(el, style, fitZoom(needed, available, min), min);
}

/**
 * Measure `el` as one row, then either scale it or — when even the floor cannot fit it — let it
 * break between its segments and scale to the widest segment (see `fitPlan`).
 *
 * The wrap is expressed by toggling the `is-wrapped` class, so the two states live in the sheet
 * next to each other instead of being spelled out in JS: `.gc-finance-total` is nowrap, and
 * `.gc-finance-total.is-wrapped` allows the break between the amount and the currency while each
 * segment stays unbreakable on its own.
 */
export function fitSegmentedLine(
  el: HTMLElement,
  min: number = FIT_MIN_ZOOM,
): FitPlan {
  // A fitter is wired from a screen's constructor, and screens are unit-tested against a minimal
  // DOM double that implements only what the screen itself uses. Measuring is an enhancement, not
  // a contract: an element that cannot report a box (or carry a style/class) is left alone rather
  // than crashing the screen that owns it.
  const style = el.style as ZoomableStyle | undefined;
  if (
    !style ||
    typeof el.clientWidth !== "number" ||
    typeof el.scrollWidth !== "number"
  )
    return { factor: 1, wrap: false };
  const classes = el.classList as DOMTokenList | undefined;
  // Always measure from the same state: no leftover zoom (scrollWidth is reported in the element's
  // own, already-zoomed pixels) and no leftover wrap (a wrapped line reports its ROW width, which
  // would make an overflowing line look like a fitting one).
  style.zoom = "1";
  classes?.remove("is-wrapped");
  const available = el.clientWidth;
  const needed = el.scrollWidth;
  let widest = 0;
  for (const child of Array.from(el.children ?? [])) {
    const w = (child as HTMLElement).getBoundingClientRect?.().width ?? 0;
    if (w > widest) widest = w;
  }
  const plan = fitPlan(needed, available, widest, min);
  if (plan.wrap) classes?.add("is-wrapped");
  return {
    factor: applyFittedZoom(el, style, plan.factor, min),
    wrap: plan.wrap,
  };
}

/** Hooks a fitter needs from the environment; separated so the logic is testable without a DOM. */
export interface FitEnv {
  /** Re-fit everything registered. */
  run(): void;
  /** Subscribe to every event that can change the available width or the rendered text size. */
  onChange(cb: () => void): () => void;
}

/**
 * Keep a set of elements fitted. Elements are handed in per render (the wallet rebuilds its summary
 * on every refresh), so the fitter owns the list and the caller owns nothing but the disposer.
 *
 * One fitter is one GROUP. Every caller already creates a fitter per control — the chat list makes
 * one for its two header tabs, the call log one for its filter strip, the wallet one for its
 * headline — so the grouping is the instance, and nothing new has to be declared at the call sites.
 * Members share the smallest factor any of them needs (V144, see `groupFactor`); a fitter with a
 * single target is unaffected, which is why the wallet headline behaves exactly as before.
 */
export function createWidthFitter(min: number = FIT_MIN_ZOOM): {
  track(el: HTMLElement): void;
  refit(): void;
  destroy(): void;
} {
  let targets: HTMLElement[] = [];
  let disposed = false;
  // V103 (owner P0-5, measured on the signed direct APK 1000012, redroid 15, `wm density 540` =
  // 320 dp, system font 2.0, route #/chats, CDP against the device WebView, 2026-07-31): the
  // "Archived" tab still painted 97 px of text through a 75 px box even though V102 had wired the
  // fitter to it. Cause: a screen builds its DOM and tracks its labels BEFORE the router mounts the
  // node, so at track time the label is not connected and has no box — and the old sweep
  // `targets.filter(t => t.isConnected)` deleted exactly those elements on the very first retry.
  // The label was therefore never measured again once it finally had a width. An element may only
  // be dropped after it has HAD a box and then left the document; until then it is merely pending.
  const everBoxed = new WeakSet<HTMLElement>();
  // V144: what each member needs ON ITS OWN, from its last measurement. The group's factor is the
  // smallest of these, and it is re-derived from scratch on every pass (`fitSegmentedLine` measures
  // at zoom 1), so an equalised member can never ratchet itself down over successive passes.
  const ownFactor = new WeakMap<HTMLElement, number>();
  const setZoom = (el: HTMLElement, factor: number): void => {
    const style = el.style as ZoomableStyle | undefined;
    if (!style) return;
    if (factor >= 1) style.removeProperty?.("zoom");
    else style.zoom = String(factor);
  };
  // Applying a factor SMALLER than the one an element measured for cannot make it overflow, so this
  // needs no refinement loop — it is a write, not a fit.
  const equalize = (): void => {
    const live = targets.filter((t) => t.isConnected);
    if (live.length < 2) return;
    const factor = groupFactor(
      live.map((t) => ownFactor.get(t) ?? 1),
      min,
    );
    for (const t of live) setZoom(t, factor);
  };
  const refit = (): void => {
    if (disposed) return;
    targets = targets.filter((t) => !everBoxed.has(t) || t.isConnected);
    for (const t of targets) {
      if (!t.isConnected) continue;
      if (t.clientWidth > 0) everBoxed.add(t);
      ownFactor.set(t, fitSegmentedLine(t, min).factor);
    }
    equalize();
  };
  const offs: Array<() => void> = [];
  const listen = (
    target: { addEventListener?: unknown; removeEventListener?: unknown },
    type: string,
  ): void => {
    const add = target.addEventListener as
      | ((t: string, cb: () => void) => void)
      | undefined;
    const remove = target.removeEventListener as
      | ((t: string, cb: () => void) => void)
      | undefined;
    if (typeof add !== "function" || typeof remove !== "function") return;
    const cb = (): void => refit();
    add.call(target, type, cb);
    offs.push(() => remove.call(target, type, cb));
  };
  const view = globalThis as unknown as {
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  // resize covers rotation, the keyboard and a system font change (Android re-lays out the WebView);
  // visibilitychange covers a font size changed while the app sat in the background.
  listen(view, "resize");
  listen(view, "orientationchange");
  if (typeof document !== "undefined")
    listen(
      document as unknown as {
        addEventListener?: unknown;
        removeEventListener?: unknown;
      },
      "visibilitychange",
    );
  // An element handed in before its screen is mounted has no box yet: `clientWidth` is 0 and
  // fitting on that would be a guess (fitZoom returns 1). Rather than leaving the label unfitted
  // until the first resize — which on a phone may never come — retry on the next few animation
  // frames and stop as soon as every target has a box. Bounded, so a screen that is created and
  // never mounted cannot leave an endless loop behind.
  const raf = (
    globalThis as { requestAnimationFrame?: (cb: () => void) => number }
  ).requestAnimationFrame;
  const settle = (left: number): void => {
    if (disposed || left <= 0) return;
    // V103: "not connected yet" is pending too — a screen tracked before the router mounts it needs
    // the retries to survive until the mount, not to stop on the frame after construction.
    const pending = targets.some((t) => !t.isConnected || t.clientWidth === 0);
    refit();
    if (!pending) return;
    if (typeof raf === "function") raf(() => settle(left - 1));
  };
  // V103: the retries above are a bounded guess about WHEN the box appears. The box itself is an
  // observable fact, so watch it: ResizeObserver fires when the element goes from no box to a box
  // (mount) and on every later width change, which is what a fitter actually depends on. Guarded
  // because the UI test doubles ship a DOM without it.
  const RO = (
    globalThis as {
      ResizeObserver?: new (cb: () => void) => {
        observe(el: Element): void;
        disconnect(): void;
      };
    }
  ).ResizeObserver;
  // The observed node is the PARENT, never the target: the fitter's own remedy is `zoom` on the
  // target, and `zoom` changes the target's reported box — observing the target would make the fix
  // re-trigger the observer forever. The parent box is what actually constrains the line and is
  // unaffected by the child's zoom. `reentrant` additionally swallows notifications caused by our
  // own write, so a browser that reports the parent as changed cannot start a loop either.
  let reentrant = false;
  const observed = new WeakSet<Element>();
  const ro =
    typeof RO === "function"
      ? new RO(() => {
          if (reentrant) return;
          reentrant = true;
          try {
            refit();
          } finally {
            reentrant = false;
          }
        })
      : undefined;
  return {
    track(el: HTMLElement) {
      if (disposed || targets.includes(el)) return;
      targets.push(el);
      ownFactor.set(el, fitSegmentedLine(el, min).factor);
      if (el.clientWidth > 0) everBoxed.add(el);
      // V144: the second label of a strip is tracked after the first one is already fitted, so the
      // group is levelled here too — otherwise a strip that never receives a resize, an observer
      // notification or a settle frame would keep the two factors it was built with.
      equalize();
      const box = el.parentElement ?? el;
      if (ro && box && !observed.has(box)) {
        observed.add(box);
        ro.observe(box);
      }
      if (el.clientWidth === 0) settle(8);
    },
    refit,
    destroy() {
      disposed = true;
      targets = [];
      ro?.disconnect();
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}
