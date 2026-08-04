// clients/ui/test/support_status.test.ts — T-514 (MS-4 §3.1.3 / §14): the service-status model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import {
  serviceLevel, describeStatus, formatUptime, levelLabel, parseHealth,
  type StatusProbe,
} from "../src/screens/support_status.ts";

const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

function probe(over: Partial<StatusProbe> = {}): StatusProbe {
  return { online: true, health: { status: "up", uptime_sec: 3600 }, ws: "open", queued: 0, ...over };
}

test("serviceLevel: ok only when online + health up + ws open", () => {
  assert.equal(serviceLevel(probe()), "ok");
});

test("serviceLevel: degraded when server up but socket not open", () => {
  for (const ws of ["idle", "connecting", "reconnecting", "closed", "weird"]) {
    assert.equal(serviceLevel(probe({ ws })), "degraded", `ws=${ws}`);
  }
});

test("serviceLevel: down when offline, or health missing/not up", () => {
  assert.equal(serviceLevel(probe({ online: false })), "down");
  assert.equal(serviceLevel(probe({ health: null })), "down");
  assert.equal(serviceLevel(probe({ health: { status: "maintenance" } })), "down");
});

test("describeStatus: server/connection labels are localized and non-empty", () => {
  const ok = describeStatus(probe(), i18n);
  assert.equal(ok.level, "ok");
  assert.equal(ok.server, "доступен");
  assert.equal(ok.connection, "активно");

  const offline = describeStatus(probe({ online: false, health: null }), i18n);
  assert.equal(offline.level, "down");
  assert.equal(offline.server, "недоступен");
  assert.equal(offline.connection, "нет сети"); // offline short-circuits the ws line

  const reconnecting = describeStatus(probe({ ws: "reconnecting" }), i18n);
  assert.equal(reconnecting.connection, "переподключение");
  const closed = describeStatus(probe({ ws: "closed" }), i18n);
  assert.equal(closed.connection, "нет");
});

test("describeStatus: queued row appears only when the offline queue is non-empty", () => {
  assert.equal(describeStatus(probe({ queued: 0 }), i18n).queued, null);
  const q = describeStatus(probe({ queued: 3 }), i18n).queued;
  assert.ok(q && q.includes("3"), "queued line should carry the count");
});

test("describeStatus: uptime shown only when server is up and reported it", () => {
  assert.ok(describeStatus(probe({ health: { status: "up", uptime_sec: 90061 } }), i18n).uptime);
  assert.equal(describeStatus(probe({ health: { status: "up" } }), i18n).uptime, null);
  assert.equal(describeStatus(probe({ online: false, health: null }), i18n).uptime, null);
});

test("formatUptime: two largest units, minutes floor, localized suffixes", () => {
  assert.equal(formatUptime(0, i18n), "0м");
  assert.equal(formatUptime(59, i18n), "0м");
  assert.equal(formatUptime(60, i18n), "1м");
  assert.equal(formatUptime(3600, i18n), "1ч");
  assert.equal(formatUptime(3660, i18n), "1ч 1м");
  assert.equal(formatUptime(90061, i18n), "1д 1ч"); // 1d 1h 1m 1s → top two units
  assert.equal(formatUptime(-5, i18n), "0м");
});

test("levelLabel resolves a localized caption for every level", () => {
  for (const lvl of ["ok", "degraded", "down"] as const) {
    assert.ok(levelLabel(lvl, i18n) !== `status.level.${lvl}`, `missing label for ${lvl}`);
  }
});

test("parseHealth: unwraps the server {ok,result} envelope (the real wire shape)", () => {
  // Exactly what GET /health returns — the router wraps every handler in the envelope. Regression guard:
  // reading `.status` off the envelope root (undefined) pinned the status card to "down" forever.
  const wire = { ok: true, result: { status: "up", uptime_sec: 0, db: { size_bytes: 4096 }, counts: { users: 0 } } };
  assert.deepEqual(parseHealth(wire), { status: "up", uptime_sec: 0 });
  assert.equal(serviceLevel(probe({ health: parseHealth(wire) })), "ok");
});

test("parseHealth: also accepts a bare object (unwrapped self-host/proxy)", () => {
  assert.deepEqual(parseHealth({ status: "up", uptime_sec: 42 }), { status: "up", uptime_sec: 42 });
  // A non-object `result` is not an envelope → fall back to the bare root.
  assert.deepEqual(parseHealth({ result: "x", status: "up" }), { status: "up" });
});

test("parseHealth: omits uptime_sec unless it is a number (exactOptionalPropertyTypes)", () => {
  const noUptime = parseHealth({ ok: true, result: { status: "up" } });
  assert.deepEqual(noUptime, { status: "up" });
  assert.ok(noUptime && !("uptime_sec" in noUptime), "absent uptime must be an ABSENT key, never undefined");
  assert.deepEqual(parseHealth({ status: "up", uptime_sec: "60" }), { status: "up" }); // wrong type dropped
});

test("parseHealth: null for anything without a string status", () => {
  assert.equal(parseHealth(null), null);
  assert.equal(parseHealth(undefined), null);
  assert.equal(parseHealth("up"), null);
  assert.equal(parseHealth(42), null);
  assert.equal(parseHealth([]), null);
  assert.equal(parseHealth({ ok: false, error: { code: "X" } }), null); // error envelope → no status
  assert.equal(parseHealth({ result: { uptime_sec: 5 } }), null); // status missing
});
