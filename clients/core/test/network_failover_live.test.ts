// QA-NET-001 — hermetic live transport gate for the T-604 connection manager.
//
// Unlike conn_manager.test.ts, this test uses real loopback TCP listeners and the real Node fetch.
// Two ingress addresses share one authoritative in-memory state, modelling direct and RU relay paths to
// the same GreenChat backend. The direct listener is then physically closed and reopened on the same
// port. The client must move direct -> relay -> direct while preserving state and resolving both HTTP
// and WebSocket routes against the active, allow-listed endpoint.
//
// This is deliberately NOT evidence for the physical RU/DE production gate: it does not exercise
// REALITY/xray, Cloudflare WARP, TSPU blocking or real WebSocket frame delivery. It is the deterministic
// source-level live pre-gate that catches integration gaps hidden by fake-fetch unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign as signDetached } from "node:crypto";
import {
  createEndpointFetch,
  createEndpointManager,
  createEndpointWebSocket,
  type StructuredEndpoint,
} from "../src/endpoints.ts";
import { createConnectionManager, memoryConnKv, type ConnectionManager } from "../src/conn_manager.ts";
import { canonicalizeConfigCore } from "../src/config_verify.ts";

interface SharedState {
  value: number;
  requests: Array<{ ingress: string; method: string; path: string }>;
}

interface Ingress {
  server: Server;
  origin: string;
  port: number;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.byteLength),
    connection: "close",
  });
  res.end(bytes);
}

async function startIngress(ingress: string, shared: SharedState, port = 0): Promise<Ingress> {
  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    shared.requests.push({ ingress, method, path });

    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true, ingress });
      return;
    }
    if (method === "GET" && path === "/v1/state") {
      json(res, 200, { value: shared.value, ingress });
      return;
    }
    if (method === "POST" && path === "/v1/state") {
      try {
        const body = await readJsonBody(req) as { value?: unknown } | null;
        if (body === null || !Number.isSafeInteger(body.value)) {
          json(res, 400, { error: "invalid value" });
          return;
        }
        shared.value = body.value as number;
        json(res, 200, { value: shared.value, ingress });
      } catch {
        json(res, 400, { error: "invalid json" });
      }
      return;
    }
    json(res, 404, { error: "not found" });
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
  return { server, port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

async function stopIngress(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function getState(fetchImpl: typeof fetch): Promise<{ value: number; ingress: string }> {
  const response = await fetchImpl("/v1/state");
  assert.equal(response.status, 200);
  return await response.json() as { value: number; ingress: string };
}

async function setState(fetchImpl: typeof fetch, value: number): Promise<{ value: number; ingress: string }> {
  const response = await fetchImpl("/v1/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  assert.equal(response.status, 200);
  return await response.json() as { value: number; ingress: string };
}

function signedConfig(direct: string, relay: string): {
  body: Record<string, unknown>;
  pin: string;
} {
  const directEndpoint: StructuredEndpoint = {
    id: "de-direct",
    base: direct,
    region: "de",
    transport: "direct",
    priority: 10,
    weight: 100,
  };
  const relayEndpoint: StructuredEndpoint = {
    id: "ru-relay",
    base: relay,
    region: "ru",
    transport: "reality",
    priority: 20,
    weight: 100,
    reality: {
      host: "127.0.0.1",
      port: new URL(relay).port === "" ? 80 : Number(new URL(relay).port),
      sni: "local.invalid",
      fingerprint: "chrome",
      public_key: "qa-local-only",
      short_id: "qa01",
    },
  };
  const core = {
    endpoints: [directEndpoint, relayEndpoint],
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

test("QA-NET-001 live loopback direct -> relay -> direct preserves state and route selection", async (t) => {
  const shared: SharedState = { value: 0, requests: [] };
  let direct = await startIngress("direct", shared);
  const relay = await startIngress("relay", shared);
  t.after(async () => {
    if (direct.server.listening) await stopIngress(direct.server);
    if (relay.server.listening) await stopIngress(relay.server);
  });

  let connectionManager!: ConnectionManager;
  const endpointManager = createEndpointManager({
    primary: direct.origin,
    selfOrigin: null,
    onSwitch: (current, reason) => connectionManager.onEndpointSwitch(current, reason),
  });
  const { body, pin } = signedConfig(direct.origin, relay.origin);
  connectionManager = createConnectionManager({
    manager: endpointManager,
    fetchImpl: globalThis.fetch.bind(globalThis),
    kv: memoryConnKv(),
    networkId: () => "qa-loopback-network",
    configSignaturePin: pin,
  });

  assert.equal(await connectionManager.applyConfigVerified(body), true, "signed config accepted before routing");
  assert.deepEqual(endpointManager.candidates(), [direct.origin, relay.origin]);

  const endpointFetch = createEndpointFetch(endpointManager, globalThis.fetch.bind(globalThis));
  const wsUrls: string[] = [];
  class CaptureWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    constructor(url: string | URL) {
      wsUrls.push(String(url));
    }
  }
  const EndpointWebSocket = createEndpointWebSocket(endpointManager, CaptureWebSocket as unknown as typeof WebSocket);

  assert.equal(await connectionManager.connect(), direct.origin);
  assert.deepEqual(await getState(endpointFetch), { value: 0, ingress: "direct" });
  assert.deepEqual(await setState(endpointFetch, 1), { value: 1, ingress: "direct" });
  new EndpointWebSocket("/v1/ws");

  const directPort = direct.port;
  await stopIngress(direct.server);
  assert.equal(await connectionManager.connect(), relay.origin, "closed direct listener forces L1 relay");
  assert.equal(connectionManager.getStatus().tier, "backup");
  assert.deepEqual(await getState(endpointFetch), { value: 1, ingress: "relay" }, "authoritative state survives path change");
  assert.deepEqual(await setState(endpointFetch, 2), { value: 2, ingress: "relay" });
  new EndpointWebSocket("/v1/ws");

  direct = await startIngress("direct", shared, directPort);
  assert.equal(await connectionManager.recheckDirect(), true, "recovered direct listener returns client to L0");
  assert.equal(endpointManager.current(), direct.origin);
  assert.equal(connectionManager.getStatus().lastSwitchReason, "recovered");
  assert.deepEqual(await getState(endpointFetch), { value: 2, ingress: "direct" }, "relay mutation remains visible after L0 recovery");
  new EndpointWebSocket("/v1/ws");

  assert.deepEqual(wsUrls, [
    direct.origin.replace(/^http/, "ws") + "/v1/ws",
    relay.origin.replace(/^http/, "ws") + "/v1/ws",
    direct.origin.replace(/^http/, "ws") + "/v1/ws",
  ]);
  assert.ok(shared.requests.some((r) => r.ingress === "direct" && r.path === "/health"));
  assert.ok(shared.requests.some((r) => r.ingress === "relay" && r.path === "/health"));
  assert.equal(shared.value, 2);
});
