// Browser/WebView scroll stability for the mounted chat feed.
//
// The feed owns message rendering and intentional history navigation. This guard owns a narrower
// platform boundary: browsers and mobile IMEs are allowed to move a focused scroll container without
// a wheel/touch/key gesture. When that happens at the live tail, the resulting stable `scroll` event
// must not be mistaken for a person asking to read old history. Otherwise the next own or incoming
// message preserves that synthetic offset and the conversation appears to jump to the top.

interface MutationObserverLike {
  observe(target: Node, options?: MutationObserverInit): void;
  disconnect(): void;
}

interface ResizeObserverLike {
  observe(target: Element, options?: ResizeObserverOptions): void;
  disconnect(): void;
}

export interface FeedScrollStabilityEnv {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  createMutationObserver?(callback: () => void): MutationObserverLike;
  createResizeObserver?(callback: () => void): ResizeObserverLike;
}

export interface FeedScrollStabilityController {
  allowNavigation(action: () => void): void;
  destroy(): void;
}

const TAIL_EPSILON = 2;
const READER_INTENT_MS = 1_200;
const NAVIGATION_INTENT_MS = 2_000;

const defaultEnv = (): FeedScrollStabilityEnv => ({
  now: () => (typeof performance === "undefined" ? Date.now() : performance.now()),
  requestFrame: (callback) => {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(() => callback());
    return setTimeout(callback, 0) as unknown as number;
  },
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
    else clearTimeout(handle);
  },
  ...(typeof MutationObserver === "undefined"
    ? {}
    : { createMutationObserver: (callback: () => void): MutationObserverLike => new MutationObserver(callback) }),
  ...(typeof ResizeObserver === "undefined"
    ? {}
    : { createResizeObserver: (callback: () => void): ResizeObserverLike => new ResizeObserver(callback) }),
});

const isTail = (list: HTMLElement): boolean =>
  list.scrollHeight - list.scrollTop - list.clientHeight <= TAIL_EPSILON;

const isScrollKey = (event: KeyboardEvent): boolean =>
  event.key === "ArrowUp"
  || event.key === "ArrowDown"
  || event.key === "PageUp"
  || event.key === "PageDown"
  || event.key === "Home"
  || event.key === "End"
  || event.key === " ";

export function installFeedScrollStability(
  root: HTMLElement,
  env: FeedScrollStabilityEnv = defaultEnv(),
): FeedScrollStabilityController {
  const list = root.querySelector<HTMLElement>(".gc-feed-list");
  const input = root.querySelector<HTMLElement>(".gc-composer-input");
  if (!list || !input) {
    return { allowNavigation: (action) => action(), destroy() {} };
  }

  const documentTarget = root.ownerDocument;
  let destroyed = false;
  let tailPinned = isTail(list);
  let pointerGesture = false;
  let readerIntentUntil = 0;
  let firstFrame = 0;
  let secondFrame = 0;

  const markReaderIntent = (duration = READER_INTENT_MS): void => {
    readerIntentUntil = Math.max(readerIntentUntil, env.now() + duration);
  };
  const readerOwnsScroll = (): boolean => pointerGesture || env.now() < readerIntentUntil;

  const cancelFrames = (): void => {
    if (firstFrame) env.cancelFrame(firstFrame);
    if (secondFrame) env.cancelFrame(secondFrame);
    firstFrame = 0;
    secondFrame = 0;
  };

  // Two frames cover both orderings seen in Android WebView: the IME can scroll first and resize the
  // feed second, or resize first and apply its focused-element correction on the following frame.
  const schedulePin = (): void => {
    if (destroyed || !tailPinned || firstFrame || secondFrame) return;
    firstFrame = env.requestFrame(() => {
      firstFrame = 0;
      if (destroyed || !tailPinned || readerOwnsScroll()) return;
      list.scrollTop = list.scrollHeight;
      secondFrame = env.requestFrame(() => {
        secondFrame = 0;
        if (destroyed || !tailPinned || readerOwnsScroll()) return;
        list.scrollTop = list.scrollHeight;
      });
    });
  };

  const onScroll = (): void => {
    if (isTail(list)) {
      tailPinned = true;
      return;
    }
    if (readerOwnsScroll()) {
      tailPinned = false;
      cancelFrames();
      return;
    }
    if (tailPinned) schedulePin();
  };

  const onWheel = (): void => markReaderIntent();
  const onPointerDown = (): void => {
    pointerGesture = true;
    markReaderIntent();
  };
  const onPointerDone = (): void => {
    if (!pointerGesture) return;
    pointerGesture = false;
    markReaderIntent(); // keep touch/mouse momentum attributable to the same gesture
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isScrollKey(event)) markReaderIntent();
  };
  const onComposerActivity = (): void => {
    if (!tailPinned && !isTail(list)) return;
    tailPinned = true;
    schedulePin();
  };

  list.addEventListener("scroll", onScroll, { passive: true });
  list.addEventListener("wheel", onWheel, { passive: true });
  list.addEventListener("pointerdown", onPointerDown, { passive: true });
  list.addEventListener("keydown", onKeyDown);
  documentTarget.addEventListener("pointerup", onPointerDone, { passive: true });
  documentTarget.addEventListener("pointercancel", onPointerDone, { passive: true });
  input.addEventListener("focus", onComposerActivity);
  input.addEventListener("beforeinput", onComposerActivity);
  input.addEventListener("input", onComposerActivity);

  const mutation = env.createMutationObserver?.(() => {
    if (tailPinned) schedulePin();
  });
  mutation?.observe(list, { childList: true, subtree: true });

  const resize = env.createResizeObserver?.(() => {
    if (tailPinned) schedulePin();
  });
  resize?.observe(list);

  schedulePin();

  return {
    allowNavigation(action) {
      if (destroyed) { action(); return; }
      tailPinned = false;
      markReaderIntent(NAVIGATION_INTENT_MS);
      cancelFrames();
      action();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelFrames();
      mutation?.disconnect();
      resize?.disconnect();
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("pointerdown", onPointerDown);
      list.removeEventListener("keydown", onKeyDown);
      documentTarget.removeEventListener("pointerup", onPointerDone);
      documentTarget.removeEventListener("pointercancel", onPointerDone);
      input.removeEventListener("focus", onComposerActivity);
      input.removeEventListener("beforeinput", onComposerActivity);
      input.removeEventListener("input", onComposerActivity);
    },
  };
}
