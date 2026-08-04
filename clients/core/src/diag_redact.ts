// clients/core/src/diag_redact.ts — device-side EXACT-allowlist diagnostics redaction (T-515).
//
// Implements SUPPORT.md §2.3 rules R1–R7. PURE, DOM-free, dependency-free: every transform is a
// string→string function applied BEFORE anything is queued or POSTed, so a raw stack, a token, an
// e-mail, a route id or a query string can never reach the crash queue or the wire.
//
// Two entry points the controller calls:
//   • redactStack(raw)      — an Error message+stack -> sanitised header (R1/R2/R3) then <=10 frames
//                             reduced to bundle `file:line:column` ONLY (R4). Locals, arguments, hosts,
//                             query strings and URL-embedded tokens are dropped, not masked.
//   • redactBreadcrumb(raw) — a screen name / route -> path only, no query/fragment, numeric segments
//                             -> {id} (R5), with R1/R2/R3 masking of any residual PII in the remainder.
//
// R6 (we never capture console.*, only onerror/unhandledrejection) and R7 (the buffer lives in memory;
// only already-redacted snapshots persist) are properties of the CALLER (diagnostics.ts), not string
// transforms — see the controller consent cache, breadcrumb gate and opt-out purge.

// ---- R1 caps -------------------------------------------------------------------------------------
export const MSG_MAX = 300; // an error message / stack header
export const FIELD_MAX = 120; // any other single field (a breadcrumb, one frame line)
export const STACK_MAX_FRAMES = 10; // R4 — keep at most the top 10 frames
export const STACK_MAX_CHARS = 8 * 1024; // mirror the server 8 KB stack ceiling (client-side clamp)

// The blob placeholder for a masked token/key/seed/wallet run (guillemets around the word "blob").
const BLOB = "‹blob›";

// Control chars C0 (0x00-0x1F) + DEL (0x7F). Built from escapes so no literal control byte is in source.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
const NUL_RE = new RegExp("\\u0000", "g");

// R2 — an e-mail address anywhere in the string.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// R2 — 7+ consecutive digits (phone / card / long numeric id).
const DIGITS_RE = /\d{7,}/g;
// R3 — a base64url / standard-base64 / hex / base58-like run LONGER than 24 chars (>24 => length >= 25):
// catches JWTs, API keys, hex private keys / seed entropy and wallet addresses. "/" is deliberately
// EXCLUDED so ordinary file paths are not swallowed — every in-scope secret format (base64url token,
// hex key, base58/bech32 wallet, TON base64url) is caught without it.
const BLOB_RE = /[A-Za-z0-9+=_-]{25,}/g;

/** R1 — strip control chars, collapse runs of whitespace, trim. (Length cap applied by the caller.) */
export function sanitize(s: string): string {
  return s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * R2 + R3 masking, ordered so each pass cannot undo the previous one:
 *   1. e-mail  -> e***@***   (before digits/blob, so a digit-bearing local part stays a whole match)
 *   2. blob    -> the blob placeholder (token collapsed before the digit pass can nibble its digits)
 *   3. digits  -> #######    (phones / cards / long numeric ids that were not part of a blob)
 */
export function maskPii(s: string): string {
  return s.replace(EMAIL_RE, "e***@***").replace(BLOB_RE, BLOB).replace(DIGITS_RE, "#######");
}

/** R1+R2+R3 for a free-text field, capped to `max`. */
export function redactText(raw: string, max: number): string {
  return maskPii(sanitize(raw)).slice(0, max);
}

/**
 * R5 — reduce a URL/route to its PATH only (no scheme, host, query or fragment); numeric path
 * segments -> {id}. Non-route strings (a plain screen name) are returned trimmed, untouched here.
 */
export function redactRoute(raw: string): string {
  let path = raw.trim();
  const scheme = path.indexOf("://");
  if (scheme >= 0) {
    const slash = path.indexOf("/", scheme + 3); // first slash after "scheme://host"
    path = slash >= 0 ? path.slice(slash) : "/";
  }
  const q = path.search(/[?#]/); // drop query + fragment
  if (q >= 0) path = path.slice(0, q);
  if (!path.startsWith("/")) return raw.trim(); // not a path — leave it for maskPii in the caller
  const out = path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? "{id}" : seg))
    .join("/");
  return out === "" ? "/" : out;
}

/** R1 + R5 (+ R2/R3) for one breadcrumb (a screen name or a route), capped to FIELD_MAX. */
export function redactBreadcrumb(raw: string): string {
  const s = sanitize(raw);
  if (s === "") return "";
  const looksRoute = s.startsWith("/") || s.includes("://");
  return maskPii(looksRoute ? redactRoute(s) : s).slice(0, FIELD_MAX);
}

/**
 * Extract `file:line:column` from a single stack-frame line and reduce the file to its BASENAME with
 * scheme/host/query/fragment stripped (R4). Returns null for a line with no trailing location (e.g.
 * `at <anonymous>`), so header text is never mistaken for a frame. maskPii runs on the basename too,
 * so a token-as-filename (one long path segment) collapses to the blob placeholder rather than leaking.
 */
function frameLocation(line: string): string | null {
  const m = line.match(/([^\s()]+):(\d+):(\d+)\)?\s*$/); // the location is always at the frame end
  if (!m) return null;
  const noQuery = (m[1] as string).split(/[?#]/)[0] as string; // strip ?query / #fragment
  const base = (noQuery.split(/[\\/]/).pop() ?? noQuery).trim(); // basename -> drops scheme + host + path
  const file = maskPii(base) || "?";
  return `${file}:${m[2]}:${m[3]}`.slice(0, FIELD_MAX);
}

// A line is a stack frame iff it carries a trailing location AND looks like one (V8 `at ...` or `fn@...`).
function looksLikeFrame(line: string): boolean {
  return frameLocation(line) !== null && (/^\s*at\s/.test(line) || line.includes("@"));
}

/**
 * R4 (+ R1/R2/R3 on the header) — an Error message+stack -> a redacted header line then at most 10
 * frames, each reduced to bundle `file:line:column`. Everything before the first frame is the message
 * header (sanitised, PII-masked, capped to 300). Empty input -> "".
 */
export function redactStack(raw: string): string {
  const text = raw.replace(NUL_RE, "").replace(/\r\n?/g, "\n"); // NUL-strip + normalise newlines
  const lines = text.split("\n");
  const headerLines: string[] = [];
  const frames: string[] = [];
  let inFrames = false;
  for (const line of lines) {
    if (!inFrames && !looksLikeFrame(line)) {
      headerLines.push(line);
      continue;
    }
    inFrames = true;
    if (frames.length >= STACK_MAX_FRAMES) break; // keep only the top 10
    const loc = frameLocation(line);
    if (loc) frames.push("at " + loc);
  }
  const header = redactText(headerLines.join(" "), MSG_MAX);
  const parts: string[] = [];
  if (header) parts.push(header);
  for (const f of frames) parts.push(f);
  return parts.join("\n").slice(0, STACK_MAX_CHARS);
}
