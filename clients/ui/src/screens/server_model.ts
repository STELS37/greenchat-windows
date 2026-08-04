// clients/ui/src/screens/server_model.ts — pure helpers for the «Адрес сервера» screen (T-419).
// The screen lets a user point the client at a self-hosted / alternate Green Chat server. This module
// holds the DOM-free, unit-tested parts: validating + normalising a typed address, and comparing two
// addresses. It deliberately MIRRORS core's normalizeBase (clients/core/src/endpoints.ts) rather than
// importing it — the ui layer stays decoupled from the SDK (the web shell's ServerPort bridges to the
// real EndpointManager). Rules: "" means "use the built-in default" (same-origin for web); a bare host
// gets https://; only http(s) is allowed; the value is reduced to a scheme+host origin (the server
// serves /v1 at the root).

export type ServerParse =
  | { ok: true; value: string } // value "" = reset to the built-in default
  | { ok: false; reason: "invalid" };

export function parseServerAddress(input: string): ServerParse {
  const s = input.trim();
  if (s === "") return { ok: true, value: "" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "invalid" };
  if (!u.host) return { ok: false, reason: "invalid" };
  return { ok: true, value: `${u.protocol}//${u.host}` };
}

// Whether two addresses resolve to the same normalised target, so a "save" with no real change skips the
// session-ending switch. Unparseable inputs compare by their trimmed raw string.
export function sameServer(a: string, b: string): boolean {
  const pa = parseServerAddress(a);
  const pb = parseServerAddress(b);
  const na = pa.ok ? pa.value : a.trim();
  const nb = pb.ok ? pb.value : b.trim();
  return na === nb;
}
