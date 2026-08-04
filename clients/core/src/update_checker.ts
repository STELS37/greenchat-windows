// clients/core/src/update_checker.ts — T-413 (client half): the APK/native update verdict.
//
// One question, asked ONLY by native shells (Android Capacitor today; web/PWA NEVER calls this — its
// update channel is the service worker, ui/pwa.ts): "given who I am, does the self-hosted manifest
// (T-412, server/src/modules/client_updates.ts) offer me anything?" The three verdicts drive the UI:
//   'latest' → nothing to show;
//   'update' → a dismissible «Доступно обновление X.Y.Z» banner (download happens ONLY on tap);
//   'force'  → the blocking screen: current < min_supported, i.e. the server no longer supports this
//              build AND a downloadable artifact exists (the server's anti-trap invariant — it only
//              raises the floor when there is a binary to update to; we re-enforce it here, see below).
//
// FAIL-SAFE mirror of the endpoint: any inability to answer — 404 (unknown platform/arch), network
// down, malformed body — resolves to null. Updates are advice, never an obstacle: a null verdict
// means the app simply runs; nothing is retried in a loop, nothing blocks, nothing is downloaded.
// The next launch asks again.
//
// The endpoint (GET /v1/client/updates/:platform/:arch?version=&build=) answers 200 with url:null for
// "up-to-date / nothing published / unconfigured", and 200 with a governed artifact URL only when a
// genuine newer build exists for this exact target. Android integrity uses SHA-256; desktop additionally
// requires the updater signature. `min_supported` is a real floor only in that case.

export type UpdateState = "latest" | "update" | "force";

export type UpdateStatus =
  | { state: "latest" }
  | { state: "update"; latest: string; url: string; sha256: string | null; minSupported: string }
  | { state: "force"; latest: string; url: string; sha256: string | null; minSupported: string };

export interface FetchUpdateStatusOptions {
  // Android versionCode from Capacitor App.getInfo().build. It distinguishes replacement APKs that
  // intentionally keep the same user-facing versionName. Omit on non-Android targets.
  currentBuild?: number;
  // Server origin, e.g. "http://127.0.0.1:8990" (no trailing slash needed) or "" for same-origin.
  // Under the Capacitor shell the bridge's fetch-rewrite makes the bare "/v1/…" path reach the
  // configured backend, so the default "" is correct there too.
  baseUrl?: string;
  // Injectable transport for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
}

// A total, prerelease-aware MAJOR.MINOR.PATCH compare — the same decisions as the server's comparator
// (client_updates.ts parseSemver/compareSemver): leading 'v' tolerated, missing parts → 0, a release
// outranks its prereleases (1.0.0 > 1.0.0-beta.4). Returns -1 | 0 | 1. Never throws on junk input.
function parseSemver(v: string): { core: number[]; pre: string } {
  const s = String(v ?? "").trim().replace(/^v/i, "");
  const dash = s.indexOf("-");
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : "";
  const nums = core.split(".").map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { core: nums.slice(0, 3), pre };
}
export function compareUpdateVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return (pa.core[i] ?? 0) < (pb.core[i] ?? 0) ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // a is a release, b is a prerelease
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// Ask the manifest endpoint and reduce its answer to a verdict. Resolves null (silent no-op) on ANY
// failure to obtain a well-formed 200 — the caller shows nothing and moves on.
export async function fetchUpdateStatus(
  platform: string,
  arch: string,
  currentVersion: string,
  opts: FetchUpdateStatusOptions = {},
): Promise<UpdateStatus | null> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const build = Number.isSafeInteger(opts.currentBuild) && Number(opts.currentBuild) > 0
    ? Number(opts.currentBuild)
    : null;
  const url =
    `${base}/v1/client/updates/${encodeURIComponent(platform)}/${encodeURIComponent(arch)}` +
    `?version=${encodeURIComponent(currentVersion)}` +
    (build === null ? "" : `&build=${build}`);

  let body: unknown;
  try {
    const res = await doFetch(url);
    if (!res.ok) return null; // the ONE contract 404 = unknown target; any other non-200 is equally "no answer"
    body = await res.json();
  } catch {
    return null; // network down / non-JSON — updates never block the app
  }
  if (typeof body !== "object" || body === null) return null;

  const m = body as Record<string, unknown>;
  const artifactUrl = typeof m.url === "string" && m.url.length > 0 ? m.url : null;
  const latest = typeof m.latest === "string" && m.latest.length > 0 ? m.latest : null;
  const displayVersion = typeof m.display_version === "string" && m.display_version.length > 0
    ? m.display_version
    : latest;
  const latestBuild = Number.isSafeInteger(m.latest_build) && Number(m.latest_build) > 0
    ? Number(m.latest_build)
    : null;
  const minSupported = typeof m.min_supported === "string" && m.min_supported.length > 0 ? m.min_supported : "0.0.0";
  const sha256 = typeof m.sha256 === "string" && m.sha256.length > 0 ? m.sha256 : null;

  // url === null is the server's unambiguous "no update" — up-to-date, nothing published, or the
  // fail-safe degradation. ANTI-TRAP: without a downloadable artifact there is never a 'force' (or
  // any) verdict, however high a (mis)configured min_supported claims to be — a person can not be
  // locked out of the only build they have.
  if (!artifactUrl || !latest) return { state: "latest" };
  // Defensive double-check of "newer": a same-versionName Android replacement is newer only when both
  // sides provide versionCode and the offered code is greater. Legacy clients receive a synthetic
  // prerelease `latest` from the server for one migration hop; display_version keeps new clients tidy.
  const versionNewer = compareUpdateVersions(currentVersion, latest) < 0;
  const buildNewer = build !== null && latestBuild !== null && latestBuild > build;
  if (!versionNewer && !buildNewer) return { state: "latest" };
  const shown = displayVersion ?? latest;

  if (compareUpdateVersions(currentVersion, minSupported) < 0) {
    return { state: "force", latest: shown, url: artifactUrl, sha256, minSupported };
  }
  return { state: "update", latest: shown, url: artifactUrl, sha256, minSupported };
}
