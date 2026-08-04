// T-413 (client half) — update_checker verdict unit tests over a SCRIPTED transport (no live server:
// the T-412 endpoint contract is mirrored here byte-for-byte from server/src/modules/client_updates.ts;
// the live cross-check happens in the lane's scratch probe, not in this suite).
//
// The checker's prime directive: UPDATES NEVER BLOCK THE APP. Any failure to answer (404 unknown
// target, network down, malformed body) yields null — the caller shows nothing and the app runs on.
// A verdict is only ever produced from a well-formed 200:
//   url:null                                  → { state:'latest' }   (up-to-date / nothing published)
//   url + latest>current, current≥min         → { state:'update' }   (dismissible banner)
//   url + current<min_supported               → { state:'force' }    (blocking screen)
// Anti-trap mirror of the server: 'force' is impossible without a downloadable artifact (url), so a
// garbled manifest can never lock a person out of a working build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUpdateStatus } from "../src/update_checker.ts";

// ---- scripted transports -------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A fetch that records the requested URL and answers from the script.
function scripted(answer: (url: string) => Response | Promise<Response>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(u);
    return Promise.resolve(answer(u));
  }) as typeof fetch;
  return { fetchImpl, urls };
}

// The T-412 endpoint's "newer artifact exists" 200 body (server: handleManifest, isNewer branch).
function newerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "stable",
    latest: "1.2.0",
    display_version: "1.2.0",
    latest_build: 1200000,
    min_supported: "1.0.0",
    url: "http://127.0.0.1:19173/v1/client/updates/artifact/gc-1.2.0.apk",
    sha256: "ab12cd34",
    notes: "test build",
    version: "1.2.0",
    pub_date: "2026-07-16T00:00:00Z",
    signature: "minisign-sig",
    ...over,
  };
}

// The fail-safe / at-latest 200 body (url === null is the unambiguous "no update" signal).
function noUpdateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "stable",
    latest: "1.2.0",
    display_version: "1.2.0",
    latest_build: 1200000,
    min_supported: "1.0.0",
    url: null,
    sha256: null,
    notes: null,
    version: null,
    pub_date: null,
    signature: null,
    ...over,
  };
}

// ---- request shape -------------------------------------------------------------------------------

test("requests versionName + Android versionCode with encoded coordinates", async () => {
  const { fetchImpl, urls } = scripted(() => jsonResponse(noUpdateBody()));
  await fetchUpdateStatus("android", "universal", "1.0.0-beta.4", { fetchImpl, currentBuild: 1000006 });
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "/v1/client/updates/android/universal?version=1.0.0-beta.4&build=1000006");
});

test("baseUrl is prepended without doubling slashes", async () => {
  const { fetchImpl, urls } = scripted(() => jsonResponse(noUpdateBody()));
  await fetchUpdateStatus("android", "universal", "1.1.0", { fetchImpl, baseUrl: "http://127.0.0.1:19173/" });
  assert.equal(urls[0], "http://127.0.0.1:19173/v1/client/updates/android/universal?version=1.1.0");
});

// ---- verdicts from well-formed answers -----------------------------------------------------------

test("newer artifact than current → state:'update' with the manifest url/sha256", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody()));
  const v = await fetchUpdateStatus("android", "universal", "1.1.0", { fetchImpl });
  assert.deepEqual(v, {
    state: "update",
    latest: "1.2.0",
    url: "http://127.0.0.1:19173/v1/client/updates/artifact/gc-1.2.0.apk",
    sha256: "ab12cd34",
    minSupported: "1.0.0",
  });
});

test("same versionName but greater Android versionCode → update with clean display version", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody({
    latest: "1.0.0-beta.4",
    display_version: "1.0.0-beta.4",
    latest_build: 1000007,
    version: "1.0.0-beta.4",
    min_supported: "0.0.0",
  })));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0-beta.4", {
    fetchImpl,
    currentBuild: 1000006,
  });
  assert.equal(v?.state, "update");
  assert.equal(v?.state === "update" ? v.latest : "", "1.0.0-beta.4");
});

test("same versionName and current Android versionCode → latest", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody({
    latest: "1.0.0-beta.4",
    display_version: "1.0.0-beta.4",
    latest_build: 1000007,
    version: "1.0.0-beta.4",
    min_supported: "0.0.0",
  })));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0-beta.4", {
    fetchImpl,
    currentBuild: 1000007,
  });
  assert.deepEqual(v, { state: "latest" });
});

test("legacy synthetic latest compares newer but displays the real versionName", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody({
    latest: "1.0.0-beta.4.build.1000007",
    display_version: "1.0.0-beta.4",
    latest_build: 1000007,
    version: "1.0.0-beta.4",
    min_supported: "0.0.0",
  })));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0-beta.4", { fetchImpl });
  assert.equal(v?.state, "update");
  assert.equal(v?.state === "update" ? v.latest : "", "1.0.0-beta.4");
});

test("at latest (url:null) → state:'latest'", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(noUpdateBody({ latest: "1.1.0" })));
  const v = await fetchUpdateStatus("android", "universal", "1.1.0", { fetchImpl });
  assert.deepEqual(v, { state: "latest" });
});

test("current below min_supported (artifact present) → state:'force'", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody()));
  const v = await fetchUpdateStatus("android", "universal", "0.9.0", { fetchImpl });
  assert.equal(v?.state, "force");
  assert.equal(v?.state === "force" ? v.minSupported : "", "1.0.0");
});

test("a prerelease of the floor is below the floor: 1.0.0-beta.4 < min_supported 1.0.0 → 'force'", async () => {
  // Our real builds are prereleases (versionName 1.0.0-beta.4); the release outranks them, exactly
  // like the server's comparator, so raising the floor to 1.0.0 force-updates every beta.
  const { fetchImpl } = scripted(() => jsonResponse(newerBody()));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0-beta.4", { fetchImpl });
  assert.equal(v?.state, "force");
});

test("current at the floor but below latest → plain 'update' (no force)", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody()));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0", { fetchImpl });
  assert.equal(v?.state, "update");
});

// ---- fail-safe / anti-trap -----------------------------------------------------------------------

test("404 (unknown platform/arch) → null: no verdict, no banner", async () => {
  const { fetchImpl } = scripted(() => new Response("not found", { status: 404 }));
  assert.equal(await fetchUpdateStatus("android", "mips", "1.0.0", { fetchImpl }), null);
});

test("network unreachable → null: updates never block the app", async () => {
  const fetchImpl = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  assert.equal(await fetchUpdateStatus("android", "universal", "1.0.0", { fetchImpl }), null);
});

test("malformed body (non-JSON) → null", async () => {
  const { fetchImpl } = scripted(() => new Response("<html>oops</html>", { status: 200 }));
  assert.equal(await fetchUpdateStatus("android", "universal", "1.0.0", { fetchImpl }), null);
});

test("JSON null / non-object body → null", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(null));
  assert.equal(await fetchUpdateStatus("android", "universal", "1.0.0", { fetchImpl }), null);
});

test("anti-trap: min_supported above current but url:null → 'latest', NEVER 'force' without an artifact", async () => {
  // The server only raises the floor when an artifact exists; if a broken manifest ever violated
  // that, the client must still refuse to lock a person out of a build it cannot replace.
  const { fetchImpl } = scripted(() => jsonResponse(noUpdateBody({ min_supported: "9.9.9" })));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0", { fetchImpl });
  assert.deepEqual(v, { state: "latest" });
});

test("defensive: url present but latest not actually newer → 'latest' (no self-downgrade banner)", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody({ latest: "1.0.0", version: "1.0.0" })));
  const v = await fetchUpdateStatus("android", "universal", "1.2.0", { fetchImpl });
  assert.deepEqual(v, { state: "latest" });
});

test("defensive: garbage url/latest types degrade to 'latest', not a crash", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody({ url: 42, latest: { v: 1 } })));
  const v = await fetchUpdateStatus("android", "universal", "1.0.0", { fetchImpl });
  assert.deepEqual(v, { state: "latest" });
});

test("missing sha256 stays null in an 'update' verdict (install handoff still allowed)", async () => {
  const { fetchImpl } = scripted(() => jsonResponse(newerBody({ sha256: null })));
  const v = await fetchUpdateStatus("android", "universal", "1.1.0", { fetchImpl });
  assert.equal(v?.state, "update");
  assert.equal(v?.state === "update" ? v.sha256 : "x", null);
});
