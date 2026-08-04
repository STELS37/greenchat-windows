// clients/core/src/connector_vault.ts — connector-only secret storage seam (T-451/T-452).
//
// External provider credentials and database keys must not share GreenChat auth/payment key domains.
// Native shells back this seam with OS secure storage/keyring. The shared core adds strict scope/name
// validation and byte/base64 conversion, exposing only ScopedConnectorVault to provider adapters.

import type { ScopedConnectorVault } from "./connectors.ts";

const TOKEN = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_SECRET_BYTES = 64 * 1024;
const NATIVE_VAULT_CAPABILITIES = new WeakMap<ScopedConnectorVault, string>();


export interface ConnectorVaultScopeIdentity {
  /** Stable GreenChat server identity (configured primary, never a transient failover endpoint). */
  serverId: string;
  greenChatUserId: string | number | bigint;
  provider: string;
  /** Stable local account slot. Telegram T-453A uses legacy `primary` plus random per-account slots. */
  externalAccountId: string;
}

export type ConnectorVaultDigest = (input: Uint8Array) => Promise<Uint8Array>;

function canonicalUserId(value: string | number | bigint): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError("GreenChat user id number must be a positive safe integer");
  }
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[1-9][0-9]{0,39}$/u.test(normalized)) throw new TypeError("GreenChat user id must be a positive integer");
  return normalized;
}

function scopePart(value: string, label: string, pattern: RegExp, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !pattern.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function canonicalScopeIdentity(identity: ConnectorVaultScopeIdentity): Uint8Array {
  const serverId = identity.serverId.trim();
  if (!serverId || serverId.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(serverId)) {
    throw new TypeError("GreenChat server id is invalid");
  }
  const userId = canonicalUserId(identity.greenChatUserId);
  const provider = scopePart(identity.provider, "connector provider", /^[a-z][a-z0-9_]{0,31}$/u, 32);
  const account = scopePart(identity.externalAccountId, "external account id", /^[A-Za-z0-9._:-]{1,128}$/u, 128);
  const fields = ["connector-vault-v1", serverId, userId, provider, account];
  return new TextEncoder().encode(fields.map((value) => `${value.length}:${value}`).join("|"));
}

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) throw new Error("secure connector scope hashing is unavailable");
  const stable = new Uint8Array(input);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", stable.buffer));
}

/**
 * Derive a compact native-vault namespace from all security-boundary identities.
 * SHA-256 avoids collision-prone ad-hoc hashes while keeping raw server/account identifiers out of keyring labels.
 */
export async function deriveConnectorVaultScope(
  identity: ConnectorVaultScopeIdentity,
  digest: ConnectorVaultDigest = sha256,
): Promise<string> {
  const provider = scopePart(identity.provider, "connector provider", /^[a-z][a-z0-9_]{0,31}$/u, 32);
  const hashed = await digest(canonicalScopeIdentity(identity));
  if (!(hashed instanceof Uint8Array) || hashed.byteLength < 24) {
    throw new Error("connector scope digest is invalid");
  }
  return `cv1.${provider}.${bytesToBase64(hashed.slice(0, 24)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
}

export interface NativeConnectorSecretVault {
  /** Exclusively bind a trusted account-derived scope and return an unpredictable process-local capability. */
  claim(scope: string): Promise<string>;
  read(lease: string, name: string): Promise<string | null>;
  write(lease: string, name: string, valueBase64: string): Promise<void>;
  remove(lease: string, name: string): Promise<void>;
  wipe(lease: string): Promise<void>;
  release(lease: string): Promise<void>;
}

function token(value: string, label: string): string {
  const normalized = value.trim();
  if (!TOKEN.test(normalized)) throw new TypeError(`${label} must be a safe opaque token`);
  return normalized;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_SECRET_BYTES) throw new RangeError("connector secret exceeds 64 KiB");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const packed = (a << 16) | (b << 8) | c;
    out += alphabet[(packed >>> 18) & 63];
    out += alphabet[(packed >>> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(packed >>> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[packed & 63] : "=";
  }
  return out;
}

/** Return the opaque native lease only to trusted native bridge adapters. */
export function nativeConnectorVaultCapability(vault: ScopedConnectorVault): string | null {
  return NATIVE_VAULT_CAPABILITIES.get(vault) ?? null;
}

function base64ToBytes(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_SECRET_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError("native connector vault returned invalid base64");
  }
  const lookup = new Int16Array(128).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i += 1) lookup[alphabet.charCodeAt(i)] = i;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = lookup[value.charCodeAt(i)] ?? -1;
    const b = lookup[value.charCodeAt(i + 1)] ?? -1;
    const cChar = value[i + 2] ?? "=";
    const dChar = value[i + 3] ?? "=";
    const c = cChar === "=" ? 0 : lookup[cChar.charCodeAt(0)] ?? -1;
    const d = dChar === "=" ? 0 : lookup[dChar.charCodeAt(0)] ?? -1;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new TypeError("native connector vault returned invalid base64");
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < out.length) out[offset++] = (packed >>> 16) & 255;
    if (offset < out.length) out[offset++] = (packed >>> 8) & 255;
    if (offset < out.length) out[offset++] = packed & 255;
  }
  return out;
}

/** Bind a provider/account-specific scope to an exclusive native capability lease. */
export async function createNativeScopedConnectorVault(
  native: NativeConnectorSecretVault,
  scopeValue: string,
): Promise<ScopedConnectorVault> {
  const scope = token(scopeValue, "connector vault scope");
  const lease = token(await native.claim(scope), "connector vault lease");
  let state: "active" | "releasing" | "disposed" = "active";
  let releaseTask: Promise<void> | null = null;
  const activeLease = (): string => {
    if (state !== "active") throw new Error("connector vault capability is released");
    return lease;
  };
  const scoped: ScopedConnectorVault = {
    async read(nameValue: string): Promise<Uint8Array | null> {
      const name = token(nameValue, "connector secret name");
      const value = await native.read(activeLease(), name);
      return value === null ? null : base64ToBytes(value);
    },
    async write(nameValue: string, value: Uint8Array): Promise<void> {
      const name = token(nameValue, "connector secret name");
      if (!(value instanceof Uint8Array)) throw new TypeError("connector secret must be Uint8Array");
      await native.write(activeLease(), name, bytesToBase64(value));
    },
    remove(nameValue: string): Promise<void> {
      return native.remove(activeLease(), token(nameValue, "connector secret name"));
    },
    wipe(): Promise<void> {
      return native.wipe(activeLease());
    },
    async dispose(): Promise<void> {
      if (state === "disposed") return;
      if (releaseTask) return releaseTask;
      state = "releasing";
      releaseTask = native.release(lease).then(
        () => { state = "disposed"; },
        (error: unknown) => {
          state = "active";
          releaseTask = null;
          throw error;
        },
      );
      return releaseTask;
    },
  };
  NATIVE_VAULT_CAPABILITIES.set(scoped, lease);
  return scoped;
}
