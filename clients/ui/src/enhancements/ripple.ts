// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeColor, type PreferenceStore } from "./preferences.ts";
export const RIPPLE_DURATION_MS = 620;
export const MAX_ACTIVE_RIPPLES = 6;
const DRAG_THRESHOLD_PX = 10;
interface Ripple {
  node: HTMLSpanElement;
  layer: HTMLDivElement;
  animation: Animation | null;
  timer: number;
  pointerId: number | null;
  x: number;
  y: number;
}
export interface TapRipple {
  start(): void;
  clear(): void;
  destroy(): void;
  /** A local preview can use an unsaved color, without enabling the global effect. */
  preview(x: number, y: number, target: Element, color: string): void;
}
/** Cross shadow boundaries without assuming that the target and controller share a global realm. */
function ancestors(target: Element): Element[] {
  const result: Element[] = [];
  let node: Element | null = target;
  while (node) {
    result.push(node);
    const root = node.getRootNode() as ShadowRoot;
    node = node.parentElement ?? root.host ?? null;
  }
  return result;
}
export function createTapRipple(doc: Document, preferences: PreferenceStore, reduced: () => boolean): TapRipple {
  const win = doc.defaultView;
  const active = new Set<Ripple>();
  const layers = new Map<Element, HTMLDivElement>();
  let started = false;
  let destroyed = false;
  let unsubscribe: (() => void) | undefined;
  let forwardedLabel: { control: Element; timer: number } | null = null;
  function clearLabelForward(): void {
    if (forwardedLabel) win?.clearTimeout(forwardedLabel.timer);
    forwardedLabel = null;
  }
  function remove(ripple: Ripple): void {
    if (!active.delete(ripple)) return;
    win?.clearTimeout(ripple.timer);
    ripple.animation?.cancel();
    ripple.node.remove();
    if (![...active].some((r) => r.layer === ripple.layer)) {
      ripple.layer.remove();
      for (const [parent, layer] of layers) if (layer === ripple.layer) layers.delete(parent);
    }
  }
  function clear(): void { clearLabelForward(); for (const ripple of [...active]) remove(ripple); }
  function draw(x: number, y: number, target: Element, color: string, pointerId: number | null): void {
    if (!win || !started || destroyed || reduced() || doc.visibilityState === "hidden" || !target.isConnected) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || target.ownerDocument !== doc) return;
    const chain = ancestors(target);
    if (chain.some(n => n.hasAttribute("inert") || n.matches("[data-gc-ripple=off],dialog[data-closing=true]"))) return;
    // Top-layer surfaces paint above body regardless of z-index. Attach inside the closest one.
    const overlay = chain.find(n => {
      if (n.matches("dialog[open]")) return true;
      try { return n.matches(":popover-open"); } catch { return false; }
    });
    const fullscreen = doc.fullscreenElement;
    const parent = overlay ?? (fullscreen && chain.includes(fullscreen) ? fullscreen : doc.body);
    // Native media controls/OS windows are not HTML paint surfaces.
    if (!parent || /^(VIDEO|AUDIO|IFRAME|IMG|INPUT|CANVAS)$/.test(parent.tagName)) return;
    while (active.size >= MAX_ACTIVE_RIPPLES) remove(active.values().next().value!);
    let layer = layers.get(parent);
    if (!layer) {
      layer = doc.createElement("div");
      layer.className = parent === doc.body ? "gc-tap-layer" : "gc-tap-layer gc-tap-layer-dialog";
      layer.setAttribute("aria-hidden", "true");
      parent.append(layer);
      layers.set(parent, layer);
    }
    const bounds = layer.getBoundingClientRect();
    const scaleX = bounds.width > 0 ? layer.clientWidth / bounds.width : 1;
    const scaleY = bounds.height > 0 ? layer.clientHeight / bounds.height : 1;
    const node = doc.createElement("span");
    node.className = "gc-tap-ring";
    node.style.left = `${(x - bounds.left) * scaleX}px`;
    node.style.top = `${(y - bounds.top) * scaleY}px`;
    node.style.setProperty("--gc-tap-color", normalizeColor(color));
    layer.append(node);
    const ripple: Ripple = { node, layer, animation: null, timer: 0, pointerId, x, y };
    active.add(ripple);
    try {
      ripple.animation = node.animate([
        { transform: "translate(-50%, -50%) scale(.12)", opacity: 0 },
        { transform: "translate(-50%, -50%) scale(.35)", opacity: .55, offset: .14 },
        { transform: "translate(-50%, -50%) scale(1)", opacity: 0 },
      ], { duration: RIPPLE_DURATION_MS, easing: "cubic-bezier(.2,.75,.25,1)" });
      void ripple.animation.finished.then(() => remove(ripple), () => remove(ripple));
    } catch {
      // Old WebViews may lack WAAPI. The scoped CSS fallback uses exactly the same finite motion.
      node.classList.add("gc-tap-css");
      node.style.animationDuration = `${RIPPLE_DURATION_MS}ms`;
      node.addEventListener("animationend", () => remove(ripple), { once: true });
    }
    ripple.timer = win.setTimeout(() => remove(ripple), RIPPLE_DURATION_MS + 200);
  }
  function eventElement(event: Event): Element | undefined {
    return event.composedPath().find((node): node is Element => typeof (node as Element)?.closest === "function");
  }
  function pointerDown(event: PointerEvent): void {
    if (!preferences.get().rippleEnabled || event.button !== 0 || !event.isPrimary) return;
    const target = eventElement(event);
    if (target) draw(event.clientX, event.clientY, target, preferences.get().rippleColor, event.pointerId);
  }
  function pointerCancel(event: PointerEvent): void {
    for (const r of [...active]) if (r.pointerId === event.pointerId) remove(r);
  }
  function pointerMove(event: PointerEvent): void {
    for (const r of [...active]) if (r.pointerId === event.pointerId &&
      Math.hypot(event.clientX - r.x, event.clientY - r.y) >= DRAG_THRESHOLD_PX) remove(r);
  }
  function pointerUp(event: PointerEvent): void {
    // A hover after mouse-up must not cancel the completed tap's remaining fade-out.
    for (const r of active) if (r.pointerId === event.pointerId) r.pointerId = null;
  }
  function keyboardClick(event: MouseEvent): void {
    if (!preferences.get().rippleEnabled) { clearLabelForward(); return; }
    const target = eventElement(event);
    if (event.detail !== 0) {
      clearLabelForward();
      // Label activation dispatches a SECOND click on its control with detail=0, even for
      // a mouse/touch tap. It is not a keyboard action: pointerdown already painted the wave.
      // Match the actual control, including label[for] and shadow roots, for this task only.
      const label = target ? ancestors(target).find(n => n.tagName === "LABEL") as HTMLLabelElement | undefined : undefined;
      if (label?.control && label.control !== target && win) {
        forwardedLabel = { control: label.control, timer: win.setTimeout(clearLabelForward, 0) };
      }
      return;
    }
    if (forwardedLabel?.control === target) { clearLabelForward(); return; }
    // An unrelated, synchronously dispatched click must not consume the label's marker.
    if (!target || !target.matches("button,a[href],input,summary,[role=button]")) return;
    const box = target.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) draw(box.left + box.width / 2, box.top + box.height / 2,
      target, preferences.get().rippleColor, null);
  }
  const hide = (): void => { if (doc.visibilityState === "hidden") clear(); };
  return {
    start() {
      if (started || destroyed || !win) return;
      started = true;
      // Passive observers only: no preventDefault, capturePointer or changes to touch-action.
      doc.addEventListener("pointerdown", pointerDown, { capture: true, passive: true });
      doc.addEventListener("pointercancel", pointerCancel, { capture: true, passive: true });
      doc.addEventListener("pointermove", pointerMove, { capture: true, passive: true });
      doc.addEventListener("pointerup", pointerUp, { capture: true, passive: true });
      doc.addEventListener("click", keyboardClick, { capture: true, passive: true });
      doc.addEventListener("scroll", clear, { capture: true, passive: true });
      doc.addEventListener("dragstart", clear, { capture: true, passive: true });
      doc.addEventListener("visibilitychange", hide);
      doc.addEventListener("fullscreenchange", clear);
      win.addEventListener("blur", clear);
      win.addEventListener("resize", clear, { passive: true });
      win.visualViewport?.addEventListener("resize", clear, { passive: true });
      win.visualViewport?.addEventListener("scroll", clear, { passive: true });
      unsubscribe = preferences.subscribe(() => { if (!preferences.get().rippleEnabled || reduced()) clear(); });
    },
    clear,
    preview: (x, y, target, color) => draw(x, y, target, color, null),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener("pointerdown", pointerDown, true);
      doc.removeEventListener("pointercancel", pointerCancel, true);
      doc.removeEventListener("pointermove", pointerMove, true);
      doc.removeEventListener("pointerup", pointerUp, true);
      doc.removeEventListener("click", keyboardClick, true);
      doc.removeEventListener("scroll", clear, true);
      doc.removeEventListener("dragstart", clear, true);
      doc.removeEventListener("visibilitychange", hide);
      doc.removeEventListener("fullscreenchange", clear);
      win?.removeEventListener("blur", clear);
      win?.removeEventListener("resize", clear);
      win?.visualViewport?.removeEventListener("resize", clear);
      win?.visualViewport?.removeEventListener("scroll", clear);
      unsubscribe?.();
      clear();
    },
  };
}
