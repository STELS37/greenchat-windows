// clients/ui/src/a11y.ts — accessibility primitives (T-404, PRODUCT_UX §8).
// Ships with the first release: ring keyboard navigation, prefers-reduced-motion, a focus trap for
// modals/the palette, and an aria-live announcer. Pure helpers (nextIndex, prefersReducedMotion with
// an injectable matcher) are unit-tested; focus/live helpers touch the DOM lazily (browser only).

// Ring navigation index: move `delta` steps through `count` items with optional wraparound.
export function nextIndex(current: number, count: number, delta: number, wrap = true): number {
  if (count <= 0) return 0;
  let next = current + delta;
  if (wrap) {
    next = ((next % count) + count) % count;
  } else {
    next = Math.min(count - 1, Math.max(0, next));
  }
  return next;
}

export interface MediaMatcher {
  matches: boolean;
}

export function prefersReducedMotion(matcher?: (query: string) => MediaMatcher): boolean {
  const mm = matcher ?? (typeof matchMedia === "function" ? (q: string) => matchMedia(q) : undefined);
  if (!mm) return false;
  return mm("(prefers-reduced-motion: reduce)").matches;
}

// What the Tab key actually stops at. Every native control is listed WITH `:not([tabindex="-1"])`,
// because a negative tabindex takes an element out of the tab order without disabling it: the button
// still clicks, still focuses in code, and a browser still skips it on Tab. Leaving that out made this
// list disagree with the platform for exactly one shape — a roving-tabindex widget, where all but one
// of the controls carry -1 on purpose — and it is the shape the emoji panel needs (V155): a focus trap
// or a menu ring built on the old list would have wrapped Tab onto a cell no browser would stop at,
// and the composer's tab-stop budget would have counted ninety glyphs that cost the keyboard nothing.
// Nothing in the client carried a negative tabindex on a native control before V155, so this closes a
// gap rather than changing any existing surface: the two -1s that do exist (call_overlay's dialog root
// and the container createFocusTrap makes focusable) are containers, which querySelectorAll never
// returns for themselves.
const FOCUSABLE = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((elm) => elm.offsetParent !== null || elm === container.ownerDocument.activeElement);
}

export interface FocusTrap {
  activate(): void;
  release(): void;
  /** Put the caret back inside after a repaint rebuilt the container's children (V152). */
  restoreInside(index: number): void;
  /** Where the caret currently sits among the container's focusables, or -1 if it is elsewhere. */
  indexInside(): number;
}

export interface FocusTrapOptions {
  /**
   * What receives the caret when the trap activates. Default: the container itself.
   *
   * The container is the safe default on purpose. A screen reader announces the dialog's role and
   * label when focus lands on it, and the next Tab steps to the first control — whereas focusing
   * "the first focusable" parks the caret on whatever happens to be leftmost, which on the call
   * screen is «Отклонить» and on a withdrawal sheet could be a submit button. A modal must not turn
   * a reflexive Enter into a dropped call or a sent transfer. Surfaces whose first control is a text
   * field (the palette's query box, the transfer form's recipient) pass it explicitly.
   *
   * Containers that are not natively focusable get tabindex="-1" here, exactly as a browser needs.
   */
  initialFocus?: HTMLElement | (() => HTMLElement | null | undefined);
}

// Trap Tab focus within a container while active; restore focus to the element that was focused
// before activation. Every `role="dialog" aria-modal="true"` surface in the client uses this: the
// flag tells assistive technology that everything outside the container has ceased to exist, so a
// surface that raises it and leaves the caret behind has hidden the page the caret is standing on.
export function createFocusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrap {
  let previouslyFocused: HTMLElement | null = null;
  let active = false;
  const doc = (): Document => container.ownerDocument;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const items = focusableWithin(container);
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const activeEl = doc().activeElement as HTMLElement | null;
    const at = activeEl ? items.indexOf(activeEl) : -1;
    // The caret is on the dialog itself (or on some node that is not one of its controls): a browser
    // would happily step OUT of the container from there, backwards in particular. Aim it inside.
    if (at < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && activeEl === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
  };
  return {
    activate(): void {
      if (active) return;
      active = true;
      // Captured BEFORE anything is focused. Reading it afterwards records the dialog's own control
      // as "where the person came from", so release() would hand the caret back to a node that is
      // being unmounted — which is precisely what the command palette did until V152.
      previouslyFocused = doc().activeElement as HTMLElement | null;
      container.addEventListener("keydown", onKey);
      const wanted = typeof options.initialFocus === "function" ? options.initialFocus() : options.initialFocus;
      const target = wanted ?? container;
      // A <div role="dialog"> is not focusable in any browser until it carries a tabindex; calling
      // focus() on one is a silent no-op, which is the quietest way for this whole contract to fail.
      // tabindex="-1" makes it focusable in code WITHOUT adding a stop to the Tab order. Real controls
      // (the palette's input, a sheet's first field) already match and are left untouched.
      if (!target.matches?.(FOCUSABLE)) target.setAttribute("tabindex", "-1");
      target.focus?.();
    },
    release(): void {
      if (!active) return;
      active = false;
      container.removeEventListener("keydown", onKey);
      // Only take the caret back if it is still ours. A surface can be closed while the person has
      // already moved on (a command that opened another screen, a call that ended after the app
      // navigated away) — yanking focus then would be its own bug.
      const activeEl = doc().activeElement as HTMLElement | null;
      if (!activeEl || container.contains(activeEl)) previouslyFocused?.focus?.();
      previouslyFocused = null;
    },
    indexInside(): number {
      const activeEl = doc().activeElement as HTMLElement | null;
      if (!activeEl || !container.contains(activeEl)) return -1;
      return focusableWithin(container).indexOf(activeEl);
    },
    restoreInside(index: number): void {
      if (index < 0) return;
      const items = focusableWithin(container);
      if (items.length === 0) { container.focus?.(); return; }
      items[Math.min(index, items.length - 1)]!.focus();
    },
  };
}

export interface LiveRegion {
  announce(message: string, assertive?: boolean): void;
  destroy(): void;
}

// A visually-hidden aria-live region for status announcements ("message sent", "no connection").
export function createLiveRegion(doc?: Document): LiveRegion {
  const d = doc ?? document;
  const region = d.createElement("div");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  region.className = "gc-sr-only";
  d.body.appendChild(region);
  return {
    announce(message: string, assertive = false): void {
      region.setAttribute("aria-live", assertive ? "assertive" : "polite");
      // Clear then set on the next frame so repeated identical messages re-announce.
      region.textContent = "";
      const set = () => { region.textContent = message; };
      if (typeof queueMicrotask === "function") queueMicrotask(set); else set();
    },
    destroy(): void { region.remove(); },
  };
}
