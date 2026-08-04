import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SNAPSHOT_MARKER = ".gc-source-snapshot.complete.json";
const SNAPSHOT_SCOPE = [
  "clients/**",
  "config/client-release.json",
  "scripts/lib/client-release.mjs",
];
const SNAPSHOT_MARKER_MAX_BYTES = 16 * 1024;

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`cannot derive release identity from Git: ${detail}`);
  }
}

function releasePathspec(repoRoot, releaseRoot) {
  const rel = relative(repoRoot, releaseRoot);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("release inputs must be inside the Git worktree");
  }
  return rel.replaceAll(sep, "/");
}

export function deriveCleanReleaseIdentity({ releaseRoot, suppliedBuildId }) {
  const inputs = resolve(releaseRoot);
  const repoRoot = resolve(git(inputs, ["rev-parse", "--show-toplevel"]));
  const buildId = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(buildId)) {
    throw new Error(`Git HEAD is not a lowercase 40-hex commit: ${buildId}`);
  }

  const supplied = String(suppliedBuildId ?? "").trim();
  if (supplied && supplied !== buildId) {
    throw new Error(
      `supplied GC_BUILD_ID ${supplied} does not match clean Git HEAD ${buildId}`,
    );
  }

  const pathspec = releasePathspec(repoRoot, inputs);
  const dirty = git(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    pathspec,
  ]);
  if (dirty) {
    const summary = dirty.split("\n").slice(0, 8).join("; ");
    throw new Error(`dirty release inputs under ${pathspec}: ${summary}`);
  }

  return { buildId, repoRoot };
}

function readSnapshotMarker(repoRoot) {
  const path = join(repoRoot, SNAPSHOT_MARKER);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_CLOEXEC ?? 0),
    );
    const state = fstatSync(descriptor, { bigint: true });
    if (
      !state.isFile() ||
      state.nlink !== 1n ||
      state.size < 1n ||
      state.size > BigInt(SNAPSHOT_MARKER_MAX_BYTES)
    ) {
      throw new Error(
        "sealed source completion marker is not a bounded regular file",
      );
    }
    const bytes = Buffer.alloc(Number(state.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count <= 0)
        throw new Error(
          "sealed source completion marker changed while reading",
        );
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== state.dev ||
      after.ino !== state.ino ||
      after.size !== state.size ||
      after.mtimeNs !== state.mtimeNs ||
      after.ctimeNs !== state.ctimeNs
    ) {
      throw new Error("sealed source completion marker changed while reading");
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `cannot verify sealed Messenger source identity: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function deriveMessengerReleaseIdentity({
  releaseRoot,
  suppliedBuildId,
  suppliedManifestSha256,
}) {
  const inputs = resolve(releaseRoot);
  const repoRoot = dirname(inputs);
  if (realpathSync(inputs) !== inputs || realpathSync(repoRoot) !== repoRoot) {
    throw new Error("Messenger release inputs must use canonical paths");
  }
  try {
    lstatSync(join(repoRoot, ".git"));
    return deriveCleanReleaseIdentity({ releaseRoot: inputs, suppliedBuildId });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const marker = readSnapshotMarker(repoRoot);
  if (
    marker?.schema_version !== 1 ||
    marker?.complete !== true ||
    JSON.stringify(marker.scope) !== JSON.stringify(SNAPSHOT_SCOPE) ||
    !/^[a-f0-9]{40}$/.test(String(marker.source_commit ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(marker.source_manifest_sha256 ?? "")) ||
    !Number.isSafeInteger(marker.file_count) ||
    marker.file_count < 1 ||
    !Number.isSafeInteger(marker.total_size_bytes) ||
    marker.total_size_bytes < 1
  ) {
    throw new Error("sealed Messenger source completion marker is invalid");
  }
  if (suppliedBuildId !== marker.source_commit) {
    throw new Error(
      `supplied GC_BUILD_ID ${String(suppliedBuildId ?? "(missing)")} does not match sealed source commit ${marker.source_commit}`,
    );
  }
  if (suppliedManifestSha256 !== marker.source_manifest_sha256) {
    throw new Error(
      "supplied source manifest SHA-256 does not match the sealed source marker",
    );
  }
  return {
    buildId: marker.source_commit,
    repoRoot,
    sourceManifestSha256: marker.source_manifest_sha256,
  };
}
