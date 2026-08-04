import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.ts";

const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r));

interface S { count: number; name: string }

test("mini-store: getState + shallow setState merge", () => {
  const store = createStore<S>({ count: 0, name: "a" });
  store.setState({ count: 5 });
  assert.deepEqual(store.getState(), { count: 5, name: "a" });
});

test("mini-store: batches many setState in a tick into one whole-store notify", async () => {
  const store = createStore<S>({ count: 0, name: "a" });
  let notifies = 0;
  store.subscribe(() => { notifies++; });
  store.setState({ count: 1 });
  store.setState({ count: 2 });
  store.setState({ name: "b" });
  assert.equal(notifies, 0, "no synchronous notify");
  await tick();
  assert.equal(notifies, 1, "collapsed into a single notification pass");
  assert.deepEqual(store.getState(), { count: 2, name: "b" });
});

test("mini-store: slice select fires only when the selected value changes", async () => {
  const store = createStore<S>({ count: 0, name: "a" });
  const seen: number[] = [];
  store.select((s) => s.count, (v) => seen.push(v));
  assert.deepEqual(seen, [0], "immediate initial value");
  store.setState({ name: "b" }); // unrelated slice
  await tick();
  assert.deepEqual(seen, [0], "name change does not fire the count slice");
  store.setState({ count: 7 });
  await tick();
  assert.deepEqual(seen, [0, 7]);
});

test("mini-store: functional updater and no-op guard", async () => {
  const store = createStore<S>({ count: 1, name: "a" });
  let notifies = 0;
  store.subscribe(() => { notifies++; });
  store.setState((prev) => ({ count: prev.count + 1 }));
  await tick();
  assert.equal(store.getState().count, 2);
  store.setState({ count: 2 }); // same value → no notify
  await tick();
  assert.equal(notifies, 1);
});

test("mini-store: unsubscribe and destroy stop notifications", async () => {
  const store = createStore<S>({ count: 0, name: "a" });
  let n = 0;
  const off = store.subscribe(() => { n++; });
  store.setState({ count: 1 });
  await tick();
  off();
  store.setState({ count: 2 });
  await tick();
  assert.equal(n, 1);
  store.destroy();
  store.setState({ count: 3 });
  await tick();
  assert.equal(store.getState().count, 2, "destroyed store ignores setState");
});
