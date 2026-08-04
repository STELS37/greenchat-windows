// clients/ui/src/virtual_list.ts — own virtual scroller (T-404, ~150 lines).
// A fixed-height window+buffer virtualiser for the chat list and the message feed. The geometry is
// a pure function (computeWindow — unit-tested in node); the DOM binder (VirtualList) is a thin,
// lazily-constructed layer that renders only the visible window into an absolutely-offset viewport.
// DOM is touched only inside the class, never at import time, so the module loads under node:test.
import { disposeDomTree } from "./dom_disposal.ts";

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  itemHeight: number;
  count: number;
  overscan?: number;
}

export interface WindowRange {
  startIndex: number; // first rendered item (inclusive)
  endIndex: number;   // last rendered item (inclusive); -1 when the list is empty
  offsetY: number;    // translateY for the first rendered item
  totalHeight: number; // full scroll height (all items)
}

// Pure geometry: given the scroll position and a fixed row height, which item indices must exist in
// the DOM, and where does the rendered slab sit. `overscan` rows are kept above/below the viewport so
// a fast flick does not flash blank rows.
export function computeWindow(input: WindowInput): WindowRange {
  const { scrollTop, viewportHeight, itemHeight, count } = input;
  const overscan = Math.max(0, Math.floor(input.overscan ?? 3));
  const total = Math.max(0, count);
  const totalHeight = total * Math.max(0, itemHeight);
  if (total <= 0 || itemHeight <= 0 || viewportHeight <= 0) {
    return { startIndex: 0, endIndex: -1, offsetY: 0, totalHeight };
  }
  const maxTop = Math.max(0, totalHeight - viewportHeight);
  const clampedTop = Math.min(Math.max(0, scrollTop), maxTop);
  const firstVisible = Math.floor(clampedTop / itemHeight);
  const visibleCount = Math.ceil(viewportHeight / itemHeight) + 1;
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(total - 1, firstVisible + visibleCount - 1 + overscan);
  return { startIndex, endIndex, offsetY: startIndex * itemHeight, totalHeight };
}

// Pure: accept a freshly resolved row height, or keep the last good one. A resolver that measures
// the DOM legitimately returns 0 while the list is hidden (`display: none` during the loading and
// empty states) or not yet laid out; taking that at face value would set the scroll geometry to
// zero and blank the list. Heights are rounded up so a fractional line box (58.3px at font_scale
// 1.3) never leaves the last text row one pixel short.
export function sanitiseHeight(next: number, previous: number): number {
  if (!Number.isFinite(next) || next <= 0) return previous;
  return Math.ceil(next);
}

export interface VirtualListOptions<T> {
  container: HTMLElement;
  /**
   * Row height in CSS px. A number pins it forever (the original behaviour). A function is asked
   * again on every `refreshItemHeight()`, which is what lets a fixed-height virtualiser follow a
   * height the platform decides — V119: at the largest Android system font a chat row needs 87px of
   * content, and the pinned 72px was written onto every row as an INLINE style, so no stylesheet
   * rule could win and rows overlapped. The resolver may return a non-positive or non-finite value
   * (container not laid out yet); the last good height is kept in that case.
   */
  itemHeight: number | (() => number);
  renderItem: (item: T, index: number) => HTMLElement;
  overscan?: number;
  // Keep the view pinned to the bottom when new items arrive (message-feed behaviour).
  stickToBottom?: boolean;
  // Rows that leave the viewport stay decoded in a bounded LRU. Scrolling back therefore reuses the
  // same DOM/image instead of flashing initials and requesting the signed avatar again.
  cacheLimit?: number;
}

// Thin DOM binder. Structure: container (scroll box) → sizer (full height) → slab (translated window).
export class VirtualList<T> {
  private readonly container: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly slab: HTMLElement;
  private readonly measureItemHeight: (() => number) | null;
  private itemHeight: number;
  private readonly overscan: number;
  private readonly renderItem: (item: T, index: number) => HTMLElement;
  private readonly stickToBottom: boolean;
  private readonly cacheLimit: number;
  private readonly nodeCache = new Map<number, { item: T; node: HTMLElement }>();
  private itemsRevision = 0;
  private renderedRevision = -1;
  private renderedStart = 0;
  private renderedEnd = -1;
  private renderedOffsetY = 0;
  private renderedItemHeight = 0;
  private items: T[] = [];
  private rafPending = false;
  private readonly onScroll: () => void;
  private readonly resizeObserver: ResizeObserver | null;
  private healPending = false; // a render was skipped because the viewport measured 0px
  private zeroRetries = 0;     // frame-retry budget while the viewport still measures 0px

  constructor(options: VirtualListOptions<T>) {
    this.container = options.container;
    this.measureItemHeight = typeof options.itemHeight === "function" ? options.itemHeight : null;
    this.itemHeight = this.measureItemHeight === null
      ? (options.itemHeight as number)
      : 0;
    if (this.measureItemHeight !== null) this.itemHeight = sanitiseHeight(this.measureItemHeight(), 0);
    this.overscan = options.overscan ?? 3;
    this.renderItem = options.renderItem;
    this.stickToBottom = options.stickToBottom ?? false;
    this.cacheLimit = Math.max(0, Math.floor(options.cacheLimit ?? 96));

    this.container.style.overflowY = "auto";
    this.container.style.position = "relative";

    this.sizer = this.container.ownerDocument.createElement("div");
    this.sizer.style.position = "relative";
    this.sizer.style.width = "100%";

    this.slab = this.container.ownerDocument.createElement("div");
    this.slab.style.position = "absolute";
    this.slab.style.top = "0";
    this.slab.style.left = "0";
    this.slab.style.right = "0";
    this.slab.style.willChange = "transform";

    this.sizer.appendChild(this.slab);
    this.container.replaceChildren(this.sizer);

    this.onScroll = () => this.scheduleRender();
    this.container.addEventListener("scroll", this.onScroll, { passive: true });

    // Self-heal for the boot race (live-QA W-1, 2026-07-13): when setItems() lands while the
    // container is detached or not yet laid out, clientHeight is 0, computeWindow yields an empty
    // window, and — with re-renders driven only by scroll — a short list stays blank forever. A
    // ResizeObserver re-renders as soon as the container gains a real box; the capped frame-retry
    // in render() is the fallback for environments without ResizeObserver.
    this.resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.scheduleRender())
      : null;
    this.resizeObserver?.observe(this.container);
  }

  /**
   * Ask the height resolver again and re-render when the answer moved. Returns whether it moved.
   * Callers use this when the platform may have changed the row height under them — a system font
   * size change (V119) or a width class change. A no-op for a list constructed with a fixed number.
   */
  refreshItemHeight(): boolean {
    if (this.measureItemHeight === null) return false;
    const next = sanitiseHeight(this.measureItemHeight(), this.itemHeight);
    if (next === this.itemHeight) return false;
    this.itemHeight = next;
    this.render();
    return true;
  }

  /** Current row height in CSS px (resolved, not the raw option). */
  get rowHeight(): number {
    return this.itemHeight;
  }

  private disposeCachedRows(): void {
    for (const cached of this.nodeCache.values()) disposeDomTree(cached.node);
    this.nodeCache.clear();
  }

  private rowNode(item: T, index: number): HTMLElement {
    const cached = this.nodeCache.get(index);
    if (cached?.item === item) {
      // Refresh insertion order: Map is the LRU list, oldest first.
      this.nodeCache.delete(index);
      this.nodeCache.set(index, cached);
      return cached.node;
    }
    if (cached) disposeDomTree(cached.node);
    const node = this.renderItem(item, index);
    this.nodeCache.set(index, { item, node });
    return node;
  }

  private trimCache(visibleStart: number, visibleEnd: number): void {
    while (this.nodeCache.size > this.cacheLimit) {
      let removed = false;
      for (const [index, cached] of this.nodeCache) {
        if (index >= visibleStart && index <= visibleEnd) continue;
        this.nodeCache.delete(index);
        disposeDomTree(cached.node);
        removed = true;
        break;
      }
      // The visible window itself may be larger than the configured limit; visible rows always win.
      if (!removed) break;
    }
  }

  setItems(items: T[]): void {
    const wasAtBottom = this.stickToBottom && this.isNearBottom();
    // A content refresh can change titles, badges, ordering and handlers even when an index is reused.
    // Cache only across scroll renders of one immutable item snapshot, never across setItems().
    this.disposeCachedRows();
    this.items = items;
    this.itemsRevision += 1;
    this.renderedRevision = -1;
    this.render();
    if (wasAtBottom) this.scrollToBottom();
  }

  private isNearBottom(): boolean {
    const gap = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
    return gap <= this.itemHeight * 2;
  }

  scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
    this.render();
  }

  /**
   * Jump to an absolute offset in px (0 = the top of the list). The caller owns the meaning of the
   * number; the browser clamps it to whatever the current content allows, exactly as it clamps a
   * finger. Used by a list whose CONTENT is replaced by a different VIEW — a search filter, another
   * tab — where the offset the reader chose for the old view describes nothing in the new one.
   */
  scrollToOffset(offset: number): void {
    this.container.scrollTop = Math.max(0, offset);
    this.render();
  }

  scrollToIndex(index: number): void {
    this.scrollToOffset(Math.max(0, index) * this.itemHeight);
  }

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
    raf(() => { this.rafPending = false; this.render(); });
  }

  private render(): void {
    // Boot order guard: a measuring resolver cannot answer before the list has a laid-out row, so
    // the resolve done in the constructor can legitimately be 0. Re-asking here means the height
    // arrives with the first render that follows a real layout (scroll, ResizeObserver, setItems)
    // instead of requiring the screen to notice and call refreshItemHeight() by hand.
    if (this.itemHeight <= 0 && this.measureItemHeight !== null) {
      this.itemHeight = sanitiseHeight(this.measureItemHeight(), this.itemHeight);
    }
    const viewportHeight = this.container.clientHeight;
    const range = computeWindow({
      scrollTop: this.container.scrollTop,
      viewportHeight,
      itemHeight: this.itemHeight,
      count: this.items.length,
      overscan: this.overscan,
    });
    this.sizer.style.height = `${range.totalHeight}px`;
    this.slab.style.transform = `translateY(${range.offsetY}px)`;
    const sameWindow =
      viewportHeight > 0 &&
      this.renderedRevision === this.itemsRevision &&
      this.renderedStart === range.startIndex &&
      this.renderedEnd === range.endIndex &&
      this.renderedOffsetY === range.offsetY &&
      this.renderedItemHeight === this.itemHeight;
    if (!sameWindow) {
      const doc = this.container.ownerDocument;
      const frag = doc.createDocumentFragment();
      for (let i = range.startIndex; i <= range.endIndex; i++) {
        const item = this.items[i];
        if (item === undefined) continue;
        const node = this.rowNode(item, i);
        node.style.height = `${this.itemHeight}px`;
        frag.appendChild(node);
      }
      this.slab.replaceChildren(frag);
      this.renderedRevision = this.itemsRevision;
      this.renderedStart = range.startIndex;
      this.renderedEnd = range.endIndex;
      this.renderedOffsetY = range.offsetY;
      this.renderedItemHeight = this.itemHeight;
      this.trimCache(range.startIndex, range.endIndex);
    }

    if (viewportHeight <= 0 && this.items.length > 0) {
      // Zero-height render: nothing was drawn even though items exist. Remember that a heal is due
      // and, when no ResizeObserver is watching, retry on upcoming frames (capped — enough to cover
      // a late attach without turning a permanently hidden list into a spin loop).
      this.healPending = true;
      if (this.resizeObserver === null && this.zeroRetries < 120) {
        this.zeroRetries += 1;
        this.scheduleRender();
      }
      return;
    }
    if (this.healPending) {
      // First successful render after a blank boot: restore the feed contract — a stick-to-bottom
      // list must wake up pinned to the newest item, not stranded at the top of the history.
      this.healPending = false;
      this.zeroRetries = 0;
      if (this.stickToBottom) this.scrollToBottom();
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.container.removeEventListener("scroll", this.onScroll);
    this.disposeCachedRows();
    this.container.replaceChildren();
  }
}
