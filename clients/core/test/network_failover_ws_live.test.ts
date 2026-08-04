// QA-NET-002 — live WebSocket frame/replay continuity through two loopback ingress paths.
//
// A real compiled GreenChat server owns the only database and realtime event log. Two reverse ingress
// listeners (direct and relay) forward HTTP and WebSocket upgrades to that same backend. The shipping
// EndpointManager/ConnectionManager, endpoint-aware fetch/WebSocket wrappers, ApiClient and WsClient
// must preserve one authenticated message stream across direct -> relay -> recovered direct.
//
// This remains a hermetic source-level pre-gate. It proves actual WebSocket handshakes, frames and
// resume-by-seq over real TCP, but it does not emulate REALITY/xray, WARP, TLS/DNS or a physical RU/TSPU
// network. Therefore it cannot by itself close M-NETWORK-FALLBACK.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { generateKeyPairSync, sign as signDetached } from "node:crypto";
import { startLiveServer, emptyTokens, waitFor } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { WsClient } from "../src/ws.ts";
import {
  createEndpointFetch,
  createEndpointManager,
  createEndpointWebSocket,
  type StructuredEndpoint,
} from "../src/endpoints.ts";
import { createConnectionManager, memoryConnKv, type ConnectionManager } from "../src/conn_manager.ts";
import { canonicalizeConfigCore } from "../src/config_verify.ts";
import type { SessionResult, SyncEvent } from "../src/types.ts";

interface IngressStats {
  httpRequests: number;
  wsUpgrades: number;
}

interface Ingress {
  server: Server;
  origin: string;
  port: number;
  close: () => Promise<void>;
}

type Destroyable = { destroy: () => void };

function forwardedHeaders(headers: IncomingHttpHeaders, backendHost: string): string[] {
  const out: string[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() === "host" || raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) out.push(`${name}: ${value}`);
    } else {
      out.push(`${name}: ${raw}`);
    }
  }
  out.push(`host: ${backendHost}`);
  return out;
}

async function startIngress(
  backendOrigin: string,
  stats: IngressStats,
  port = 0,
): Promise<Ingress> {
  const backend = new URL(backendOrigin);
  const backendPort = backend.port === "" ? 80 : Number(backend.port);
  const live = new Set<Destroyable>();
  let closed = false;

  const server = createServer((req, res) => {
    stats.httpRequests += 1;
    const upstream = httpRequest({
      hostname: backend.hostname,
      port: backendPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: backend.host, connection: "close" },
      agent: false,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    live.add(upstream);
    upstream.once("close", () => live.delete(upstream));
    upstream.once("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connection", (socket) => {
    live.add(socket);
    socket.once("close", () => live.delete(socket));
  });

  server.on("upgrade", (req, clientSocket: Duplex, head) => {
    stats.wsUpgrades += 1;
    const upstream = netConnect({ host: backend.hostname, port: backendPort });
    live.add(upstream);
    upstream.once("close", () => live.delete(upstream));
    upstream.once("error", () => clientSocket.destroy());
    clientSocket.once("error", () => upstream.destroy());
    upstream.once("connect", () => {
      const requestLine = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`;
      const headers = forwardedHeaders(req.headers, backend.host);
      upstream.write(`${requestLine}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.byteLength > 0) upstream.write(head);
      clientSocket.pipe(upstream).pipe(clientSocket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    server,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of live) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let usernameSeq = 0;
function username(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(usernameSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}

async function register(api: ApiClient, prefix: string): Promise<SessionResult & { user: { id: number } }> {
  const body: Record<string, unknown> = {
    username: username(prefix),
    name: prefix,
    legal_accepted: true,
    age_confirmed: true,
  };
  body.password = "QaNetWs-Only-123456!";
  const result = await api.post<SessionResult>("/v1/auth/register", body, { idempotent: false });
  api.tokens.access = result.access_token;
  api.tokens.refresh = result.refresh_token;
  api.tokens.accessExpiresAt = result.access_expires_at;
  return result as SessionResult & { user: { id: number } };
}

function signedConfig(direct: string, relay: string): { body: Record<string, unknown>; pin: string } {
  const endpoints: StructuredEndpoint[] = [
    {
      id: "de-direct",
      base: direct,
      region: "de",
      transport: "direct",
      priority: 10,
      weight: 100,
    },
    {
      id: "ru-relay",
      base: relay,
      region: "ru",
      transport: "reality",
      priority: 20,
      weight: 100,
      reality: {
        host: "127.0.0.1",
        port: Number(new URL(relay).port),
        sni: "local.invalid",
        fingerprint: "chrome",
        public_key: "qa-local-only",
        short_id: "qa02",
      },
    },
  ];
  const core = {
    endpoints,
    policy: {
      probe_timeout_ms: 500,
      failures_before_rotate: 1,
      race_direct_vs_known_good: true,
      sticky_per_network_ttl_s: 3600,
    },
    kill_switch: { force_transport: null },
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (typeof publicJwk.x !== "string") throw new Error("generated Ed25519 public JWK has no x coordinate");
  const pin = publicJwk.x;
  const signature = signDetached(null, Buffer.from(canonicalizeConfigCore(core)), privateKey).toString("base64");
  return { body: { ...core, signature, public_key: pin }, pin };
}

function messageText(event: SyncEvent): string | null {
  if (event.type !== "message.new") return null;
  const payload = event.payload as { message?: { text?: unknown } };
  return typeof payload.message?.text === "string" ? payload.message.text : null;
}

function assertExactlyOnce(events: readonly SyncEvent[], expected: readonly string[]): void {
  const messages = events
    .map((event) => ({ seq: event.seq, text: messageText(event) }))
    .filter((row): row is { seq: number; text: string } => typeof row.seq === "number" && row.text !== null)
    .filter((row) => expected.includes(row.text));
  assert.deepEqual(messages.map((row) => row.text), expected, "all transition messages arrived in order");
  assert.equal(new Set(messages.map((row) => row.seq)).size, messages.length, "no durable event was duplicated");
  for (let i = 1; i < messages.length; i++) {
    assert.ok(messages[i].seq > messages[i - 1].seq, "durable seq remains strictly increasing");
  }
}

test("QA-NET-002 real WS frames replay across direct -> relay -> recovered direct", async (t) => {
  const backend = await startLiveServer();
  const directStats: IngressStats = { httpRequests: 0, wsUpgrades: 0 };
  const relayStats: IngressStats = { httpRequests: 0, wsUpgrades: 0 };
  let direct = await startIngress(backend.base, directStats);
  let relay = await startIngress(backend.base, relayStats);
  let ws: WsClient | null = null;

  t.after(async () => {
    ws?.close();
    await direct.close();
    await relay.close();
    await backend.teardown();
  });

  let connectionManager!: ConnectionManager;
  const endpointManager = createEndpointManager({
    primary: direct.origin,
    selfOrigin: null,
    onSwitch: (current, reason) => connectionManager.onEndpointSwitch(current, reason),
  });
  const signed = signedConfig(direct.origin, relay.origin);
  connectionManager = createConnectionManager({
    manager: endpointManager,
    fetchImpl: globalThis.fetch.bind(globalThis),
    kv: memoryConnKv(),
    networkId: () => "qa-ws-loopback",
    configSignaturePin: signed.pin,
  });
  assert.equal(await connectionManager.applyConfigVerified(signed.body), true);
  assert.equal(await connectionManager.connect(), direct.origin);

  const routedFetch = createEndpointFetch(endpointManager, globalThis.fetch.bind(globalThis));
  const routedWebSocket = createEndpointWebSocket(endpointManager, globalThis.WebSocket);
  const apiA = new ApiClient({ baseUrl: "", clientId: "qa-net/1", tokens: emptyTokens(), fetchImpl: routedFetch });
  const apiB = new ApiClient({ baseUrl: "", clientId: "qa-net/1", tokens: emptyTokens(), fetchImpl: routedFetch });
  const alice = await register(apiA, "Alice");
  const bob = await register(apiB, "Bob");
  const controlA = new ApiClient({ baseUrl: backend.base, clientId: "qa-control/1", tokens: apiA.tokens });
  const dialog = await apiA.post<{ id: number }>("/v1/chats/dialog", { user_id: bob.user.id }, { idempotent: false });
  assert.ok(alice.user.id > 0);

  const events: SyncEvent[] = [];
  let appliedCursor = 0;
  ws = new WsClient({
    baseUrl: "",
    tokens: apiB.tokens,
    getSince: () => appliedCursor,
    onEvent: (event) => {
      if (event.seq !== null) appliedCursor = Math.max(appliedCursor, event.seq);
      events.push(event);
    },
    wsImpl: routedWebSocket,
    minBackoffMs: 500,
    maxBackoffMs: 500,
    heartbeatMs: 2_000,
    authTimeoutMs: 2_000,
    randomImpl: () => 0,
  });
  ws.start();
  await waitFor(() => ws?.getState() === "open" && directStats.wsUpgrades >= 1);

  await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "qa-net-1", text: "direct-live" });
  await waitFor(() => events.some((event) => messageText(event) === "direct-live"));

  const directPort = direct.port;
  await direct.close();
  await waitFor(() => ws?.getState() === "reconnecting");
  await controlA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "qa-net-2", text: "direct-gap" });
  assert.equal(await connectionManager.connect(), relay.origin);
  await waitFor(() => ws?.getState() === "open" && relayStats.wsUpgrades >= 1);
  await waitFor(() => events.some((event) => messageText(event) === "direct-gap"));

  await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "qa-net-3", text: "relay-live" });
  await waitFor(() => events.some((event) => messageText(event) === "relay-live"));

  direct = await startIngress(backend.base, directStats, directPort);
  assert.equal(await connectionManager.recheckDirect(), true);
  assert.equal(endpointManager.current(), direct.origin);

  await relay.close();
  await waitFor(() => ws?.getState() === "reconnecting");
  await controlA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "qa-net-4", text: "relay-gap" });
  await waitFor(() => ws?.getState() === "open" && directStats.wsUpgrades >= 2);
  await waitFor(() => events.some((event) => messageText(event) === "relay-gap"));

  await apiA.post(`/v1/chats/${dialog.id}/messages`, { client_msg_id: "qa-net-5", text: "direct-recovered" });
  await waitFor(() => events.some((event) => messageText(event) === "direct-recovered"));

  assertExactlyOnce(events, ["direct-live", "direct-gap", "relay-live", "relay-gap", "direct-recovered"]);
  assert.equal(connectionManager.getStatus().tier, "direct");
  assert.equal(connectionManager.getStatus().lastSwitchReason, "recovered");
  assert.ok(directStats.httpRequests > 0 && relayStats.httpRequests > 0, "both ingress paths carried HTTP");
  assert.ok(directStats.wsUpgrades >= 2 && relayStats.wsUpgrades >= 1, "WS upgraded through direct, relay, direct");
});
