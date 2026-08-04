import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeScopedConnectorVault,
  deriveConnectorVaultScope,
  type NativeConnectorSecretVault,
} from "../src/connector_vault.ts";

class FakeNativeVault implements NativeConnectorSecretVault {
  readonly values = new Map<string, string>();
  readonly calls: string[] = [];
  private readonly scopesByLease = new Map<string, string>();
  private readonly leasesByScope = new Map<string, string>();
  private nextLease = 0;
  failReleaseOnce = false;

  private key(scope: string, name: string): string { return `${scope}/${name}`; }
  private scope(lease: string): string {
    const scope = this.scopesByLease.get(lease);
    if (!scope) throw new Error("invalid connector vault capability");
    return scope;
  }

  async claim(scope: string): Promise<string> {
    if (this.leasesByScope.has(scope)) throw new Error("connector vault scope is already claimed");
    const lease = `lease.${++this.nextLease}.${"x".repeat(24)}`;
    this.leasesByScope.set(scope, lease);
    this.scopesByLease.set(lease, scope);
    this.calls.push(`claim:${scope}`);
    return lease;
  }

  async read(lease: string, name: string): Promise<string | null> {
    const scope = this.scope(lease);
    this.calls.push(`read:${scope}:${name}`);
    return this.values.get(this.key(scope, name)) ?? null;
  }

  async write(lease: string, name: string, valueBase64: string): Promise<void> {
    const scope = this.scope(lease);
    this.calls.push(`write:${scope}:${name}`);
    this.values.set(this.key(scope, name), valueBase64);
  }

  async remove(lease: string, name: string): Promise<void> {
    const scope = this.scope(lease);
    this.calls.push(`remove:${scope}:${name}`);
    this.values.delete(this.key(scope, name));
  }

  async wipe(lease: string): Promise<void> {
    const scope = this.scope(lease);
    this.calls.push(`wipe:${scope}`);
    for (const key of [...this.values.keys()]) if (key.startsWith(`${scope}/`)) this.values.delete(key);
  }

  async release(lease: string): Promise<void> {
    const scope = this.scope(lease);
    this.calls.push(`release:${scope}`);
    if (this.failReleaseOnce) {
      this.failReleaseOnce = false;
      throw new Error("native release failed");
    }
    this.scopesByLease.delete(lease);
    this.leasesByScope.delete(scope);
  }
}

test("native scoped connector vault round-trips arbitrary bytes without cross-account access", async () => {
  const native = new FakeNativeVault();
  const alice = await createNativeScopedConnectorVault(native, "telegram.serverA.user42");
  const bob = await createNativeScopedConnectorVault(native, "telegram.serverA.user43");
  const secret = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  await alice.write("database-key.v1", secret);
  assert.deepEqual(await alice.read("database-key.v1"), secret);
  assert.equal(await bob.read("database-key.v1"), null);
  const read = await alice.read("database-key.v1");
  assert.ok(read);
  read[0] = 99;
  assert.deepEqual(await alice.read("database-key.v1"), secret);
});

test("wipe is scoped and remove is idempotent", async () => {
  const native = new FakeNativeVault();
  const alice = await createNativeScopedConnectorVault(native, "telegram.serverA.user42");
  const bob = await createNativeScopedConnectorVault(native, "telegram.serverA.user43");
  await alice.write("one", Uint8Array.of(1));
  await alice.write("two", Uint8Array.of(2));
  await bob.write("one", Uint8Array.of(3));
  await alice.remove("missing");
  await alice.wipe();
  assert.equal(await alice.read("one"), null);
  assert.equal(await alice.read("two"), null);
  assert.deepEqual(await bob.read("one"), Uint8Array.of(3));
});

test("vault rejects traversal/control names and oversized or malformed native values", async () => {
  const native = new FakeNativeVault();
  await assert.rejects(createNativeScopedConnectorVault(native, "../wallet"), /scope/u);
  const vault = await createNativeScopedConnectorVault(native, "telegram.serverA.user42");
  await assert.rejects(vault.write("bad/name", Uint8Array.of(1)), /name/u);
  await assert.rejects(vault.write("large", new Uint8Array(64 * 1024 + 1)), /64 KiB/u);
  native.values.set("telegram.serverA.user42/broken", "not base64!");
  await assert.rejects(vault.read("broken"), /base64/u);
});


test("native connector vault grants one exclusive capability per scope and invalidates it on release", async () => {
  const native = new FakeNativeVault();
  const first = await createNativeScopedConnectorVault(native, "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await first.write("database-key.v1", Uint8Array.of(1, 2, 3));
  await assert.rejects(
    createNativeScopedConnectorVault(native, "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    /already claimed/u,
  );
  native.failReleaseOnce = true;
  assert.ok(first.dispose);
  await assert.rejects(() => first.dispose!(), /native release failed/u);
  assert.deepEqual(await first.read("database-key.v1"), Uint8Array.of(1, 2, 3), "failed release remains retryable");
  await first.dispose?.();
  await assert.rejects(first.read("database-key.v1"), /released/u);
  const replacement = await createNativeScopedConnectorVault(native, "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.deepEqual(await replacement.read("database-key.v1"), Uint8Array.of(1, 2, 3));
  await replacement.dispose?.();
});

test("connector vault scope binds server, GreenChat user, provider and account slot", async () => {
  const base = {
    serverId: "https://chat.example.test",
    greenChatUserId: "42",
    provider: "telegram",
    externalAccountId: "primary",
  } as const;
  const first = await deriveConnectorVaultScope(base);
  assert.match(first, /^cv1\.telegram\.[A-Za-z0-9_-]{32}$/u);
  assert.equal(await deriveConnectorVaultScope(base), first);
  assert.notEqual(await deriveConnectorVaultScope({ ...base, serverId: "https://other.example.test" }), first);
  assert.notEqual(await deriveConnectorVaultScope({ ...base, greenChatUserId: "43" }), first);
  assert.notEqual(await deriveConnectorVaultScope({ ...base, provider: "whatsapp_business" }), first);
  assert.notEqual(await deriveConnectorVaultScope({ ...base, externalAccountId: "secondary" }), first);
  assert.doesNotMatch(first, /example|42|primary/u, "native keyring labels do not disclose raw identities");
});

test("connector vault scope derivation fails closed on invalid identities or digest", async () => {
  const valid = {
    serverId: "https://chat.example.test",
    greenChatUserId: 42,
    provider: "telegram",
    externalAccountId: "primary",
  } as const;
  await assert.rejects(deriveConnectorVaultScope({ ...valid, serverId: "" }), /server id/u);
  await assert.rejects(deriveConnectorVaultScope({ ...valid, greenChatUserId: 0 }), /user id/u);
  await assert.rejects(
    deriveConnectorVaultScope({ ...valid, greenChatUserId: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integer/u,
  );
  await assert.doesNotReject(
    deriveConnectorVaultScope({ ...valid, greenChatUserId: "9007199254740993" }),
  );
  await assert.rejects(deriveConnectorVaultScope({ ...valid, provider: "Telegram" }), /provider/u);
  await assert.rejects(deriveConnectorVaultScope({ ...valid, externalAccountId: "../wallet" }), /account id/u);
  await assert.rejects(deriveConnectorVaultScope(valid, async () => new Uint8Array(8)), /digest/u);
});
