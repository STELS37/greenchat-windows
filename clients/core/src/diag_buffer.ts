// clients/core/src/diag_buffer.ts — T-512 (MS-2): in-RAM diagnostics ring buffer (SUPPORT.md §2.1).
//
// A DOM-free, dependency-free companion to diagnostics.ts. It keeps a short, bounded trail of technical
// breadcrumbs — route changes, FAILED api calls, WebSocket lifecycle, uncaught errors, rare perf marks
// and system-button clicks — so that a user who files a support ticket CAN attach it, and ONLY then.
//
// Privacy is structural, not a promise made at send time:
//   • R1–R5 redaction happens AT WRITE TIME, through clients/core/src/diag_redact.ts (T-515). A raw
//     token, e-mail, phone number, query string or stack frame can never ENTER the ring, so any later
//     snapshot() is safe by construction — there is no "remember to redact on send" step to forget.
//   • R6: we never wrap console.* — callers push explicit, typed breadcrumbs.
//   • R7: the ring lives entirely in memory; nothing here touches disk. The one thing that may persist is
//     the web shell's offline ticket queue, and it stores the ALREADY-redacted output of snapshot().
//   • The buffer is NOT consent-gated: it is local RAM. Its contents leave the device only when the user
//     explicitly sends a ticket with "attach technical data" ticked (and can preview the exact JSON first).
//
// Bounded twice (SUPPORT.md §2.1): at most MAX_ENTRIES records AND at most MAX_BYTES of stringified
// payload, evicting oldest-first. Successful api calls are COUNTED, not stored. A snapshot carries an
// environment head (env) that mirrors the wire shape POST /v1/support/tickets expects: { env, entries }.
//
// NOTE (path): SUPPORT.md §2.1/§2.3 name `clients/ui/src/core/diag_buffer.ts` and `.../diag_redact.ts`,
// but that directory does not exist; diag_redact.ts (T-515) and diagnostics.ts (T-418) both live here in
// clients/core/src. This module sits next to them, as §2.1 intends ("рядом с diagnostics.ts").

import {
  redactText, redactRoute, redactBreadcrumb, redactStack,
  MSG_MAX, FIELD_MAX, STACK_MAX_FRAMES,
} from "./diag_redact.ts";

// SUPPORT.md §2.1 — the ONLY breadcrumb kinds; mirrors the server allowlist in modules/support.ts.
export type DiagKind = "route" | "api" | "ws" | "err" | "perf" | "ui";

export interface DiagEntry {
  t: number; // ms since epoch (buffer clock)
  kind: DiagKind;
  data: Record<string, unknown>; // already redacted at write time
}

// The environment head (SUPPORT.md §2.1): app_version, platform, TRUNCATED user-agent, locale, the
// pseudonymous install_id (T-418), online/offline, and the T-125 clock offset (seconds). No direct account id.
export interface DiagEnv {
  app_version: string;
  platform: string;
  ua: string;
  locale: string;
  install_id: string;
  online: boolean;
  clock_offset: number;
}

// The wire shape consumed by POST /v1/support/tickets (its optional `diagnostics` field).
export interface DiagSnapshot {
  env: DiagEnv | null;
  entries: DiagEntry[];
}

export interface DiagBufferOptions {
  now?: () => number; // ms epoch; default Date.now
  maxEntries?: number; // default MAX_ENTRIES
  maxBytes?: number; // default MAX_BYTES
}

export interface DiagBuffer {
  setEnv(env: DiagEnv): void;
  route(to: string, from?: string): void;
  // status<400 with no error code => success (counted only); otherwise the failure is stored.
  api(method: string, path: string, status: number, code: string | null, ms: number): void;
  ws(event: string, code?: number, retry?: number): void;
  err(message: string, stack?: string): void;
  perf(mark: string, ms?: number, n?: number): void;
  ui(action: string): void;
  snapshot(): DiagSnapshot;
  size(): { entries: number; bytes: number; ok: number };
  clear(): void;
}

export const MAX_ENTRIES = 200;
export const MAX_BYTES = 64 * 1024;
// The server rejects a ticket whose ANY diagnostics entry stringifies to > 2048 bytes; clamp locally so a
// pathological breadcrumb degrades to a marker instead of failing the whole ticket with VALIDATION.
export const ENTRY_DATA_MAX_BYTES = 2048;

const WS_EVENTS = new Set(["idle", "connecting", "open", "reconnecting", "closed", "error"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// UTF-8 byte length without allocating (browser + Node): the ring is capped by bytes, not chars.
function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } // surrogate pair -> one 4-byte code point
    else n += 3;
  }
  return n;
}

function jsonLen(v: unknown): number {
  try { return utf8Len(JSON.stringify(v) ?? ""); } catch { return 0; }
}

function httpMethod(m: string): string {
  const up = String(m || "").toUpperCase();
  return HTTP_METHODS.has(up) ? up : "GET";
}

function intOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt;
}

// R4-consistent frames array: reuse redactStack (redacted header + <=10 `at file:line:col` frames), then
// keep the frames only. The server computes error_hash = sha256(msg + "\n" + stack[0]) from the first
// `err` entry, so `stack` MUST be an array of frame strings.
function framesFromStack(raw: string): string[] {
  if (!raw) return [];
  const frames: string[] = [];
  for (const line of redactStack(raw).split("\n")) {
    if (line.startsWith("at ")) frames.push(line);
    if (frames.length >= STACK_MAX_FRAMES) break;
  }
  return frames;
}

function redactEnv(env: DiagEnv): DiagEnv {
  return {
    app_version: redactText(env.app_version ?? "", 64),
    platform: redactText(env.platform ?? "", 32),
    ua: redactText(env.ua ?? "", FIELD_MAX),
    locale: redactText(env.locale ?? "", 35),
    // install_id is a pseudonymous, deliberately-carried id (T-418): sanitise-and-cap but do NOT PII-mask —
    // maskPii would blob a long hex run, and the id must survive intact to be useful.
    install_id: String(env.install_id ?? "").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64),
    online: !!env.online,
    clock_offset: typeof env.clock_offset === "number" && Number.isFinite(env.clock_offset)
      ? Math.trunc(env.clock_offset) : 0,
  };
}

export function createDiagBuffer(opts: DiagBufferOptions = {}): DiagBuffer {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;

  let env: DiagEnv | null = null;
  const nodes: { entry: DiagEntry; bytes: number }[] = [];
  let totalBytes = 0;
  let ok = 0; // successful api calls: counter only (privacy + signal-to-noise)

  function evict(): void {
    while (nodes.length > 0 && (nodes.length > maxEntries || totalBytes > maxBytes)) {
      const dropped = nodes.shift();
      if (dropped) totalBytes -= dropped.bytes;
      if (totalBytes < 0) totalBytes = 0;
    }
  }

  function push(kind: DiagKind, data: Record<string, unknown>): void {
    const finalData = jsonLen(data) > ENTRY_DATA_MAX_BYTES ? { truncated: true } : data;
    const entry: DiagEntry = { t: Math.trunc(now()), kind, data: finalData };
    const bytes = jsonLen(entry);
    nodes.push({ entry, bytes });
    totalBytes += bytes;
    evict();
  }

  return {
    setEnv(e: DiagEnv): void { env = redactEnv(e); },

    route(to: string, from?: string): void {
      const data: Record<string, unknown> = { to: redactBreadcrumb(to) };
      if (from) data.from = redactBreadcrumb(from);
      push("route", data);
    },

    api(method: string, path: string, status: number, code: string | null, ms: number): void {
      const s = intOr(status, 0);
      const failed = !!code || s === 0 || s >= 400;
      if (!failed) { ok++; return; }
      const data: Record<string, unknown> = { m: httpMethod(method), p: redactRoute(path), s };
      if (code) data.code = redactText(String(code), FIELD_MAX);
      if (typeof ms === "number" && Number.isFinite(ms)) data.ms = Math.max(0, Math.round(ms));
      push("api", data);
    },

    ws(event: string, code?: number, retry?: number): void {
      const data: Record<string, unknown> = { ev: WS_EVENTS.has(event) ? event : "state" };
      if (typeof code === "number" && Number.isFinite(code)) data.code = Math.trunc(code);
      if (typeof retry === "number" && Number.isFinite(retry)) data.retry = Math.trunc(retry);
      push("ws", data);
    },

    err(message: string, stack?: string): void {
      push("err", { msg: redactText(message ?? "", MSG_MAX), stack: framesFromStack(stack ?? "") });
    },

    perf(mark: string, ms?: number, n?: number): void {
      const data: Record<string, unknown> = { mark: redactText(mark, FIELD_MAX) };
      if (typeof ms === "number" && Number.isFinite(ms)) data.ms = Math.max(0, Math.round(ms));
      if (typeof n === "number" && Number.isFinite(n)) data.n = Math.trunc(n);
      push("perf", data);
    },

    ui(action: string): void { push("ui", { act: redactText(action, FIELD_MAX) }); },

    snapshot(): DiagSnapshot {
      return { env, entries: nodes.map((x) => ({ t: x.entry.t, kind: x.entry.kind, data: x.entry.data })) };
    },

    size(): { entries: number; bytes: number; ok: number } {
      return { entries: nodes.length, bytes: totalBytes, ok };
    },

    clear(): void { nodes.length = 0; totalBytes = 0; ok = 0; },
  };
}
