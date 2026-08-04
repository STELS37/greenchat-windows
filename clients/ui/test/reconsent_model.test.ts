// reconsent_model.ts — account-epoch, runtime-contract and fail-open classification tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLegalGate, parseLegalStatus } from "../src/screens/reconsent_model.ts";
import type { ApiLike, LegalStatus } from "../src/screens/api.ts";

function fakeApi(handler: () => unknown | Promise<unknown>): { api: ApiLike; calls: () => number } {
  let calls = 0;
  const api = {
    get<T>(path: string): Promise<T> {
      assert.equal(path, "/v1/legal/status");
      calls++;
      return Promise.resolve().then(handler).then((value) => value as T);
    },
    post<T>(): Promise<T> { throw new Error("unexpected"); },
    put<T>(): Promise<T> { throw new Error("unexpected"); },
    patch<T>(): Promise<T> { throw new Error("unexpected"); },
    delete<T>(): Promise<T> { throw new Error("unexpected"); },
    refreshTokens: () => Promise.resolve(true),
  } satisfies ApiLike;
  return { api, calls: () => calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const apiErr = (code: string, httpStatus: number) =>
  Object.assign(new Error(code), { name: "ApiError", code, httpStatus, data: {} });
const OWED: LegalStatus = { accepted_version: 1, current_version: 2, reconsent_required: true };
const CLEAR: LegalStatus = { accepted_version: 2, current_version: 2, reconsent_required: false };

test("parseLegalStatus accepts only a logically consistent exact wire contract", () => {
  assert.deepEqual(parseLegalStatus(OWED), OWED);
  assert.deepEqual(
    parseLegalStatus({ accepted_version: null, current_version: 2, reconsent_required: true }),
    { accepted_version: null, current_version: 2, reconsent_required: true },
  );
  for (const malformed of [
    null,
    [],
    {},
    { accepted_version: 1, current_version: 2 },
    { accepted_version: 1, current_version: 2, reconsent_required: false },
    { accepted_version: 3, current_version: 2, reconsent_required: false },
    { accepted_version: 1.5, current_version: 2, reconsent_required: true },
    { accepted_version: 1, current_version: 0, reconsent_required: true },
  ]) {
    assert.throws(() => parseLegalStatus(malformed), /legal status payload/);
  }
});

test("check(): owed status closes the gate and an identical repeat stays silent", async () => {
  const { api } = fakeApi(() => OWED);
  const gate = createLegalGate({ api });
  let emits = 0;
  gate.subscribe(() => emits++);
  assert.equal(gate.blocking(), null);
  assert.equal(gate.failure(), null);
  await gate.check();
  assert.deepEqual(gate.blocking(), OWED);
  assert.equal(emits, 1);
  await gate.check();
  assert.equal(emits, 1);
});

test("check() is single-flight within one account epoch", async () => {
  const { api, calls } = fakeApi(() => CLEAR);
  const gate = createLegalGate({ api });
  await Promise.all([gate.check(), gate.check(), gate.check()]);
  assert.equal(calls(), 1);
});

test("reset invalidates a previous account response and its finally cannot clear the new inflight", async () => {
  const oldAccount = deferred<LegalStatus>();
  const newAccount = deferred<LegalStatus>();
  let calls = 0;
  const { api } = fakeApi(() => {
    calls++;
    if (calls === 1) return oldAccount.promise;
    if (calls === 2) return newAccount.promise;
    throw new Error("unexpected third status request");
  });
  const gate = createLegalGate({ api });

  const oldCheck = gate.check();
  gate.reset();
  const currentCheck = gate.check();
  assert.equal(gate.check(), currentCheck, "new-account check remains single-flight");

  oldAccount.resolve(OWED);
  await oldCheck;
  assert.equal(gate.blocking(), null, "old account cannot block the new account");
  assert.equal(gate.failure(), null);
  assert.equal(gate.check(), currentCheck, "old finally did not erase the current inflight");
  assert.equal(calls, 2);

  newAccount.resolve(CLEAR);
  await currentCheck;
  assert.equal(gate.blocking(), null);
  assert.equal(gate.failure(), null);
});

test("network and 5xx are fail-open, while non-transient 4xx becomes a blocking failure", async () => {
  for (const transient of [
    Object.assign(new Error("offline"), { name: "NetworkError" }),
    apiErr("SERVER_ERROR", 503),
  ]) {
    const gate = createLegalGate({ api: fakeApi(() => { throw transient; }).api });
    await gate.check();
    assert.equal(gate.blocking(), null);
    assert.equal(gate.failure(), null);
  }

  const fatal = createLegalGate({ api: fakeApi(() => { throw apiErr("VALIDATION_FAILED", 400); }).api });
  let emits = 0;
  fatal.subscribe(() => emits++);
  await fatal.check();
  assert.equal(fatal.blocking(), null);
  assert.ok(fatal.failure());
  assert.equal(emits, 1);
});

test("malformed successful payload blocks until a valid retry clears the failure", async () => {
  let attempt = 0;
  const { api } = fakeApi(() => ++attempt === 1
    ? { current_version: 2 }
    : CLEAR);
  const gate = createLegalGate({ api });
  await gate.check();
  assert.ok(gate.failure());
  await gate.check();
  assert.equal(gate.failure(), null);
  assert.equal(gate.blocking(), null);
});

test("markAccepted opens the gate; reset forgets account state silently", async () => {
  const { api } = fakeApi(() => OWED);
  const gate = createLegalGate({ api });
  await gate.check();
  let emits = 0;
  gate.subscribe(() => emits++);
  gate.markAccepted();
  assert.equal(gate.blocking(), null);
  assert.equal(emits, 1);
  gate.markAccepted();
  assert.equal(emits, 1);
  await gate.check();
  assert.deepEqual(gate.blocking(), OWED);
  gate.reset();
  assert.equal(gate.blocking(), null);
  assert.equal(gate.failure(), null);
  assert.equal(emits, 2);
});

test("a later probe with a newer edition re-emits", async () => {
  let version = 2;
  const { api } = fakeApi(() => ({ accepted_version: 1, current_version: version, reconsent_required: true }));
  const gate = createLegalGate({ api });
  let emits = 0;
  gate.subscribe(() => emits++);
  await gate.check();
  version = 3;
  await gate.check();
  assert.equal(emits, 2);
  assert.equal(gate.blocking()?.current_version, 3);
});
