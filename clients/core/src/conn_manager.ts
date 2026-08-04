// clients/core — ConnectionManager (T-604 / NR-04, NETWORK_RESILIENCE.md §2/§3/§4/§7).
//
// The thin-client half of "server-driven policy + тонкий клиент": everything this module DECIDES is
// parameterised by the T-602 /v1/config payload (endpoints[] objects, policy{}, kill_switch{}) and
// everything it DOES goes through the T-419 EndpointManager's public surface — it never duplicates the
// failover internals, never widens the anti-exfiltration allow-list, and stays fully inert on a
// same-origin web build (candidates() === [""]), where the T-419 wrappers are inert too.
//
// Responsibilities on top of T-419:
//   - applyConfig()    ingest a /v1/config body: structural/legacy endpoints[] → manager, policy{} →
//                      probe timings + manager failover threshold, kill_switch{} → transport pin.
//   - applyConfigVerified() NR-03 (T-603 client half): when the build carries a pinned ed25519 public
//                      key, verify the detached signature over the canonical {endpoints, policy,
//                      kill_switch} BEFORE anything is applied; any defect ⇒ the WHOLE config is
//                      rejected atomically and the previous state (incl. persisted sticky memory)
//                      stays live. No pin ⇒ legacy pass-through, byte-for-byte prior behaviour.
//   - probeEndpoint()  lightweight GET /health reachability probe with policy.probe_timeout_ms; ANY
//                      HTTP response (incl. 5xx) = reachable, mirroring reportSuccess() semantics.
//   - health           per-endpoint record: last success/error, latency, consecutive probe failures.
//   - connect()        L0(direct)→L1(backup) auto-selection: kill-switch pin > user auto-toggle > race "direct vs
//                      known-good" (policy-gated, direct wins when alive) > sticky per-network memory
//                      > sequential probe walk in candidate order. Winner via manager.select().
//   - recheckDirect()  return to L0 once direct is reachable again (call on a timer/reconnect — the
//                      module itself schedules nothing; determinism > convenience).
//   - getStatus()      the "тихий индикатор": machine-readable snapshot {activeEndpoint, tier,
//                      healthByEndpoint, lastSwitchReason} + onStatusChange callback. No pixels here —
//                      the UI layer (client phase) renders it.
//
// Injection discipline (like media_cache/endpoints): fetchImpl, clock, network-id provider and the KV
// used for per-network transport memory are all constructor options with safe defaults, so node tests
// drive every path with fakes and the core touches no platform global it wasn't handed.
//
// PER-NETWORK MEMORY & THE ENCRYPTION GATE (ревизия №96): the sticky "last good transport per network"
// record is persisted through the injectable ConnKv interface. The default is in-RAM (nothing touches
// disk). The KV contract is 1:1 adaptable to the ClientStore "meta" collection — and therefore to the
// T-520 EncryptedStore that wraps it:
//     const kv: ConnKv = {
//       get: (k) => store.get("meta", `nr.${k}`),
//       put: (k, v) => store.put("meta", `nr.${k}`, v),
//       delete: (k) => store.delete("meta", `nr.${k}`),
//     };
// web/main.ts wires this adapter as a hybrid RAM + encrypted-meta KV: before unlock it remains RAM-only;
// while UNLOCKED the same record is persisted through EncryptedStore. No transport metadata is written
// to plaintext storage.
import type { EndpointManager, EndpointSwitchReason, KillSwitch, TransportPolicy } from "./endpoints.ts";
import { parseEndpointInput, type EndpointInput } from "./endpoints.ts";
import { verifyConfigSignature } from "./config_verify.ts";

// Spec defaults (NETWORK_RESILIENCE §4) — used until the first applyConfig() delivers server policy.
export const DEFAULT_POLICY: TransportPolicy = {
  probe_timeout_ms: 2500,
  failures_before_rotate: 3,
  race_direct_vs_known_good: true,
  sticky_per_network_ttl_s: 86400,
};

// Minimal async KV for the per-network sticky memory. Deliberately a subset of ClientStore("meta")
// so the T-520 EncryptedStore adapter above is three one-liners.
export interface ConnKv {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

// In-RAM default: safe (no plaintext on disk), enough for a session; persistence arrives with the
// encrypted-store wiring.
export function memoryConnKv(): ConnKv {
  const m = new Map<string, unknown>();
  return {
    get: (k) => Promise.resolve(m.get(k)),
    put: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

// Health record per endpoint base URL. Timestamps are ms from the injected clock; 0 = never.
export interface EndpointHealth {
  lastSuccessAt: number;
  lastErrorAt: number;
  lastError: string | null;
  latencyMs: number | null; // last successful probe round-trip
  consecutiveFailures: number; // probe failures since the last success
}

export interface ProbeResult {
  base: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

// Why the active endpoint last changed — superset of EndpointSwitchReason with the conn-manager verbs.
export type ConnSwitchReason =
  | EndpointSwitchReason // "failover" | "primary" | "manual" (forwarded from the manager)
  | "probe" // sequential L0→L1 reachability walk picked a live endpoint
  | "race:direct" // the direct-vs-known-good race: direct answered → direct wins (ties included)
  | "race:known-good" // direct was dead/hanging, the remembered relay answered
  | "sticky" // per-network memory selected the last known-good without a full walk
  | "kill_switch" // operator pin (/v1/config kill_switch.force_transport)
  | "recovered"; // direct became reachable again → returned to L0

export interface ConnStatus {
  activeEndpoint: string; // "" = same-origin
  tier: "direct" | "backup"; // backup ⇔ active transport ≠ "direct" — the quiet indicator
  healthByEndpoint: Record<string, EndpointHealth>;
  lastSwitchReason: ConnSwitchReason | null;
  // NR-03: present ONLY while the last pinned-key config ingest was rejected (absent otherwise, so
  // the legacy status shape stays byte-for-byte). Cleared by the next successfully verified config.
  lastConfigReject?: ConfigRejectReason;
}

// The slice of a parsed /v1/config body this module consumes. Legacy servers send string endpoints and
// no policy/kill_switch — every field is optional and defensively parsed. signature/public_key are the
// T-603 fields: consulted ONLY when the build carries a pinned key (configSignaturePin), and the
// transmitted public_key is NEVER a root of trust — at most a mismatch diagnostic.
export interface ConnConfig {
  endpoints?: unknown;
  policy?: unknown;
  kill_switch?: unknown;
  signature?: unknown;
  public_key?: unknown;
}

// Optional transaction participant for platform work that must happen only for a signature-verified
// config and before its endpoint/policy state becomes visible. Returning false or throwing aborts the
// client commit without marking a cryptographic rejection. Unsigned development builds never call it.
export type VerifiedConfigPrepare = (config: Readonly<ConnConfig>) => Promise<boolean>;

// NR-03: why a /v1/config body was NOT applied under a pinned key. Reported through the existing
// status channel (getStatus().lastConfigReject + onStatusChange) — no new event mechanism.
export type ConfigRejectReason =
  | "signature_missing" // pinned key, but the body carries no signature string
  | "signature_invalid" // signature present but does not verify over the canonical core
  | "public_key_mismatch" // refinement of invalid: the body ALSO advertises a key ≠ pin (rotation/MITM hint)
  | "webcrypto_unavailable"; // crypto.subtle absent — cannot verify ⇒ fail closed

export interface ConnectionManagerOptions {
  manager: EndpointManager;
  // Probe transport. Injected like media_cache's fetchImpl; defaults to the platform fetch. NOTE:
  // probes are also guarded by manager.isAllowed() so even a mis-wired fetch cannot exfiltrate.
  fetchImpl?: typeof fetch;
  // Millisecond clock (fake-able for sticky-TTL tests). Default Date.now.
  now?: () => number;
  // Identifies the CURRENT network for the sticky memory: SSID / operator on the mobile shells (they
  // inject a provider reading the OS API), "default" on web — a browser deliberately cannot read the
  // SSID, so web gets one shared bucket and the TTL/probes still keep it fresh. Honest limitation.
  networkId?: () => string;
  // Sticky per-network memory. Default in-RAM; the DS-wave wires the EncryptedStore adapter (above).
  kv?: ConnKv;
  onStatusChange?: (status: ConnStatus) => void;
  // NR-03 (T-603 client half): the BUILD-PINNED ed25519 public key — base64url raw 32 bytes, i.e. the
  // JWK "x" string exactly as printed at key generation and as the server transmits in `public_key`
  // (the transmitted copy is NEVER trusted; this option is the only root of trust). undefined/"" =
  // unsigned build: applyConfig stays byte-for-byte the prior pass-through (additive rollout, mirror
  // of the server's "no key file = unsigned"). Set ⇒ every /v1/config ingest MUST verify: missing/
  // unparseable/mismatching signature, canonical-core mismatch or unavailable WebCrypto rejects the
  // WHOLE body atomically (endpoints, policy and kill_switch all keep their previous state).
  configSignaturePin?: string;
}

const STICKY_PREFIX = "last_good."; // kv key = last_good.<networkId>

interface StickyRecord {
  base: string;
  at: number; // ms, injected clock
}

function parseSticky(v: unknown): StickyRecord | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.base !== "string" || typeof r.at !== "number") return null;
  return { base: r.base, at: r.at };
}

export interface ConnectionManager {
  // Ingest a /v1/config body (any shape). Structural endpoints reach the EndpointManager (ordered,
  // de-duplicated, metadata retained), policy tunes probes + the failover threshold, kill_switch pins.
  // Sync contract preserved: without a configSignaturePin the body applies before this returns
  // (unchanged legacy path); with a pin it delegates to applyConfigVerified() and the ATOMIC apply
  // happens only after the ed25519 check resolves — nothing is applied on any verification defect.
  applyConfig(cfg: ConnConfig): void;
  // NR-03 verify-then-apply. With a pinned key, optional prepareVerified runs after signature success
  // and before endpoint/policy/kill-switch commit. Its false/throw aborts the whole commit while keeping
  // the previous trusted state. Unsigned builds ignore the hook. Never rejects the promise.
  applyConfigVerified(cfg: ConnConfig, prepareVerified?: VerifiedConfigPrepare): Promise<boolean>;
  // Supersede an in-flight WebCrypto verification immediately (for example when a newer shell refresh
  // starts or the user switches servers). This is silent cancellation, not a security rejection.
  invalidateConfigVerification(): void;
  // One reachability probe: GET <base>/health bounded by policy.probe_timeout_ms. Updates health.
  probeEndpoint(base: string): Promise<ProbeResult>;
  // Full L0→L1 selection (kill-switch > race > sticky > sequential walk). Resolves to the active base.
  connect(): Promise<string>;
  // If we sit on a backup, probe direct and return to it when reachable. True = back on direct.
  recheckDirect(): Promise<boolean>;
  // Forward the EndpointManager's onSwitch here (wire: onSwitch: (c, r) => cm.onEndpointSwitch(c, r))
  // so streak-failovers made inside T-419 show up in the status snapshot.
  onEndpointSwitch(current: string, reason: EndpointSwitchReason): void;
  getStatus(): ConnStatus;
  policy(): TransportPolicy;
  killSwitch(): KillSwitch;
}

export function createConnectionManager(opts: ConnectionManagerOptions): ConnectionManager {
  const manager = opts.manager;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const networkId = opts.networkId ?? ((): string => "default");
  const kv = opts.kv ?? memoryConnKv();
  const onStatusChange = opts.onStatusChange;
  // NR-03: empty string = no pin (an accidental "" must not silently disable endpoints forever).
  const configSignaturePin = typeof opts.configSignaturePin === "string" && opts.configSignaturePin !== ""
    ? opts.configSignaturePin
    : null;

  let policy: TransportPolicy = { ...DEFAULT_POLICY };
  let killSwitch: KillSwitch = { force_transport: null };
  const health = new Map<string, EndpointHealth>();
  let lastSwitchReason: ConnSwitchReason | null = null;
  let lastConfigReject: ConfigRejectReason | null = null;
  let configVerificationSeq = 0;
  let routingGeneration = 0;

  const healthOf = (base: string): EndpointHealth => {
    let h = health.get(base);
    if (!h) {
      h = { lastSuccessAt: 0, lastErrorAt: 0, lastError: null, latencyMs: null, consecutiveFailures: 0 };
      health.set(base, h);
    }
    return h;
  };

  // transport of a candidate: structural metadata wins; the plain primary / legacy strings are direct.
  const transportOf = (base: string): string => manager.endpointInfo(base)?.transport ?? "direct";

  const buildStatus = (): ConnStatus => {
    const byEndpoint: Record<string, EndpointHealth> = {};
    for (const [k, v] of health) byEndpoint[k] = { ...v };
    const active = manager.current();
    return {
      activeEndpoint: active,
      tier: transportOf(active) === "direct" ? "direct" : "backup",
      healthByEndpoint: byEndpoint,
      lastSwitchReason,
      // Key absent entirely on the legacy/healthy path — old consumers see the exact prior shape.
      ...(lastConfigReject !== null ? { lastConfigReject } : {}),
    };
  };

  const notify = (): void => {
    onStatusChange?.(buildStatus());
  };

  // Select `base` in the manager and record why. select() refuses non-candidates, so a stale sticky
  // record or a raced URL can never point traffic outside the allow-list.
  const selectAs = (base: string, reason: ConnSwitchReason): boolean => {
    const before = manager.current();
    if (!manager.select(base)) return false;
    if (manager.current() !== before) {
      lastSwitchReason = reason;
      notify();
    }
    return true;
  };

  const stickyKey = (): string => STICKY_PREFIX + networkId();

  const rememberLastGood = async (base: string): Promise<void> => {
    try {
      await kv.put(stickyKey(), { base, at: now() } satisfies StickyRecord);
    } catch {
      /* memory is an optimisation — a failing store must not break connectivity */
    }
  };

  const readLastGood = async (): Promise<string | null> => {
    let rec: StickyRecord | null = null;
    try {
      rec = parseSticky(await kv.get(stickyKey()));
    } catch {
      return null;
    }
    if (!rec) return null;
    const ttlMs = policy.sticky_per_network_ttl_s * 1000;
    if (ttlMs > 0 && now() - rec.at > ttlMs) return null; // expired — forget it
    return manager.candidates().includes(rec.base) ? rec.base : null; // must still be configured
  };

  const probeEndpoint = async (base: string): Promise<ProbeResult> => {
    const url = base === "" ? "/health" : `${base}/health`;
    // Anti-exfiltration, defense in depth: same gate the T-419 fetch wrapper enforces.
    if (base !== "" && !manager.isAllowed(url)) {
      return { base, ok: false, latencyMs: 0, error: "blocked: not a configured server address" };
    }
    const h = healthOf(base);
    const t0 = now();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        reject(new Error(`probe timeout after ${policy.probe_timeout_ms}ms`));
      }, policy.probe_timeout_ms);
    });
    try {
      const init: RequestInit = ctrl ? { method: "GET", signal: ctrl.signal } : { method: "GET" };
      await Promise.race([fetchImpl(url, init), timeout]);
      // ANY HTTP response (incl. 5xx) = the endpoint is reachable — identical to reportSuccess().
      const latencyMs = now() - t0;
      h.lastSuccessAt = now();
      h.latencyMs = latencyMs;
      h.lastError = null;
      h.consecutiveFailures = 0;
      return { base, ok: true, latencyMs };
    } catch (err) {
      h.lastErrorAt = now();
      h.lastError = err instanceof Error ? err.message : String(err);
      h.consecutiveFailures++;
      return { base, ok: false, latencyMs: now() - t0, error: h.lastError };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // First candidate whose transport is "direct" — the L0 the client should prefer and return to.
  const directCandidate = (): string | null => {
    for (const c of manager.candidates()) if (transportOf(c) === "direct") return c;
    return null;
  };

  const connect = async (): Promise<string> => {
    const generation = routingGeneration;
    const superseded = (): boolean => generation !== routingGeneration;
    const candidates = manager.candidates();
    // Same-origin web (current "") or a single fixed address: nothing to choose between — the whole
    // layer is INERT: no probes, no writes, no status churn (regression-pinned by test).
    if (candidates.length <= 1) return manager.current();

    // 1. Operator kill-switch: pin to the first candidate of the forced transport, unconditionally
    //    (an incident lever must win over probes and memory). Unknown transport → no match → fall
    //    through to normal selection (fail-open: a typo cannot strand every client).
    const force = killSwitch.force_transport;
    if (force !== null) {
      const pinned = candidates.find((c) => transportOf(c) === force);
      if (pinned !== undefined) {
        selectAs(pinned, "kill_switch");
        void probeEndpoint(pinned).catch(() => undefined); // health bookkeeping; the pin stands regardless
        return manager.current();
      }
    }

    // User-disabled auto failover blocks every non-emergency probe/switch. The operator kill-switch
    // above remains the explicit incident-control override.
    if (!manager.autoFailoverEnabled()) return manager.current();
    const direct = directCandidate();
    const sticky = await readLastGood();
    if (superseded()) return manager.current();

    // 2. The race (§3): direct vs the remembered known-good, in parallel, both bounded by
    //    probe_timeout_ms. Direct wins WHENEVER it is alive ("direct предпочтителен при равенстве"
    //    taken to its useful extreme — L0 is always the better route when reachable); the known-good
    //    only wins when direct is down/hanging.
    if (policy.race_direct_vs_known_good && sticky !== null && direct !== null && sticky !== direct) {
      const directProbe = probeEndpoint(direct);
      const stickyProbe = probeEndpoint(sticky);
      const d = await directProbe;
      if (superseded()) return manager.current();
      if (d.ok) {
        void stickyProbe.catch(() => undefined); // let it settle for health; result irrelevant
        selectAs(direct, "race:direct");
        await rememberLastGood(direct);
        return manager.current();
      }
      const s = await stickyProbe;
      if (superseded()) return manager.current();
      if (s.ok) {
        selectAs(sticky, "race:known-good");
        await rememberLastGood(sticky);
        return manager.current();
      }
      // both dead → fall through to the sequential walk over the remaining candidates
    } else if (sticky !== null) {
      // 3. No race (policy off, or sticky IS direct): trust the per-network memory first.
      const s = await probeEndpoint(sticky);
      if (superseded()) return manager.current();
      if (s.ok) {
        selectAs(sticky, sticky === direct ? "probe" : "sticky");
        await rememberLastGood(sticky);
        return manager.current();
      }
    }

    // 4. Sequential L0→L1 walk in candidate order (priority-ordered: direct first, then backups).
    for (const base of candidates) {
      const r = await probeEndpoint(base);
      if (superseded()) return manager.current();
      if (r.ok) {
        selectAs(base, "probe");
        await rememberLastGood(base);
        return manager.current();
      }
    }
    // Nothing reachable: stay put — the T-419 streak failover keeps rotating on live traffic.
    if (!superseded()) notify();
    return manager.current();
  };

  const recheckDirect = async (): Promise<boolean> => {
    const generation = routingGeneration;
    if (!manager.autoFailoverEnabled() || killSwitch.force_transport !== null) {
      return transportOf(manager.current()) === "direct";
    }
    const active = manager.current();
    if (transportOf(active) === "direct") return true; // already on L0
    const direct = directCandidate();
    if (direct === null) return false;
    const r = await probeEndpoint(direct);
    if (generation !== routingGeneration) return transportOf(manager.current()) === "direct";
    if (!r.ok) return false;
    selectAs(direct, "recovered");
    await rememberLastGood(direct);
    return transportOf(manager.current()) === "direct";
  };

  // The pre-NR-03 ingest, byte-for-byte: reached directly when no key is pinned, and ONLY after a
  // successful signature check when one is. Kept private so no caller can skip the verification gate.
  const applyUnverified = (cfg: ConnConfig): void => {
    routingGeneration += 1;
    // endpoints[]: both wire formats, defensively element-parsed; junk elements dropped.
    if (Array.isArray(cfg.endpoints)) {
      const inputs: EndpointInput[] = [];
      for (const raw of cfg.endpoints) {
        const parsed = parseEndpointInput(raw);
        if (parsed !== null) inputs.push(parsed);
      }
      manager.setAdvertisedEndpoints(inputs);
    }
    // policy{}: each knob validated independently; missing/garbage keeps the previous value.
    if (cfg.policy !== null && typeof cfg.policy === "object") {
      const p = cfg.policy as Record<string, unknown>;
      const int = (v: unknown, min: number): number | null =>
        typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : null;
      policy = {
        probe_timeout_ms: int(p.probe_timeout_ms, 1) ?? policy.probe_timeout_ms,
        failures_before_rotate: int(p.failures_before_rotate, 1) ?? policy.failures_before_rotate,
        race_direct_vs_known_good:
          typeof p.race_direct_vs_known_good === "boolean" ? p.race_direct_vs_known_good : policy.race_direct_vs_known_good,
        sticky_per_network_ttl_s: int(p.sticky_per_network_ttl_s, 0) ?? policy.sticky_per_network_ttl_s,
      };
      manager.setFailoverThreshold(policy.failures_before_rotate);
    }
    // kill_switch{}: only the two transports the server can emit are honoured; junk = no pin.
    if (cfg.kill_switch !== null && typeof cfg.kill_switch === "object") {
      const k = (cfg.kill_switch as Record<string, unknown>).force_transport;
      killSwitch = { force_transport: k === "direct" || k === "reality" ? k : null };
    }
  };

  // NR-03 rejection: NOTHING above ran — manager endpoints, policy, killSwitch, health and the
  // persisted sticky memory all keep their previous values. The reason travels through the existing
  // status channel (the module's one diagnostics surface) — no new event mechanism.
  const rejectConfig = (reason: ConfigRejectReason): void => {
    lastConfigReject = reason;
    notify();
  };

  const invalidateConfigVerification = (): void => {
    configVerificationSeq += 1;
  };

  const applyConfigVerified = async (
    cfg: ConnConfig,
    prepareVerified?: VerifiedConfigPrepare,
  ): Promise<boolean> => {
    const verificationSeq = ++configVerificationSeq;
    if (configSignaturePin === null) {
      applyUnverified(cfg); // unsigned build — legacy pass-through, prior behaviour byte-for-byte
      return true;
    }
    if (typeof cfg.signature !== "string" || cfg.signature === "") {
      rejectConfig("signature_missing"); // a stripping proxy must not degrade us to unsigned
      return false;
    }
    let ok = false;
    try {
      // Root of trust = the pin ONLY. cfg.public_key is deliberately not passed anywhere near this.
      ok = await verifyConfigSignature(
        { endpoints: cfg.endpoints, policy: cfg.policy, kill_switch: cfg.kill_switch },
        cfg.signature,
        configSignaturePin,
      );
    } catch {
      if (verificationSeq !== configVerificationSeq) return false;
      rejectConfig("webcrypto_unavailable"); // cannot verify ⇒ fail closed (primitives.ts-style throw)
      return false;
    }
    // A newer /v1/config ingest owns all state, including rejection diagnostics. Never let an older
    // WebCrypto completion roll endpoints/policy/kill-switch backwards or heal the newer reject flag.
    if (verificationSeq !== configVerificationSeq) return false;
    if (!ok) {
      // public_key is consulted ONLY to refine the diagnostic (key rotation vs plain corruption) —
      // it never influences acceptance: a "correct" advertised key with a bad signature still lands here.
      const advertised = typeof cfg.public_key === "string" ? cfg.public_key : null;
      rejectConfig(advertised !== null && advertised !== configSignaturePin ? "public_key_mismatch" : "signature_invalid");
      return false;
    }
    if (prepareVerified !== undefined) {
      let prepared = false;
      try {
        prepared = await prepareVerified(cfg);
      } catch {
        prepared = false;
      }
      // A server switch or another verified ingest may supersede us while native preparation is pending.
      // Never publish the old endpoint set after that boundary; platform cleanup is owned by the hook/shell.
      if (verificationSeq !== configVerificationSeq || !prepared) return false;
    }
    if (lastConfigReject !== null) {
      lastConfigReject = null; // verified config heals the reject flag (visible to status listeners)
      notify();
    }
    applyUnverified(cfg);
    return true;
  };

  return {
    applyConfig(cfg: ConnConfig): void {
      if (configSignaturePin === null) {
        applyUnverified(cfg); // sync contract of existing callers preserved exactly
        return;
      }
      // Pinned build behind the legacy sync signature: verification is unavoidably async (WebCrypto),
      // so the apply lands after this returns — callers keep working on the PREVIOUS trusted state
      // until then, which is exactly the fail-closed semantics. applyConfigVerified never rejects.
      void applyConfigVerified(cfg);
    },
    applyConfigVerified,
    invalidateConfigVerification,
    probeEndpoint,
    connect,
    recheckDirect,
    onEndpointSwitch(_current: string, reason: EndpointSwitchReason): void {
      lastSwitchReason = reason;
      notify();
    },
    getStatus: buildStatus,
    policy: (): TransportPolicy => ({ ...policy }),
    killSwitch: (): KillSwitch => ({ ...killSwitch }),
  };
}
