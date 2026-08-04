import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  assertBuildTargetsOutsideLiveTree,
  findLiveTreeViolations,
  LIVE_TREE_OVERRIDE_ENV,
  parseLiveRepoRoot,
} from "./live_tree_guard.mjs";

const LIVE_ROOT = "/srv/green_chat";
const UNIT = [
  "[Service]",
  "WorkingDirectory=/srv/green_chat/server",
  "ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /srv/green_chat/server/dist/bootstrap.js",
  "Restart=always",
].join("\n");

const inTreeTargets = () => [
  { label: "web output directory", path: join(LIVE_ROOT, "clients", "web", "dist") },
  { label: "update manifest", path: join(LIVE_ROOT, "var", "updates", "manifest.json") },
];

test("live root is parsed from the systemd ExecStart entry point", () => {
  assert.equal(parseLiveRepoRoot(UNIT), LIVE_ROOT);
  assert.equal(parseLiveRepoRoot("ExecStart=/usr/bin/node /srv/other/server.js"), null);
  assert.equal(parseLiveRepoRoot("[Service]\nExecStop=/bin/true"), null);
  assert.equal(parseLiveRepoRoot(null), null);
});

test("a plain in-tree build on the production host is refused with actionable guidance", async () => {
  await assert.rejects(
    assertBuildTargetsOutsideLiveTree({
      targets: inTreeTargets(),
      env: {},
      unitFile: "/etc/systemd/system/green-chat.service",
      readUnit: async () => UNIT,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /refusing to build into the live production tree \/srv\/green_chat/u);
      assert.match(error.message, /live served web bundle/u);
      assert.match(error.message, /live published update artifacts/u);
      assert.match(error.message, /scripts\/deploy\.sh/u);
      assert.match(error.message, /GC_WEB_OUT_DIR/u);
      assert.match(error.message, new RegExp(`${LIVE_TREE_OVERRIDE_ENV}=1`, "u"));
      return true;
    },
  );
});

test("staged deploy targets and isolated CI checkouts keep building", async () => {
  // scripts/deploy.sh: GC_WEB_OUT_DIR / GC_UPDATE_MANIFEST_OUT point at a mktemp rollback directory.
  const staged = await assertBuildTargetsOutsideLiveTree({
    targets: [
      { label: "web output directory", path: "/tmp/gc-deploy-rollback.AbCdEf/web-dist.new" },
      { label: "update manifest", path: "/tmp/gc-deploy-rollback.AbCdEf/updates.new/manifest.json" },
    ],
    env: {},
    readUnit: async () => UNIT,
  });
  assert.equal(staged, LIVE_ROOT);

  // A checkout that is not the deployed tree (external CI mirror, sandbox worker, developer clone).
  const elsewhere = await assertBuildTargetsOutsideLiveTree({
    targets: [{ label: "web output directory", path: "/tmp/gc-external-ci-source.XyZ/clients/web/dist" }],
    env: {},
    readUnit: async () => UNIT,
  });
  assert.equal(elsewhere, LIVE_ROOT);
});

test("hosts without a live deployment are unaffected", async () => {
  const noUnit = await assertBuildTargetsOutsideLiveTree({
    targets: inTreeTargets(),
    env: {},
    readUnit: async () => null,
  });
  assert.equal(noUnit, null);
});

test("the override waives the guard for an intentional live rebuild", async () => {
  const waived = await assertBuildTargetsOutsideLiveTree({
    targets: inTreeTargets(),
    env: { [LIVE_TREE_OVERRIDE_ENV]: "1" },
    readUnit: async () => {
      throw new Error("unit file must not be read when the guard is waived");
    },
  });
  assert.equal(waived, null);
});

// DE2 regression: /srv/projects is bind-mounted at /a0/usr/projects, so the live tree answers to two
// absolute paths. A build launched through the alias writes into the very inodes the service serves
// while a string compare against the systemd ExecStart path reports nothing.
const ALIAS_ROOT = "/a0/usr/projects/green_chat";
const BIND_MOUNT_INODES = new Map([
  [join(LIVE_ROOT, "clients", "web", "dist"), { dev: 65028, ino: 2621704 }],
  [join(ALIAS_ROOT, "clients", "web", "dist"), { dev: 65028, ino: 2621704 }],
  [join(LIVE_ROOT, "var", "updates"), { dev: 65028, ino: 2621799 }],
  [join(ALIAS_ROOT, "var", "updates"), { dev: 65028, ino: 2621799 }],
  [join(ALIAS_ROOT, "clients", "web", "dist-staging"), { dev: 65028, ino: 3300001 }],
  ["/tmp/gc-deploy-rollback.AbCdEf/web-dist.new", { dev: 64, ino: 9001 }],
]);
const bindMountStat = (path) => {
  const entry = BIND_MOUNT_INODES.get(path);
  if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return entry;
};

test("a build through a bind-mounted alias of the live tree is caught by inode identity", () => {
  const violations = findLiveTreeViolations({
    liveRoot: LIVE_ROOT,
    stat: bindMountStat,
    targets: [
      { label: "web output directory", path: join(ALIAS_ROOT, "clients", "web", "dist") },
      { label: "update manifest", path: join(ALIAS_ROOT, "var", "updates", "manifest.json") },
    ],
  });
  assert.equal(violations.length, 2);
  assert.match(violations[0], /web output directory → \/a0\/usr\/projects\/green_chat\/clients\/web\/dist /u);
  assert.match(violations[0], /live served web bundle, same directory as \/srv\/green_chat\/clients\/web\/dist under another mount path/u);
  assert.match(violations[1], /live published update artifacts, same directory as \/srv\/green_chat\/var\/updates under another mount path/u);
});

test("inode identity does not fire on distinct directories or staged deploy targets", () => {
  assert.deepEqual(
    findLiveTreeViolations({
      liveRoot: LIVE_ROOT,
      stat: bindMountStat,
      targets: [
        { label: "sibling staging dir", path: join(ALIAS_ROOT, "clients", "web", "dist-staging") },
        { label: "web output directory", path: "/tmp/gc-deploy-rollback.AbCdEf/web-dist.new" },
      ],
    }),
    [],
  );
});

test("an alias build is refused end to end with the same actionable guidance", async () => {
  await assert.rejects(
    assertBuildTargetsOutsideLiveTree({
      targets: [{ label: "web output directory", path: join(ALIAS_ROOT, "clients", "web", "dist") }],
      env: {},
      stat: bindMountStat,
      readUnit: async () => UNIT,
    }),
    (error) => {
      assert.match(error.message, /refusing to build into the live production tree \/srv\/green_chat/u);
      assert.match(error.message, /under another mount path/u);
      assert.match(error.message, new RegExp(`${LIVE_TREE_OVERRIDE_ENV}=1`, "u"));
      return true;
    },
  );
});

test("path matching is prefix-safe and covers nested targets", () => {
  const violations = findLiveTreeViolations({
    liveRoot: LIVE_ROOT,
    targets: [
      { label: "sibling staging dir", path: join(LIVE_ROOT, "clients", "web", "dist-staging") },
      { label: "unrelated var dir", path: join(LIVE_ROOT, "var", "updates-old") },
      { label: "nested asset dir", path: join(LIVE_ROOT, "clients", "web", "dist", "assets") },
    ],
  });
  assert.deepEqual(violations, [
    `nested asset dir → ${join(LIVE_ROOT, "clients", "web", "dist", "assets")} (live served web bundle)`,
  ]);
  assert.deepEqual(findLiveTreeViolations({ liveRoot: null, targets: inTreeTargets() }), []);
});
