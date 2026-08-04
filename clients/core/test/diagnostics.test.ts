// T-418 — client-quality telemetry controller. Pure-logic tests (in-memory DiagStore + spy DiagApi)
// plus one live-server wire check against the real /v1/client/crash + /v1/client/diag endpoints.
//
// The headline guarantee under test is the STRICT opt-in: with consent OFF the controller issues ZERO
// diagnostic requests and collects nothing (T-418 acceptance #2). The rest pin the crash drain/retry
// contract, the once-a-day diag gate (acceptance #3), the purge-on-opt-out, and the quantile/offset math.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import { ApiError, NetworkError } from "../src/errors.ts";
import {
  createDiagnostics,
  quantile,
  computeAggregate,
  type DiagStore,
  type DiagApi,
  type DiagMeta,
  type QueuedCrash,
  type LatencySample,
} from "../src/diagnostics.ts";

const META: DiagMeta = { platform: "web", appVersion: "0.1.0", osVersion: "TestOS 1.0" };

// A fully in-memory DiagStore — the fake the web shell replaces with IndexedDB in production.
function memStore(consent = false, installId = "inst-abcd1234"): DiagStore {
  let cons = consent;
  let id = installId;
  let crashes: QueuedCrash[] = [];
  let samples: LatencySample[] = [];
  let last = 0;
  return {
    async installId() {
      if (!id) id = "inst-" + Math.random().toString(36).slice(2, 12);
      return id;
    },
    async getConsent() {
      return cons;
    },
    async setConsent(on) {
      cons = on;
    },
    async pushCrash(c) {
      crashes.push(c);
    },
    async listCrashes() {
      return crashes.map((c) => ({ ...c }));
    },
    async dropCrash(cid) {
      crashes = crashes.filter((c) => c.id !== cid);
    },
    async clearCrashes() {
      crashes = [];
    },
    async addSample(s) {
      samples.push(s);
    },
    async listSamples() {
      return samples.map((s) => ({ ...s }));
    },
    async clearSamples() {
      samples = [];
    },
    async lastDiagAt() {
      return last;
    },
    async setLastDiagAt(ms) {
      last = ms;
    },
  };
}

// A DiagApi spy recording every call. `fail` lets a test make posts throw a chosen error.
function spyApi(fail?: (path: string) => Error | null) {
  const calls: { path: string; body: Record<string, unknown>; noAuth: boolean }[] = [];
  const api: DiagApi = {
    async post<T>(path: string, body?: unknown, opts?: { noAuth?: boolean }): Promise<T> {
      const err = fail ? fail(path) : null;
      calls.push({ path, body: (body ?? {}) as Record<string, unknown>, noAuth: opts?.noAuth === true });
      if (err) throw err;
      return { ok: true } as T;
    },
  };
  return { api, calls };
}

// ---- acceptance #2: consent OFF => absolutely no diagnostic traffic ------------------------------

test("consent OFF: no request and nothing collected", async () => {
  const store = memStore(false);
  const { api, calls } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });

  diag.recordScreen("chats");
  await diag.reportError({ message: "boom", stack: "Error: boom\n at x" });
  await diag.sample({ sentAtSec: 1000, receivedAtMs: 1_000_500 });
  await diag.start();

  assert.equal(calls.length, 0, "no diagnostic request may leave the client when consent is OFF");
  assert.deepEqual(await store.listCrashes(), [], "no crash may be queued when consent is OFF");
  assert.deepEqual(await store.listSamples(), [], "no sample may be stored when consent is OFF");
});

// ---- crash queue + drain -------------------------------------------------------------------------

test("consent ON: a crash is delivered as an anonymous, PII-free body", async () => {
  const store = memStore(true);
  const { api, calls } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.start(); // T-515: confirm consent ON in the sync cache before recording breadcrumbs

  diag.recordScreen("chats");
  diag.recordScreen("chat"); // screen NAMES only — never contents
  await diag.reportError({ stack: "TypeError: boom\n at send (app.js:1:1)", breadcrumbs: ["settings"] });

  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.path, "/v1/client/crash");
  assert.equal(c.noAuth, true, "crash is anonymous (noAuth)");
  assert.equal(c.body.install_id, "inst-abcd1234");
  assert.equal(c.body.platform, "web");
  assert.equal(c.body.app_version, "0.1.0");
  assert.equal(c.body.os_version, "TestOS 1.0");
  assert.match(String(c.body.stack), /TypeError: boom/);
  assert.deepEqual(c.body.breadcrumbs, ["chats", "chat", "settings"]);
  // The body must carry ONLY the allow-listed fields — no chat/contact ids, no message text.
  assert.deepEqual(
    Object.keys(c.body).sort(),
    ["app_version", "breadcrumbs", "install_id", "os_version", "platform", "stack"],
  );
  assert.deepEqual(await store.listCrashes(), [], "a delivered crash is removed from the queue");
});

test("network failure keeps the crash queued for the next start", async () => {
  const store = memStore(true);
  let offline = true;
  const { api, calls } = spyApi(() => (offline ? new NetworkError("offline", null) : null));
  const diag = createDiagnostics({ api, store, meta: META });

  await diag.reportError({ stack: "Error: net" });
  assert.equal(calls.length, 1, "one attempt was made");
  assert.equal((await store.listCrashes()).length, 1, "a network failure must not drop the crash");

  offline = false;
  await diag.start();
  assert.equal((await store.listCrashes()).length, 0, "the queued crash is delivered once back online");
});

test("a server verdict (429) drops the crash instead of wedging the queue", async () => {
  const store = memStore(true);
  const { api } = spyApi(() => new ApiError("TOO_MANY", "slow down", 429));
  const diag = createDiagnostics({ api, store, meta: META });

  await diag.reportError({ stack: "Error: rejected" });
  assert.deepEqual(await store.listCrashes(), [], "a 4xx/429 verdict retires the crash so it can't loop");
});

test("reportError ignores an empty stack/message", async () => {
  const store = memStore(true);
  const { api, calls } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.reportError({ stack: "   ", message: "" });
  assert.equal(calls.length, 0);
  assert.deepEqual(await store.listCrashes(), []);
});

// ---- acceptance #3: diag at most once per day ----------------------------------------------------

test("diag aggregate is sent at most once per day", async () => {
  const store = memStore(true);
  const { api, calls } = spyApi();
  let nowMs = 1_000_000_000_000;
  const diag = createDiagnostics({ api, store, meta: META, now: () => nowMs, clockOffsetSec: () => 0 });

  // Two samples ~200ms and ~400ms after their server sent_at.
  await diag.sample({ sentAtSec: 1000, receivedAtMs: 1_000_200 });
  await diag.sample({ sentAtSec: 2000, receivedAtMs: 2_000_400 });

  await diag.start();
  await diag.start(); // same day → must NOT send a second time
  const diagCalls = calls.filter((c) => c.path === "/v1/client/diag");
  assert.equal(diagCalls.length, 1, "no more than one diag per 24h");

  const body = diagCalls[0]!.body;
  assert.equal(diagCalls[0]!.noAuth, true, "diag is anonymous (noAuth)");
  assert.equal(body.install_id, "inst-abcd1234");
  assert.equal(body.samples, 2);
  assert.equal(typeof body.push_p50_ms, "number");
  assert.equal(typeof body.push_p95_ms, "number");
  assert.deepEqual(await store.listSamples(), [], "samples are cleared once reported");

  // A day later, with fresh samples, a second aggregate goes out.
  nowMs += 24 * 60 * 60 * 1000 + 1;
  await diag.sample({ sentAtSec: 3000, receivedAtMs: 3_000_100 });
  await diag.start();
  assert.equal(calls.filter((c) => c.path === "/v1/client/diag").length, 2, "a new day allows one more diag");
});

test("no diag request when there are no samples", async () => {
  const store = memStore(true);
  const { api, calls } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.start();
  assert.equal(calls.filter((c) => c.path === "/v1/client/diag").length, 0);
});

// ---- opt-out purges everything -------------------------------------------------------------------

test("turning consent OFF purges queued crashes and samples", async () => {
  const store = memStore(true);
  const { api } = spyApi(() => new NetworkError("offline", null)); // keep the crash queued
  const diag = createDiagnostics({ api, store, meta: META });

  await diag.reportError({ stack: "Error: keep me" });
  await diag.sample({ sentAtSec: 1000, receivedAtMs: 1_000_300 });
  assert.equal((await store.listCrashes()).length, 1);
  assert.equal((await store.listSamples()).length, 1);

  await diag.setConsent(false);
  assert.deepEqual(await store.listCrashes(), [], "opting out purges the crash queue");
  assert.deepEqual(await store.listSamples(), [], "opting out purges the sample buffer");
});

// ---- pure math -----------------------------------------------------------------------------------

test("quantile uses nearest-rank", () => {
  const s = [10, 20, 30, 40, 50];
  assert.equal(quantile(s, 50), 30);
  assert.equal(quantile(s, 95), 50);
  assert.equal(quantile(s, 0), 10);
  assert.equal(quantile([], 50), 0);
});

test("computeAggregate applies the clock offset and drops impossible deltas", () => {
  // offset +10s means the client clock is 10s BEHIND the server (client = server − 10).
  const samples: LatencySample[] = [
    { sentAtSec: 1000, receivedAtMs: (1000 - 10) * 1000 + 500 }, // +500ms
    { sentAtSec: 2000, receivedAtMs: (2000 - 10) * 1000 + 1500 }, // +1500ms
    { sentAtSec: 3000, receivedAtMs: (3000 - 10) * 1000 - 5000 }, // negative → dropped
    { sentAtSec: 4000, receivedAtMs: (4000 - 10) * 1000 + 9_999_999 }, // > 1h → dropped
  ];
  const agg = computeAggregate(samples, 10);
  assert.equal(agg.samples, 2, "only the two plausible deltas survive");
  assert.equal(agg.p50, 500);
  assert.equal(agg.p95, 1500);

  assert.deepEqual(computeAggregate([], 0), { p50: 0, p95: 0, samples: 0 });
});

// ---- live wire check: the controller talks to the real server -----------------------------------

test("crash + diag reach the real server endpoints", async () => {
  const srv: LiveServer = await startLiveServer();
  try {
    const api = new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
    const installId = "inst-" + Date.now().toString(36) + "abcd";
    const store = memStore(true, installId);
    const diag = createDiagnostics({ api, store, meta: META });

    await diag.reportError({ stack: "Error: live-wire\n at t (a.js:1:1)", breadcrumbs: ["chats"] });
    assert.deepEqual(await store.listCrashes(), [], "the server accepted the crash");

    await diag.sample({ sentAtSec: 1000, receivedAtMs: 1_000_250 });
    await diag.start();
    assert.deepEqual(await store.listSamples(), [], "the server accepted the diag aggregate");
  } finally {
    await srv.teardown();
  }
});

// ==================================================================================================
// T-515 — device-side privacy hardening of the crash/breadcrumb pipeline (SUPPORT.md §2.3, R1–R7).
// Six blocking acceptance criteria, each pinned below. These assert the DESIRED post-redaction state;
// against the pre-T-515 controller they FAIL — proof that the raw pipeline leaked stacks/PII/tokens/
// routes and recorded breadcrumbs with no consent gate.
// ==================================================================================================

// The crash body that actually reaches api.post('/v1/client/crash', body); undefined if none was sent.
function lastCrashBody(
  calls: { path: string; body: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  return calls.filter((c) => c.path === "/v1/client/crash").at(-1)?.body;
}

// ---- acceptance #2: consent OFF ⇒ ZERO breadcrumbs recorded (synchronous default-deny gate) ------

test("T-515 #2: recordScreen keeps NOTHING until consent is confirmed ON (default-deny)", () => {
  const store = memStore(true); // the store SAYS on, but the sync gate must not trust it yet
  const { api } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  // No start()/setConsent has resolved → the in-object consent cache is default-DENY.
  diag.recordScreen("/secret/before-consent");
  diag.recordScreen("chats");
  assert.deepEqual(diag.breadcrumbs(), [], "no breadcrumb may be kept before consent is confirmed ON");
});

test("T-515 #2: with consent OFF in the store, no breadcrumb is ever recorded", async () => {
  const store = memStore(false);
  const { api } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.start(); // pulls the real consent (OFF) into the cache
  diag.recordScreen("/chat/42");
  diag.recordScreen("settings");
  assert.deepEqual(diag.breadcrumbs(), [], "consent OFF ⇒ recordScreen is a no-op");
});

// ---- acceptance #3: opt-out purges the IN-MEMORY breadcrumb buffer -------------------------------

test("T-515 #3: setConsent(false) purges the in-memory breadcrumb buffer", async () => {
  const store = memStore(true);
  const { api } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.start(); // consent ON in the cache
  diag.recordScreen("chats");
  diag.recordScreen("settings");
  assert.equal(diag.breadcrumbs().length, 2, "crumbs accumulate while consent is ON");

  await diag.setConsent(false);
  assert.deepEqual(diag.breadcrumbs(), [], "opting out clears the in-memory breadcrumbs immediately");
});

// ---- acceptance #4: OFF → routes → ON → crash carries NO pre-consent route -----------------------

test("T-515 #4: a crash after opt-in carries no route visited before consent", async () => {
  const store = memStore(false);
  const { api, calls } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.start(); // consent OFF

  diag.recordScreen("/wallet/import/secret"); // pre-consent — must never be kept
  diag.recordScreen("/chat/8821");

  await diag.setConsent(true); // user opts in
  diag.recordScreen("chats"); // only THIS is legitimate history

  await diag.reportError({ stack: "TypeError: boom\n at f (app.js:1:1)" });

  const body = lastCrashBody(calls);
  assert.ok(body, "a crash is delivered once consent is ON");
  assert.deepEqual(body!.breadcrumbs, ["chats"], "only post-consent screens survive");
  const wire = JSON.stringify(body);
  assert.equal(wire.includes("wallet"), false, "no pre-consent route may leak");
  assert.equal(wire.includes("8821"), false, "no pre-consent id may leak");
});

// ---- acceptance #1 + #6: the OUTBOUND crash stack is redacted (R1–R4) ----------------------------

test("T-515 #1/#6: the crash stack that leaves the client carries no token/email/host/query", async () => {
  const store = memStore(true);
  const { api, calls } = spyApi();
  const diag = createDiagnostics({ api, store, meta: META });
  await diag.start();

  const stack = [
    "TypeError: cannot read x of null for john.doe@example.com",
    '    at submit (password="hunter2secret", token="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9") (https://app.example.com/assets/app.js?token=deadbeefcafebabe0123456789abcd:5:9)',
    "    at async click (https://app.example.com/assets/app.js:1:23456)",
  ].join("\n");
  await diag.reportError({ stack });

  const wire = String(lastCrashBody(calls)!.stack);
  assert.match(wire, /TypeError/, "the error type is preserved for triage");
  for (const forbidden of [
    "john.doe",
    "example.com",
    "hunter2secret",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "deadbeefcafebabe",
    "app.example.com",
    "password=",
  ]) {
    assert.equal(wire.includes(forbidden), false, `forbidden bytes must not leave the client: ${forbidden}`);
  }
  assert.match(wire, /app\.js:5:9/, "the frame keeps only bundle file:line:column");
});

// ---- acceptance #5 + #6: malicious fixtures — forbidden bytes never leave, per PII class ----------

// Each fixture is a realistic capture surface (an error stack, or a visited route) carrying one class
// of secret. After R1–R7 the listed `forbidden` byte-runs must be absent from what api.post ships.
const STACK_FIXTURES: { label: string; stack: string; forbidden: string[] }[] = [
  {
    label: "token (JWT in message)",
    stack:
      "Error: 401 Authorization Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    forbidden: ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  },
  {
    label: "cookie (session value)",
    stack: "Error: bad Set-Cookie session=AbCdEf0123456789AbCdEf0123456789AbCd; Path=/; HttpOnly",
    forbidden: ["AbCdEf0123456789AbCdEf0123456789AbCd"],
  },
  {
    label: "email",
    stack: "Error: login failed for john.doe+tag@example.co.uk",
    forbidden: ["john.doe", "example.co.uk"],
  },
  { label: "phone", stack: "Error: SMS to +15551234567 timed out", forbidden: ["5551234567"] },
  { label: "card number", stack: "Error: card 4111111111111111 declined", forbidden: ["4111111111111111"] },
  {
    label: "long numeric id",
    stack: "Error: user_id=1234567890 chat_id=987654321 not found",
    forbidden: ["1234567890", "987654321"],
  },
  {
    label: "seed phrase (hex entropy)",
    stack: "Error: bad entropy 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    forbidden: ["000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"],
  },
  {
    label: "wallet address (ETH)",
    stack: "Error: transfer to 0x71C7656EC7ab88b098defB751B7401B5f6d8976F reverted",
    forbidden: ["71C7656EC7ab88b098defB751B7401B5f6d8976F"],
  },
  {
    label: "wallet address (BTC base58)",
    stack: "Error: utxo 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 missing",
    forbidden: ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"],
  },
  {
    label: "stack locals + args + tokenised URL",
    stack:
      'Error: submit failed\n    at submit (pin="hunter2secret", email="a@b.com") (https://app.example.com/a.js?token=deadbeefcafebabe0123456789abcd:5:9)',
    forbidden: ["hunter2secret", "a@b.com", "deadbeefcafebabe0123456789abcd", "app.example.com"],
  },
  {
    label: "geo coordinates (in stack URL query)",
    stack: "Error: map\n    at render (https://app.example.com/map.js?lat=37.7749295&lng=-122.4194155:12:3)",
    forbidden: ["37.7749295", "122.4194155", "app.example.com"],
  },
];

test("T-515 #5/#6: forbidden bytes never leave the client via the crash STACK", async () => {
  for (const fx of STACK_FIXTURES) {
    const store = memStore(true);
    const { api, calls } = spyApi();
    const diag = createDiagnostics({ api, store, meta: META });
    await diag.start();
    await diag.reportError({ stack: fx.stack });
    const body = lastCrashBody(calls);
    assert.ok(body, `[${fx.label}] a crash is delivered`);
    const wire = JSON.stringify(body);
    for (const bad of fx.forbidden) {
      assert.equal(wire.includes(bad), false, `[${fx.label}] must not leak: ${bad.slice(0, 24)}…`);
    }
  }
});

const ROUTE_FIXTURES: { label: string; route: string; forbidden: string[] }[] = [
  {
    label: "query-string (search + token)",
    route: "/search?q=my+secret+draft+text&access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    forbidden: ["secret+draft", "access_token", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"],
  },
  { label: "numeric id segments", route: "/chat/8821/thread/990077", forbidden: ["8821", "990077"] },
  {
    label: "message text / draft (in query)",
    route: "/chat/8821?draft=please+wire+me+the+money+now",
    forbidden: ["please+wire", "the+money"],
  },
  { label: "geo coordinates (in query)", route: "/map?lat=37.7749295&lng=-122.4194155", forbidden: ["37.7749295", "122.4194155"] },
  {
    label: "seed phrase (mnemonic in query)",
    route: "/wallet/import?mnemonic=witch+collapse+practice+feed+shame+open+despair",
    forbidden: ["witch", "collapse", "practice", "despair"],
  },
  {
    label: "absolute URL with host + token",
    route: "https://app.example.com/chat/8821?token=supersecretvalue0123456789",
    forbidden: ["app.example.com", "8821", "supersecretvalue0123456789", "token="],
  },
];

test("T-515 #5/#6: forbidden bytes never leave the client via BREADCRUMBS", async () => {
  for (const fx of ROUTE_FIXTURES) {
    const store = memStore(true);
    const { api, calls } = spyApi();
    const diag = createDiagnostics({ api, store, meta: META });
    await diag.start();
    diag.recordScreen(fx.route);
    await diag.reportError({ stack: "Error: boom\n at f (app.js:1:1)" });
    const body = lastCrashBody(calls);
    assert.ok(body, `[${fx.label}] a crash is delivered`);
    const wire = JSON.stringify(body);
    for (const bad of fx.forbidden) {
      assert.equal(wire.includes(bad), false, `[${fx.label}] must not leak: ${bad}`);
    }
  }
});
