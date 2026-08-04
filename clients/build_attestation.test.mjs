import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createWebBuildAttestation,
  WEB_BUILD_ATTESTATION_FILE,
  verifyWebBuildAttestation,
} from "./build_attestation.mjs";

const BUILD_ID = "0123456789abcdef0123456789abcdef01234567";

test("web attestation binds the exact messenger distribution channel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gc-channel-attestation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html>\n", "utf8");

  const attestation = await createWebBuildAttestation(root, {
    profile: "messenger",
    distributionChannel: "messenger-direct-apk",
    buildId: BUILD_ID,
  });
  assert.equal(attestation.distribution_channel, "messenger-direct-apk");
  await writeFile(
    join(root, WEB_BUILD_ATTESTATION_FILE),
    `${JSON.stringify(attestation)}\n`,
    "utf8",
  );

  await assert.doesNotReject(
    verifyWebBuildAttestation(root, {
      expectedProfile: "messenger",
      expectedDistributionChannel: "messenger-direct-apk",
      expectedBuildId: BUILD_ID,
    }),
  );
  await assert.rejects(
    verifyWebBuildAttestation(root, {
      expectedProfile: "messenger",
      expectedDistributionChannel: "messenger-store-managed",
      expectedBuildId: BUILD_ID,
    }),
    /distribution channel.*expected messenger-store-managed/i,
  );
});

test("development attestation cannot claim a messenger channel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gc-channel-attestation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html>\n", "utf8");

  await assert.rejects(
    createWebBuildAttestation(root, {
      profile: "development",
      distributionChannel: "messenger-direct-apk",
      buildId: "dev-local",
    }),
    /GC_DISTRIBUTION_CHANNEL|distribution channel/i,
  );
});
