// clients/core — EndpointManager: runtime-switchable server address with sticky auto-failover and
// anti-exfiltration (T-419, "сетевая устойчивость и «свой сервер»").
//
// The whole SDK talks to ONE base URL that must be (a) chosen by the user («свой сервер»), (b) able to
// fail over to hardwired / server-advertised fallbacks after repeated NETWORK errors, and (c) unable to
// leak traffic anywhere except the configured addresses. Rather than thread a mutable base through
// ApiClient / WsClient / FileUploader / MediaCache (and rewrite their tests), every transport keeps
// baseUrl:"" (paths stay relative — "/v1/…", "/v1/ws") and we inject two thin wrappers:
//
//   - createEndpointFetch      resolves a relative "/…" against the manager's current endpoint, counts
//     fetch REJECTIONS (network failures) and, after `threshold` in a row, advances to the next candidate
//     (sticky until the NEXT streak) — and REFUSES any absolute URL whose origin is not one of the
//     configured endpoints. That refusal is the mandatory anti-exfiltration gate: "исходящие соединения
//     клиента — ТОЛЬКО на настроенные адреса сервера".
//   - createEndpointWebSocket  resolves a relative "/v1/ws" against the ws(s) origin of the current
//     endpoint, with the same allow-list guard. Because WsClient re-reads the socket URL on every
//     reconnect, a failover driven by the HTTP path is picked up by the next WS reconnect for free — no
//     coupling between the two transports is needed.
//
// Same-origin web keeps current="" so both wrappers are inert (paths stay relative, no CORS, no proxy
// code — a self-hoster or a native shell points `primary` at an absolute origin and gets failover). The
// module is pure and dependency-free (only ./errors), so its behaviour is unit-tested in node.
import { NetworkError } from "./errors.ts";

// ---------------------------------------------------------------------------------------------------
// T-604 (NR-04): client mirror of the T-602 structural /v1/config schema. Field-for-field the server's
// NrEndpoint/NrReality (server/src/core/config.ts) — the server normalizes and geo-orders the list,
// the client only validates defensively and re-orders by priority/weight. `reality` is carried through
// for the T-605 REALITY connector; nothing in this module dials it.
export interface RealityParams {
  host: string;
  port: number;
  sni: string;
  fingerprint: string;
  public_key: string;
  short_id: string;
  uuid?: string;
  flow?: string;
  credential_scope?: string;
}

export interface StructuredEndpoint {
  id: string;
  base: string;
  region: string;
  transport: string; // "direct" | "reality" | future transports — free-form on the wire
  priority: number; // ascending: lower tries first
  weight: number; // descending within a priority tier
  reality?: RealityParams;
}

// T-602 `policy{}` — the server-driven knobs the connection manager obeys (NETWORK_RESILIENCE §4).
export interface TransportPolicy {
  probe_timeout_ms: number;
  failures_before_rotate: number;
  race_direct_vs_known_good: boolean;
  sticky_per_network_ttl_s: number;
}

// T-602 `kill_switch{}` — the operator's emergency pin ("direct" | "reality" | null).
export interface KillSwitch {
  force_transport: string | null;
}

// /v1/config `endpoints[]` items come in two shapes: legacy flat strings (GC_ENDPOINTS) and T-602
// structural objects (GC_ENDPOINTS_JSON). Both are accepted everywhere a list enters the manager.
export type EndpointInput = string | StructuredEndpoint;

export function isStructuredEndpoint(v: EndpointInput): v is StructuredEndpoint {
  return typeof v !== "string";
}

const DEFAULT_PRIORITY = 100;
const DEFAULT_WEIGHT = 100;

// Parse ONE /v1/config endpoints[] item of unknown shape. Strings pass through (legacy); objects need
// at least {id, base} — the same minimum the server enforces (config.ts normalizeEndpoint) — and get
// the same defaults for the rest, so a hand-rolled or older server payload cannot crash the client.
export function parseEndpointInput(raw: unknown): EndpointInput | null {
  if (typeof raw === "string") return raw.trim() === "" ? null : raw.trim();
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const base = typeof r.base === "string" ? r.base.trim() : "";
  if (id === "" || base === "") return null;
  const ep: StructuredEndpoint = {
    id,
    base,
    region: typeof r.region === "string" ? r.region.trim().toLowerCase() : "",
    transport: typeof r.transport === "string" && r.transport.trim() !== "" ? r.transport.trim() : "direct",
    priority: typeof r.priority === "number" && Number.isFinite(r.priority) ? Math.floor(r.priority) : DEFAULT_PRIORITY,
    weight: typeof r.weight === "number" && Number.isFinite(r.weight) ? Math.floor(r.weight) : DEFAULT_WEIGHT,
  };
  const rr = r.reality;
  if (rr !== null && typeof rr === "object") {
    const q = rr as Record<string, unknown>;
    const host = typeof q.host === "string" ? q.host.trim() : "";
    if (host !== "") {
      ep.reality = {
        host,
        port: typeof q.port === "number" && Number.isFinite(q.port) ? Math.floor(q.port) : 443,
        sni: typeof q.sni === "string" ? q.sni.trim() : "",
        fingerprint: typeof q.fingerprint === "string" && q.fingerprint.trim() !== "" ? q.fingerprint.trim() : "chrome",
        public_key: typeof q.public_key === "string" ? q.public_key.trim() : "",
        short_id: typeof q.short_id === "string" ? q.short_id.trim() : "",
        ...(typeof q.uuid === "string" ? { uuid: q.uuid.trim() } : {}),
        ...(typeof q.flow === "string" ? { flow: q.flow.trim() } : {}),
        ...(typeof q.credential_scope === "string" ? { credential_scope: q.credential_scope.trim() } : {}),
      };
    }
  }
  return ep;
}

// Order a mixed endpoints[] list: ascending priority, ties by descending weight, otherwise stable
// (original index — the server's geo-aware order). Legacy strings carry the defaults, so a pure-legacy
// list keeps its server order byte-for-byte. NOTE: this only shapes the CANDIDATE order; the actual
// active endpoint is decided by reachability probes (conn_manager), so re-sorting a geo-ordered list
// by priority cannot strand a client on an unreachable address.
export function orderEndpointInputs(list: readonly EndpointInput[]): EndpointInput[] {
  return list
    .map((e, index) => ({ e, index }))
    .sort((a, b) => {
      const pa = isStructuredEndpoint(a.e) ? a.e.priority : DEFAULT_PRIORITY;
      const pb = isStructuredEndpoint(b.e) ? b.e.priority : DEFAULT_PRIORITY;
      if (pa !== pb) return pa - pb;
      const wa = isStructuredEndpoint(a.e) ? a.e.weight : DEFAULT_WEIGHT;
      const wb = isStructuredEndpoint(b.e) ? b.e.weight : DEFAULT_WEIGHT;
      if (wa !== wb) return wb - wa;
      return a.index - b.index;
    })
    .map((x) => x.e);
}

// The URL an endpoint input contributes to the candidate list.
export function endpointBase(e: EndpointInput): string {
  return typeof e === "string" ? e : e.base;
}
// ---------------------------------------------------------------------------------------------------

export interface EndpointManagerOptions {
  // The active-by-default address. "" means same-origin (web PWA served by the server). An absolute
  // http(s) origin means "talk to this server" (self-host / native shell).
  primary: string;
  // Hardwired build-time fallbacks, tried in order after the primary. `mergeEndpoints` later appends the
  // server-advertised `endpoints[]` from /v1/config (T-125) without duplicating.
  fallbacks?: readonly string[];
  // Auto-rotation on repeated network failure. Default true; user-toggleable ("отключаема в настройках").
  autoFailover?: boolean;
  // Consecutive network errors on the current endpoint before switching to the next. Default 3.
  threshold?: number;
  // The origin that "" resolves to for the allow-list (browser: location.origin). Defaults to
  // location.origin when available, else null (relative-only; absolute same-origin cannot be verified).
  selfOrigin?: string | null;
  // Notified whenever the ACTIVE endpoint changes (failover / primary change / manual advance).
  onSwitch?: (current: string, reason: EndpointSwitchReason) => void;
}

export type EndpointSwitchReason = "failover" | "primary" | "manual";

export interface EndpointManager {
  // The active base URL ("" = same-origin). Prepended to relative paths by the wrappers.
  current(): string;
  // The ordered, de-duplicated candidate list: [primary, ...fallbacks, ...merged].
  candidates(): string[];
  // Change the user-chosen server address; resets the active pointer to it (a different server is a
  // different account namespace — the shell pairs this with a logout).
  setPrimary(url: string): void;
  // Append server-advertised fallbacks (/v1/config endpoints[]); de-duplicated, active endpoint kept.
  // T-604: accepts legacy flat strings AND T-602 structural objects (mixed lists too); structural
  // entries are ordered by priority/weight before appending, and their metadata (transport/region/
  // reality) is retrievable via endpointInfo().
  mergeEndpoints(urls: readonly EndpointInput[]): void;
  // Replace the authoritative server-advertised set on a later /v1/config refresh. Removed mirrors
  // stop being allowed immediately; hardwired build fallbacks are unaffected.
  setAdvertisedEndpoints(urls: readonly EndpointInput[]): void;
  // T-604: structural metadata (T-602) for a candidate base URL, or null for legacy/unknown entries.
  // The primary and hardwired fallbacks are plain URLs, so they answer null (= implicit "direct").
  endpointInfo(base: string): StructuredEndpoint | null;
  setAutoFailover(on: boolean): void;
  autoFailoverEnabled(): boolean;
  // T-604: point the active endpoint at a specific configured candidate (a probe winner). Returns
  // false (and does nothing) when the base is not a current candidate — the anti-exfiltration set is
  // never widened by a select. Fires onSwitch with reason "manual" only on an actual change.
  select(base: string): boolean;
  // T-604: server-driven failure window (policy.failures_before_rotate). Same semantics as the
  // `threshold` construction option; invalid values (<1) are ignored.
  setFailoverThreshold(n: number): void;
  // Reset the consecutive-failure counter — a reachable endpoint (ANY HTTP response, incl. 5xx).
  reportSuccess(): void;
  // Count one network failure; may advance the active endpoint (sticky) when the streak hits threshold.
  reportNetworkError(): void;
  // Anti-exfiltration: is this URL allowed to leave the client? Relative "/…" always; absolute only when
  // its origin is one of the configured endpoints.
  isAllowed(url: string): boolean;
}

const DEFAULT_THRESHOLD = 3;

// Normalise a base URL. "" stays "" (same-origin). A bare host ("my.host:8443") gets https:// (secure by
// default). Anything with a non-http(s) scheme, or unparseable, is rejected (returns null). The result is
// reduced to a scheme+authority origin with no trailing slash (the server serves /v1 at the root).
export function normalizeBase(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.host) return null;
  return `${u.protocol}//${u.host}`;
}

// The http(s) origin an endpoint resolves to, for the allow-list. "" → selfOrigin. Never throws.
function originOf(base: string, selfOrigin: string | null): string | null {
  if (base === "") return selfOrigin;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

// http(s)://h → ws(s)://h (mirrors ws.ts toWsUrl). Applied to a normalized absolute base only.
function toWsOrigin(base: string): string {
  return base.replace(/^http/, "ws");
}

function detectSelfOrigin(): string | null {
  try {
    if (typeof location !== "undefined" && typeof location.origin === "string") return location.origin;
  } catch {
    /* no DOM */
  }
  return null;
}

// De-duplicate while preserving order (first occurrence wins).
function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function createEndpointManager(opts: EndpointManagerOptions): EndpointManager {
  const selfOrigin = opts.selfOrigin !== undefined ? opts.selfOrigin : detectSelfOrigin();
  let threshold = opts.threshold !== undefined && opts.threshold > 0 ? opts.threshold : DEFAULT_THRESHOLD;
  const onSwitch = opts.onSwitch;

  let primary = normalizeBase(opts.primary) ?? "";
  const fallbacks = dedupe((opts.fallbacks ?? []).map(normalizeBase).filter((x): x is string => x !== null));
  let merged: string[] = [];
  // T-604: structural T-602 metadata keyed by the NORMALIZED base URL of an advertised endpoint. Only
  // entries that survived normalization are kept, so info and candidates never disagree.
  let mergedInfo = new Map<string, StructuredEndpoint>();
  let auto = opts.autoFailover !== false; // default true
  let idx = 0;
  let failures = 0;

  const buildList = (): string[] => dedupe([primary, ...fallbacks, ...merged]);
  let list = buildList();

  const current = (): string => list[idx] ?? primary;

  // Normalize a mixed legacy/structural advertised list into [normalized bases, base→metadata map].
  // Structural entries are priority/weight-ordered first (a pure-legacy list keeps server order).
  const normalizeInputs = (urls: readonly EndpointInput[]): { bases: string[]; info: Map<string, StructuredEndpoint> } => {
    const bases: string[] = [];
    const info = new Map<string, StructuredEndpoint>();
    for (const item of orderEndpointInputs(urls)) {
      const norm = normalizeBase(endpointBase(item));
      if (norm === null) continue;
      bases.push(norm);
      if (isStructuredEndpoint(item) && !info.has(norm)) info.set(norm, item);
    }
    return { bases: dedupe(bases), info };
  };

  const allowedOrigins = (): Set<string> => {
    const set = new Set<string>();
    for (const c of list) {
      const o = originOf(c, selfOrigin);
      if (o) set.add(o);
    }
    return set;
  };

  return {
    current,
    candidates(): string[] {
      return [...list];
    },
    setPrimary(url: string): void {
      const norm = normalizeBase(url);
      if (norm === null) return; // reject junk silently; the UI validates before calling
      primary = norm;
      // Advertised mirrors belong to the OLD server namespace. Keeping them after a manual server
      // switch would allow failover back to an unrelated host and violate the anti-exfiltration rule.
      merged = [];
      mergedInfo = new Map();
      list = buildList();
      idx = 0;
      failures = 0;
      onSwitch?.(current(), "primary");
    },
    mergeEndpoints(urls: readonly EndpointInput[]): void {
      const { bases, info } = normalizeInputs(urls);
      const active = current();
      merged = dedupe([...merged, ...bases]);
      for (const [k, v] of info) if (!mergedInfo.has(k)) mergedInfo.set(k, v);
      list = buildList();
      const at = list.indexOf(active);
      idx = at >= 0 ? at : 0;
      failures = 0;
    },
    setAdvertisedEndpoints(urls: readonly EndpointInput[]): void {
      const { bases, info } = normalizeInputs(urls);
      const active = current();
      merged = bases;
      mergedInfo = info;
      list = buildList();
      const at = list.indexOf(active);
      idx = at >= 0 ? at : 0;
      failures = 0;
    },
    endpointInfo(base: string): StructuredEndpoint | null {
      const norm = normalizeBase(base);
      if (norm === null || norm === "") return null;
      return mergedInfo.get(norm) ?? null;
    },
    setAutoFailover(on: boolean): void {
      auto = on;
      failures = 0;
    },
    autoFailoverEnabled(): boolean {
      return auto;
    },
    select(base: string): boolean {
      const norm = normalizeBase(base);
      if (norm === null) return false;
      const at = list.indexOf(norm);
      if (at < 0) return false; // not a configured candidate — never widen the allow-list
      if (at === idx) return true; // already active; no switch event
      idx = at;
      failures = 0;
      onSwitch?.(current(), "manual");
      return true;
    },
    setFailoverThreshold(n: number): void {
      if (Number.isFinite(n) && n >= 1) threshold = Math.floor(n);
    },
    reportSuccess(): void {
      failures = 0;
    },
    reportNetworkError(): void {
      if (!auto) return;
      if (list.length <= 1) return; // nowhere to fail over to
      failures++;
      if (failures < threshold) return;
      failures = 0;
      idx = (idx + 1) % list.length;
      onSwitch?.(current(), "failover");
    },
    isAllowed(url: string): boolean {
      const s = url.trim();
      if (s === "") return false;
      if (s.startsWith("/")) return true; // relative → resolved against current(), always ours
      let origin: string;
      try {
        origin = new URL(s).origin;
      } catch {
        return false;
      }
      const allowed = allowedOrigins();
      if (allowed.has(origin)) return true;
      // Map a ws(s) origin to its http(s) equivalent so a WebSocket URL matches an http endpoint.
      if (origin.startsWith("ws")) return allowed.has(origin.replace(/^ws/, "http"));
      return false;
    },
  };
}

// Extract a string URL from the three fetch input shapes without assuming a DOM Request exists.
function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// Best-effort origin for a log message (never throws, never includes a path/query — no PII).
function originSafe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown origin";
  }
}

// A fetch that resolves relative "/…" against the manager's current endpoint, enforces the allow-list on
// absolute URLs, and drives failover from network REJECTIONS (not server 5xx — those mean "reachable").
export function createEndpointFetch(manager: EndpointManager, baseFetch?: typeof fetch): typeof fetch {
  const doFetch = baseFetch ?? globalThis.fetch.bind(globalThis);
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    let target: string = url;
    if (url.startsWith("/")) {
      const cur = manager.current();
      target = cur === "" ? url : cur + url;
    } else if (!manager.isAllowed(url)) {
      // Anti-exfiltration: never let the SDK reach an origin that is not a configured server address.
      throw new NetworkError(`blocked: ${originSafe(url)} is not a configured server address`, undefined, false);
    }
    let res: Response;
    try {
      if (typeof input === "string" || input instanceof URL) {
        res = await doFetch(target, init);
      } else {
        // A Request object: rebuild it against the resolved absolute URL, preserving method/headers/body.
        res = target === url ? await doFetch(input, init) : await doFetch(new Request(target, input), init);
      }
    } catch (err) {
      manager.reportNetworkError();
      throw err;
    }
    manager.reportSuccess();
    return res;
  };
  return wrapped as typeof fetch;
}

// A WebSocket constructor that resolves a relative "/v1/ws" against the current endpoint's ws(s) origin
// and blocks absolute URLs outside the allow-list. Returned as `typeof WebSocket` so it drops straight
// into WsClient's `wsImpl`.
export function createEndpointWebSocket(manager: EndpointManager, baseWs?: typeof WebSocket): typeof WebSocket {
  const WS = baseWs ?? globalThis.WebSocket;
  const EndpointWebSocket = function (url: string | URL, protocols?: string | string[]): WebSocket {
    const raw = typeof url === "string" ? url : url.href;
    let target: string = raw;
    if (raw.startsWith("/")) {
      const cur = manager.current();
      target = cur === "" ? raw : toWsOrigin(cur) + raw;
    } else if (!manager.isAllowed(raw)) {
      throw new NetworkError(`blocked: ${originSafe(raw)} is not a configured server address`, undefined, false);
    }
    return protocols === undefined ? new WS(target) : new WS(target, protocols);
  } as unknown as { new (url: string | URL, protocols?: string | string[]): WebSocket } & Record<string, unknown>;
  // Preserve the prototype + the readyState constants callers read off the constructor.
  EndpointWebSocket.prototype = WS.prototype;
  EndpointWebSocket.CONNECTING = WS.CONNECTING;
  EndpointWebSocket.OPEN = WS.OPEN;
  EndpointWebSocket.CLOSING = WS.CLOSING;
  EndpointWebSocket.CLOSED = WS.CLOSED;
  return EndpointWebSocket as unknown as typeof WebSocket;
}
