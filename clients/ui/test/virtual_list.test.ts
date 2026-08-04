import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWindow } from "../src/virtual_list.ts";

test("computeWindow: empty list", () => {
  const r = computeWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 20, count: 0 });
  assert.deepEqual(r, { startIndex: 0, endIndex: -1, offsetY: 0, totalHeight: 0 });
});

test("computeWindow: at the top with overscan", () => {
  const r = computeWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 2 });
  assert.equal(r.startIndex, 0);
  assert.equal(r.endIndex, 7); // firstVisible 0 + (ceil(100/20)+1=6) -1 + overscan 2
  assert.equal(r.offsetY, 0);
  assert.equal(r.totalHeight, 2000);
});

test("computeWindow: scrolled to the middle", () => {
  const r = computeWindow({ scrollTop: 400, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 2 });
  assert.equal(r.startIndex, 18); // firstVisible 20 - 2
  assert.equal(r.endIndex, 27);
  assert.equal(r.offsetY, 360); // 18 * 20
});

test("computeWindow: clamps past the bottom", () => {
  const r = computeWindow({ scrollTop: 999999, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 2 });
  assert.equal(r.endIndex, 99, "never exceeds the last index");
  assert.equal(r.startIndex, 93);
  assert.equal(r.offsetY, 1860);
});

test("computeWindow: guards zero item height", () => {
  const r = computeWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 0, count: 10 });
  assert.equal(r.endIndex, -1);
});

// ── VirtualList self-heal (live-QA W-1, 2026-07-13): a list whose data arrives while the container
// still measures 0px tall must render as soon as the container gains a real box — without waiting
// for a scroll event that a short list never gets. The class is exercised against a hand-rolled
// stub of the exact DOM surface it touches, so these tests still run under plain `node --test`.

import { VirtualList } from "../src/virtual_list.ts";

const stubDocument = {
  createElement: (_tag: string) => new StubElement(),
  createDocumentFragment: () => new StubFragment(),
};

class StubFragment {
  nodes: StubElement[] = [];
  appendChild(n: StubElement): StubElement { this.nodes.push(n); return n; }
}

class StubElement {
  style: Record<string, string> = {};
  children: StubElement[] = [];
  clientHeight = 0;
  scrollTop = 0;
  ownerDocument = stubDocument;
  private readonly listeners = new Map<string, Set<() => void>>();
  // The only scrollHeight consumer is stick-to-bottom math; the sizer's height is the list height.
  get scrollHeight(): number { return parseInt(this.children[0]?.style.height ?? "0", 10) || 0; }
  appendChild(n: StubElement): StubElement { this.children.push(n); return n; }
  replaceChildren(...nodes: Array<StubElement | StubFragment>): void {
    this.children = nodes.flatMap((n) => (n instanceof StubFragment ? n.nodes : [n]));
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void { this.listeners.get(type)?.delete(fn); }
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const asEl = (n: StubElement): HTMLElement => n as unknown as HTMLElement;

test("VirtualList: self-heals after a zero-height boot (frame-retry fallback)", async () => {
  const container = new StubElement();
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: 68,
    renderItem: () => asEl(stubDocument.createElement("div")),
  });
  vl.setItems([1]);
  const slab = container.children[0]!.children[0]!; // container → sizer → slab
  assert.equal(slab.children.length, 0, "blank while the container has no box");
  container.clientHeight = 600; // the screen gets attached / laid out
  await tick(120); // a few 16ms frame retries
  assert.equal(slab.children.length, 1, "row appears without any scroll event");
  vl.destroy();
});

test("VirtualList: self-heals via ResizeObserver when the platform provides it", async () => {
  const observed: Array<() => void> = [];
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe(): void { observed.push(this.cb); }
    disconnect(): void {}
  };
  try {
    const container = new StubElement();
    const vl = new VirtualList<number>({
      container: asEl(container),
      itemHeight: 68,
      renderItem: () => asEl(stubDocument.createElement("div")),
    });
    vl.setItems([1, 2]);
    const slab = container.children[0]!.children[0]!;
    assert.equal(slab.children.length, 0, "blank while the container has no box");
    assert.equal(observed.length, 1, "the container is being observed");
    container.clientHeight = 600;
    observed[0]!(); // the observer reports the new box
    await tick(60); // scheduleRender coalesces via one frame
    assert.equal(slab.children.length, 2, "rows appear from the observer alone");
    vl.destroy();
  } finally {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("VirtualList: heal keeps a stick-to-bottom feed pinned to the newest item", async () => {
  const container = new StubElement();
  let lastIndex = -1;
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: 68,
    stickToBottom: true,
    renderItem: (_v, i) => { if (i > lastIndex) lastIndex = i; return asEl(stubDocument.createElement("div")); },
  });
  vl.setItems(Array.from({ length: 100 }, (_v, i) => i));
  container.clientHeight = 600;
  await tick(160);
  assert.equal(lastIndex, 99, "newest message is rendered after the heal");
  assert.equal(container.scrollTop, container.scrollHeight, "view is pinned to the bottom");
  vl.destroy();
});


test("VirtualList: scroll away and back reuses decoded row DOM instead of repainting avatars", () => {
  const container = new StubElement();
  container.clientHeight = 40;
  const renders = new Map<number, number>();
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: 20,
    overscan: 0,
    cacheLimit: 32,
    renderItem: (value, index) => {
      renders.set(index, (renders.get(index) ?? 0) + 1);
      const row = stubDocument.createElement("div") as StubElement & { decoded?: string };
      row.decoded = `avatar-${value}`;
      return asEl(row);
    },
  });
  vl.setItems(Array.from({ length: 12 }, (_value, index) => index));
  const slab = container.children[0]!.children[0]!;
  const first = slab.children[0] as StubElement & { decoded?: string };

  vl.scrollToOffset(100);
  assert.notEqual(slab.children[0], first, "the top row leaves the rendered window");
  vl.scrollToOffset(0);

  assert.equal(slab.children[0], first, "returning to the top reattaches the exact decoded row node");
  assert.equal((slab.children[0] as StubElement & { decoded?: string }).decoded, "avatar-0");
  assert.equal(renders.get(0), 1, "the avatar row is not rebuilt or re-requested");

  const sameWindow = [...slab.children];
  vl.scrollToOffset(5);
  assert.deepEqual(slab.children, sameWindow, "pixel scrolling inside one window does not replace its DOM");
  assert.equal(renders.get(0), 1);
  vl.destroy();
});

test("VirtualList: replacing items and destroying the list releases row-owned resources", async () => {
  const { registerDomCleanup } = await import("../src/dom_disposal.ts");
  const container = new StubElement();
  container.clientHeight = 100;
  let disposed = 0;
  const vl = new VirtualList<number>({
    container: asEl(container),
    itemHeight: 20,
    renderItem: () => {
      const row = stubDocument.createElement("div");
      registerDomCleanup(row, () => { disposed += 1; });
      return asEl(row);
    },
  });

  vl.setItems([1, 2]);
  vl.setItems([3]);
  assert.equal(disposed, 2, "a content snapshot replacement disposes its detached rows");
  vl.destroy();
  assert.equal(disposed, 3, "destroy releases the final rendered row exactly once");
});
