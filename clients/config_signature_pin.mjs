// Build-time root of trust for signed /v1/config network policy.
//
// The browser receives only the raw Ed25519 public JWK `x` (base64url, 32 bytes). Production deploys
// derive it from the same private PEM the server uses, so signer and client pin cannot silently drift.
// Native release builders that intentionally cannot read the server key may provide the public pin via
// GC_CONFIG_SIGNATURE_PIN. When both sources are present they MUST match.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";

const RAW_ED25519_PUBLIC_BYTES = 32;
const RAW_ED25519_JWK_X_RE = /^[A-Za-z0-9_-]{43}$/;

export function normalizeConfigSignaturePin(value, label = "config signature pin") {
  const pin = typeof value === "string" ? value.trim() : "";
  if (!pin) return "";
  if (!RAW_ED25519_JWK_X_RE.test(pin)) {
    throw new Error(`${label} must be an unpadded base64url Ed25519 JWK x value`);
  }
  let decoded;
  try {
    decoded = Buffer.from(pin, "base64url");
  } catch {
    throw new Error(`${label} is not valid base64url`);
  }
  if (decoded.length !== RAW_ED25519_PUBLIC_BYTES || decoded.toString("base64url") !== pin) {
    throw new Error(`${label} must decode to exactly ${RAW_ED25519_PUBLIC_BYTES} bytes`);
  }
  return pin;
}

async function pinFromPrivateKeyFile(keyFile) {
  if (!keyFile) return "";
  let pem;
  try {
    pem = await readFile(keyFile, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw new Error(`cannot read config signing key file: ${error instanceof Error ? error.message : String(error)}`);
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error("config signing key file is not a readable private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("config signing key must be Ed25519");
  }
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  return normalizeConfigSignaturePin(publicJwk.x, "derived config signature pin");
}

export async function resolveConfigSignaturePin({ explicitPin = "", keyFile = "", required = false } = {}) {
  const explicit = normalizeConfigSignaturePin(explicitPin, "GC_CONFIG_SIGNATURE_PIN");
  const derived = await pinFromPrivateKeyFile(typeof keyFile === "string" ? keyFile.trim() : "");
  if (explicit && derived && explicit !== derived) {
    throw new Error("GC_CONFIG_SIGNATURE_PIN does not match GC_CONFIG_SIGN_KEY_FILE");
  }
  const pin = explicit || derived;
  if (required && !pin) {
    throw new Error("signed network config is required, but no Ed25519 public pin is available");
  }
  return pin;
}
