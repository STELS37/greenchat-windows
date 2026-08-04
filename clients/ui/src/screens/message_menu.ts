// clients/ui/src/screens/message_menu.ts — the per-message action surface (UI redesign V5).
//
// Before V5 every bubble carried a floating hover toolbar plus an inline "report this message" link
// baked into the bubble body. On a touch device `:hover` never fires, so the toolbar was unreachable,
// while the report link permanently disfigured every incoming bubble (it was the widest element in
// the feed). This module replaces both with one deliberate surface: a bottom sheet on touch/narrow
// screens and an anchored card on pointer devices, opened by long-press, right-click, or the
// keyboard-reachable "⋯" affordance the feed renders on each row.
//
// DOM-only wiring; no network and no formatting decisions. The feed screen supplies fully-resolved
// actions, so this file stays trivially testable against the DOM stub (it never touches globals that
// only exist in a real browser: document listeners and focus are feature-detected).
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { focusableWithin, nextIndex } from "../a11y.ts";
import { icon, type IconName } from "../icons.ts";

export interface MessageMenuItem {
  id: string;
  label: string;
  glyph: IconName;
  danger?: boolean;
  /** A one-of-several choice (media cache mode, …). Renders as a radio item and marks the active one,
   *  so a setting with three states no longer needs a native `<select>` sitting in a header. */
  checked?: boolean;
  /** Non-interactive caption that groups the radio items that follow it. */
  heading?: string;
  run: () => void;
}

export interface MessageMenuOptions {
  i18n: I18n;
  host: HTMLElement; // container the layer is appended to (the feed root)
  anchor?: HTMLElement | null; // bubble row the menu belongs to — dimmed/raised while open
  quickReactions?: readonly string[];
  onReact?: (emoji: string) => void;
  items: MessageMenuItem[];
  label?: string; // accessible name; defaults to "message actions" (the chat list passes its own)
  title?: string; // optional heading shown at the top of the sheet (e.g. the chat title)
  /**
   * Fires exactly once, when the menu leaves the screen for any reason: the scrim, Escape, an item, or
   * the caller's own close(). The screen that opened it needs this to stop holding a reference to a
   * menu that is no longer there — see modal_layer.ts.
   */
  onClose?: () => void;
}

export interface MessageMenuHandle {
  root: HTMLElement;
  close: () => void;
}

const OPEN_CLASS = "is-menu-open";

interface DocLike {
  addEventListener?: (type: string, fn: (event: unknown) => void, capture?: boolean) => void;
  removeEventListener?: (type: string, fn: (event: unknown) => void, capture?: boolean) => void;
  activeElement?: { focus?: () => void } | null;
}

function doc(): DocLike | null {
  return typeof document === "undefined" ? null : (document as unknown as DocLike);
}

// Open the menu. Returns a handle; close() (also triggered by the scrim, Escape, or activating any
// item) tears the layer down and restores focus to the element that was focused before.
export function openMessageMenu(opts: MessageMenuOptions): MessageMenuHandle {
  const { i18n, host } = opts;
  const d = doc();
  const previouslyFocused = d && d.activeElement ? d.activeElement : null;

  // Gesture guard. A long-press opens this sheet while the finger is still on the glass; when the
  // finger lifts, the browser synthesises a click at that same point — which now lands on the sheet
  // that was mounted underneath it. Measured before this guard: the menu existed during the press and
  // was gone the instant the finger came up, i.e. the message menu was unusable on every touch
  // device, and a synthetic click landing on a row could even have run an action nobody chose.
  // The sheet therefore stays "unarmed" until a *new* press starts inside it. Keyboard activation
  // carries detail === 0 (and the DOM test stub carries no detail at all), so it is always honoured.
  let armed = false;
  const arm = (): void => { armed = true; };
  const accepts = (event: unknown): boolean => {
    if (armed) return true;
    const detail = (event as { detail?: number }).detail;
    return detail === undefined || detail === 0;
  };

  const panel = el("div", {
    class: "gc-msgmenu",
    role: "menu",
    "aria-label": opts.label ?? i18n.t("feed.messageActions"),
  });
  if (opts.title) panel.append(el("div", { class: "gc-msgmenu-title" }, [opts.title]));

  const quick = opts.quickReactions ?? [];
  if (quick.length > 0 && opts.onReact) {
    const strip = el("div", { class: "gc-msgmenu-reactions" });
    for (const emoji of quick) {
      // A `role="menu"` may only own menu items; a bare <button> inside one is announced as a stray
      // control and is skipped by the arrow navigation a menu is supposed to provide. The strip is
      // the first row of this sheet, not a separate island, so it says so.
      const b = el("button", {
        type: "button",
        role: "menuitem",
        class: "gc-msgmenu-reaction",
        "aria-label": `${i18n.t("feed.react")}: ${emoji}`,
      }, [emoji]);
      b.addEventListener("click", (event) => {
        if (!accepts(event)) return; // tail click of the opening gesture — never fire an action
        close();
        opts.onReact?.(emoji);
      });
      strip.append(b);
    }
    panel.append(strip);
  }

  const list = el("div", { class: "gc-msgmenu-items" });
  let lastHeading: string | null = null;
  for (const item of opts.items) {
    if (item.heading && item.heading !== lastHeading) {
      lastHeading = item.heading;
      list.append(el("div", { class: "gc-msgmenu-group", role: "presentation" }, [item.heading]));
    }
    const isRadio = typeof item.checked === "boolean";
    const classes = ["gc-msgmenu-item"];
    if (item.danger) classes.push("is-danger");
    if (isRadio) classes.push("is-choice");
    if (item.checked) classes.push("is-checked");
    const b = el("button", {
      type: "button",
      role: isRadio ? "menuitemradio" : "menuitem",
      ...(isRadio ? { "aria-checked": item.checked ? "true" : "false" } : {}),
      class: classes.join(" "),
      "data-action": item.id,
    }, [
      el("span", { class: "gc-msgmenu-glyph", "aria-hidden": "true" }, [icon(item.checked ? "check" : item.glyph)]),
      el("span", { class: "gc-msgmenu-label" }, [item.label]),
    ]);
    b.addEventListener("click", (event) => {
      if (!accepts(event)) return; // see the gesture guard above (a stray "delete" would be fatal)
      close();
      item.run();
    });
    list.append(b);
  }
  panel.append(list);

  const layer = el("div", { class: "gc-msgmenu-layer" }, [panel]);

  let closed = false;

  // Everything in the sheet a person can act on, in the order it is read: the reaction strip, then
  // the actions. Group headings and the optional title are not focusable and drop out on their own.
  // Recomputed per keystroke rather than cached — a menu holds a handful of nodes, and a stale ring
  // is the kind of bug that only shows up on the one item that matters.
  const ring = (): HTMLElement[] => focusableWithin(panel);

  // Arrow/Home/End movement. Returns false when there is nothing to move to, so the caller can leave
  // the key to the browser instead of swallowing it.
  const moveFocus = (delta: number, edge?: "first" | "last"): boolean => {
    const items = ring();
    if (items.length === 0) return false;
    const current = items.indexOf(d?.activeElement as unknown as HTMLElement);
    const target = edge === "first"
      ? 0
      : edge === "last"
        ? items.length - 1
        // Arrowing in from outside the ring (the caret never entered, or a repaint moved it) starts at
        // the end nearest the direction of travel, exactly as a native menu does.
        : current < 0
          ? (delta > 0 ? 0 : items.length - 1)
          : nextIndex(current, items.length, delta);
    items[target]?.focus();
    return true;
  };

  const onKey = (event: unknown): void => {
    const key = (event as { key?: string }).key;
    const claim = (): void => (event as { preventDefault?: () => void }).preventDefault?.();
    if (key === "Escape") {
      claim();
      close();
      return;
    }
    // The panel says `role="menu"` and its buttons say `role="menuitem"` — a promise to assistive
    // technology that the arrows walk this list. Until now the only key this surface handled was
    // Escape, so a keyboard could reach the sheet and then only leave it. preventDefault matters as
    // much as the movement: an unclaimed ArrowDown scrolls the sheet's own body out from under the
    // caret while the screen behind it is inert and cannot take the scroll instead.
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (moveFocus(key === "ArrowDown" ? 1 : -1)) claim();
      return;
    }
    // A chat's overflow menu runs past a phone's screen; Home/End are how a keyboard reaches the ends
    // of it without walking, and the WAI-ARIA menu pattern lists them alongside the arrows.
    if (key === "Home" || key === "End") {
      if (moveFocus(0, key === "Home" ? "first" : "last")) claim();
    }
  };
  // Modal semantics. The sheet dims everything behind it, but dimming is paint only: before this,
  // Tab still walked into the greyed-out conversation, screen readers still announced it, and the
  // pixel audit measured the day separator behind the scrim at 1.38:1 because it was still exposed
  // content. `inert` is the platform primitive for "this subtree is not interactive and not in the
  // accessibility tree", so the siblings of the layer are inerted for exactly as long as it is open.
  const inerted: Array<{ setAttribute?: (k: string, v: string) => void; removeAttribute?: (k: string) => void }> = [];
  const setBackgroundInert = (on: boolean): void => {
    if (on) {
      const kids = (host as unknown as { children?: ArrayLike<unknown> }).children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i] as { setAttribute?: (k: string, v: string) => void; removeAttribute?: (k: string) => void };
        if (node === (layer as unknown)) continue;
        node.setAttribute?.("inert", "");
        inerted.push(node);
      }
      return;
    }
    for (const node of inerted) node.removeAttribute?.("inert");
    inerted.length = 0;
  };

  function close(): void {
    if (closed) return;
    closed = true;
    d?.removeEventListener?.("keydown", onKey, true);
    opts.anchor?.classList.toggle(OPEN_CLASS, false);
    setBackgroundInert(false);
    layer.remove();
    previouslyFocused?.focus?.();
    opts.onClose?.();
  }

  layer.addEventListener("click", (event) => {
    if (event.target !== layer) return;
    if (!accepts(event)) return;
    close();
  });
  layer.addEventListener("contextmenu", (event) => { event.preventDefault(); });
  // See `accepts` above: arm the sheet as soon as a *new* press starts inside it. Only real pointer
  // events may arm it. After a touch ends, Chrome replays a compatibility mousedown/mouseup/click
  // triple at the release point — i.e. on the sheet that the long-press just mounted there. Measured:
  // arming on that replayed mousedown let the following click through and closed the menu again.
  // Compatibility events are derived from pointer events, so where Pointer Events exist a genuine
  // press always produces pointerdown first; the raw pair is only a fallback for engines without them.
  layer.addEventListener("pointerdown", arm);
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== "function") {
    layer.addEventListener("mousedown", arm);
    layer.addEventListener("touchstart", arm);
  }
  d?.addEventListener?.("keydown", onKey, true);

  opts.anchor?.classList.toggle(OPEN_CLASS, true);
  host.append(layer);
  setBackgroundInert(true);

  // Opening a menu moves the caret to its first ITEM. This used to focus `list.firstChild`, which is
  // the `<div role="presentation">` group caption whenever the first action carries a `heading` — an
  // element no browser will focus, so the call did nothing and reported nothing. One line above,
  // setBackgroundInert(true) has just inerted the subtree the caret was sitting in, and a browser
  // blurs a focused element the instant it becomes inert. The result was a sheet that opened
  // unannounced with the caret on <body> and every route back inerted: a dead end for anyone without
  // a mouse. Reachable today from the feed's overflow menu — on a wide window, in a chat that cannot
  // be called, in a shell with a cache policy and no support link, the cache modes are the only
  // entries and every one of them carries a heading (V154).
  ring()[0]?.focus();

  return { root: layer, close };
}

export interface LongPressOptions {
  delayMs?: number;
  moveTolerance?: number;
  onTrigger: (source: "longpress" | "contextmenu") => void;
}

// Bind the "open the message menu" gestures to a row: long-press for touch/pen, contextmenu for mouse.
// A pointer that travels further than `moveTolerance` is a scroll, not a press, and cancels the timer.
export function bindLongPress(node: HTMLElement, opts: LongPressOptions): () => void {
  const delay = opts.delayMs ?? 400;
  const tolerance = opts.moveTolerance ?? 12;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;

  const cancel = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  const onPointerDown = (event: Event): void => {
    const pe = event as PointerEvent;
    if (pe.pointerType === "mouse") return; // mouse uses contextmenu instead
    startX = pe.clientX;
    startY = pe.clientY;
    cancel();
    timer = setTimeout(() => { timer = null; opts.onTrigger("longpress"); }, delay);
  };
  const onPointerMove = (event: Event): void => {
    if (timer === null) return;
    const pe = event as PointerEvent;
    if (Math.abs(pe.clientX - startX) > tolerance || Math.abs(pe.clientY - startY) > tolerance) cancel();
  };
  const onContextMenu = (event: Event): void => {
    event.preventDefault();
    cancel();
    opts.onTrigger("contextmenu");
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", cancel);
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("pointerleave", cancel);
  node.addEventListener("contextmenu", onContextMenu);

  return (): void => {
    cancel();
    node.removeEventListener?.("pointerdown", onPointerDown);
    node.removeEventListener?.("pointermove", onPointerMove);
    node.removeEventListener?.("pointerup", cancel);
    node.removeEventListener?.("pointercancel", cancel);
    node.removeEventListener?.("pointerleave", cancel);
    node.removeEventListener?.("contextmenu", onContextMenu);
  };
}

// Deterministic peer colours: the same user always gets the same tone, the way Telegram assigns peer
// colours. Pure and unit-testable; the palette itself lives in CSS as .gc-avatar[data-tone="N"].
const AVATAR_TONES = 8;
export function avatarTone(seed: number | string | null | undefined): number {
  if (seed === null || seed === undefined) return 0;
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_TONES;
}

// The two-letter monogram Telegram-style avatars show ("Борис Тимофеев" → "БТ").
export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]!][0] ?? "";
  const second = words.length > 1 ? ([...words[1]!][0] ?? "") : "";
  return (first + second).toUpperCase();
}
