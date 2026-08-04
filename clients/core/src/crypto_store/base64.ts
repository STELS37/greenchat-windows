// Канонический base64 без Buffer/atob — одинаково работает в браузере, WebView и Node 22.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class CanonicalBase64Error extends Error {
  readonly reason: "invalid" | "noncanonical";

  constructor(reason: "invalid" | "noncanonical") {
    super(`invalid canonical base64 (${reason})`);
    this.name = "CanonicalBase64Error";
    this.reason = reason;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      ALPHABET[(n >> 6) & 63]! +
      ALPHABET[n & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      ALPHABET[(n >> 6) & 63]! +
      "=";
  }
  return out;
}

export function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    throw new CanonicalBase64Error("invalid");
  }
  const unpadded = value.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((unpadded.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of unpadded) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new CanonicalBase64Error("invalid");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
  }
  if (encodeBase64(out) !== value) throw new CanonicalBase64Error("noncanonical");
  return out;
}
