// T-461 reliability guard: a plain `npm run build:web` must never overwrite the LIVE production tree.
//
// Production runs straight out of this working tree (systemd ExecStart → <root>/server/dist/bootstrap.js,
// static frontend served from <root>/clients/web/dist). build.mjs defaults outDir to clients/web/dist and
// the update manifest to var/updates/manifest.json, and it starts with `rm(outDir, {recursive:true})`.
// Both paths are gitignored, so an accidental in-tree build destroys the served bundle and the published
// update manifest while `git status` stays clean — the failure is invisible until users hit it.
//
// scripts/deploy.sh is unaffected: it always builds into a private staging directory (GC_WEB_OUT_DIR /
// GC_UPDATE_MANIFEST_OUT under mktemp) and swaps it under the ops lock. CI, containers and dev checkouts
// are unaffected too: without the systemd unit of THIS tree there is no live deployment to protect.
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const LIVE_UNIT_FILE = "/etc/systemd/system/green-chat.service";
export const LIVE_TREE_OVERRIDE_ENV = "GC_ALLOW_LIVE_TREE_BUILD";

// Parses the deployed repository root out of a systemd unit: the ExecStart entry point is
// `<root>/server/dist/bootstrap.js`. Returns null when the unit does not describe such a deployment.
export function parseLiveRepoRoot(unitText) {
  if (typeof unitText !== "string") return null;
  for (const rawLine of unitText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("ExecStart=")) continue;
    const match = /(\/[^\s"']+)\/server\/dist\/bootstrap\.js/u.exec(line);
    if (match) return resolve(match[1]);
  }
  return null;
}

function isInside(parent, candidate) {
  const base = resolve(parent);
  const path = resolve(candidate);
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

// Filesystem identity, not spelling. On DE2 the canonical root /srv/projects is bind-mounted at
// /a0/usr/projects, so the very same directory answers to two absolute paths and a string compare
// against the systemd ExecStart path misses the alias entirely. dev:ino is the same object either way.
function defaultStat(path) {
  return statSync(path);
}

function identityOf(path, stat) {
  try {
    const info = stat(resolve(path));
    if (!info || typeof info.dev === "undefined" || typeof info.ino === "undefined") return null;
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

// Identities of the target and of every existing ancestor up to the filesystem root. Build targets
// usually do not exist yet (`dist.new`, a manifest that is about to be written), so the identity of
// the nearest existing parent is what proves where the write will actually land.
function ancestorIdentities(target, stat) {
  const identities = new Set();
  let current = resolve(target);
  for (let depth = 0; depth < 128; depth += 1) {
    const identity = identityOf(current, stat);
    if (identity) identities.add(identity);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return identities;
}

// Paths of the live tree that the running service reads at request time.
export function liveTreePaths(liveRoot) {
  return [
    { path: join(liveRoot, "clients", "web", "dist"), label: "served web bundle" },
    { path: join(liveRoot, "var", "updates"), label: "published update artifacts" },
  ];
}

export function findLiveTreeViolations({ liveRoot, targets = [], stat = defaultStat }) {
  if (!liveRoot) return [];
  const guarded = liveTreePaths(liveRoot).map((entry) => ({
    ...entry,
    identity: identityOf(entry.path, stat),
  }));
  const violations = [];
  for (const target of targets) {
    if (!target || typeof target.path !== "string" || target.path.length === 0) continue;
    let identities = null;
    for (const entry of guarded) {
      if (isInside(entry.path, target.path)) {
        violations.push(`${target.label} → ${resolve(target.path)} (live ${entry.label})`);
        continue;
      }
      if (!entry.identity) continue;
      if (identities === null) identities = ancestorIdentities(target.path, stat);
      if (identities.has(entry.identity)) {
        violations.push(
          `${target.label} → ${resolve(target.path)} (live ${entry.label}, same directory as ${entry.path} under another mount path)`,
        );
      }
    }
  }
  return violations;
}

async function readUnitFile(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

// Fail-fast before the first destructive write. Returns the detected live root (or null when this host
// runs no live deployment / the guard was explicitly waived).
export async function assertBuildTargetsOutsideLiveTree({
  targets = [],
  env = process.env,
  unitFile = LIVE_UNIT_FILE,
  readUnit = readUnitFile,
  stat = defaultStat,
} = {}) {
  if (env[LIVE_TREE_OVERRIDE_ENV] === "1") return null;
  const liveRoot = parseLiveRepoRoot(await readUnit(unitFile));
  const violations = findLiveTreeViolations({ liveRoot, targets, stat });
  if (violations.length === 0) return liveRoot;
  throw new Error(
    [
      `refusing to build into the live production tree ${liveRoot} (${unitFile})`,
      ...violations.map((item) => `  - ${item}`),
      "this build would delete artifacts the running service is serving right now",
      "use scripts/deploy.sh (it stages the build and swaps it under the ops lock), or point the build",
      "at a scratch directory: GC_WEB_OUT_DIR=/tmp/gc-web-dist GC_UPDATE_MANIFEST_OUT=/tmp/gc-manifest.json",
      `override only when you intentionally rebuild the live tree: ${LIVE_TREE_OVERRIDE_ENV}=1`,
    ].join("\n"),
  );
}
