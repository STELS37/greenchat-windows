import { test } from "node:test";
import assert from "node:assert/strict";
import { finishDuressTeardown } from "../../web/src/duress_teardown.ts";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("T-526 teardown never navigates before bounded revoke/signal network work settles", async () => {
  const network = deferred<void>();
  let navigated = false;
  const run = finishDuressTeardown(Promise.resolve(), network.promise, () => { navigated = true; });

  await Promise.resolve();
  assert.equal(navigated, false, "auth gate may rerender, but hard navigation must not cancel revoke_all");
  network.resolve();
  await run;
  assert.equal(navigated, true);
});

test("T-526 teardown still navigates after local or network failure", async () => {
  for (const [local, network] of [
    [Promise.reject(new Error("local")), Promise.resolve()],
    [Promise.resolve(), Promise.reject(new Error("offline"))],
    [Promise.reject(new Error("local")), Promise.reject(new Error("offline"))],
  ] as const) {
    let count = 0;
    await assert.doesNotReject(() => finishDuressTeardown(local, network, () => { count += 1; }));
    assert.equal(count, 1);
  }
});
