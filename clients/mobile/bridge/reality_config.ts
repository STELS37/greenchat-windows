// T-605 / NR-05: deterministic sing-box configuration for GreenChat's Android app-scoped transport.
// There is no TUN/VpnService. The WebView talks to one loopback SOCKS5 listener; exact GreenChat direct
// origins leave directly, exact bridge origins leave through their signed VLESS/REALITY outbound, and
// every other destination is blocked. Endpoint credentials are public-but-constrained relay credentials,
// never general-purpose VPN secrets.
import type { StructuredEndpoint } from "../../core/src/endpoints.ts";

const PIN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_ID = /^(?:[0-9a-f]{2}){1,8}$/i;
const HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const FINGERPRINTS = new Set(["chrome", "firefox", "safari", "edge", "randomized"]);
const FLOW = "xtls-rprx-vision";
const SCOPE = "greenchat-only";

function isIpv4(value: string): boolean {
  if (value === "0.0.0.0") return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) =>
    /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
  );
}

function isDnsHost(value: string): boolean {
  return HOST.test(value) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function isRelayHost(value: string): boolean {
  return isDnsHost(value) || isIpv4(value);
}

export interface RealityEngineOptions {
  listenPort?: number;
  directEndpoints: readonly StructuredEndpoint[];
  realityEndpoints: readonly StructuredEndpoint[];
}

export interface RealityEnginePlan {
  proxyUrl: string;
  configJson: string;
  directOrigins: string[];
  bridgeOrigins: string[];
  routeIds: string[];
}

function httpsOrigin(raw: string, label: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label}: invalid URL`); }
  if (url.protocol !== "https:" || url.origin !== raw.replace(/\/$/, "")) {
    throw new Error(`${label}: exact HTTPS origin required`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label}: credentials/path/query/fragment forbidden`);
  }
  if (!isDnsHost(url.hostname)) throw new Error(`${label}: DNS hostname required`);
  return url;
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error("listenPort: 1024..65535 required");
  return value;
}

function requiredReality(endpoint: StructuredEndpoint) {
  if (endpoint.transport !== "reality") throw new Error(`${endpoint.id}: transport must be reality`);
  const r = endpoint.reality;
  if (!r) throw new Error(`${endpoint.id}: reality parameters required`);
  if (!isRelayHost(r.host)) throw new Error(`${endpoint.id}: invalid relay host`);
  if (!Number.isSafeInteger(r.port) || r.port < 1 || r.port > 65535) throw new Error(`${endpoint.id}: invalid relay port`);
  if (!isDnsHost(r.sni)) throw new Error(`${endpoint.id}: invalid REALITY SNI`);
  if (!FINGERPRINTS.has(r.fingerprint)) throw new Error(`${endpoint.id}: unsupported uTLS fingerprint`);
  if (!PIN.test(r.public_key)) throw new Error(`${endpoint.id}: invalid REALITY public key`);
  if (!SHORT_ID.test(r.short_id)) throw new Error(`${endpoint.id}: invalid REALITY short id`);
  if (typeof r.uuid !== "string" || !UUID.test(r.uuid)) throw new Error(`${endpoint.id}: canonical VLESS UUID required`);
  if (r.flow !== FLOW) throw new Error(`${endpoint.id}: flow must be ${FLOW}`);
  if (r.credential_scope !== SCOPE) throw new Error(`${endpoint.id}: credential_scope must be ${SCOPE}`);
  return r as Required<typeof r>;
}

export function buildRealityEnginePlan(options: RealityEngineOptions): RealityEnginePlan {
  const listenPort = validPort(options.listenPort ?? 20808);
  if (options.directEndpoints.length < 1) throw new Error("at least one direct endpoint required");
  if (options.realityEndpoints.length < 1) throw new Error("at least one REALITY endpoint required");
  const directOrigins: string[] = [];
  const bridgeOrigins: string[] = [];
  const routeIds: string[] = [];
  const usedOrigins = new Set<string>();
  const usedHosts = new Set<string>();
  const usedIds = new Set<string>();

  for (const endpoint of options.directEndpoints) {
    if (endpoint.transport !== "direct") throw new Error(`${endpoint.id}: direct endpoint transport mismatch`);
    const url = httpsOrigin(endpoint.base, endpoint.id);
    const origin = url.origin;
    if (usedOrigins.has(origin)) throw new Error(`${endpoint.id}: duplicate endpoint origin`);
    if (usedHosts.has(url.hostname)) throw new Error(`${endpoint.id}: duplicate route hostname`);
    usedOrigins.add(origin);
    usedHosts.add(url.hostname);
    directOrigins.push(origin);
  }

  const outbounds: Record<string, unknown>[] = [{ type: "direct", tag: "gc-direct" }];
  const rules: Record<string, unknown>[] = directOrigins.map((origin) => ({
    domain: [new URL(origin).hostname],
    outbound: "gc-direct",
  }));

  for (const endpoint of options.realityEndpoints) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(endpoint.id) || usedIds.has(endpoint.id)) {
      throw new Error(`${endpoint.id || "reality"}: invalid/duplicate route id`);
    }
    usedIds.add(endpoint.id);
    const url = httpsOrigin(endpoint.base, endpoint.id);
    const origin = url.origin;
    if (usedOrigins.has(origin)) throw new Error(`${endpoint.id}: bridge origin must differ from every direct origin`);
    if (usedHosts.has(url.hostname)) throw new Error(`${endpoint.id}: duplicate route hostname`);
    usedOrigins.add(origin);
    usedHosts.add(url.hostname);
    const r = requiredReality(endpoint);
    const tag = `gc-reality-${endpoint.id}`;
    bridgeOrigins.push(origin);
    routeIds.push(endpoint.id);
    outbounds.push({
      type: "vless",
      tag,
      server: r.host,
      server_port: r.port,
      uuid: r.uuid,
      flow: r.flow,
      tls: {
        enabled: true,
        server_name: r.sni,
        utls: { enabled: true, fingerprint: r.fingerprint },
        reality: { enabled: true, public_key: r.public_key, short_id: r.short_id },
      },
    });
    rules.push({ domain: [new URL(origin).hostname], outbound: tag });
  }
  outbounds.push({ type: "block", tag: "gc-block" });

  const config = {
    log: { level: "warn", timestamp: false },
    inbounds: [{ type: "mixed", tag: "gc-loopback", listen: "127.0.0.1", listen_port: listenPort }],
    outbounds,
    route: { rules, final: "gc-block", auto_detect_interface: false },
  };
  return {
    proxyUrl: `socks://127.0.0.1:${listenPort}`,
    configJson: JSON.stringify(config),
    directOrigins,
    bridgeOrigins,
    routeIds,
  };
}
