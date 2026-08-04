import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRealityTransportController,
  type RealityTransportApplyStatus,
} from "../../web/src/reality_transport_controller.ts";
import type { RealityTransportBridge } from "../../mobile/bridge/reality_transport.ts";
import type { StructuredEndpoint } from "../src/endpoints.ts";

const DIRECT: StructuredEndpoint = {
  id: "de-direct",
  base: "https://greenchat.example",
  region: "de",
  transport: "direct",
  priority: 10,
  weight: 100,
};

const REALITY_A: StructuredEndpoint = {
  id: "ru-a",
  base: "https://bridge-a.greenchat.example",
  region: "ru",
  transport: "reality",
  priority: 20,
  weight: 100,
  reality: {
    host: "203.0.113.7",
    port: 8446,
    sni: "swcdn.apple.com",
    fingerprint: "chrome",
    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    short_id: "ab12cd34",
    uuid: "11111111-1111-4111-8111-111111111111",
    flow: "xtls-rprx-vision",
    credential_scope: "greenchat-only",
  },
};

const REALITY_B: StructuredEndpoint = {
  ...REALITY_A,
  id: "ru-b",
  base: "https://bridge-b.greenchat.example",
  reality: {
    ...REALITY_A.reality!,
    host: "203.0.113.8",
    uuid: "22222222-2222-4222-8222-222222222222",
  },
};

function config(...endpoints: StructuredEndpoint[]): unknown {
  return endpoints;
}

function fakeBridge(overrides: Partial<RealityTransportBridge> = {}): RealityTransportBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    availability: async () => ({ available: true, packaged: true, active: false, reason: null }),
    status: async () => ({ available: true, packaged: true, active: false, reason: null }),
    start: async (plan) => { calls.push(`start:${plan.routeIds.join(",")}`); },
    stop: async () => { calls.push("stop"); },
    ...overrides,
  };
}

async function status(promise: Promise<{ status: RealityTransportApplyStatus }>): Promise<RealityTransportApplyStatus> {
  return (await promise).status;
}

test("T-605 orchestration: a signed direct+REALITY set starts once; the same plan is unchanged", async () => {
  const bridge = fakeBridge();
  const controller = createRealityTransportController({ bridge });
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_A))), "active");
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_A))), "unchanged");
  assert.deepEqual(bridge.calls, ["start:ru-a"]);
});

test("T-605 orchestration: direct-only verified config stops the prior engine", async () => {
  const bridge = fakeBridge();
  const controller = createRealityTransportController({ bridge });
  await controller.applySignedEndpoints(config(DIRECT, REALITY_A));
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT))), "direct_only");
  assert.deepEqual(bridge.calls, ["start:ru-a", "stop"]);
});

test("T-605 orchestration: malformed candidate preserves the last verified engine", async () => {
  const bridge = fakeBridge();
  const controller = createRealityTransportController({ bridge });
  await controller.applySignedEndpoints(config(DIRECT, REALITY_A));
  const malformed = { ...REALITY_B, reality: { ...REALITY_B.reality!, uuid: "bad" } };
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, malformed))), "invalid_config");
  assert.deepEqual(bridge.calls, ["start:ru-a"], "invalid uncommitted config cannot remove the trusted route");
});

test("T-605 orchestration: overlapping verified plans serialize and never stack engines", async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let starts = 0;
  const bridge = fakeBridge({
    start: async (plan) => {
      bridge.calls.push(`start:${plan.routeIds.join(",")}`);
      starts += 1;
      if (starts === 1) {
        markFirstStarted();
        await firstGate;
      }
    },
  });
  const controller = createRealityTransportController({ bridge });
  const first = controller.applySignedEndpoints(config(DIRECT, REALITY_A));
  await firstStarted;
  const second = controller.applySignedEndpoints(config(DIRECT, REALITY_B));
  releaseFirst();
  assert.equal(await status(first), "active");
  assert.equal(await status(second), "active");
  assert.deepEqual(bridge.calls, ["start:ru-a", "stop", "start:ru-b"]);
});

test("T-605 orchestration: failed replacement restores the previous verified engine", async () => {
  let failB = true;
  const bridge = fakeBridge({
    start: async (plan) => {
      const id = plan.routeIds.join(",");
      bridge.calls.push(`start:${id}`);
      if (id === "ru-b" && failB) {
        failB = false;
        throw new Error("new engine failed");
      }
    },
  });
  const controller = createRealityTransportController({ bridge });
  await controller.applySignedEndpoints(config(DIRECT, REALITY_A));
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_B))), "failed");
  assert.deepEqual(bridge.calls, ["start:ru-a", "stop", "start:ru-b", "start:ru-a"],
    "rollback must restore the exact previous plan");
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_A))), "unchanged");
});

test("T-605 orchestration: explicit stop is a serialization barrier before a later plan", async () => {
  const bridge = fakeBridge();
  const controller = createRealityTransportController({ bridge });
  await controller.applySignedEndpoints(config(DIRECT, REALITY_A));
  const stopping = controller.stop();
  const newer = controller.applySignedEndpoints(config(DIRECT, REALITY_B));
  assert.equal(await status(stopping), "direct_only");
  assert.equal(await status(newer), "active");
  assert.deepEqual(bridge.calls, ["start:ru-a", "stop", "start:ru-b"]);
});

test("T-605 orchestration: web/iOS without the Android bridge never claims REALITY", async () => {
  const controller = createRealityTransportController({ bridge: null });
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT))), "direct_only");
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_A))), "unsupported");
});

test("T-605 orchestration: failed stop blocks replacement instead of stacking two engines", async () => {
  let stops = 0;
  const bridge = fakeBridge({
    stop: async () => {
      bridge.calls.push("stop");
      stops += 1;
      if (stops === 1) throw new Error("native clear failed");
    },
  });
  const controller = createRealityTransportController({ bridge });
  await controller.applySignedEndpoints(config(DIRECT, REALITY_A));
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_B))), "failed");
  assert.deepEqual(bridge.calls, ["start:ru-a", "stop"]);
  assert.equal(await status(controller.applySignedEndpoints(config(DIRECT, REALITY_B))), "active");
  assert.deepEqual(bridge.calls, ["start:ru-a", "stop", "stop", "start:ru-b"]);
});
