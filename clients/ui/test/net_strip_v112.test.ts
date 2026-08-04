import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import {
  CONNECTION_NOTICE_DELAY_MS,
  createNetStrip,
  netLevel,
  netPhase,
  type NetSample,
} from "../src/screens/net_strip.ts";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

test("connection health uses aggregate delivery rather than raw WebSocket state", () => {
  assert.equal(netLevel({ online: false, ws: "open" }), "offline");
  assert.equal(netLevel({ online: true, ws: "open" }), "online");

  for (const ws of ["idle", "connecting", "reconnecting", "closed"]) {
    assert.equal(netLevel({ online: true, ws, delivery: "fallback" }), "online", `${ws}: fallback works`);
    assert.equal(netLevel({ online: true, ws, delivery: "unavailable" }), "reconnecting", `${ws}: both failed`);
    assert.equal(netLevel({ online: true, ws }), "reconnecting", `${ws}: unknown delivery`);
  }
});

test("brief mobile network transitions stay silent and recovery never shows a success banner", () => {
  for (const level of ["offline", "reconnecting"] as const) {
    assert.equal(netPhase({ level, heldMs: 0 }), "hidden");
    assert.equal(netPhase({ level, heldMs: CONNECTION_NOTICE_DELAY_MS - 1 }), "hidden");
    assert.equal(netPhase({ level, heldMs: CONNECTION_NOTICE_DELAY_MS }), "connecting");
  }
  assert.equal(netPhase({ level: "online", heldMs: 0 }), "hidden");
  assert.equal(netPhase({ level: "online", heldMs: 60_000 }), "hidden");
});

test("offline to reconnecting is one continuous degraded interval", () => {
  installDomStub();
  const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
  let now = 1_000_000;
  let sample: NetSample = { online: true, ws: "open", delivery: "websocket" };
  let tick: (() => void) | null = null;
  const strip = createNetStrip({
    i18n,
    sample: () => sample,
    now: () => now,
    schedule: (fn) => { tick = fn; return 1; },
    cancel: () => { tick = null; },
  });
  const attrs = (strip.root as unknown as StubNode).attrs;

  assert.equal(strip.phase(), "hidden");
  assert.equal(strip.root.hidden, true);
  assert.equal(attrs["role"], "status");
  assert.equal(attrs["aria-live"], "polite");
  assert.equal(attrs["aria-atomic"], "true");

  // A radio hand-off starts offline, then the socket rebuilds. There was no healthy interval between
  // them, so the five-second clock must continue rather than restart or flash immediately.
  sample = { online: false, ws: "closed", delivery: "unavailable" };
  strip.refresh();
  now += 2_000;
  strip.refresh();
  assert.equal(strip.phase(), "hidden");

  sample = { online: true, ws: "connecting", delivery: "unavailable" };
  now += CONNECTION_NOTICE_DELAY_MS - 2_001;
  strip.refresh();
  assert.equal(strip.phase(), "hidden");

  now += 1;
  strip.refresh();
  assert.equal(strip.phase(), "connecting");
  assert.equal(strip.root.hidden, false);
  assert.equal(attrs["data-phase"], "connecting");
  assert.equal(strip.root.textContent, "Подключение…");

  // Recovery is quiet and immediate: no green “restored” phase after every routine reconnect.
  sample = { online: true, ws: "open", delivery: "websocket" };
  strip.refresh();
  assert.equal(strip.phase(), "hidden");
  assert.equal(strip.root.hidden, true);
  assert.equal(strip.root.textContent, "");

  assert.equal(typeof tick, "function");
  strip.destroy();
  assert.equal(tick, null);
});

test("a broken status port is surfaced to the shell instead of inventing an outage", () => {
  installDomStub();
  const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
  assert.throws(
    () => createNetStrip({ i18n, sample: () => { throw new Error("port exploded"); }, schedule: () => 1, cancel: () => {} }),
    /port exploded/,
  );
});

test("the shell mounts a compact neutral connecting status with one wording", () => {
  const netStrip = read("../src/screens/net_strip.ts");
  const app = read("../src/screens/app.ts");
  const redesign = read("../../web/src/redesign.css");

  assert.equal(netStrip.includes('i18n.t("net.reconnecting")'), true);
  assert.equal(ru["net.reconnecting"], "Подключение…");
  assert.equal(en["net.reconnecting"], "Connecting…");
  assert.equal("net.offline" in ru, false);
  assert.equal("net.restored" in ru, false);
  assert.equal("net.offline" in en, false);
  assert.equal("net.restored" in en, false);

  assert.match(app, /createNetStrip\(/);
  assert.match(app, /netStrip\.root, stageBody/);
  assert.match(app, /netStrip\?\.destroy\(\)/);
  assert.match(app, /listen\(globalThis, "offline"\)/);

  const start = redesign.indexOf(".gc-net-strip {");
  const end = redesign.indexOf(".gc-net-strip[hidden]", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const rule = redesign.slice(start, end);
  assert.match(rule, /position:\s*sticky/);
  assert.match(rule, /min-height:\s*24px/);
  assert.match(rule, /color:\s*var\(--gc-accent\)/);
  assert.doesNotMatch(rule, /#b45309|color:\s*#fff/);
  assert.doesNotMatch(redesign, /gc-net-strip-spin|data-phase="offline"|data-phase="restored"/);

  const MQ = "@media (prefers-reduced-motion: reduce)";
  const reducedBlocks: string[] = [];
  for (let i = redesign.indexOf(MQ); i >= 0; i = redesign.indexOf(MQ, i + 1)) {
    let depth = 0;
    let endAt = redesign.indexOf("{", i);
    for (let j = endAt; j < redesign.length; j++) {
      if (redesign[j] === "{") depth++;
      else if (redesign[j] === "}" && --depth === 0) { endAt = j; break; }
    }
    reducedBlocks.push(redesign.slice(i, endAt + 1));
  }
  assert.equal(reducedBlocks.some((b) => b.includes(".gc-net-strip") && /animation:\s*none/.test(b)), true);
});
