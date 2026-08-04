import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfigSignaturePin, resolveConfigSignaturePin } from "./config_signature_pin.mjs";

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pin = publicKey.export({ format: "jwk" }).x;
  assert.equal(typeof pin, "string");
  return { privateKey, pin };
}

test("empty build inputs produce an explicitly unpinned development bundle", async () => {
  assert.equal(await resolveConfigSignaturePin(), "");
  assert.equal(normalizeConfigSignaturePin("  "), "");
});

test("an explicit raw Ed25519 public JWK x is normalized and accepted", async () => {
  const { pin } = pair();
  assert.equal(await resolveConfigSignaturePin({ explicitPin: ` ${pin} ` }), pin);
});

test("required release builds fail closed when neither a key nor a public pin is available", async () => {
  await assert.rejects(resolveConfigSignaturePin({ required: true }), /no Ed25519 public pin/);
  const { pin } = pair();
  assert.equal(await resolveConfigSignaturePin({ required: true, explicitPin: pin }), pin);
});

test("malformed, padded or wrong-length public pins are rejected", async () => {
  await assert.rejects(resolveConfigSignaturePin({ explicitPin: "not-a-key" }), /unpadded base64url/);
  await assert.rejects(resolveConfigSignaturePin({ explicitPin: "A".repeat(42) }), /unpadded base64url/);
  await assert.rejects(resolveConfigSignaturePin({ explicitPin: "A".repeat(42) + "B" }), /decode to exactly 32 bytes/);
  await assert.rejects(resolveConfigSignaturePin({ explicitPin: "A".repeat(42) + "=" }), /unpadded base64url/);
});

test("the production pin is derived from the server's Ed25519 private PEM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-config-pin-"));
  try {
    const { privateKey, pin } = pair();
    const keyFile = join(dir, "config_ed25519.pem");
    await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    assert.equal(await resolveConfigSignaturePin({ keyFile }), pin);
    assert.equal(await resolveConfigSignaturePin({ keyFile, explicitPin: pin }), pin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit pin cannot disagree with the server signing key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-config-pin-mismatch-"));
  try {
    const first = pair();
    const second = pair();
    const keyFile = join(dir, "config_ed25519.pem");
    await writeFile(keyFile, first.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await assert.rejects(
      resolveConfigSignaturePin({ keyFile, explicitPin: second.pin }),
      /does not match/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing key files stay compatible, but invalid or non-Ed25519 key files fail the build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-config-pin-invalid-"));
  try {
    assert.equal(await resolveConfigSignaturePin({ keyFile: join(dir, "missing.pem") }), "");
    const invalid = join(dir, "invalid.pem");
    await writeFile(invalid, "not a private key", { mode: 0o600 });
    await assert.rejects(resolveConfigSignaturePin({ keyFile: invalid }), /not a readable private key/);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const rsaFile = join(dir, "rsa.pem");
    await writeFile(rsaFile, rsa.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await assert.rejects(resolveConfigSignaturePin({ keyFile: rsaFile }), /must be Ed25519/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
