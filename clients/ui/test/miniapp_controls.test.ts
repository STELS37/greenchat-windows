import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMiniAppControlMessage,
  DEFAULT_MINI_APP_CONTROLS,
  parseMiniAppBridgeMessage,
  type MiniAppControlsState,
} from "../src/screens/miniapps_model.ts";

function fresh(): MiniAppControlsState {
  return {
    main: { ...DEFAULT_MINI_APP_CONTROLS.main },
    backVisible: false,
    settingsVisible: false,
  };
}

test("Mini App system controls accept only exact bounded payloads", () => {
  const main = applyMiniAppControlMessage(fresh(), "setMainButton", {
    visible: true,
    text: "  Pay securely  ",
    enabled: true,
    loading: false,
  });
  assert.deepEqual(main?.main, {
    visible: true,
    text: "Pay securely",
    enabled: true,
    loading: false,
  });

  assert.equal(applyMiniAppControlMessage(fresh(), "setMainButton", {
    visible: true,
    text: "",
    enabled: true,
    loading: false,
  }), null, "a visible main button cannot be blank");
  assert.equal(applyMiniAppControlMessage(fresh(), "setMainButton", {
    visible: false,
    text: "",
    enabled: true,
    loading: false,
    extra: true,
  }), null, "unknown fields are rejected rather than ignored");
  assert.equal(applyMiniAppControlMessage(fresh(), "setMainButton", {
    visible: true,
    text: "x".repeat(65),
    enabled: true,
    loading: false,
  }), null, "labels are bounded by Unicode code points");
  assert.equal(applyMiniAppControlMessage(fresh(), "setMainButton", {
    visible: true,
    text: "Pay\nnow",
    enabled: true,
    loading: false,
  }), null, "control characters are rejected");
});

test("Back and settings controls are independent immutable reductions", () => {
  const start = fresh();
  const withBack = applyMiniAppControlMessage(start, "setBackButton", { visible: true });
  assert.ok(withBack);
  assert.equal(withBack.backVisible, true);
  assert.equal(withBack.settingsVisible, false);
  assert.equal(start.backVisible, false, "the reducer never mutates the caller state");

  const withSettings = applyMiniAppControlMessage(withBack, "setSettingsButton", { visible: true });
  assert.equal(withSettings?.backVisible, true);
  assert.equal(withSettings?.settingsVisible, true);
  assert.equal(applyMiniAppControlMessage(start, "setBackButton", { visible: true, extra: 1 }), null);
});

test("Bridge parser exposes the three system-control methods and rejects invented ones", () => {
  for (const method of ["setMainButton", "setBackButton", "setSettingsButton"] as const) {
    const parsed = parseMiniAppBridgeMessage({
      type: "greenchat:miniapp",
      version: 1,
      id: `req-${method}`,
      method,
      payload: { visible: false },
    });
    assert.equal(parsed?.method, method);
  }
  assert.equal(parseMiniAppBridgeMessage({
    type: "greenchat:miniapp",
    version: 1,
    id: "req-bad",
    method: "setWalletButton",
  }), null);
});
