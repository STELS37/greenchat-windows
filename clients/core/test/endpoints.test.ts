// T-419 — EndpointManager + the anti-exfiltration fetch/WebSocket wrappers. Pure, hermetic (no live
// server): a fake fetch/WebSocket drives the failover + allow-list logic deterministically. This file is
// the deterministic form of acceptance #1 ("основной адрес подменён на невалидный → клиент сам уходит на
// резервный ≤ 10 с"): three consecutive fetch rejections on the primary switch the client to the backup,
// which then serves the next request — no timers, no wall-clock, so it proves the mechanism in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEndpointManager,
  createEndpointFetch,
  createEndpointWebSocket,
  normalizeBase,
  parseEndpointInput,
  orderEndpointInputs,
  type StructuredEndpoint,
} from "../src/endpoints.ts";
import { NetworkError } from "../src/errors.ts";

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";

function resp(ok: boolean, status = ok ? 200 : 500): Response {
  return { ok, status } as unknown as Response;
}

// A fake fetch: routes by which endpoint the (already-resolved absolute) URL targets. `reject` hosts throw
// (network failure); everything else resolves with a 200. Records the last URL it was actually called with.
function fakeFetch(reject: (url: string) => boolean, ok: (url: string) => boolean = () => true): {
  fn: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = (async (input: string): Promise<Response> => {
    calls.push(input);
    if (reject(input)) throw new NetworkError("boom", undefined, false);
    return resp(ok(input));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// A controllable fake WebSocket that just records the URL it was constructed with (ws_auth.test.ts style).
class FakeWs {
  static last: FakeWs | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.last = this;
  }
}
const FakeWsCtor = FakeWs as unknown as typeof WebSocket;

test("normalizeBase: same-origin, bare host, scheme, origin reduction, rejects non-http(s)", () => {
  assert.equal(normalizeBase(""), "");
  assert.equal(normalizeBase("  "), "");
  assert.equal(normalizeBase("host.example:8443"), "https://host.example:8443");
  assert.equal(normalizeBase("http://a.example"), "http://a.example");
  assert.equal(normalizeBase("https://a.example/v1/x?y=1"), "https://a.example");
  assert.equal(normalizeBase("HTTPS://A.Example"), "https://a.example");
  assert.equal(normalizeBase("ftp://a.example"), null);
  assert.equal(normalizeBase("javascript:alert(1)"), null);
  assert.equal(normalizeBase("not a url"), null);
});

test("candidates + current: ordered, de-duplicated [primary, ...fallbacks]", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B, C, B], selfOrigin: null });
  assert.deepEqual(m.candidates(), [A, B, C]);
  assert.equal(m.current(), A);
});

test("failover: switches after exactly 3 consecutive network errors, sticky + wrap-around", () => {
  const switches: Array<[string, string]> = [];
  const m = createEndpointManager({
    primary: A,
    fallbacks: [B, C],
    selfOrigin: null,
    onSwitch: (cur, reason) => switches.push([cur, reason]),
  });
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), A, "two errors do not switch");
  m.reportNetworkError();
  assert.equal(m.current(), B, "third consecutive error switches to the backup");
  // Sticky: stays on B until the NEXT streak of three.
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), B);
  m.reportNetworkError();
  assert.equal(m.current(), C);
  // Wrap-around back to the primary after another streak.
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), A);
  assert.deepEqual(switches, [[B, "failover"], [C, "failover"], [A, "failover"]]);
});

test("reportSuccess resets the streak (a reachable endpoint, incl. 5xx, keeps us put)", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportSuccess();
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), A, "streak was interrupted → no switch");
  m.reportNetworkError();
  assert.equal(m.current(), B);
});

test("autoFailover off → never switches; re-enabling resumes", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], autoFailover: false, selfOrigin: null });
  for (let i = 0; i < 9; i++) m.reportNetworkError();
  assert.equal(m.current(), A);
  assert.equal(m.autoFailoverEnabled(), false);
  m.setAutoFailover(true);
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), B);
});

test("setPrimary resets the pointer to the new primary and rebuilds the list", () => {
  const switches: Array<[string, string]> = [];
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null, onSwitch: (c, r) => switches.push([c, r]) });
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), B);
  m.setPrimary("x.example");
  assert.equal(m.current(), "https://x.example");
  assert.deepEqual(m.candidates(), ["https://x.example", B]);
  assert.deepEqual(switches[switches.length - 1], ["https://x.example", "primary"]);
});

test("setPrimary drops mirrors advertised by the previous server", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  m.mergeEndpoints(["https://old-mirror.example"]);
  assert.equal(m.isAllowed("https://old-mirror.example/v1/config"), true);
  m.setPrimary("new.example");
  assert.deepEqual(m.candidates(), ["https://new.example", B]);
  assert.equal(m.isAllowed("https://old-mirror.example/v1/config"), false);
});

test("mergeEndpoints: de-dupes and keeps the active endpoint selected", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportNetworkError();
  assert.equal(m.current(), B);
  m.mergeEndpoints([B, "https://d.example"]); // B already known → de-duped
  assert.deepEqual(m.candidates(), [A, B, "https://d.example"]);
  assert.equal(m.current(), B, "active endpoint stays selected across a merge");
});

test("setAdvertisedEndpoints removes mirrors no longer published by config", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  m.setAdvertisedEndpoints(["https://old.example", "https://keep.example"]);
  assert.equal(m.isAllowed("https://old.example/v1/x"), true);
  m.setAdvertisedEndpoints(["https://keep.example", "https://new.example"]);
  assert.deepEqual(m.candidates(), [A, B, "https://keep.example", "https://new.example"]);
  assert.equal(m.isAllowed("https://old.example/v1/x"), false);
});

test("isAllowed: relative always; configured origins yes; foreign no; ws origin maps to http(s)", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  assert.equal(m.isAllowed("/v1/updates"), true);
  assert.equal(m.isAllowed(`${A}/v1/x`), true);
  assert.equal(m.isAllowed(`${B}/y`), true);
  assert.equal(m.isAllowed("https://evil.example/x"), false);
  assert.equal(m.isAllowed("wss://a.example/v1/ws"), true, "wss maps to the https endpoint");
  assert.equal(m.isAllowed("ws://a.example/v1/ws"), false, "plaintext ws to an https endpoint is not allowed");
  assert.equal(m.isAllowed(""), false);
});

test("createEndpointFetch: rewrites relative → current; fails over after 3 rejections; serves from backup", async () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  // The primary rejects (invalid/unreachable address); the backup answers.
  const { fn, calls } = fakeFetch((url) => url.startsWith(A));
  const ef = createEndpointFetch(m, fn);

  await assert.rejects(() => ef("/v1/updates"));
  await assert.rejects(() => ef("/v1/updates"));
  await assert.rejects(() => ef("/v1/updates"));
  assert.equal(m.current(), B, "three rejections on the primary → switched to backup");

  const res = await ef("/v1/updates");
  assert.equal(res.ok, true);
  assert.equal(calls[0], `${A}/v1/updates`, "first request targeted the primary");
  assert.equal(calls[calls.length - 1], `${B}/v1/updates`, "later request targeted the backup");
});

test("createEndpointFetch: a server 5xx is a REACHABLE response — no failover", async () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  const { fn } = fakeFetch(() => false, () => false); // always resolves, always 500
  const ef = createEndpointFetch(m, fn);
  for (let i = 0; i < 5; i++) {
    const res = await ef("/v1/x");
    assert.equal(res.status, 500);
  }
  assert.equal(m.current(), A, "5xx responses never trigger failover");
});

test("createEndpointFetch: anti-exfiltration — a foreign absolute URL is blocked before any network call", async () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  const { fn, calls } = fakeFetch(() => false);
  const ef = createEndpointFetch(m, fn);
  await assert.rejects(() => ef("https://evil.example/steal"), (e: unknown) => {
    assert.ok(e instanceof NetworkError);
    assert.match(e.message, /blocked/);
    return true;
  });
  assert.equal(calls.length, 0, "the wrapped fetch was never invoked for a foreign origin");
  // A configured absolute URL passes straight through.
  await ef(`${A}/v1/x`);
  assert.equal(calls.length, 1);
});

test("createEndpointWebSocket: relative /v1/ws → ws(s) origin of current; foreign blocked; same-origin passthrough", () => {
  const https = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  const ews = createEndpointWebSocket(https, FakeWsCtor);
  new ews("/v1/ws");
  assert.equal(FakeWs.last?.url, "wss://a.example/v1/ws");

  const httpMgr = createEndpointManager({ primary: "http://a.example", selfOrigin: null });
  new (createEndpointWebSocket(httpMgr, FakeWsCtor))("/v1/ws");
  assert.equal(FakeWs.last?.url, "ws://a.example/v1/ws");

  const sameOrigin = createEndpointManager({ primary: "", selfOrigin: null });
  new (createEndpointWebSocket(sameOrigin, FakeWsCtor))("/v1/ws");
  assert.equal(FakeWs.last?.url, "/v1/ws", "same-origin default leaves the relative URL untouched");

  assert.throws(() => new ews("wss://evil.example/v1/ws"), /blocked/);
});

test("createEndpointWebSocket: follows an HTTP-driven failover on the next connect", () => {
  const m = createEndpointManager({ primary: A, fallbacks: [B], selfOrigin: null });
  const ews = createEndpointWebSocket(m, FakeWsCtor);
  new ews("/v1/ws");
  assert.equal(FakeWs.last?.url, "wss://a.example/v1/ws");
  m.reportNetworkError();
  m.reportNetworkError();
  m.reportNetworkError(); // HTTP path switched us to B
  new ews("/v1/ws"); // WsClient's next reconnect re-resolves the URL
  assert.equal(FakeWs.last?.url, "wss://b.example/v1/ws");
});

// ------------------------------------------------------------------------------------------------
// T-604: structural T-602 endpoints[] entering mergeEndpoints / setAdvertisedEndpoints. The exact
// object shape mirrors server/test/integration/config_endpoints.test.ts SAMPLE.
const STRUCT_DE: StructuredEndpoint = {
  id: "de-direct", base: "https://greenchat.example", region: "de",
  transport: "direct", priority: 10, weight: 100,
};
const STRUCT_RU: StructuredEndpoint = {
  id: "ru-relay", base: "https://relay.ru.example", region: "ru",
  transport: "reality", priority: 20, weight: 100,
  reality: { host: "relay.example", port: 8446, sni: "swcdn.apple.com", fingerprint: "chrome", public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", short_id: "ab12cd34", uuid: "11111111-1111-4111-8111-111111111111", flow: "xtls-rprx-vision", credential_scope: "greenchat-only" },
};

test("T-604 parseEndpointInput: legacy string, structural object with defaults, junk rejected", () => {
  assert.equal(parseEndpointInput("https://a.example"), "https://a.example");
  assert.equal(parseEndpointInput("  "), null);
  assert.equal(parseEndpointInput(42), null);
  assert.equal(parseEndpointInput(null), null);
  assert.equal(parseEndpointInput({ no: "id" }), null, "id+base are the minimum, like the server");
  const min = parseEndpointInput({ id: "x", base: "https://x.example" });
  assert.deepEqual(min, {
    id: "x", base: "https://x.example", region: "", transport: "direct", priority: 100, weight: 100,
  });
  const full = parseEndpointInput({ ...STRUCT_RU });
  assert.deepEqual(full, STRUCT_RU, "the T-602 wire shape round-trips unchanged");
  const noHost = parseEndpointInput({ id: "y", base: "https://y.example", reality: { port: 443 } });
  assert.equal((noHost as StructuredEndpoint).reality, undefined, "reality without host is dropped");
});

test("T-604 orderEndpointInputs: ascending priority, descending weight, stable; legacy keeps order", () => {
  const lo = { ...STRUCT_DE, id: "lo", priority: 30 };
  const heavy = { ...STRUCT_DE, id: "heavy", base: "https://h.example", priority: 30, weight: 200 };
  const ordered = orderEndpointInputs([lo, STRUCT_RU, heavy, STRUCT_DE]);
  assert.deepEqual(
    ordered.map((e) => (typeof e === "string" ? e : e.id)),
    ["de-direct", "ru-relay", "heavy", "lo"],
    "priority asc, then weight desc, then original order",
  );
  // Pure-legacy lists keep the server's order byte-for-byte (strings carry default priority/weight).
  assert.deepEqual(orderEndpointInputs([B, A, C]), [B, A, C]);
});

test("T-604 mergeEndpoints accepts structural objects: candidates + allow-list + metadata", () => {
  const m = createEndpointManager({ primary: A, selfOrigin: null });
  m.mergeEndpoints([STRUCT_RU, STRUCT_DE]); // wire order ru-first; priority says de-first
  assert.deepEqual(m.candidates(), [A, "https://greenchat.example", "https://relay.ru.example"]);
  assert.equal(m.isAllowed("https://relay.ru.example/v1/x"), true);
  assert.deepEqual(m.endpointInfo("https://relay.ru.example"), STRUCT_RU, "metadata retrievable by base");
  assert.equal(m.endpointInfo(A), null, "the plain primary has no structural metadata");
});

test("T-604 mergeEndpoints mixed legacy + structural in one list", () => {
  const m = createEndpointManager({ primary: A, selfOrigin: null });
  m.mergeEndpoints([B, STRUCT_DE]);
  assert.deepEqual(m.candidates(), [A, "https://greenchat.example", B], "structural priority 10 sorts before default-100 legacy");
  assert.equal(m.endpointInfo(B), null);
  assert.equal(m.endpointInfo("https://greenchat.example")?.id, "de-direct");
});

test("T-604 setAdvertisedEndpoints with structural list drops stale metadata with the mirror", () => {
  const m = createEndpointManager({ primary: A, selfOrigin: null });
  m.setAdvertisedEndpoints([STRUCT_RU]);
  assert.equal(m.endpointInfo("https://relay.ru.example")?.transport, "reality");
  m.setAdvertisedEndpoints([STRUCT_DE]); // refresh no longer advertises the relay
  assert.equal(m.isAllowed("https://relay.ru.example/v1/x"), false, "removed mirror not allowed");
  assert.equal(m.endpointInfo("https://relay.ru.example"), null, "removed mirror loses metadata");
});

test("T-604 setPrimary still drops structural mirrors of the previous server (anti-exfiltration)", () => {
  const m = createEndpointManager({ primary: A, selfOrigin: null });
  m.mergeEndpoints([STRUCT_RU]);
  m.setPrimary("new.example");
  assert.equal(m.isAllowed("https://relay.ru.example/v1/x"), false);
  assert.equal(m.endpointInfo("https://relay.ru.example"), null);
});
