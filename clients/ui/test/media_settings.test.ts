import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountMediaSettings } from "../src/screens/media_settings.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("media settings reset immediately restores the account-neutral wifi default", async () => {
  const gate = deferred<Record<string, unknown>>();
  const settings = createAccountMediaSettings({ loadSettings: () => gate.promise });

  const load = settings.load();
  settings.reset();
  assert.equal(settings.policy(), "wifi");

  gate.resolve({ autodownload: "none" });
  await load;
  assert.equal(settings.policy(), "wifi", "a response owned by the signed-out account stays ignored");
});

test("a late account-A response cannot overwrite account B media policy", async () => {
  const a = deferred<Record<string, unknown>>();
  const b = deferred<Record<string, unknown>>();
  const queue = [a.promise, b.promise];
  const settings = createAccountMediaSettings({ loadSettings: () => queue.shift()! });

  const loadA = settings.load();
  settings.reset();
  const loadB = settings.load();

  b.resolve({ autodownload: "all" });
  await loadB;
  assert.equal(settings.policy(), "all");

  a.resolve({ autodownload: "none" });
  await loadA;
  assert.equal(settings.policy(), "all", "last account action, not last network completion, wins");
});

test("two loads in one account are latest-wins and stale completions do not run settled side effects", async () => {
  const first = deferred<Record<string, unknown>>();
  const second = deferred<Record<string, unknown>>();
  const queue = [first.promise, second.promise];
  let settled = 0;
  const settings = createAccountMediaSettings({
    loadSettings: () => queue.shift()!,
    onCurrentSettled: () => { settled += 1; },
  });

  const one = settings.load();
  const two = settings.load();
  second.resolve({ autodownload: "none" });
  await two;
  first.resolve({ autodownload: "all" });
  await one;

  assert.equal(settings.policy(), "none");
  assert.equal(settled, 1, "only the current load may apply cache-limit side effects");
});

test("current load failure keeps the default and still runs the current settled hook", async () => {
  let settled = 0;
  const settings = createAccountMediaSettings({
    loadSettings: () => Promise.reject(new Error("offline")),
    onCurrentSettled: () => { settled += 1; },
  });

  await settings.load();
  assert.equal(settings.policy(), "wifi");
  assert.equal(settled, 1);
});
