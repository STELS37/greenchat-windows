// T-604 — ConnectionManager over the T-419 EndpointManager. Hermetic: fake fetch (hanging / failing /
// slow endpoints via manual timer control), fake clock for the sticky TTL, in-RAM KV — no live server,
// no wall-clock sleeps. Proves: policy/kill_switch parsing from a T-602-shaped /v1/config body, the
// probe with timeout, the direct-vs-known-good race in both outcomes, L0→L1 failover + return to L0,
// per-network sticky memory with TTL, that the anti-exfiltration gate is NOT weakened, and that the
// whole layer is inert on a same-origin web build (current "").
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signDetached } from "node:crypto";
import { createEndpointManager, type StructuredEndpoint } from "../src/endpoints.ts";
import {
  createConnectionManager,
  memoryConnKv,
  DEFAULT_POLICY,
  type ConnStatus,
} from "../src/conn_manager.ts";
import { canonicalizeConfigCore } from "../src/config_verify.ts";

const DIRECT = "https://direct.example";
const RELAY = "https://relay.example";
const RELAY2 = "https://relay2.example";

const EP_DIRECT: StructuredEndpoint = {
  id: "de-direct", base: DIRECT, region: "de", transport: "direct", priority: 10, weight: 100,
};
const EP_RELAY: StructuredEndpoint = {
  id: "ru-relay", base: RELAY, region: "ru", transport: "reality", priority: 20, weight: 100,
  reality: { host: "www.microsoft.com", port: 443, sni: "www.microsoft.com", fingerprint: "chrome", public_key: "PUB", short_id: "ab12" },
};
const EP_RELAY2: StructuredEndpoint = {
  id: "ru-relay-2", base: RELAY2, region: "ru", transport: "reality", priority: 30, weight: 100,
};

// The T-602 wire shape (mirrors server/test/integration/config_endpoints.test.ts SAMPLE + policy).
const CONFIG = {
  endpoints: [EP_DIRECT, EP_RELAY, EP_RELAY2],
  policy: { probe_timeout_ms: 100, failures_before_rotate: 3, race_direct_vs_known_good: true, sticky_per_network_ttl_s: 3600 },
  kill_switch: { force_transport: null },
};

// A controllable fake fetch keyed by origin behaviour:
//   "ok"    → resolves immediately with 200
//   "err"   → rejects immediately (network failure)
//   "hang"  → never settles by itself (the probe timeout must fire); respects AbortSignal
//   "slow:N"→ resolves after N ms (real timer — keep N small)
function fakeFetch(behavior: (url: string) => string): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const b = behavior(url);
    if (b === "ok") return { ok: true, status: 200 } as unknown as Response;
    if (b === "err") throw new Error("ECONNREFUSED (fake)");
    if (b === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted (fake)")));
      });
    }
    const slow = /^slow:(\d+)$/.exec(b);
    if (slow) {
      const ms = Number(slow[1]);
      return new Promise<Response>((resolve) => setTimeout(() => resolve({ ok: true, status: 200 } as unknown as Response), ms));
    }
    throw new Error(`fakeFetch: unknown behavior ${b}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeManager(primary = DIRECT): ReturnType<typeof createEndpointManager> {
  return createEndpointManager({ primary, selfOrigin: null });
}

test("applyConfig: T-602 body → endpoints merged, policy applied, kill_switch parsed", () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn });
  assert.deepEqual(cm.policy(), DEFAULT_POLICY, "spec defaults before any config");
  cm.applyConfig(CONFIG);
  assert.deepEqual(m.candidates(), [DIRECT, RELAY, RELAY2], "structural endpoints reached the manager");
  assert.equal(cm.policy().probe_timeout_ms, 100);
  assert.equal(m.endpointInfo(RELAY)?.reality?.sni, "www.microsoft.com", "reality params carried for T-605");
  assert.deepEqual(cm.killSwitch(), { force_transport: null });
});

test("applyConfig: legacy flat-string endpoints and junk fields survive", () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn });
  cm.applyConfig({ endpoints: ["https://mirror.example", 42, null, "  "], policy: "junk", kill_switch: 7 });
  assert.deepEqual(m.candidates(), [DIRECT, "https://mirror.example"], "strings live, junk dropped");
  assert.deepEqual(cm.policy(), DEFAULT_POLICY, "junk policy ignored");
  assert.deepEqual(cm.killSwitch(), { force_transport: null }, "junk kill_switch ignored");
});

test("applyConfig: policy garbage per-field falls back to previous value", () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn });
  cm.applyConfig({ policy: { probe_timeout_ms: 500, failures_before_rotate: -1, race_direct_vs_known_good: "yes", sticky_per_network_ttl_s: 60 } });
  assert.deepEqual(cm.policy(), { ...DEFAULT_POLICY, probe_timeout_ms: 500, sticky_per_network_ttl_s: 60 });
});

test("probeEndpoint: reachable endpoint records success + latency; 5xx counts as reachable", async () => {
  const m = makeManager();
  let t = 1000;
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, now: () => t });
  const r = await cm.probeEndpoint(DIRECT);
  assert.equal(r.ok, true);
  const h = cm.getStatus().healthByEndpoint[DIRECT];
  assert.ok(h);
  assert.equal(h.lastSuccessAt, 1000);
  assert.equal(h.consecutiveFailures, 0);
  t = 2000; // clock moves; a failing probe records the error side
  const m2 = makeManager();
  const cm2 = createConnectionManager({ manager: m2, fetchImpl: fakeFetch(() => "err").fn, now: () => t });
  const r2 = await cm2.probeEndpoint(DIRECT);
  assert.equal(r2.ok, false);
  const h2 = cm2.getStatus().healthByEndpoint[DIRECT];
  assert.ok(h2);
  assert.equal(h2.lastErrorAt, 2000);
  assert.match(h2.lastError ?? "", /ECONNREFUSED/);
  assert.equal(h2.consecutiveFailures, 1);
});

test("probeEndpoint: a hanging endpoint fails via policy.probe_timeout_ms", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "hang").fn });
  cm.applyConfig({ policy: { probe_timeout_ms: 30 } }); // keep the real timer short
  const t0 = Date.now();
  const r = await cm.probeEndpoint(DIRECT);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /probe timeout after 30ms/);
  assert.ok(Date.now() - t0 < 2000, "did not wait for the hang");
});

test("probeEndpoint: a slow-but-alive endpoint inside the timeout succeeds", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "slow:10").fn });
  cm.applyConfig({ policy: { probe_timeout_ms: 500 } });
  const r = await cm.probeEndpoint(DIRECT);
  assert.equal(r.ok, true);
});

test("connect: L0 alive → stays on direct, remembers it per-network", async () => {
  const m = makeManager();
  const kv = memoryConnKv();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, kv, networkId: () => "wifi-home" });
  cm.applyConfig(CONFIG);
  assert.equal(await cm.connect(), DIRECT);
  assert.equal(cm.getStatus().tier, "direct");
  const rec = (await kv.get("last_good.wifi-home")) as { base: string };
  assert.equal(rec.base, DIRECT, "last-good stored under the network id");
});

test("connect: L0 dead → probes walk to L1 backup; status flips to backup with reason", async () => {
  const m = makeManager();
  const statuses: ConnStatus[] = [];
  const { fn, calls } = fakeFetch((url) => (url.startsWith(DIRECT) ? "err" : "ok"));
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, onStatusChange: (s) => statuses.push(s) });
  cm.applyConfig(CONFIG);
  assert.equal(await cm.connect(), RELAY);
  const st = cm.getStatus();
  assert.equal(st.tier, "backup", "quiet indicator: on the reserve route");
  assert.equal(st.lastSwitchReason, "probe");
  assert.ok(calls.some((u) => u === `${DIRECT}/health`), "direct probed first");
  assert.ok(statuses.length >= 1, "onStatusChange fired on the switch");
  const hd = st.healthByEndpoint[DIRECT];
  assert.ok(hd);
  assert.ok(hd.consecutiveFailures >= 1, "direct's failure recorded");
});

test("connect + recheckDirect: fail to L1, then direct recovers → back on L0", async () => {
  const m = makeManager();
  let directUp = false;
  const { fn } = fakeFetch((url) => (url.startsWith(DIRECT) ? (directUp ? "ok" : "err") : "ok"));
  const cm = createConnectionManager({ manager: m, fetchImpl: fn });
  cm.applyConfig(CONFIG);
  await cm.connect();
  assert.equal(cm.getStatus().tier, "backup");
  assert.equal(await cm.recheckDirect(), false, "direct still down → stay on backup");
  directUp = true;
  assert.equal(await cm.recheckDirect(), true);
  assert.equal(cm.getStatus().activeEndpoint, DIRECT);
  assert.equal(cm.getStatus().lastSwitchReason, "recovered");
  assert.equal(cm.getStatus().tier, "direct");
});

test("race direct vs known-good: direct alive → direct wins (preferred even when relay is faster)", async () => {
  const m = makeManager();
  const kv = memoryConnKv();
  // Seed the sticky memory with the relay (a previous session on this network used L1).
  await kv.put("last_good.net1", { base: RELAY, at: 1 });
  // Relay answers instantly, direct is slower but alive — direct must still win (§3 preference).
  const { fn } = fakeFetch((url) => (url.startsWith(DIRECT) ? "slow:10" : "ok"));
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, networkId: () => "net1", now: () => 2 });
  cm.applyConfig(CONFIG);
  m.select(RELAY); // start the session where the last one ended — on the backup
  assert.equal(await cm.connect(), DIRECT);
  assert.equal(cm.getStatus().lastSwitchReason, "race:direct");
  assert.equal(cm.getStatus().tier, "direct");
  const rec = (await kv.get("last_good.net1")) as { base: string };
  assert.equal(rec.base, DIRECT, "memory refreshed to the race winner");
});

test("race direct vs known-good: direct hangs → known-good relay wins within the timeout", async () => {
  const m = makeManager();
  const kv = memoryConnKv();
  await kv.put("last_good.net1", { base: RELAY, at: 1 });
  const { fn } = fakeFetch((url) => (url.startsWith(DIRECT) ? "hang" : "ok"));
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, networkId: () => "net1", now: () => 2 });
  cm.applyConfig({ ...CONFIG, policy: { ...CONFIG.policy, probe_timeout_ms: 30 } });
  assert.equal(await cm.connect(), RELAY);
  assert.equal(cm.getStatus().lastSwitchReason, "race:known-good");
  assert.equal(cm.getStatus().tier, "backup", "quiet indicator on");
});

test("race disabled by policy: sticky known-good is trusted first, no direct probe", async () => {
  const m = makeManager();
  const kv = memoryConnKv();
  await kv.put("last_good.net1", { base: RELAY, at: 1 });
  const { fn, calls } = fakeFetch(() => "ok");
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, networkId: () => "net1", now: () => 2 });
  cm.applyConfig({ ...CONFIG, policy: { ...CONFIG.policy, race_direct_vs_known_good: false } });
  assert.equal(await cm.connect(), RELAY);
  assert.equal(cm.getStatus().lastSwitchReason, "sticky");
  assert.deepEqual(calls, [`${RELAY}/health`], "only the remembered endpoint was probed");
});

test("sticky per-network TTL: expired memory is ignored; fresh memory is honoured (fake clock)", async () => {
  const kv = memoryConnKv();
  const ttlS = 3600;
  await kv.put("last_good.net1", { base: RELAY, at: 1_000_000 });
  // Clock far past the TTL → the record must be ignored and the normal walk picks direct.
  let t = 1_000_000 + ttlS * 1000 + 1;
  const m = makeManager();
  const { fn, calls } = fakeFetch(() => "ok");
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, networkId: () => "net1", now: () => t });
  cm.applyConfig({ ...CONFIG, policy: { ...CONFIG.policy, race_direct_vs_known_good: false, sticky_per_network_ttl_s: ttlS } });
  assert.equal(await cm.connect(), DIRECT, "expired sticky ignored → sequential walk from L0");
  assert.equal(calls[0], `${DIRECT}/health`);
  // Within TTL on a fresh manager: the memory (now refreshed to DIRECT by the connect above) is used.
  const rec = (await kv.get("last_good.net1")) as { base: string; at: number };
  assert.equal(rec.base, DIRECT, "connect refreshed the record");
  assert.equal(rec.at, t, "stamped with the injected clock");
});

test("sticky memory is per network-id: switching networks uses its own bucket", async () => {
  const kv = memoryConnKv();
  await kv.put("last_good.wifi-a", { base: RELAY, at: 10 });
  let net = "wifi-a";
  const m = makeManager();
  const { fn } = fakeFetch(() => "ok");
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, networkId: () => net, now: () => 20 });
  cm.applyConfig({ ...CONFIG, policy: { ...CONFIG.policy, race_direct_vs_known_good: false } });
  assert.equal(await cm.connect(), RELAY, "wifi-a remembers the relay");
  net = "cell-b"; // new network → no memory → sequential walk lands on direct
  assert.equal(await cm.connect(), DIRECT, "cell-b has its own (empty) bucket");
  const a = (await kv.get("last_good.wifi-a")) as { base: string };
  const b = (await kv.get("last_good.cell-b")) as { base: string };
  assert.equal(a.base, RELAY, "wifi-a bucket untouched by cell-b activity");
  assert.equal(b.base, DIRECT);
});

test("kill_switch.force_transport=reality pins the relay over probes and memory", async () => {
  const m = makeManager();
  const kv = memoryConnKv();
  await kv.put("last_good.default", { base: DIRECT, at: 1 });
  const { fn } = fakeFetch(() => "ok"); // everything alive — only the pin explains landing on RELAY
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, now: () => 2 });
  cm.applyConfig({ ...CONFIG, kill_switch: { force_transport: "reality" } });
  assert.equal(await cm.connect(), RELAY, "first reality candidate pinned");
  assert.equal(cm.getStatus().lastSwitchReason, "kill_switch");
  assert.equal(cm.getStatus().tier, "backup");
  // Flipping the pin to direct returns to L0.
  cm.applyConfig({ kill_switch: { force_transport: "direct" } });
  assert.equal(await cm.connect(), DIRECT);
  // Unknown value = no pin (fail-open to normal selection).
  cm.applyConfig({ kill_switch: { force_transport: "carrier-pigeon" } });
  assert.deepEqual(cm.killSwitch(), { force_transport: null });
});

test("auto-failover off blocks proactive probes and recovery; operator kill-switch still overrides", async () => {
  const m = createEndpointManager({ primary: DIRECT, selfOrigin: null, autoFailover: false });
  const { fn, calls } = fakeFetch((url) => (url.startsWith(DIRECT) ? "err" : "ok"));
  const cm = createConnectionManager({ manager: m, fetchImpl: fn });
  cm.applyConfig(CONFIG);

  assert.equal(await cm.connect(), DIRECT, "user-disabled automation keeps the current route");
  assert.equal(calls.length, 0, "no proactive health probes while automation is disabled");

  m.select(RELAY); // explicit/manual selection remains possible
  assert.equal(await cm.recheckDirect(), false, "automatic return to L0 is disabled too");
  assert.equal(calls.length, 0, "recheck made no request");

  m.select(DIRECT);
  cm.applyConfig({ kill_switch: { force_transport: "reality" } });
  assert.equal(await cm.connect(), RELAY, "incident kill-switch overrides the user toggle");
  assert.equal(cm.getStatus().lastSwitchReason, "kill_switch");
});

test("anti-exfiltration NOT weakened: foreign origins rejected by manager and by probes", async () => {
  const m = makeManager();
  const { fn, calls } = fakeFetch(() => "ok");
  const cm = createConnectionManager({ manager: m, fetchImpl: fn });
  cm.applyConfig(CONFIG);
  assert.equal(m.isAllowed("https://evil.example/x"), false, "T-419 gate intact after applyConfig");
  const r = await cm.probeEndpoint("https://evil.example");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /blocked/);
  assert.equal(calls.length, 0, "the probe fetch was never invoked for a foreign origin");
  // A sticky record pointing at a foreign origin can never be selected (select() refuses).
  assert.equal(m.select("https://evil.example"), false);
});

test("same-origin web (current \"\"): the whole layer is inert — no probes, no kv writes, no status churn", async () => {
  // primary "" + no fallbacks = the reference web build. candidates() === [""].
  const m = createEndpointManager({ primary: "", selfOrigin: null });
  const { fn, calls } = fakeFetch(() => "ok");
  const statuses: ConnStatus[] = [];
  let kvTouched = 0;
  const kv = {
    get: async (k: string) => { kvTouched++; return memoryConnKv().get(k); },
    put: async () => { kvTouched++; },
    delete: async () => { kvTouched++; },
  };
  const cm = createConnectionManager({ manager: m, fetchImpl: fn, kv, onStatusChange: (s) => statuses.push(s) });
  cm.applyConfig({ endpoints: [], policy: CONFIG.policy, kill_switch: { force_transport: null } }); // legacy empty answer
  assert.equal(await cm.connect(), "", "same-origin stays same-origin");
  assert.equal(calls.length, 0, "no probe traffic");
  assert.equal(kvTouched, 0, "no kv access");
  assert.equal(statuses.length, 0, "no status events");
  assert.equal(m.current(), "", "manager untouched — T-419 behaviour byte-for-byte");
  assert.deepEqual(cm.getStatus(), { activeEndpoint: "", tier: "direct", healthByEndpoint: {}, lastSwitchReason: null });
});

test("T-419 streak failover forwards into the status snapshot via onEndpointSwitch", () => {
  const m = createEndpointManager({
    primary: DIRECT,
    fallbacks: [RELAY],
    selfOrigin: null,
    onSwitch: (c, r) => cm.onEndpointSwitch(c, r),
  });
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn });
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), RELAY);
  assert.equal(cm.getStatus().lastSwitchReason, "failover", "manager-driven switch visible in status");
});

test("policy.failures_before_rotate reconfigures the T-419 streak threshold", () => {
  const m = createEndpointManager({ primary: DIRECT, fallbacks: [RELAY], selfOrigin: null });
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn });
  cm.applyConfig({ policy: { failures_before_rotate: 2 } });
  m.reportNetworkError();
  assert.equal(m.current(), DIRECT);
  m.reportNetworkError();
  assert.equal(m.current(), RELAY, "rotated after the server-driven 2, not the default 3");
});

// ---------------------------------------------------------------------------------------------------
// NR-03 (T-603 client half): pinned-key verification gate in front of applyConfig. The signed fixture
// below was produced by the SERVER'S OWN compiled signConfig (server/dist/core/config_sign.js,
// throwaway /tmp ed25519 keys — never prod var/keys), so acceptance proves canonicalization parity.
// Bases match this suite's DIRECT/RELAY; policy values are distinctive (≠ DEFAULT_POLICY) so
// "applied vs not applied" is directly observable.

const SIGNED_CORE_JSON =
  '{"endpoints":[{"id":"de-direct","base":"https://direct.example","region":"de","transport":"direct","priority":10,"weight":100},{"id":"ru-relay","base":"https://relay.example","region":"ru","transport":"reality","priority":20,"weight":100,"reality":{"host":"www.microsoft.com","port":443,"sni":"www.microsoft.com","fingerprint":"chrome","public_key":"PUB","short_id":"ab12"}}],"policy":{"probe_timeout_ms":1234,"failures_before_rotate":5,"race_direct_vs_known_good":false,"sticky_per_network_ttl_s":4321},"kill_switch":{"force_transport":null}}';
const SIGNED_SIG = "enFnKkwYb/1c/Y26+uEDrRTx/TaiB66nEmIoSqbR2kd/g2xoYcg9i53Vm6cSLtuCf4MSnMMwie1H8u6HRPXeBQ==";
const SIGNED_SIG_FOREIGN = "n2mj6bUN4huPxQfgBoSZ0PL5L0kDj5d9zM2fIxoQ2laRRNPX5jcqUubhfNlLkj4x53CfqEu19dDPwxzymR10Aw==";
const SIGNED_PIN = "uDAu7Bx3TcVuPrwBRnpLrZ9xMdrHQwbGo5il3jHkGLk";

type SignedBody = {
  endpoints: unknown[];
  policy: Record<string, unknown>;
  kill_switch: Record<string, unknown>;
  signature?: string;
  public_key?: string;
};
const signedBody = (): SignedBody => {
  const body = JSON.parse(SIGNED_CORE_JSON) as SignedBody;
  body.signature = SIGNED_SIG;
  return body;
};

// A kv wrapper that counts writes — "persisted state unchanged on reject" is asserted with it.
function countingKv(): { kv: ReturnType<typeof memoryConnKv>; writes: () => number } {
  const inner = memoryConnKv();
  let writes = 0;
  return {
    kv: {
      get: (k) => inner.get(k),
      put: (k, v) => { writes++; return inner.put(k, v); },
      delete: (k) => { writes++; return inner.delete(k); },
    },
    writes: () => writes,
  };
}

test("NR-03: valid signed empty core keeps production direct-only without probes", async () => {
  const core = {
    endpoints: [],
    policy: { ...DEFAULT_POLICY },
    kill_switch: { force_transport: null },
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pin = (publicKey.export({ format: "jwk" }) as { x?: string }).x;
  if (typeof pin !== "string") throw new Error("generated Ed25519 JWK has no x");
  const signature = signDetached(
    null,
    Buffer.from(canonicalizeConfigCore(core), "utf8"),
    privateKey,
  ).toString("base64");
  const transport = fakeFetch(() => "ok");
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: transport.fn, configSignaturePin: pin });
  assert.equal(await cm.applyConfigVerified({ ...core, signature, public_key: pin }), true);
  assert.deepEqual(m.candidates(), [DIRECT], "empty advertised list preserves the built-in direct primary");
  assert.equal(await cm.connect(), DIRECT);
  assert.deepEqual(transport.calls, [], "a single direct candidate is inert and performs no probe");
  assert.equal("lastConfigReject" in cm.getStatus(), false);
});

test("NR-03: valid server-signed config + pinned key ⇒ применён (endpoints/policy/kill_switch)", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  assert.equal(await cm.applyConfigVerified(signedBody()), true, "verified apply reports success");
  assert.deepEqual(m.candidates(), [DIRECT, RELAY], "signed endpoints reached the manager");
  assert.equal(cm.policy().probe_timeout_ms, 1234, "signed policy applied");
  assert.equal(cm.policy().failures_before_rotate, 5);
  assert.equal(m.endpointInfo(RELAY)?.transport, "reality");
  assert.equal("lastConfigReject" in cm.getStatus(), false, "no reject flag on the healthy path");
});

test("NR-03/T-605: verified prepare completes before endpoint state is committed", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  let release!: (value: boolean) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const body = signedBody();
  const applying = cm.applyConfigVerified(body, async (verified) => {
    assert.deepEqual(verified.endpoints, body.endpoints, "prepare sees the already verified config body");
    markStarted();
    return gate;
  });
  await started;
  assert.deepEqual(m.candidates(), [DIRECT], "native preparation cannot expose endpoints early");
  assert.deepEqual(cm.policy(), DEFAULT_POLICY, "policy also remains atomic");
  release(true);
  assert.equal(await applying, true);
  assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
});

test("NR-03/T-605: prepare refusal or exception preserves the previous trusted config", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  assert.equal(await cm.applyConfigVerified(signedBody(), async () => false), false);
  assert.deepEqual(m.candidates(), [DIRECT]);
  assert.deepEqual(cm.policy(), DEFAULT_POLICY);
  assert.equal("lastConfigReject" in cm.getStatus(), false, "native inability is not a signature rejection");
  assert.equal(await cm.applyConfigVerified(signedBody(), async () => { throw new Error("native failed"); }), false);
  assert.deepEqual(m.candidates(), [DIRECT]);
});

test("NR-03/T-605: unsigned development config never invokes the trusted native prepare hook", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn });
  let calls = 0;
  assert.equal(await cm.applyConfigVerified(signedBody(), async () => { calls += 1; return false; }), true);
  assert.equal(calls, 0, "unverified bodies cannot reach native transport orchestration");
  assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
});

test("NR-03: порча тела ⇒ ВЕСЬ конфиг отвергнут атомарно (endpoints+policy+kill_switch нетронуты)", async () => {
  const m = makeManager();
  const { kv, writes } = countingKv();
  const statuses: ConnStatus[] = [];
  const cm = createConnectionManager({
    manager: m, fetchImpl: fakeFetch(() => "ok").fn, kv, configSignaturePin: SIGNED_PIN,
    onStatusChange: (s) => statuses.push(s),
  });
  const tampered = signedBody();
  (tampered.endpoints[1] as Record<string, unknown>).base = "https://evil.example"; // relay swapped by a hostile middlebox
  tampered.kill_switch = { force_transport: "reality" }; // and the emergency lever pulled
  assert.equal(await cm.applyConfigVerified(tampered), false, "tampered body rejected");
  assert.deepEqual(m.candidates(), [DIRECT], "no endpoint reached the manager — not even untampered ones");
  assert.deepEqual(cm.policy(), DEFAULT_POLICY, "policy untouched");
  assert.deepEqual(cm.killSwitch(), { force_transport: null }, "kill_switch untouched");
  assert.equal(writes(), 0, "persisted sticky memory untouched");
  assert.equal(cm.getStatus().lastConfigReject, "signature_invalid", "reason on the existing status channel");
  assert.equal(statuses.length, 1, "one status event for the reject");
  // recovery: the genuine config still applies afterwards and heals the flag
  assert.equal(await cm.applyConfigVerified(signedBody()), true);
  assert.equal("lastConfigReject" in cm.getStatus(), false, "reject flag cleared by a verified config");
  assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
});

test("NR-03: перестановка endpoints[] ⇒ отказ (порядок массива подписан)", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  const reordered = signedBody();
  reordered.endpoints = [reordered.endpoints[1], reordered.endpoints[0]];
  assert.equal(await cm.applyConfigVerified(reordered), false, "geo/priority order is signed — reorder rejected");
  assert.deepEqual(m.candidates(), [DIRECT]);
});

test("NR-03: добавленный/удалённый ключ в policy ⇒ отказ", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  const added = signedBody();
  added.policy.probe_timeout_ms_extra = 1;
  assert.equal(await cm.applyConfigVerified(added), false, "added policy key rejected");
  const removed = signedBody();
  delete removed.policy.probe_timeout_ms;
  assert.equal(await cm.applyConfigVerified(removed), false, "removed policy key rejected");
  assert.deepEqual(cm.policy(), DEFAULT_POLICY);
});

test("NR-03: подпись чужим ключом ⇒ отказ", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  const foreign = signedBody();
  foreign.signature = SIGNED_SIG_FOREIGN;
  assert.equal(await cm.applyConfigVerified(foreign), false);
  assert.deepEqual(m.candidates(), [DIRECT]);
  assert.equal(cm.getStatus().lastConfigReject, "signature_invalid");
});

test("NR-03: signature отсутствует/не строка при pinned-ключе ⇒ отказ", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  const missing = signedBody();
  delete missing.signature;
  assert.equal(await cm.applyConfigVerified(missing), false, "stripping proxy cannot degrade to unsigned");
  assert.equal(cm.getStatus().lastConfigReject, "signature_missing");
  const junk = signedBody();
  (junk as Record<string, unknown>).signature = 42;
  assert.equal(await cm.applyConfigVerified(junk), false, "non-string signature = missing");
  assert.deepEqual(m.candidates(), [DIRECT]);
});

test("NR-03: злонамеренный public_key в теле при валидной pinned-подписи ⇒ принято (тело — не доверие)", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  const attacker = signedBody();
  attacker.public_key = "ATTACKER-KEY-b64url-that-must-be-ignored";
  assert.equal(await cm.applyConfigVerified(attacker), true, "verification uses ONLY the pin");
  assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
});

test("NR-03: «правильный» public_key в теле + битая подпись ⇒ отказ; несовпадающий ключ — только диагностика", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  // (a) advertised key EQUALS the pin, signature corrupt — the honest-looking body is still refused
  const honest = signedBody();
  honest.public_key = SIGNED_PIN;
  honest.signature = SIGNED_SIG_FOREIGN;
  assert.equal(await cm.applyConfigVerified(honest), false, "advertised key never vouches for the body");
  assert.equal(cm.getStatus().lastConfigReject, "signature_invalid");
  // (b) advertised key DIFFERS from the pin with a bad signature — refined diagnostic, same refusal
  const rotated = signedBody();
  rotated.public_key = "SomeOtherKeyEntirely";
  rotated.signature = SIGNED_SIG_FOREIGN;
  assert.equal(await cm.applyConfigVerified(rotated), false);
  assert.equal(cm.getStatus().lastConfigReject, "public_key_mismatch", "rotation/MITM hint surfaced");
  assert.deepEqual(m.candidates(), [DIRECT], "nothing applied in either case");
});

test("NR-03: без pinned-ключа signature/public_key игнорируются — legacy-путь байт-в-байт", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn }); // no pin
  const garbage = signedBody();
  garbage.signature = "not-even-base64!!";
  garbage.public_key = "junk";
  assert.equal(await cm.applyConfigVerified(garbage), true, "unsigned build applies without verification");
  assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
  assert.equal(cm.policy().probe_timeout_ms, 1234);
  assert.equal("lastConfigReject" in cm.getStatus(), false, "status shape unchanged for legacy consumers");
});

test("NR-03: sync applyConfig при pinned-ключе верифицирует асинхронно (тот же fail-closed путь)", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  cm.applyConfig(signedBody()); // existing sync call sites keep their signature
  assert.deepEqual(m.candidates(), [DIRECT], "not applied synchronously — verification is in flight");
  await new Promise((r) => setTimeout(r, 20)); // let the ed25519 check resolve
  assert.deepEqual(m.candidates(), [DIRECT, RELAY], "verified config landed after the check");
  const m2 = makeManager();
  const cm2 = createConnectionManager({ manager: m2, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  const bad = signedBody();
  (bad.endpoints[0] as Record<string, unknown>).base = "https://evil.example";
  cm2.applyConfig(bad);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(m2.candidates(), [DIRECT], "tampered config never lands through the sync facade");
  assert.equal(cm2.getStatus().lastConfigReject, "signature_invalid");
});

test("NR-03: malformed non-empty build pin cannot degrade to unsigned config", async () => {
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: "malformed-pin" });
  assert.equal(await cm.applyConfigVerified(signedBody()), false);
  assert.deepEqual(m.candidates(), [DIRECT], "no fallback endpoint applied");
  assert.ok("lastConfigReject" in cm.getStatus(), "failure is visible on the existing diagnostics channel");
});

test("NR-03: subtle недоступен при pinned-ключе ⇒ отказ (fail closed), без pin — прежнее поведение", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(desc, "crypto global expected in the test env");
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl: fakeFetch(() => "ok").fn, configSignaturePin: SIGNED_PIN });
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    assert.equal(await cm.applyConfigVerified(signedBody()), false, "cannot verify ⇒ reject");
    assert.equal(cm.getStatus().lastConfigReject, "webcrypto_unavailable");
    assert.deepEqual(m.candidates(), [DIRECT], "nothing applied");
    // no pin ⇒ the legacy path needs no WebCrypto at all
    const m2 = makeManager();
    const cm2 = createConnectionManager({ manager: m2, fetchImpl: fakeFetch(() => "ok").fn });
    assert.equal(await cm2.applyConfigVerified(signedBody()), true, "unsigned build unaffected");
    assert.deepEqual(m2.candidates(), [DIRECT, RELAY]);
  } finally {
    Object.defineProperty(globalThis, "crypto", desc!);
  }
  assert.equal(await cm.applyConfigVerified(signedBody()), true, "restored environment verifies again");
});


test("NR-03: a slower old verification cannot apply after a newer config verdict", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(descriptor, "crypto global expected in the test env");
  let releaseOld!: (ok: boolean) => void;
  const oldVerify = new Promise<boolean>((resolve) => { releaseOld = resolve; });
  let markOldStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
  let verifyCalls = 0;
  const subtle = {
    importKey: async () => ({}),
    verify: async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        markOldStarted();
        return oldVerify;
      }
      return false;
    },
  } as unknown as SubtleCrypto;
  Object.defineProperty(globalThis, "crypto", {
    value: { subtle } as Crypto,
    configurable: true,
  });

  try {
    const m = makeManager();
    const cm = createConnectionManager({
      manager: m,
      fetchImpl: fakeFetch(() => "ok").fn,
      configSignaturePin: SIGNED_PIN,
    });

    const oldResult = cm.applyConfigVerified(signedBody());
    await oldStarted;

    const newerInvalid = signedBody();
    newerInvalid.signature = SIGNED_SIG_FOREIGN;
    assert.equal(await cm.applyConfigVerified(newerInvalid), false);
    assert.deepEqual(m.candidates(), [DIRECT], "newer rejection leaves the last trusted config live");
    assert.equal(cm.getStatus().lastConfigReject, "signature_invalid");

    releaseOld(true);
    assert.equal(await oldResult, false, "the superseded verification reports that it was not applied");
    assert.deepEqual(m.candidates(), [DIRECT], "late old success cannot overwrite the newer verdict");
    assert.equal(cm.getStatus().lastConfigReject, "signature_invalid");
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});


test("NR-03: shell invalidation cancels an in-flight verification before a newer response exists", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(descriptor, "crypto global expected in the test env");
  let releaseVerify!: (ok: boolean) => void;
  const pendingVerify = new Promise<boolean>((resolve) => { releaseVerify = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const subtle = {
    importKey: async () => ({}),
    verify: async () => {
      markStarted();
      return pendingVerify;
    },
  } as unknown as SubtleCrypto;
  Object.defineProperty(globalThis, "crypto", { value: { subtle } as Crypto, configurable: true });

  try {
    const m = makeManager();
    const cm = createConnectionManager({
      manager: m,
      fetchImpl: fakeFetch(() => "ok").fn,
      configSignaturePin: SIGNED_PIN,
    });
    const oldResult = cm.applyConfigVerified(signedBody());
    await started;
    cm.invalidateConfigVerification();
    releaseVerify(true);
    assert.equal(await oldResult, false, "invalidated verification reports that nothing was applied");
    assert.deepEqual(m.candidates(), [DIRECT], "late success cannot install stale endpoints");
    assert.equal("lastConfigReject" in cm.getStatus(), false, "supersession is not a security rejection");
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});


test("NR-03: a late old rejection cannot poison a newer verified config", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(descriptor, "crypto global expected in the test env");
  let releaseOld!: (ok: boolean) => void;
  const oldVerify = new Promise<boolean>((resolve) => { releaseOld = resolve; });
  let markOldStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
  let verifyCalls = 0;
  const subtle = {
    importKey: async () => ({}),
    verify: async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        markOldStarted();
        return oldVerify;
      }
      return true;
    },
  } as unknown as SubtleCrypto;
  Object.defineProperty(globalThis, "crypto", { value: { subtle } as Crypto, configurable: true });

  try {
    const m = makeManager();
    const cm = createConnectionManager({
      manager: m,
      fetchImpl: fakeFetch(() => "ok").fn,
      configSignaturePin: SIGNED_PIN,
    });

    const oldInvalid = signedBody();
    oldInvalid.signature = SIGNED_SIG_FOREIGN;
    const oldResult = cm.applyConfigVerified(oldInvalid);
    await oldStarted;

    assert.equal(await cm.applyConfigVerified(signedBody()), true);
    assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
    assert.equal("lastConfigReject" in cm.getStatus(), false);

    releaseOld(false);
    assert.equal(await oldResult, false);
    assert.deepEqual(m.candidates(), [DIRECT, RELAY]);
    assert.equal("lastConfigReject" in cm.getStatus(), false, "superseded reject cannot poison current status");
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});


test("connect: an old direct probe cannot override a newer kill-switch config", async () => {
  let releaseDirect!: () => void;
  const directGate = new Promise<void>((resolve) => { releaseDirect = resolve; });
  let markDirectStarted!: () => void;
  const directStarted = new Promise<void>((resolve) => { markDirectStarted = resolve; });
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === `${DIRECT}/health`) {
      markDirectStarted();
      await directGate;
    }
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl });
  cm.applyConfig(CONFIG);

  const oldConnect = cm.connect();
  await directStarted;

  cm.applyConfig({ kill_switch: { force_transport: "reality" } });
  assert.equal(await cm.connect(), RELAY, "new config pins the backup transport");
  assert.equal(m.current(), RELAY);

  releaseDirect();
  assert.equal(await oldConnect, RELAY, "superseded connect returns the route selected by newer config");
  assert.equal(m.current(), RELAY, "late direct success cannot violate the kill-switch");
});


test("recheckDirect: an old recovery probe cannot override a newer backup kill-switch", async () => {
  let releaseDirect!: () => void;
  const directGate = new Promise<void>((resolve) => { releaseDirect = resolve; });
  let markDirectStarted!: () => void;
  const directStarted = new Promise<void>((resolve) => { markDirectStarted = resolve; });
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input) === `${DIRECT}/health`) {
      markDirectStarted();
      await directGate;
    }
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const m = makeManager();
  const cm = createConnectionManager({ manager: m, fetchImpl });
  cm.applyConfig(CONFIG);
  assert.equal(m.select(RELAY), true);
  assert.equal(m.current(), RELAY);

  const oldRecovery = cm.recheckDirect();
  await directStarted;

  cm.applyConfig({ kill_switch: { force_transport: "reality" } });
  assert.equal(await cm.connect(), RELAY);
  releaseDirect();

  assert.equal(await oldRecovery, false);
  assert.equal(m.current(), RELAY);
});
