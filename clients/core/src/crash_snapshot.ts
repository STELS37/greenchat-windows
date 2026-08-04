// clients/core/src/crash_snapshot.ts — T-514 (MS-4, SUPPORT.md §2.3 R7 / §14): the ONE thing the RAM-only
// diagnostics ring is allowed to persist — a crash snapshot, so a report survives the reload that a hard
// crash forces.
//
// The flow (wired by the web shell, main.ts): on an uncaught error / unhandledrejection we push the error
// into the ring (diagBuffer.err → redacted at write time) and then persist diagBuffer.snapshot() here. On
// the NEXT launch the shell offers "the app closed unexpectedly — send a report?", which prefills the
// support form with this exact (already-redacted) snapshot. Refusing or sending clears it.
//
// Privacy (R7): the payload is the diagnostics snapshot, which is redacted AT WRITE TIME (diag_redact.ts /
// T-515) — env is PII-free, api paths are id-masked, err frames are bundle file:line:col only, message
// text/drafts/file names are never recorded. The one string we add — the crash `message` — is redacted
// here too (redactText, R1–R3). So nothing sensitive is written to disk by construction.
//
// Bounded: ONE snapshot, last-wins (a fresh crash overwrites an unsent one), capped at CRASH_SNAPSHOT_MAX_BYTES
// by evicting oldest ring entries first (mirrors the buffer's own eviction) — env + message always survive.
// The localStorage KEY is distinct from the offline ticket queue (gc.support.queue, S-003) and from every
// T-418 diagnostics key, so the three persisted surfaces never collide.
import { redactText, MSG_MAX } from "./diag_redact.ts";
import type { DiagSnapshot } from "./diag_buffer.ts";

// localStorage lives under one key. removeItem is needed (the ticket-queue StorageLike does not expose it),
// so this is its own minimal shape — a real Web Storage satisfies it, and tests fake it with a Map.
export interface CrashStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// The persisted record. `v` guards forward-compat (an unknown version reads back as null → ignored, never
// crashes the offer). `message` is the redacted crash headline; `snapshot` is the redacted diagnostics ring.
export interface CrashSnapshot {
  v: 1;
  at: number; // ms epoch when the crash was captured
  message: string; // redacted (R1–R3) crash message
  snapshot: DiagSnapshot; // already-redacted ring snapshot (env + entries)
}

// Distinct from SUPPORT_QUEUE_KEY ("gc.support.queue", S-003) and every T-418 diagnostics key.
export const CRASH_SNAPSHOT_KEY = "gc.support.crash";
// Match the ring's own ceiling (SUPPORT.md §2.1) so a full ring still fits after wrapping in the record.
export const CRASH_SNAPSHOT_MAX_BYTES = 64 * 1024;

export interface SaveCrashOptions {
  now?: () => number; // ms epoch; default Date.now
  maxBytes?: number; // default CRASH_SNAPSHOT_MAX_BYTES
}

// UTF-8 byte length without allocating a Buffer/TextEncoder (browser + Node). Same technique the ring uses;
// the cap is a byte budget, not a char count.
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

// Persist a crash snapshot (last-wins). Redacts the message, caps the serialized record to maxBytes by
// dropping the OLDEST ring entries first (env + message are never dropped), and never throws — a
// disabled/quota-full Storage just leaves no snapshot, exactly as if the crash had not been captured.
export function saveCrashSnapshot(
  storage: CrashStorageLike,
  message: string,
  snapshot: DiagSnapshot,
  opts: SaveCrashOptions = {},
): void {
  try {
    const at = Math.trunc((opts.now ?? Date.now)());
    const maxBytes = opts.maxBytes ?? CRASH_SNAPSHOT_MAX_BYTES;
    const env = snapshot?.env ?? null;
    let entries = Array.isArray(snapshot?.entries) ? snapshot.entries.slice() : [];
    const build = (es: DiagSnapshot["entries"]): CrashSnapshot => ({
      v: 1, at, message: redactText(message ?? "", MSG_MAX), snapshot: { env, entries: es },
    });
    let rec = build(entries);
    let json = JSON.stringify(rec);
    // Evict oldest-first until the whole record fits the byte budget (or only env + message remain).
    while (entries.length > 0 && utf8Len(json) > maxBytes) {
      entries = entries.slice(1);
      rec = build(entries);
      json = JSON.stringify(rec);
    }
    storage.setItem(CRASH_SNAPSHOT_KEY, json);
  } catch { /* storage blocked / quota — best-effort; no snapshot persists */ }
}

// Read back the snapshot, or null when there is none / it is malformed / it is a version we don't know.
// A wrong shape can never throw here (a corrupt value simply yields null and is treated as "no crash").
export function readCrashSnapshot(storage: CrashStorageLike): CrashSnapshot | null {
  try {
    const raw = storage.getItem(CRASH_SNAPSHOT_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    if (r.v !== 1) return null;
    if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
    if (typeof r.message !== "string") return null;
    const s = r.snapshot;
    if (!s || typeof s !== "object") return null;
    const snap = s as Record<string, unknown>;
    if (!Array.isArray(snap.entries)) return null;
    // `env` may be null (head never seeded) — accept it; entries is an opaque already-redacted array.
    return { v: 1, at: r.at, message: r.message, snapshot: { env: (snap.env ?? null) as DiagSnapshot["env"], entries: snap.entries as DiagSnapshot["entries"] } };
  } catch {
    return null;
  }
}

// Drop the stored snapshot (on send, on dismiss, or after a successful offer). Never throws.
export function clearCrashSnapshot(storage: CrashStorageLike): void {
  try { storage.removeItem(CRASH_SNAPSHOT_KEY); } catch { /* best-effort */ }
}

/**
 * Not every window `error` event is a crash.
 *
 * Measured on the signed APK (redroid Android 15, WebView 128.0.6613.88, 2026-07-31): plain navigation
 * between the tabs raised the window error `ResizeObserver loop completed with undelivered
 * notifications.` twice inside one minute. It is not an exception — the browser dispatches it when a
 * ResizeObserver callback changed layout and the remaining observations were deferred to the next
 * frame; the frame is still painted and nothing is lost. It arrives with `error === null` and an empty
 * stack, which is exactly how the spec describes a browser-generated notice rather than a thrown value.
 *
 * The product treated it as a hard crash: it persisted a crash snapshot, counted the session as
 * crashed in the quality metric, and on the NEXT launch greeted the user with "the app crashed last
 * time — send a report?". So the app accused itself of crashing after a session in which nothing had
 * gone wrong, and its own crash-rate telemetry was inflated by a layout notice.
 *
 * This predicate is the narrow gate for that class: a message the browser generates itself, with no
 * Error object behind it. Anything carrying a real Error stays a crash.
 */
export function isBrowserLayoutNotice(message: unknown, error?: unknown): boolean {
  if (error instanceof Error) return false; // a real throw — always a crash
  if (error != null) return false; // any non-null reason is the app's own value, not a browser notice
  return /resizeobserver loop/i.test(String(message ?? ""));
}
