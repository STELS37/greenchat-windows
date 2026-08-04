// Who owns a modal after `modalRoot()` moved it out of the screen.
//
// `modalRoot()` (see dom.ts) mounts overlays on `document.body` so they can compete with the navigation
// bar on equal terms. That fixed the stacking bug and created a second one nobody wrote down: a screen's
// `destroy()` unmounts its own subtree, and the modal is no longer in it. From then on every caller had
// to remember two separate facts by hand —
//   1. "one at a time": a second tap must not build a second copy;
//   2. "it leaves with the screen": destroy() must take the modal down too.
//
// Measured across the client on 2026-08-03 (headless run of the real screens, DOM stub): seven call
// sites mount a modal through `modalRoot()`, in three different hand-rolled shapes, and four of them
// got at least one half wrong. The chat header's info sheet is the plain reading of the damage — three
// taps on the title produced three stacked sheets (`after 3 taps=3`) and all three were still on screen
// after the screen was destroyed (`after destroy=3`), i.e. a card about a chat the person had already
// left, painted over the one they went to.
//
// The lesson is not "fix the info sheet". Copying a convention by hand is a coin flip, and the coin came
// up wrong four times out of seven. So the convention stops being a convention: a screen asks this layer
// for a modal under a key, and the layer is the single place that knows both facts.
import { modalRoot } from "./dom.ts";

/** What the layer needs to know about a modal to own it. Everything else stays the caller's business. */
export interface ModalPresence {
  /**
   * Take the modal off screen. Called at most once per instance by the layer, but the modal's own
   * Escape/scrim handlers may have run first, so it must tolerate repeats.
   */
  close(): void;
  /** Hand the caret back. Called on the first open AND every time the modal is asked for again. */
  focus?(): void;
  /**
   * Called once, right after the node is in the document, and never on a repeat open. This is where
   * work that must not be redone belongs — the video-note recorder starts its camera here, and a second
   * tap on the record button must not restart it.
   */
  mounted?(): void;
  /**
   * The node to mount. Omit when the builder already mounted itself — anchored menus position
   * themselves against a trigger and must be in the document before they can measure it.
   */
  node?: HTMLElement;
}

export interface ModalLayer {
  /**
   * Open the modal filed under `key`, or hand focus back to the one already open. `build` receives the
   * release callback the modal must call from its own `onClose`: it tells the layer the modal is gone
   * without asking it to close anything.
   */
  open(key: string, build: (release: () => void) => ModalPresence): void;
  /** Replace whatever is open under `key`. Menus want this: a second message's menu is not the first's. */
  close(key: string): void;
  isOpen(key: string): boolean;
  /** Every live modal, newest first. Screens call this from destroy(). */
  closeAll(): void;
}

/**
 * `owner` is consulted only at mount time, as the fallback `modalRoot()` falls back to when there is no
 * document body (unit runs). A getter is accepted because a screen's root element is often built after
 * the handlers that open its modals — the feed declares `let root!: HTMLElement` and fills it in later.
 */
export function createModalLayer(owner: HTMLElement | (() => HTMLElement)): ModalLayer {
  const ownerNode = (): HTMLElement => (typeof owner === "function" ? owner() : owner);
  // Insertion order is preserved by Map, which is what lets closeAll() unwind newest-first.
  const live = new Map<string, ModalPresence>();

  const forget = (key: string, who: ModalPresence | undefined): void => {
    if (who !== undefined && live.get(key) === who) live.delete(key);
  };

  const close = (key: string): void => {
    const present = live.get(key);
    if (!present) return;
    // Drop the entry BEFORE closing. A well-behaved modal calls its onClose from close(), which lands in
    // forget() — by then the key is already gone, so the two paths cannot fight over one entry.
    live.delete(key);
    present.close();
  };

  return {
    open(key, build) {
      const already = live.get(key);
      if (already) {
        // Not a no-op: the person tapped something, so the answer is the sheet they are looking at.
        already.focus?.();
        return;
      }
      // `present` is read only from the release callback, which cannot run before the assignment below
      // unless the builder closes the modal while still constructing it — in which case there is nothing
      // to forget and the guard above sees `undefined`.
      let present: ModalPresence | undefined;
      present = build(() => forget(key, present));
      live.set(key, present);
      if (present.node) modalRoot(ownerNode()).append(present.node);
      present.focus?.();
      present.mounted?.();
    },
    close,
    isOpen: (key) => live.has(key),
    closeAll() {
      for (const key of [...live.keys()].reverse()) close(key);
    },
  };
}
