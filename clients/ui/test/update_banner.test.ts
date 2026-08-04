// T-413 (client half) — DOM contract of the APK update surfaces, red-first:
//   verdict 'update' (манифест latest>current) ⇒ the dismissible banner IS VISIBLE in the host,
//     names the offered version, and the primary button hands the artifact url to the shell;
//   «Позже» ⇒ the banner leaves the tree for the rest of THIS run (session-dismissal is in-memory
//     by construction — the check runs once per boot and nothing is persisted);
//   verdict 'force' ⇒ the BLOCKING screen (alertdialog) with no dismiss affordance at all;
//   verdict 'latest' / null ⇒ nothing is ever mounted.
// StubNode pattern per clients/ui/test/auth_screen.test.ts (+ remove(), which the banner uses).
import { test } from "node:test";
import assert from "node:assert/strict";

import { installDomStub, StubNode } from "./dom_stub.ts";

// The DOM model is the SHARED stub (./dom_stub.ts), not a private copy. This file used to carry its
// own 60-line StubNode, and that copy silently lacked `ownerDocument` — a property every real element
// has. The moment the force screen started managing focus (V152) the missing property turned into a
// TypeError here, i.e. the harness, not the product, was deciding the verdict. The shared stub also
// models activeElement, so "the blocking screen owns the keyboard" is measurable at all.
installDomStub();

// Imported AFTER the document stub exists (el() only touches it at call time anyway).
const { presentUpdateStatus } = await import("../src/update_banner.ts");
const { createI18n } = await import("../src/i18n.ts");
const { en } = await import("../src/locales/en.ts");
const { ru } = await import("../src/locales/ru.ts");

const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

function newHost(): StubNode {
  return new StubNode("body");
}
const asHost = (n: StubNode): HTMLElement => n as unknown as HTMLElement;

const UPDATE = {
  state: "update" as const,
  latest: "1.2.0",
  url: "http://127.0.0.1:19173/v1/client/updates/artifact/gc-1.2.0.apk",
  sha256: "ab12cd34",
  minSupported: "1.0.0",
};

test("манифест с latest>current ⇒ баннер виден, называет версию, «Обновить» отдаёт url шеллу", () => {
  const host = newHost();
  const opened: string[] = [];
  const handle = presentUpdateStatus(UPDATE, {
    i18n,
    host: asHost(host),
    current: "1.1.0",
    openUrl: (u) => opened.push(u),
  });
  assert.ok(handle, "verdict 'update' must mount a surface");
  const banner = host.find((n) => (n.attrs["class"] ?? "").includes("gc-update-banner"));
  assert.ok(banner, "the banner is in the host tree (visible)");
  assert.ok(banner!.textContent.includes("1.2.0"), "the offered version is named");
  assert.equal(banner!.attrs["role"], "status");
  assert.equal(banner!.attrs["aria-atomic"], "true", "assistive technology announces the compact notice as one message");
  assert.ok(banner!.hasClass("gc-update-notice"), "optional update uses the shared compact notice chrome");
  assert.ok(banner!.hasClass("gc-update-banner"), "native update keeps its shell-specific hook");

  const update = banner!.find((n) => n.tag === "button" && (n.attrs["class"] ?? "").includes("gc-update-banner-btn"));
  assert.ok(update, "primary action present");
  update!.click();
  assert.deepEqual(opened, [UPDATE.url], "tap hands the MANIFEST url to the shell — nothing is downloaded by the web layer");
  assert.ok(host.find((n) => (n.attrs["class"] ?? "").includes("gc-update-banner")), "banner stays until dismissed (browser takes over the download)");
});

test("«Позже» убирает баннер на эту сессию", () => {
  const host = newHost();
  presentUpdateStatus(UPDATE, { i18n, host: asHost(host), current: "1.1.0", openUrl: () => {} });
  const later = host.find((n) => n.tag === "button" && (n.attrs["class"] ?? "").includes("gc-update-banner-later"));
  assert.ok(later, "dismiss affordance present on the OPTIONAL banner");
  assert.equal(later!.attrs["aria-label"], "Позже", "icon-only dismiss remains named for assistive technology");
  assert.equal(later!.textContent, "", "the compact card does not spend a second visible action on «Позже»");
  later!.click();
  assert.equal(host.find((n) => (n.attrs["class"] ?? "").includes("gc-update-banner")), null, "dismissed banner leaves the tree");
});

test("verdict 'force' ⇒ блокирующий экран без «Позже»", () => {
  const host = newHost();
  const opened: string[] = [];
  const handle = presentUpdateStatus(
    { ...UPDATE, state: "force" as const },
    { i18n, host: asHost(host), current: "0.9.0", openUrl: (u) => opened.push(u) },
  );
  assert.ok(handle);
  const screen = host.find((n) => (n.attrs["class"] ?? "").includes("gc-update-force"));
  assert.ok(screen, "blocking screen mounted");
  assert.equal(screen!.attrs["role"], "alertdialog");
  assert.equal(screen!.attrs["aria-modal"], "true");
  assert.ok(screen!.textContent.includes("0.9.0"), "names the unsupported current version");
  assert.ok(screen!.textContent.includes("1.2.0"), "names the version to install");
  assert.equal(
    screen!.find((n) => n.tag === "button" && (n.attrs["class"] ?? "").includes("later")),
    null,
    "a FORCE screen has no dismiss",
  );
  const go = screen!.find((n) => n.tag === "button");
  assert.ok(go, "the only way forward is the download action");
  go!.click();
  assert.deepEqual(opened, [UPDATE.url]);
  assert.ok(host.find((n) => (n.attrs["class"] ?? "").includes("gc-update-force")), "force screen NEVER leaves on tap — only a successful install/relaunch clears it");
});

test("verdict 'latest' и null ⇒ ничего не монтируется", () => {
  const host = newHost();
  assert.equal(presentUpdateStatus({ state: "latest" }, { i18n, host: asHost(host), current: "1.2.0", openUrl: () => {} }), null);
  assert.equal(presentUpdateStatus(null, { i18n, host: asHost(host), current: "1.2.0", openUrl: () => {} }), null);
  assert.equal(host.children.length, 0, "nothing mounted for an up-to-date build");
});

test("локали: en-словарь тоже содержит все update.* ключи (fallback не маскирует пропуск)", () => {
  for (const key of ["update.available", "update.action", "update.later", "update.forceTitle", "update.forceBody", "update.forceAction", "update.downloadHint"]) {
    assert.equal(typeof (ru as Record<string, string>)[key], "string", `ru missing ${key}`);
    assert.equal(typeof (en as Record<string, string>)[key], "string", `en missing ${key}`);
  }
});
