// clients/core — config_verify (NR-03 client half; server counterpart: server/src/core/config_sign.ts,
// T-603). Independent verifier for the ed25519-signed /v1/config core {endpoints, policy, kill_switch}
// against a BUILD-PINNED public key (NETWORK_RESILIENCE.md §5: only the public key baked into the
// binary is the root of trust — the `public_key` transmitted in the body is NEVER trusted, at most it
// feeds a mismatch diagnostic upstream).
//
// SELF-CONTAINED BY DESIGN: zero imports. The canonicalizer below MUST stay a byte-for-byte mirror of
// server/src/core/config_sign.ts canonicalize() — the parity is regression-pinned by
// test/config_verify.test.ts, which (a) verifies a fixture signed by the server's own compiled
// signConfig and (b) runs both canonicalizers over an edge-case battery asserting byte equality.
// Mirror contract (identical code ⇒ identical bytes, guaranteed by ECMAScript semantics, not by luck):
//   * object keys sorted lexicographically (Array.prototype.sort default = UTF-16 code-unit order),
//     recursively, by REBUILDING each object in sorted insertion order and letting JSON.stringify
//     enumerate it (spec-ordered: integer-like keys ascending first, then insertion order — the same
//     on V8/JSC/SpiderMonkey/Node, so e.g. {"10":1,"2":2} canonicalizes identically everywhere);
//   * ARRAY ORDER PRESERVED — endpoint order encodes geo/priority preference and is signed;
//   * scalars/whitespace = plain JSON.stringify (no spaces; numbers via spec Number::toString;
//     lone surrogates escaped \uXXXX by well-formed JSON.stringify, ES2019+ — pure-ASCII output there);
//   * UTF-8 encoding of the canonical string == Node's Buffer.from(str, "utf8") for every well-formed
//     string (and JSON.stringify output is always well-formed).

/** Byte-for-byte mirror of server canonicalize(): deterministic canonical JSON of the signed core. */
export function canonicalizeConfigCore(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

// --- strict base64 (zero-dep; atob/Buffer deliberately avoided — one deterministic decoder for both
// --- alphabets, canonical-form-only so an attacker gets no malleability games) ---------------------

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// null = malformed (bad charset / bad padding / impossible length / non-zero trailing bits).
function decodeB64(input: string, alphabet: string): Uint8Array | null {
  let body = input;
  const padIdx = input.indexOf("=");
  if (padIdx !== -1) {
    if (input.length % 4 !== 0) return null; // padding only makes sense on 4-aligned input
    for (let i = padIdx; i < input.length; i++) if (input[i] !== "=") return null;
    if (input.length - padIdx > 2) return null;
    body = input.slice(0, padIdx);
  }
  if (body.length % 4 === 1) return null; // no byte length produces a 1-char tail
  const out = new Uint8Array(Math.floor((body.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < body.length; i++) {
    const v = alphabet.indexOf(body[i]!);
    if (v === -1) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null; // reject non-canonical encodings
  return out;
}

/** Возвращает глобальный SubtleCrypto — стиль отказа как в crypto_store/primitives.ts. */
function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error("config_verify: WebCrypto (crypto.subtle) недоступен в этой среде");
  }
  return c.subtle;
}

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

// ArrayBuffer view of a Uint8Array for strict WebCrypto BufferSource typing (same pattern as
// crypto_store/primitives.ts bufOf; our arrays are freshly allocated, so this is always zero-copy).
function bufOf(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) {
    return u.buffer as ArrayBuffer;
  }
  return u.slice().buffer as ArrayBuffer;
}

/**
 * Verify the detached ed25519 signature over the /v1/config core against the PINNED public key.
 *
 *   core               — the {endpoints, policy, kill_switch} EXACTLY as received (any extra body
 *                        fields are ignored here: the server signs only these three keys —
 *                        server/src/modules/config.ts). A missing member simply fails verification,
 *                        because the server-signed canonical form always contains all three.
 *   signatureB64       — standard base64 (what signConfig emits via Buffer.toString("base64")).
 *   pinnedPublicKeyB64Url — base64url raw 32-byte ed25519 key, i.e. the JWK "x" value: the exact
 *                        string the operator gets from the signing key (crypto.createPublicKey(...)
 *                        .export({format:"jwk"}).x) and the same encoding the server transmits as
 *                        `public_key`. Chosen so the build pin is copy-pasteable from key generation
 *                        output; imported as "raw" bytes (we already hold a validated 32-byte value —
 *                        no intermediate JWK object, same support matrix per WebCrypto Secure Curves).
 *
 * Returns false on ANY defect: malformed/wrong-size signature or pin, canonical-core mismatch (body
 * tampering, added/removed keys, reordered arrays), foreign key, or an importKey/verify failure
 * (e.g. an engine without Ed25519 — the caller under a pin must fail closed either way).
 * Throws ONLY when WebCrypto itself is absent (subtle() above) — a loudly broken environment.
 */
export async function verifyConfigSignature(
  core: { endpoints?: unknown; policy?: unknown; kill_switch?: unknown },
  signatureB64: string,
  pinnedPublicKeyB64Url: string,
): Promise<boolean> {
  const sig = decodeB64(signatureB64, STD_ALPHABET);
  if (sig === null || sig.length !== ED25519_SIGNATURE_BYTES) return false;
  const pin = decodeB64(pinnedPublicKeyB64Url, URL_ALPHABET);
  if (pin === null || pin.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  const s = subtle();
  // Rebuild the exact signed triple: literal key order here is irrelevant (canonicalize sorts), and
  // rebuilding guarantees unsigned body fields (server_time/limits/features/legal) never leak in.
  const canonical = canonicalizeConfigCore({
    endpoints: core.endpoints,
    policy: core.policy,
    kill_switch: core.kill_switch,
  });
  const message = new TextEncoder().encode(canonical);
  try {
    const key = await s.importKey("raw", bufOf(pin), { name: "Ed25519" }, false, ["verify"]);
    return await s.verify({ name: "Ed25519" }, key, bufOf(sig), bufOf(message));
  } catch {
    return false; // no Ed25519 in this engine / hostile key material — never an acceptance
  }
}
