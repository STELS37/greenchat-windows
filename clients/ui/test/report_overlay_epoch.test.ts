import { test } from "node:test";
import assert from "node:assert/strict";
import { createReportOverlayEpoch } from "../src/screens/report_overlay_epoch.ts";

test("closing a report overlay invalidates its pending search or submit", () => {
  const epoch = createReportOverlayEpoch();
  const token = epoch.begin()!;
  assert.equal(epoch.close(), true);
  assert.equal(epoch.isCurrent(token), false);
});

test("a closed report overlay cannot start another operation", () => {
  const epoch = createReportOverlayEpoch();
  epoch.close();
  assert.equal(epoch.begin(), null);
});

test("report overlay close is idempotent so onClose fires once", () => {
  const epoch = createReportOverlayEpoch();
  assert.equal(epoch.close(), true);
  assert.equal(epoch.close(), false);
});
