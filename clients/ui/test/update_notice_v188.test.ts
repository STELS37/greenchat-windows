// V188 — optional update advice must be truthful, compact and easy to silence for one app run.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { PwaEnv, SwUpdateHandle } from "../src/pwa.ts";
import { installDomStub, StubNode } from "./dom_stub.ts";

installDomStub();

const { PwaController } = await import("../src/pwa.ts");
const { createI18n } = await import("../src/i18n.ts");
const { en } = await import("../src/locales/en.ts");
const { ru } = await import("../src/locales/ru.ts");

const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
const asHost = (node: StubNode): HTMLElement => node as unknown as HTMLElement;

function runtime(waiting = true): {
  env: PwaEnv;
  emitWaiting(): void;
  emitControllerChange(): void;
  activations(): number;
  reloads(): number;
} {
  let waitingCallback: (() => void) | null = null;
  let controllerCallback: (() => void) | null = null;
  let activationCount = 0;
  let reloadCount = 0;
  const handle: SwUpdateHandle = {
    hasWaiting: () => waiting,
    onWaiting: (cb) => { waitingCallback = cb; },
    activate: () => { activationCount += 1; },
  };
  const env: PwaEnv = {
    registerSW: async () => handle,
    onControllerChange: (cb) => { controllerCallback = cb; },
    reload: () => { reloadCount += 1; },
    setBadge: () => {},
    ua: () => "",
    maxTouchPoints: () => 0,
    matchStandalone: () => false,
    navigatorStandalone: () => undefined,
    storageGet: () => null,
    storageSet: () => {},
  };
  return {
    env,
    emitWaiting: () => waitingCallback?.(),
    emitControllerChange: () => controllerCallback?.(),
    activations: () => activationCount,
    reloads: () => reloadCount,
  };
}

test("PWA: waiting worker shows one compact notice and close silences it until the next app run", async () => {
  const host = new StubNode("body");
  const fake = runtime(true);
  const controller = new PwaController({ env: fake.env, i18n, host: asHost(host) });

  await controller.start();
  const notice = host.find((node) => node.hasClass("gc-update-notice"));
  assert.ok(notice, "a real waiting worker produces an update notice");
  assert.equal(notice!.attrs["role"], "status");
  assert.equal(notice!.attrs["aria-live"], "polite");
  assert.equal(notice!.attrs["aria-atomic"], "true");
  assert.ok(notice!.hasClass("gc-update-notice"), "PWA uses the compact startup notice variant");

  const close = notice!.find((node) => node.tag === "button" && node.hasClass("gc-update-notice-dismiss"));
  assert.ok(close, "optional update can be dismissed without accepting it");
  assert.equal(close!.attrs["aria-label"], "Закрыть");
  close!.click();
  assert.equal(host.find((node) => node.hasClass("gc-update-notice")), null);

  fake.emitWaiting();
  assert.equal(
    host.find((node) => node.hasClass("gc-update-notice")),
    null,
    "another updatefound callback in the same run must not nag after dismissal",
  );
});

test("PWA: update action activates the waiting worker and reloads only after controllerchange", async () => {
  const host = new StubNode("body");
  const fake = runtime(true);
  const controller = new PwaController({ env: fake.env, i18n, host: asHost(host) });

  await controller.start();
  const action = host.find((node) => node.tag === "button" && node.hasClass("gc-pwa-update-btn"));
  assert.ok(action);
  action!.click();
  assert.equal(action!.disabled, true, "double activation is blocked while the worker takes control");
  assert.equal(fake.activations(), 1);
  assert.equal(fake.reloads(), 0, "the current page stays intact until the new worker owns it");

  fake.emitControllerChange();
  assert.equal(fake.reloads(), 1);
  fake.emitControllerChange();
  assert.equal(fake.reloads(), 1, "one accepted update causes one reload");
});
