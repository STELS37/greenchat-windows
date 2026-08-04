import { test } from "node:test";
import assert from "node:assert/strict";
import { createBadgeRefreshController } from "../src/screens/badge_refresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function scheduler() {
  const queue: Array<() => void> = [];
  return {
    setTimer(fn: () => void): unknown { queue.push(fn); return fn; },
    clearTimer(handle: unknown): void {
      const index = queue.indexOf(handle as () => void);
      if (index >= 0) queue.splice(index, 1);
    },
    runNext(): void { queue.shift()?.(); },
    size(): number { return queue.length; },
  };
}

async function ticks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("badge reset invalidates an already-started unread request", async () => {
  const s = scheduler();
  const load = deferred<number>();
  const applied: number[] = [];
  const badge = createBadgeRefreshController({
    allowed: () => true,
    loadCount: () => load.promise,
    apply: (n) => applied.push(n),
    setTimer: (fn) => s.setTimer(fn),
    clearTimer: (h) => s.clearTimer(h),
  });

  badge.request();
  s.runNext();
  badge.reset();
  load.resolve(9);
  await ticks();

  assert.deepEqual(applied, [0], "a signed-out shell must not resurrect the previous unread count");
});

test("a slower old unread request cannot overwrite a newer refresh", async () => {
  const s = scheduler();
  const first = deferred<number>();
  const second = deferred<number>();
  const loads = [first.promise, second.promise];
  const applied: number[] = [];
  const badge = createBadgeRefreshController({
    allowed: () => true,
    loadCount: () => loads.shift()!,
    apply: (n) => applied.push(n),
    setTimer: (fn) => s.setTimer(fn),
    clearTimer: (h) => s.clearTimer(h),
  });

  badge.request();
  s.runNext();
  badge.request();
  s.runNext();

  second.resolve(2);
  await ticks();
  first.resolve(8);
  await ticks();

  assert.deepEqual(applied, [2], "latest request, not latest completion, owns the badge");
});

test("badge refresh still debounces repeated events before the timer fires", async () => {
  const s = scheduler();
  let loads = 0;
  const applied: number[] = [];
  const badge = createBadgeRefreshController({
    allowed: () => true,
    loadCount: async () => { loads += 1; return 4; },
    apply: (n) => applied.push(n),
    setTimer: (fn) => s.setTimer(fn),
    clearTimer: (h) => s.clearTimer(h),
  });

  badge.request();
  badge.request();
  badge.request();
  assert.equal(s.size(), 1);
  s.runNext();
  await ticks();
  assert.equal(loads, 1);
  assert.deepEqual(applied, [4]);
});

test("reset cancels a pending timer before any request starts", async () => {
  const s = scheduler();
  let loads = 0;
  const applied: number[] = [];
  const badge = createBadgeRefreshController({
    allowed: () => true,
    loadCount: async () => { loads += 1; return 3; },
    apply: (n) => applied.push(n),
    setTimer: (fn) => s.setTimer(fn),
    clearTimer: (h) => s.clearTimer(h),
  });

  badge.request();
  badge.reset();
  assert.equal(s.size(), 0);
  await ticks();
  assert.equal(loads, 0);
  assert.deepEqual(applied, [0]);
});
