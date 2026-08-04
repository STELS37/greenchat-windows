import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerClock } from "../src/server_clock.ts";

test("ServerClock derives offset from the request midpoint and exposes corrected time", () => {
  let localMs = 1_000_400;
  const clock = new ServerClock(() => localMs);
  // Request travelled from local 1000.0s to 1000.4s; server answered at 1120.2s.
  clock.update(1120.2, 1_000_000, 1_000_400);
  assert.equal(clock.offsetSec(), 120);
  assert.equal(clock.nowSec(), 1120.4);

  localMs = 1_001_000;
  assert.equal(clock.nowSec(), 1121);
});

test("ServerClock ignores malformed server timestamps and keeps the previous offset", () => {
  const clock = new ServerClock(() => 10_000);
  clock.update(20, 9_000, 11_000);
  assert.equal(clock.offsetSec(), 10);
  clock.update(Number.NaN, 12_000, 13_000);
  assert.equal(clock.offsetSec(), 10);
});
