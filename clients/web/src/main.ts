// clients/web/src/main.ts — the web shell entry (T-405). Wires the transport (ApiClient, same-origin),
// the auth Session (in-memory access token + localStorage refresh), i18n + theme, the hash router and
// the Ctrl+K palette, then hands them to the route-gated app (ui/screens). The server serves this built
// bundle on GET / and the same origin answers /v1/* — so baseUrl is "" (no CORS, no secrets in code).
import "../../ui/src/tokens.css";
import "./styles.css";
// V5 redesign layer — loaded AFTER styles.css so its overrides win without editing 5 000 legacy lines.
import "./redesign.css";
// V95 brand layer — loaded last so it can close the palette (no colour outside the amber→teal arc)
// and give «Ещё» its brand plate without editing the two large legacy stylesheets.
import "./brand.css";

// Owner-facing Bot Center: list, create, commands, webhook and token security surfaces.
import "./bot_center.css";

// Native GreenChat Mini Apps catalogue, developer editor and isolated runtime host.
import "./miniapps.css";
// Contacts acquisition hub: private phonebook sync, invitations and compact empty state.
import "./contacts.css";
// V178: SFU-backed group audio/video calls and screen sharing.
import "./conference.css";
// V193: once a message wraps, the text gets the full composer width and secondary actions move to a
// bottom rail. It loads after the general redesign layers but before the two final invariant sheets.
import "./composer_expanded.css";
// V194 native received-file card and mobile save/open hand-off.
import "./file_attachments.css";
// V187 delivery geometry reserves the locale-aware metadata width from the optimistic bubble's first
// frame. It stays adjacent to V96: the short-viewport correction must remain the final cascade layer.
import "./message_delivery.css";
// V96 short-viewport layer — loaded after every other sheet so a 825x115 window (phone in landscape
// with the keyboard open) stops being drawn as a desktop two-pane shell. See shortscreen.css.
import "./shortscreen.css";
import {
  ApiClient,
  type TokenStore,
  SyncEngine,
  Outbox,
  CacheSync,
  LocalCachePolicy,
  MemoryStore,
  IndexedDbStore,
  EncryptedStore,
  type ClientStore,
  FileUploader,
  MediaCache,
  // GC_MESSENGER_DIRECT_APK_ONLY_START
  registerPush,
  type PushBridge,
  type PushRegistration,
  type PushToken,
  // GC_MESSENGER_DIRECT_APK_ONLY_END
  parseTelegramExport,
  runTelegramImport,
  ZipArchive,
  guessMimeFromName,
  type TgParsed,
  type TgImportProgress,
  type TgImportResult,
  createDiagnostics,
  createSessionQuality,
  type SessionQualityStorage,
  createDiagBuffer,
  saveCrashSnapshot, readCrashSnapshot, clearCrashSnapshot, isBrowserLayoutNotice,
  type CrashStorageLike, type CrashSnapshot,
  createEndpointManager, createEndpointFetch, createEndpointWebSocket, normalizeBase,
  createConnectionManager,
  createTelegramAccountsController,
  ServerClock,
  // GC_MESSENGER_DIRECT_APK_ONLY_START
  fetchUpdateStatus,
  // GC_MESSENGER_DIRECT_APK_ONLY_END
  type EndpointManager,
  type ConnectionManager,
  type ConnConfig,
  type NativeConnectorSecretVault,
  type TelegramAccountsController,
  type TelegramAccountsSnapshot,
  type TelegramTdlibBridge,
  type AppLockMigrationKeys,

  type DuressAction,
} from "../../core/src/index.ts";
import {
  createI18n,
  ThemeController,
  browserThemeEnv,
  watchSystemTextZoom, browserTextZoomEnv,
  HashRouter,
  browserHashEnv,
  WEB_ROUTES,
  Shortcuts,
  CommandPalette,
  PwaController,
  browserPwaEnv,
  parseShareParams,
  shareToText,
  // GC_MESSENGER_DIRECT_APK_ONLY_START
  presentUpdateStatus,
  // GC_MESSENGER_DIRECT_APK_ONLY_END
} from "../../ui/src/index.ts";
import type { Command, Dict, Locale } from "../../ui/src/index.ts";
import type { LangPref } from "../../ui/src/lang.ts";
import {
  createApp, Session, createAccountMediaSettings, createBadgeRefreshController,
  networkType, platformDataSaver, cacheLimitBytes, normalizeSpeed,
  setPendingShare,
  createSupportController, createSupportQueue, createReportOverlay, parseHealth,
  CallController, createCallOverlay, ConferenceController,
} from "../../ui/src/screens/index.ts";
import type {
  OutboxPort, EventFeed, OutboxChangeView, MediaPort, MediaEnv, Badge,
  ImportSource, ImportPorts, ServerPort, RegistrationMode, RegistrationModePort,
  StorageLike, SupportPrefill, ReportTarget, HealthInfo, SupportStatusPort,
  IceServer, ConferenceJoinGrant,
} from "../../ui/src/screens/index.ts";
import type { ConferenceScreenShareGrant } from "../../ui/src/screens/conference_model.ts";
import { createBrowserCallMedia } from "./call_media.ts";
import { createBrowserCallTones } from "./call_tones.ts";
import type { ConferenceOverlay } from "./conference_overlay.ts";
import { webSessionStorage } from "./session_storage.ts";
import { webLocalData } from "./local_data.ts";
import { webDiagStore } from "./diag_store.ts";


import {
  createDiagnosticsConsentCoordinator,
  type DiagnosticsConsentSignal,
} from "./diagnostics_consent_sync.ts";
import { webNotifyModePort } from "./notify_mode.ts";
import { webScreenPrivacyPort } from "./screen_privacy.ts";

import { createWebCachePolicyPort } from "./cache_policy.ts";
import { createWebAppLock, recoverPendingLocalReset } from "./app_lock.ts";
import { nativeShellPlatform } from "./native_shell.ts";
// GC_MESSENGER_DIRECT_APK_ONLY_START
import {
  browserNativeUpdateLifecycleEnv,
  startNativeUpdateLifecycle,
} from "./native_update_lifecycle.ts";
// GC_MESSENGER_DIRECT_APK_ONLY_END
import { finishDuressTeardown } from "./duress_teardown.ts";
import { browserOutboxExclusive } from "./outbox_lock.ts";
import { browserRefreshBarrier, browserRefreshCoordinator } from "./refresh_lock.ts";
import { webPowRunner } from "./pow_runner.ts"; // T-121: registration PoW solved in a Web Worker

import { createRealityTransportController } from "./reality_transport_controller.ts";
import type { RealityTransportBridge } from "../../mobile/bridge/reality_transport.ts";

const CLIENT_ID = "web/1.0.0-beta.6";
const APP_VERSION = "1.0.0-beta.6";

declare const __GC_BUILD_ID__: string;
declare const __GC_CONFIG_SIGNATURE_PIN__: string;
const BUILD_ID = typeof __GC_BUILD_ID__ === "string" && /^[A-Za-z0-9._-]{7,48}$/.test(__GC_BUILD_ID__)
  ? __GC_BUILD_ID__
  : "dev-local";
// Build-time Ed25519 trust root for the signed network-policy core of /v1/config. The server-advertised
// public_key is never trusted; empty means an explicitly unpinned development/self-host build.
const CONFIG_SIGNATURE_PIN =
  typeof __GC_CONFIG_SIGNATURE_PIN__ === "string" ? __GC_CONFIG_SIGNATURE_PIN__ : "";
// Client-quality cohorts must identify the exact serviced artifact, not only a marketing version that may
// span several deployments. The full source build id remains under the server's 64-char version cap.
const QUALITY_APP_VERSION = `${APP_VERSION}+${BUILD_ID}`;


// Keep locale catalogues out of the startup closure. The selected language is awaited before the UI
// starts, while the alternate language is fetched after the first render and is always awaited before
// a manual/system switch. This preserves a complete dictionary with no raw-key or wrong-language flash,
// but avoids shipping both ~60–90 KB source catalogues in the initial JavaScript bundle.
const localeLoads = new Map<Locale, Promise<Dict>>();
function loadUiLocale(locale: Locale): Promise<Dict> {
  const existing = localeLoads.get(locale);
  if (existing) return existing;
  const request = (locale === "ru"
    ? import("../../ui/src/locales/ru.ts").then((module) => module.ru)
    : import("../../ui/src/locales/en.ts").then((module) => module.en))
    .catch((error) => {
      localeLoads.delete(locale);
      throw error;
    });
  localeLoads.set(locale, request);
  return request;
}

// T-419 — network resilience / «свой сервер». The web build talks to its own origin by default
// (`gc.server` unset → primary ""). A user can point the client at a self-hosted / alternate server on the
// «Адрес сервера» screen; the choice persists here and drives the core EndpointManager. NOTE: there is NO
// proxy setting on web — a browser PWA uses the browser/OS proxy (the honest per-spec posture); proxy
// configuration lives only in the native shells (desktop Tauri / Android).
const SERVER_KEY = "gc.server";
const FAILOVER_KEY = "gc.server.failover";

const DIAGNOSTICS_CONSENT_SIGNAL_KEY = "gc.diagnostics-consent.v1";
// Backup addresses compiled into THIS build. Empty for the reference web build (same-origin); a fork /
// self-hoster can bake in mirrors, and the server can advertise more via /v1/config endpoints[] (T-125).
const FALLBACK_ENDPOINTS: readonly string[] = [];

function loadServerPref(): string {
  try { return localStorage.getItem(SERVER_KEY) ?? ""; } catch { return ""; }
}
function saveServerPref(value: string): void {
  try {
    if (value) localStorage.setItem(SERVER_KEY, value);
    else localStorage.removeItem(SERVER_KEY);
  } catch { /* storage blocked — the choice is session-only this run */ }
}
function loadFailoverPref(): boolean {
  try { return localStorage.getItem(FAILOVER_KEY) !== "0"; } catch { return true; } // default ON
}
function saveFailoverPref(on: boolean): void {
  try { localStorage.setItem(FAILOVER_KEY, on ? "1" : "0"); } catch { /* storage blocked */ }

}

interface DuressEnvelopeResult<T> {
  ok: boolean;
  result?: T;
}

async function duressRequest<T>(
  fetchImpl: typeof fetch,
  access: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${access}`,
    "x-gc-client": CLIENT_ID,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchImpl(path, {
    method,
    headers,
    // Duress network actions are deliberately tiny and must survive the immediate local wipe/remount.
    // keepalive prevents a page navigation from cancelling revoke_all on a slow or busy connection.
    keepalive: true,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const envelope = await response.json() as DuressEnvelopeResult<T>;
  if (!response.ok || envelope.ok !== true) {
    throw new Error("duress network action failed");
  }
  // Some successful mutation endpoints return only {ok:true}; callers that require a result validate it by use.
  return envelope.result as T;
}
async function performDuressNetwork(
  fetchImpl: typeof fetch,
  access: string,
  action: DuressAction,
  locale: Locale,
): Promise<void> {
  if (action.trustedUsername) {
    const signalAbort = new AbortController();
    const signalTimer = setTimeout(() => signalAbort.abort(), 2_500);
    try {
      const peer = await duressRequest<{ id: number }>(
        fetchImpl,
        access,
        "GET",
        `/v1/users/resolve?username=${encodeURIComponent(action.trustedUsername)}`,
        undefined,
        signalAbort.signal,
      );
      const dialog = await duressRequest<{ id: number }>(
        fetchImpl,
        access,
        "POST",
        "/v1/chats/dialog",
        { user_id: peer.id },
        signalAbort.signal,
      );
      const text = locale === "ru"
        ? "Пожалуйста, свяжитесь со мной, когда сможете."
        : "Please contact me when you can.";
      await duressRequest<unknown>(
        fetchImpl,
        access,
        "POST",
        `/v1/chats/${dialog.id}/messages`,
        {
          client_msg_id: `duress-${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`,
          kind: "text",
          text,
        },
        signalAbort.signal,
      );
    } catch {
      // Optional trusted-contact signal: best-effort within its own strict deadline.
    } finally {
      clearTimeout(signalTimer);
    }
  }

  const revokeAbort = new AbortController();
  const revokeTimer = setTimeout(() => revokeAbort.abort(), 5_000);
  try {
    await duressRequest<unknown>(
      fetchImpl,
      access,
      "POST",
      "/v1/auth/sessions/revoke_all",
      undefined,
      revokeAbort.signal,
    );
  } catch {
    // Offline: local cryptographic erasure is already complete and authoritative.
  } finally {
    clearTimeout(revokeTimer);
  }
}


// The host carried by a greenchat://connect?host=… deep link. The native bridge (and a web ?host= param)
// resolves it to a #/connect?host=… hash; the router strips the query, so we read it from the RAW hash.
function pendingHostFromHash(): string | null {
  try {
    const h = typeof location !== "undefined" ? location.hash || "" : "";
    const qi = h.indexOf("?");
    if (qi < 0) return null;
    const host = new URLSearchParams(h.slice(qi + 1)).get("host");
    return host && host.trim() ? host.trim() : null;
  } catch { return null; }
}

// T-418 — a native shell (Tauri desktop / Capacitor WebView) may expose window.__GC_NATIVE to report its
// platform and hand over crashes captured before the web layer booted (e.g. a Rust panic). Absent on web.
interface NativeDiag {
  platform?: string;
  takeCrashes?: () => Promise<string[]>;
}

// The diagnostics platform tag: ask the host, else "web". No PII — a coarse family only.
// Reading __GC_NATIVE alone was wrong: the Capacitor WebView never sets it (measured on the signed
// APK, versionCode 1000013), so every Android install used to report itself as a browser tab in
// diagnostics, support reports and update checks. native_shell.ts consults Capacitor as well.
function nativePlatform(): "web" | "android" | "ios" | "desktop" {
  return nativeShellPlatform(window);
}

// A COARSE OS family (no version, no PII) for the crash's os_version field, derived from the UA string.
function coarseOs(): string {
  let ua = "";
  try { ua = navigator.userAgent || ""; } catch { ua = ""; }
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Web";
}

// T-417 — Telegram import wiring (kept at module scope so boot() stays readable).
//
// Parse result.json in a dedicated Web Worker (a real export is megabytes of JSON; parsing on the UI
// thread would jank). build.mjs bundles web/src/tg_import.worker.ts as its own hashed chunk and injects
// its URL here via esbuild `define` (__GC_WORKER_URL__). Under tsc/dev, or a build without the split, the
// token resolves to null and we fall back to a main-thread parse so import still works.
declare const __GC_WORKER_URL__: string;

function workerUrl(): string | null {
  // `typeof` on the (possibly build-time-replaced) token never throws for a free identifier.
  return typeof __GC_WORKER_URL__ === "string" && __GC_WORKER_URL__.length > 0 ? __GC_WORKER_URL__ : null;
}

function parseExportInWorker(text: string): Promise<TgParsed> {
  return new Promise<TgParsed>((resolve, reject) => {
    const url = workerUrl();
    if (!url) {
      reject(new Error("worker unavailable"));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(url, { type: "module" });
    } catch (e) {
      reject(e instanceof Error ? e : new Error("worker unavailable"));
      return;
    }
    const finish = (fn: () => void): void => {
      try { worker.terminate(); } catch { /* already gone */ }
      fn();
    };
    worker.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { ok?: boolean; parsed?: TgParsed; error?: string };
      if (d && d.ok && d.parsed) finish(() => resolve(d.parsed as TgParsed));
      else finish(() => reject(new Error(d?.error ?? "parse failed")));
    };
    worker.onerror = (ev: ErrorEvent): void => finish(() => reject(new Error(ev.message || "worker error")));
    worker.postMessage({ text });
  });
}

async function parseExport(text: string): Promise<TgParsed> {
  try {
    return await parseExportInWorker(text);
  } catch {
    // Worker unavailable → parse inline on the main thread.
    return parseTelegramExport(JSON.parse(text));
  }
}

// Build an import source from a chosen directory: key every file by its export-relative path, both with
// and without the top export folder, so "photos/x.jpg" resolves whether or not the pick had a root dir.
function makeFolderSource(files: FileList): ImportSource {
  const byPath = new Map<string, File>();
  for (const f of Array.from(files)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    byPath.set(rel, f);
    const slash = rel.indexOf("/");
    if (slash >= 0) byPath.set(rel.slice(slash + 1), f);
  }
  const findSuffix = (suffix: string): File | null => {
    for (const [p, f] of byPath) if (p === suffix || p.endsWith("/" + suffix)) return f;
    return null;
  };
  return {
    async readManifest() {
      const f = byPath.get("result.json") ?? findSuffix("result.json");
      if (!f) throw new Error("result.json not found in the selected folder");
      return await f.text();
    },
    async readMedia(path) {
      const f = byPath.get(path) ?? findSuffix(path);
      if (!f) return null;
      const bytes = new Uint8Array(await f.arrayBuffer());
      return { bytes, name: f.name, mime: f.type || guessMimeFromName(f.name) };
    },
  };
}

// Build an import source from a .zip: the core ZipArchive locates result.json (possibly nested under an
// export folder) and inflates media on demand. Media mime is guessed from the name (zip stores none).
function makeZipSource(bytes: Uint8Array): ImportSource {
  const arc = ZipArchive.open(bytes);
  const manifest = arc.find((n) => n === "result.json" || n.endsWith("/result.json"));
  const base = manifest && manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/") + 1) : "";
  const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
  return {
    async readManifest() {
      if (!manifest) throw new Error("result.json not found in the zip archive");
      const b = await arc.read(manifest);
      if (!b) throw new Error("result.json could not be read");
      return decode(b);
    },
    async readMedia(path) {
      const b = (await arc.read(base + path)) ?? (await arc.read(path));
      if (!b) return null;
      const name = path.slice(path.lastIndexOf("/") + 1);
      return { bytes: b, name, mime: guessMimeFromName(name) };
    },
  };
}

// A fresh, server-legal import_id (/^[A-Za-z0-9_-]{1,128}$/ — a UUID's hex+hyphens qualify).
function newImportId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// T-512 (S-003) — a StorageLike for the support offline queue. localStorage when present (a queued ticket
// survives a reload / cold boot), else an in-memory fallback (private mode / embed). The queue itself
// wraps every access in try/catch, so a disabled or quota-full Storage degrades to best-effort silently.
function supportQueueStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch { /* access denied (privacy mode) */ }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k, v) => { mem.set(k, v); },
  };
}

// T-514 (MS-4, §2.3 R7) — a CrashStorageLike for the one snapshot the ring is allowed to persist. Same
// posture as the ticket queue (localStorage when present, in-memory fallback), but this shape also needs
// removeItem (send/dismiss clears the snapshot). The crash module wraps every access in try/catch, so a
// disabled/quota-full Storage silently means "no crash captured / nothing to offer".
function crashSnapshotStorage(): CrashStorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch { /* access denied (privacy mode) */ }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: (k) => { mem.delete(k); },
  };
}

// Crash-free denominator uses synchronous local state so pagehide/fatal handlers can commit one bounded
// counter without relying on an async transaction. Blocked localStorage degrades to per-tab memory; because
// diagnostics consent cannot persist in that posture, the controller remains default-deny on the next boot.
function sessionQualityStorage(): SessionQualityStorage {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch { /* access denied (privacy mode) */ }
  const mem = new Map<string, string>();
  return {
    get length() { return mem.size; },
    key: (index) => [...mem.keys()][index] ?? null,
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => { mem.set(key, value); },
    removeItem: (key) => { mem.delete(key); },
  };
}

// Cross-tab privacy signal for the single diagnostics opt-in. localStorage is used only as an event bus;
// the canonical verdict remains in the IndexedDB diagnostics store. A nonce forces an event even when the
// same boolean is selected twice. The payload contains no account, install or device identifier.
function diagnosticsConsentSignal(): DiagnosticsConsentSignal {
  const listeners = new Set<(on: boolean) => void>();
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== DIAGNOSTICS_CONSENT_SIGNAL_KEY || event.newValue === null) return;
    try {
      const payload = JSON.parse(event.newValue) as { on?: unknown };
      if (typeof payload.on !== "boolean") return;
      for (const listener of listeners) listener(payload.on);
    } catch { /* malformed or foreign value — ignore */ }
  };
  try { addEventListener("storage", onStorage); } catch { /* non-window shell */ }
  return {
    publish(on: boolean): void {
      try {
        localStorage.setItem(DIAGNOSTICS_CONSENT_SIGNAL_KEY, JSON.stringify({
          on,
          nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        }));
      } catch { /* blocked storage: this tab still applies the verdict locally */ }
    },
    subscribe(listener: (on: boolean) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// A fresh client_ref for a support ticket (server idempotency S-001; regex /^[A-Za-z0-9._:-]{1,64}$/ — a
// UUID qualifies). The SAME ref is reused for a queued retry so a replay never double-creates a ticket.
function newSupportRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `gc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// T-512 — a minimal, dependency-free toast (auto-dismiss). Confirms «Обращение GC-NNNNNN создано» / an
// offline-queued ticket. textContent only (no HTML injection); best-effort (a missing DOM is not fatal).
function showToast(msg: string): void {
  try {
    const host = document.body;
    if (!host) return;
    const node = document.createElement("div");
    node.className = "gc-toast";
    node.setAttribute("role", "status");
    node.textContent = msg;
    host.appendChild(node);
    setTimeout(() => { try { node.classList.add("is-leaving"); } catch { /* */ } }, 3600);
    setTimeout(() => { try { node.remove(); } catch { /* */ } }, 4000);
  } catch { /* no DOM — a toast is best-effort UX, never critical */ }
}

// T-514 (MS-4, §14) — a persistent, dismissible banner offering to send last session's crash report.
// textContent only (no HTML injection); two explicit choices (Send / Dismiss), both of which clear the
// stored snapshot via the callbacks. Best-effort chrome — a missing DOM is never fatal.
function showCrashOffer(labels: { text: string; send: string; dismiss: string }, onSend: () => void, onDismiss: () => void): void {
  try {
    const host = document.body;
    if (!host) return;
    const bar = document.createElement("div");
    bar.className = "gc-crash-offer";
    bar.setAttribute("role", "status");
    const msg = document.createElement("span");
    msg.className = "gc-crash-offer-text";
    msg.textContent = labels.text;
    const actions = document.createElement("div");
    actions.className = "gc-crash-offer-actions";
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "gc-btn gc-btn-accent";
    sendBtn.textContent = labels.send;
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "gc-btn";
    dismissBtn.textContent = labels.dismiss;
    // V107 — the offer is fixed chrome, so it reserved NO space and painted over the newest messages
    // (measured on the signed APK: the last bubble in #/chat/17 was 75 % covered and its taps were
    // swallowed). It now publishes the strip it occupies — from the top of the card to the bottom of
    // the viewport, plus an 8 px gap — and the mobile stage subtracts it (styles.css/redesign.css), so
    // the feed simply gets shorter. Shrinking the list box is what the V98 ResizeObserver already
    // watches, so a reader pinned to the bottom stays pinned; no new scroll logic.
    const root = document.documentElement;
    const publish = (): void => {
      try {
        const r = bar.getBoundingClientRect();
        if (!r.height) return;
        const vh = window.innerHeight || r.bottom;
        root.style.setProperty("--gc-offer-h", `${Math.max(0, Math.round(vh - r.top + 8))}px`);
      } catch { /* */ }
    };
    // The card re-wraps on rotation and when the system font size changes, so a height published once
    // would leave a gap (or come back short). Follow the card's own box instead.
    let ro: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => publish());
        ro.observe(bar);
      }
    } catch { ro = null; }
    const release = (): void => {
      try { ro?.disconnect(); } catch { /* */ }
      try { window.removeEventListener("resize", publish); } catch { /* */ }
      try { root.style.removeProperty("--gc-offer-h"); } catch { /* */ }
    };
    const done = (fn: () => void): void => {
      try { bar.remove(); } catch { /* */ }
      release();
      try { fn(); } catch { /* */ }
    };
    sendBtn.addEventListener("click", () => done(onSend));
    dismissBtn.addEventListener("click", () => done(onDismiss));
    actions.append(dismissBtn, sendBtn);
    bar.append(msg, actions);
    host.appendChild(bar);
    try { window.addEventListener("resize", publish); } catch { /* */ }
    publish();
  } catch { /* no DOM — the offer is best-effort UX, never critical */ }
}

async function boot(): Promise<void> {
  const host = document.getElementById("app");
  if (!host) return;
  host.removeAttribute("aria-busy");

  // Theme & density: resolve "system" and paint the root attributes before first render.
  const theme = new ThemeController(browserThemeEnv());
  theme.apply();

  // The platform applies its own font multiplier on top of our tokens (measured x2 on the emulator at
  // Android `font_scale` 2.0). Publish the measured factor so the few controls that live in a fixed-size
  // box — the bottom navigation labels — can cap their rendered size instead of overflowing their cell.
  // Body copy never reads the variable, so accessibility text growth is untouched.
  const textZoomEnv = browserTextZoomEnv();
  if (textZoomEnv) watchSystemTextZoom(textZoomEnv);

  // Interface language is a device-local preference and remains changeable while offline.
  let langPref: LangPref = "system";
  try {
    const stored = localStorage.getItem("gc.lang");
    if (stored === "ru" || stored === "en") langPref = stored;
  } catch { /* storage may be unavailable in private mode */ }
  const resolvedLanguage = (): Locale => {
    if (langPref !== "system") return langPref;
    const tag = navigator.languages.find((value) => /^(ru|en)(-|$)/i.test(value));
    return (tag?.slice(0, 2).toLowerCase() as Locale | undefined) ?? "en";
  };
  const initialLocale = resolvedLanguage();
  const dicts: Record<Locale, Dict> = { ru: {}, en: {} };
  dicts[initialLocale] = await loadUiLocale(initialLocale);
  const loadedLocales = new Set<Locale>([initialLocale]);
  const ensureLocale = async (locale: Locale): Promise<void> => {
    if (loadedLocales.has(locale)) return;
    dicts[locale] = await loadUiLocale(locale);
    loadedLocales.add(locale);
  };
  const i18n = createI18n({ locale: initialLocale, dicts });
  const setLangPref = async (pref: LangPref): Promise<void> => {
    langPref = pref;
    try { localStorage.setItem("gc.lang", langPref); } catch { /* local preference remains live */ }
    const next = resolvedLanguage();
    await ensureLocale(next);
    // A second preference/system-language change may have landed while the chunk was loading.
    if (resolvedLanguage() === next) i18n.setLocale(next);
  };
  window.addEventListener("languagechange", () => {
    if (langPref !== "system") return;
    const next = resolvedLanguage();
    void ensureLocale(next).then(() => {
      if (langPref === "system" && resolvedLanguage() === next) i18n.setLocale(next);
    }).catch(() => undefined);
  });
  // Keep the document language authoritative too. Besides assistive technology and spell-checking,
  // V187 uses :lang() to reserve the exact 24-hour or 12-hour metadata width in a pending message.
  const applyDocumentLocale = (locale: Locale): void => { document.documentElement.lang = locale; };
  applyDocumentLocale(i18n.locale);
  i18n.subscribe(applyDocumentLocale);


  // T-604: quiet, content-free route status. Hidden on direct L0, visible only while traffic uses
  // a configured backup. It never reveals the endpoint, region or transport implementation.
  const routeIndicator = document.createElement("div");
  routeIndicator.className = "gc-route-indicator";
  routeIndicator.setAttribute("role", "status");
  routeIndicator.setAttribute("aria-live", "polite");
  routeIndicator.hidden = true;
  const renderRouteIndicator = (): void => {
    routeIndicator.textContent = i18n.t("server.backupActive");
  };
  renderRouteIndicator();
  i18n.subscribe(renderRouteIndicator);
  document.body.appendChild(routeIndicator);

  // Transport: same-origin. The token holder is a live reference the ApiClient mutates on refresh; the
  // Session owns its lifecycle (persist refresh, restore on boot). onAuthLost drops us back to auth.
  const tokens: TokenStore = { access: null, refresh: null, accessExpiresAt: null };
  const storage = webSessionStorage();
  let onAuthLost = (): void => {};

  // T-419: the runtime-switchable endpoint. Every transport keeps baseUrl:"" (relative paths); the injected
  // efetch/ews wrappers resolve those against the manager's current address, fail over to a backup after 3
  // consecutive network errors (sticky, user-disableable), and BLOCK any request to an origin that is not a
  // configured server address (anti-exfiltration). Same-origin default ("") → both wrappers are inert.
  let configuredServer = loadServerPref();
  // T-604 is created after the encrypted store exists; EndpointManager can still report early/manual
  // switches through this nullable bridge without owning the higher-level policy itself.
  let connectionManager: ConnectionManager | null = null;
  const endpoints: EndpointManager = createEndpointManager({
    primary: configuredServer,
    fallbacks: FALLBACK_ENDPOINTS,
    autoFailover: loadFailoverPref(),
    onSwitch: (current, reason) => connectionManager?.onEndpointSwitch(current, reason),
  });
  const efetch = createEndpointFetch(endpoints);
  const ews = createEndpointWebSocket(endpoints);

  // T-512 (MS-2) — the diagnostics ring buffer (SUPPORT.md §2): a DOM-free, RAM-only, PII-safe trail of
  // route changes, FAILED api calls, WebSocket lifecycle, uncaught errors and system-button clicks that a
  // user CAN attach to a support ticket — and only then. It is NOT consent-gated (it never leaves the
  // device on its own) and everything is redacted at write time (T-515). Created BEFORE the ApiClient so
  // `onRequest` can feed every round-trip into it (successful calls are counted, failures are stored).
  const diagBuffer = createDiagBuffer({});
  // T-514 (MS-4, §2.3 R7) — the one on-disk surface for the ring: a crash snapshot persisted here on an
  // uncaught error and offered for sending on the next launch (maybeOfferCrashReport below).
  const crashStore = crashSnapshotStorage();
  // A coarse UI breadcrumb: the tag + first class of a clicked control (never text, value or ids). Capture
  // phase so it sees the click even when a handler stops propagation. Best-effort — never break a click.
  try {
    document.addEventListener("click", (e) => {
      try {
        const t = e.target as Element | null;
        const el = t && typeof t.closest === "function" ? t.closest("button,a,[role=button]") : null;
        if (!el) return;
        const tag = el.tagName ? el.tagName.toLowerCase() : "?";
        const cls = typeof el.className === "string" && el.className ? el.className.split(/\s+/)[0] : "";
        diagBuffer.ui(cls ? `${tag}.${cls}` : tag);
      } catch { /* never break a click */ }
    }, { capture: true });
  } catch { /* no document (non-browser host) */ }

  const api = new ApiClient({
    baseUrl: "",
    clientId: CLIENT_ID,
    tokens,
    onAuthLost: () => onAuthLost(),
    refreshCoordinator: browserRefreshCoordinator(tokens, storage),
    fetchImpl: efetch,
    // Feed each HTTP round-trip into the ring buffer (redaction of path/ids happens inside the buffer).
    onRequest: (o) => { try { diagBuffer.api(o.method, o.path, o.status, o.code, o.ms); } catch { /* diag must never break a request */ } },
  });

  // T-125: corrected wall clock + the registration policy are populated from public /v1/config
  // before the auth screen paints, then refreshed hourly. Until the first successful request the
  // safe compatibility defaults are local time and open registration.
  const serverClock = new ServerClock();
  let registrationMode: RegistrationMode = "open";
  const registrationListeners = new Set<() => void>();
  const registration: RegistrationModePort = {
    get: () => registrationMode,
    subscribe: (listener) => { registrationListeners.add(listener); return () => { registrationListeners.delete(listener); }; },
  };

  // T-418 — client-quality telemetry (crash-free + push-latency KPIs), STRICTLY opt-in and pseudonymous. The
  // DOM-free controller is backed by the IndexedDB DiagStore (shared with the service worker, which samples
  // push latency) and fed PII-free build metadata. T-125's ServerClock corrects device clock skew.
  const diagStore = webDiagStore();
  const diag = createDiagnostics({
    api,
    store: diagStore,
    meta: { platform: nativePlatform(), appVersion: QUALITY_APP_VERSION, osVersion: coarseOs() },
    clockOffsetSec: () => serverClock.offsetSec(),
  });
  const sessionQuality = createSessionQuality({
    api,
    storage: sessionQualityStorage(),
    consent: () => diag.getConsent(),
    installId: () => diag.installId(),

    exclusive: browserOutboxExclusive(),
    meta: { platform: nativePlatform(), appVersion: QUALITY_APP_VERSION },
  });
  const diagnosticsConsent = createDiagnosticsConsentCoordinator({
    diagnostics: diag,
    sessions: sessionQuality,
    signal: diagnosticsConsentSignal(),
  });
  // Global crash capture (consent-gated inside reportError): uncaught errors + unhandled promise rejections.
  // Only the error message + stack are ever queued — never message text, chat/contact ids or other content.
  addEventListener("error", (e: ErrorEvent) => {
    // A browser-generated layout notice ("ResizeObserver loop completed with undelivered
    // notifications.") arrives on this very event but is not a crash: nothing was thrown, the frame is
    // still painted. Measured on the signed APK it fired on ordinary tab switches, which made the app
    // persist a crash snapshot, inflate its own crash rate and greet the user on the next launch with
    // "the app crashed last time". Keep it in the diagnostics ring (it is a real timing signal) and
    // stop there.
    if (isBrowserLayoutNotice(e.message, e.error)) {
      try { diagBuffer.perf("resize-observer-loop"); } catch { /* diag best-effort */ }
      return;
    }
    try { diagBuffer.err(e.message, e.error instanceof Error ? e.error.stack : undefined); } catch { /* diag best-effort */ }
    // T-514 — persist the ring (now carrying this err entry) so a report survives the crash+reload. The
    // snapshot is already redacted; saveCrashSnapshot redacts the message too and never throws.
    try { saveCrashSnapshot(crashStore, e.message, diagBuffer.snapshot()); } catch { /* best-effort */ }
    sessionQuality.markCrashed();
    void diag.reportError({ message: e.message, stack: e.error instanceof Error ? e.error.stack : undefined });
  });
  addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    try {
      diagBuffer.err(message, reason instanceof Error ? reason.stack : undefined);
    } catch { /* diag best-effort */ }
    try { saveCrashSnapshot(crashStore, message, diagBuffer.snapshot()); } catch { /* best-effort */ } // T-514
    sessionQuality.markCrashed();
    void diag.reportError(
      reason instanceof Error ? { message: reason.message, stack: reason.stack } : { message: String(reason) },
    );
  });
  // Dev-only trigger so an artificial crash is visible in `scripts/crashes.mjs top` (acceptance #1). Throwing
  // asynchronously routes it through the global "error" handler exactly like a real crash.
  (window as Window & { __gcDiagCrash?: () => void }).__gcDiagCrash = () => {
    setTimeout(() => { throw new Error("gc dev diagnostics crash"); }, 0);
  };
  // Native shells (Tauri panic-hook, WebView) buffer crashes that happened before this layer booted; pull
  // them once and feed them through the same opt-in pipeline.
  void (async () => {
    try {
      const native = (window as Window & { __GC_NATIVE?: NativeDiag }).__GC_NATIVE;
      const pending = native?.takeCrashes ? await native.takeCrashes() : [];
      for (const stack of pending) if (typeof stack === "string" && stack) await diag.reportError({ stack });
    } catch { /* no native bridge, or it failed — ignore */ }
  })();
  void diag.start(); // drain any queued crashes + send a due daily aggregate (all consent-gated)
  void sessionQuality.start(); // begin/recover the opt-in crash-free denominator and flush changed counters
  addEventListener("pagehide", () => { sessionQuality.close(); });
  addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) void sessionQuality.start(); // BFCache restore starts a fresh measurable app session
  });
  // T-512 — seed the ring buffer's environment head (SUPPORT.md §2.1) once the pseudonymous install_id (T-418)
  // resolves. PII-free: app version, coarse platform, TRUNCATED UA, locale, install_id, online flag and the
  // T-125 clock skew. A failure just leaves env=null — breadcrumbs still record, only the head is absent.
  void diag.installId().then((installId) => {
    let ua = ""; try { ua = navigator.userAgent || ""; } catch { /* no navigator */ }
    let online = true; try { online = navigator.onLine; } catch { /* no navigator */ }
    diagBuffer.setEnv({
      app_version: QUALITY_APP_VERSION, platform: nativePlatform(), ua,
      locale: i18n.locale, install_id: installId, online, clock_offset: serverClock.offsetSec(),
    });
  }).catch(() => { /* install_id unavailable — env head stays null */ });

  // Offline substrate: a durable store (IndexedDB in the browser, memory as a fallback). Created BEFORE
  // the Session so it can back both the cache layers below AND the LocalData wipe the Session runs on
  // logout / account switch (T-423 — see webLocalData).
  // T-520/T-523: EncryptedStore reads K_db dynamically from the application-lock controller. Before the
  // user enables the lock it is an explicit compatibility passthrough; COLD/LOCKED/WIPED are fail-closed.
  const lowerStore: ClientStore = supportsIndexedDb() ? new IndexedDbStore({ name: "greenchat" }) : new MemoryStore();
  let migrateForAppLock = async (_keys: AppLockMigrationKeys): Promise<void> => {
    throw new Error("app_lock: migration wiring is not ready");
  };
  let handleDuress = (_action: DuressAction): void => {};
  const reloadAfterRefreshBarrier = (): void => {
    const reload = (): void => {
      try { location.reload(); } catch { /* native shell without Location */ }
    };
    // A forced reload must never interrupt a rotating refresh after the server commits but before the
    // coordinator persists the successor token. Wait behind the same origin-wide exclusive lock.
    void browserRefreshBarrier(reload).catch(reload);
  };
  let handleExternalAppLockSnapshot = reloadAfterRefreshBarrier;
  let stopIntegrityDataPlane = (): void => {};
  let handleStoreIntegrityIncident = (): void => {
    tokens.access = null;
    tokens.refresh = null;
    tokens.accessExpiresAt = null;
    try { storage.clear(); } catch { /* best-effort until full wiring exists */ }
  };
  const appLock = createWebAppLock({
    store: lowerStore,
    platform: nativePlatform(),
    migrateLocalData: (keys) => migrateForAppLock(keys),
    onExternalSnapshotChange: () => handleExternalAppLockSnapshot(),

    onDuress: (action) => handleDuress(action),
  });
  const localResetRecovery = recoverPendingLocalReset(appLock.controller, tokens, storage);

  // Initial WIPED recovery is already owned by localResetRecovery. Later transitions into WIPED
  // (attempt-limit/panic/duress paths) acquire this latch and clear auth exactly once per receipt.
  let wipedCleanupStarted = appLock.port.state === "WIPED";

  let storeIntegrityWipeStarted = false;
  handleStoreIntegrityIncident = (): void => {
    if (storeIntegrityWipeStarted || appLock.port.state === "WIPED") return;
    storeIntegrityWipeStarted = true;
    stopIntegrityDataPlane();
    tokens.access = null;
    tokens.refresh = null;
    tokens.accessExpiresAt = null;
    try { storage.clear(); } catch { /* local receipt remains authoritative */ }
    void appLock.controller.wipe("wipe").catch(() => undefined);
  };
  const encryptedStore = new EncryptedStore({
    store: lowerStore,
    key: () => appLock.controller.currentDbKey,
    allowPassthrough: () => appLock.controller.passthroughAllowed(),
    allowPlaintext: () => appLock.controller.passthroughAllowed(),
    onIntegrityError: () => handleStoreIntegrityIncident(),
  });
  const store: ClientStore = encryptedStore;

  // T-529: one encrypted policy controls every local chat-data writer. Until load() succeeds after
  // unlock it fails closed, so COLD boot can never race a plaintext/disk cache write.
  const localCachePolicy = new LocalCachePolicy({ store, nowSec: () => serverClock.nowSec() });

  // T-604: the session keeps an in-memory last-good route, and persists it only while the encrypted
  // container is UNLOCKED. DISABLED/COLD/LOCKED never write transport metadata in plaintext.
  const connMemory = new Map<string, unknown>();
  connectionManager = createConnectionManager({
    manager: endpoints,
    fetchImpl: efetch,
    configSignaturePin: CONFIG_SIGNATURE_PIN,
    onStatusChange: (status) => {
      routeIndicator.hidden = status.tier !== "backup";
      if (!routeIndicator.hidden) renderRouteIndicator();
    },
    kv: {
      async get(key) {
        const memory = connMemory.get(key);
        if (!appLock.controller.isUnlocked) return memory;
        try {
          const persisted = await store.get("meta", `nr.${key}`);
          if (persisted !== undefined) connMemory.set(key, persisted);
          return persisted ?? memory;
        } catch {
          return memory;
        }
      },
      async put(key, value) {
        connMemory.set(key, value);
        if (appLock.controller.isUnlocked) await store.put("meta", `nr.${key}`, value);
      },
      async delete(key) {
        connMemory.delete(key);
        if (appLock.controller.isUnlocked) await store.delete("meta", `nr.${key}`);
      },
    },
  });

  // T-605: Android injects this capability before importing the shared app. Web/PWA/iOS expose none and
  // remain direct-only. The controller receives endpoint data only after NR-03 signature verification.
  const nativeRealityTransport = (
    window as Window & { __gcRealityTransport?: RealityTransportBridge }
  ).__gcRealityTransport ?? null;
  const realityTransport = createRealityTransportController({ bridge: nativeRealityTransport });

  const prepareRealityConfig = CONFIG_SIGNATURE_PIN === ""
    ? undefined
    : async (verifiedConfig: Readonly<ConnConfig>): Promise<boolean> => {
        const verdict = await realityTransport.applySignedEndpoints(verifiedConfig.endpoints);
        return verdict.status === "active" || verdict.status === "unchanged" || verdict.status === "direct_only";
      };

  // Session is constructed before the account data-plane objects below. The closures are assigned once
  // all invalidators exist, before restore/login can clear an account; until then they are safe no-ops.
  let invalidateAccountOperations = (): void => {};
  let finalizeAccountClear = async (): Promise<void> => {};
  const session = new Session({
    api,
    tokens,
    storage,

    refreshStorageManaged: true,
    localData: webLocalData({ store }),
    powRunner: webPowRunner,
    onBeforeClear: () => invalidateAccountOperations(),
    onAfterClear: () => finalizeAccountClear(),
  });


  // T-453A/T-453B: native Telegram multi-account manager. The protected catalogue and random account
  // slots live only in the OS Connector Vault. Plain web/PWA exposes neither native seam. While the native
  // process is alive every authorized slot may own one bounded TDLib client; activeSlot alone owns auth and
  // user-mutation controls. Lock suspends every runtime and unlock restores them through one single-flight.
  const nativeConnectorWindow = window as Window & {
    __gcTelegramTdlibBridge?: TelegramTdlibBridge;
    __gcTakeConnectorSecretVault?: () => NativeConnectorSecretVault | null;
  };
  const telegramBridge = nativeConnectorWindow.__gcTelegramTdlibBridge;
  const connectorSecretVault = nativeConnectorWindow.__gcTakeConnectorSecretVault?.() ?? undefined;
  try { delete nativeConnectorWindow.__gcTakeConnectorSecretVault; } catch { /* native one-shot closure still denies reuse */ }

  const telegramClientConfig = telegramBridge && connectorSecretVault
    ? {
        applicationVersion: APP_VERSION,
        systemLanguageCode: i18n.locale,
        deviceModel: `GreenChat ${telegramBridge.platform}`,
        systemVersion: telegramBridge.platform,
      }
    : null;
  const initialTelegramSnapshot = (): TelegramAccountsSnapshot => telegramClientConfig
    ? {
        available: false, configured: false, busy: true, login: { status: "starting" },
        activeSlot: null, accounts: [], canAddAccount: false,
        totalUnreadCount: 0, backgroundReadyCount: 0,
      }
    : {
        available: false, configured: false, busy: false,
        login: { status: "revoked", reason: "not_connected" }, reason: "not_configured",
        activeSlot: null, accounts: [], canAddAccount: false,
        totalUnreadCount: 0, backgroundReadyCount: 0,
      };
  let telegramController: TelegramAccountsController | null = null;
  let telegramControllerDetach: (() => void) | null = null;
  let telegramGreenChatIdentity: string | null = null;
  let telegramBindSeq = 0;
  let telegramSnapshot: TelegramAccountsSnapshot = initialTelegramSnapshot();
  // GC_MESSENGER_DIRECT_APK_ONLY_START
  let telegramFcmToken: string | null | undefined;

  // T-453C: relay only the Android FCM token into official TDLib registerDevice. Encrypted Telegram push
  // payloads remain in the native FirebaseMessagingService/Keystore queue and never cross this seam.
  const telegramPushBridge = (window as Window & { __gcPushBridge?: PushBridge }).__gcPushBridge;
  const applyTelegramPushToken = (token: PushToken | null): void => {
    const next = token?.platform === "fcm" ? token.endpoint : null;
    if (telegramFcmToken === next) return;
    telegramFcmToken = next;
    void telegramController?.setPushToken(next).catch(() => {
      diagBuffer.err("telegram.accounts.push_registration_failed");
    });
  };
  if (telegramBridge?.platform === "android" && telegramPushBridge) {
    let tokenEventSeen = false;
    telegramPushBridge.onToken((token) => {
      tokenEventSeen = true;
      applyTelegramPushToken(token);
    });
    void telegramPushBridge.getToken().then((token) => {
      if (!tokenEventSeen) applyTelegramPushToken(token);
    }).catch(() => undefined);
  }
  // GC_MESSENGER_DIRECT_APK_ONLY_END

  const telegramListeners = new Set<(snapshot: TelegramAccountsSnapshot) => void>();
  const publishTelegram = (snapshot: TelegramAccountsSnapshot): void => {
    telegramSnapshot = snapshot;
    for (const listener of [...telegramListeners]) {
      try { listener(snapshot); } catch { /* isolate settings view */ }
    }
  };
  const bindTelegramAccount = async (userId: number): Promise<TelegramAccountsController | null> => {
    if (!telegramBridge || !connectorSecretVault || userId <= 0 || !appLockAllowsData()) return null;
    // A transient failover endpoint never changes this identity; only the configured primary server does.
    const identity = JSON.stringify([configuredServer || location.origin, String(userId)]);
    const currentController = telegramController;
    if (currentController && telegramGreenChatIdentity === identity) {
      // Same-account callers share the manager's own single-flight initialize. Do not advance the host
      // generation here: a second UI action must never invalidate and close the first caller's manager.
      await currentController.initialize().catch(() => undefined);
      currentController.retryPushRecovery();
      return telegramController === currentController && telegramGreenChatIdentity === identity
        ? currentController
        : null;
    }
    const seq = ++telegramBindSeq;
    const previous = telegramController;
    telegramController = null;
    telegramGreenChatIdentity = null;
    telegramControllerDetach?.();
    telegramControllerDetach = null;
    previous?.suspend();
    if (previous) {
      await previous.wipe().catch(() => undefined);
      await previous.close().catch(() => undefined);
    }
    if (seq !== telegramBindSeq || !appLockAllowsData()) return null;
    const controller = createTelegramAccountsController({
      bridge: telegramBridge,
      nativeVault: connectorSecretVault,
      serverId: configuredServer || location.origin,
      greenChatUserId: userId,
      platform: telegramBridge.platform,
      config: telegramClientConfig,
      now: () => new Date(serverClock.nowSec() * 1000),
      onDiagnostic: (event) => diagBuffer.err(`telegram.${event.code}`),
    });
    const detach = controller.subscribe(publishTelegram);
    telegramController = controller;
    telegramGreenChatIdentity = identity;
    telegramControllerDetach = detach;
    await controller.initialize().catch(() => undefined);
    // GC_MESSENGER_DIRECT_APK_ONLY_START
    if (telegramFcmToken !== undefined) {
      await controller.setPushToken(telegramFcmToken).catch(() => undefined);
    }
    // GC_MESSENGER_DIRECT_APK_ONLY_END
    if (seq !== telegramBindSeq || !appLockAllowsData()) {
      // Lock/background invalidation closes the transient renderer/native runtime but MUST NOT erase the
      // account catalogue or TDLib database. Logout/server switch have their own wipeTelegram owner.
      if (telegramController === controller) {
        telegramController = null;
        telegramGreenChatIdentity = null;
        if (telegramControllerDetach === detach) telegramControllerDetach = null;
      }
      detach();
      controller.suspend();
      await controller.close().catch(() => undefined);
      return null;
    }
    return controller;
  };
  const activeTelegram = async (): Promise<TelegramAccountsController> => {
    const user = session.currentUser();
    if (!user) throw new Error("GreenChat session is not authenticated");
    const controller = await bindTelegramAccount(user.id);
    if (!controller) throw new Error("Native Telegram connector is unavailable");
    return controller;
  };
  const suspendTelegram = (): void => {
    telegramBindSeq += 1;
    telegramController?.suspend();
  };
  const recoverTelegramAccounts = (): void => {
    if (!session.isAuthed() || !appLockAllowsData()) return;
    const user = session.currentUser();
    if (user) void bindTelegramAccount(user.id);
  };
  const wipeTelegram = async (): Promise<void> => {
    telegramBindSeq += 1;
    const controller = telegramController;
    telegramController = null;
    telegramGreenChatIdentity = null;
    telegramControllerDetach?.();
    telegramControllerDetach = null;
    if (controller) {
      await controller.wipe().catch(() => undefined);
      await controller.close().catch(() => undefined);
    }
    publishTelegram(initialTelegramSnapshot());
  };
  const telegramPort = telegramBridge && connectorSecretVault ? {
    snapshot: () => telegramSnapshot,
    subscribe(listener: (snapshot: TelegramAccountsSnapshot) => void) {
      telegramListeners.add(listener);
      listener(telegramSnapshot);
      return () => { telegramListeners.delete(listener); };
    },
    async initialize() { const user = session.currentUser(); if (user) await bindTelegramAccount(user.id); },
    async addAccount() { return (await activeTelegram()).addAccount(); },
    async selectAccount(slot: string) { await (await activeTelegram()).selectAccount(slot); },
    async connectQr() { await (await activeTelegram()).connectQr(); },
    async connectPhone(phone: string) { await (await activeTelegram()).connectPhone(phone); },
    async submitCode(code: string) { await (await activeTelegram()).submitCode(code); },
    async submitPassword(password: string) { await (await activeTelegram()).submitPassword(password); },
    async disconnect() { await (await activeTelegram()).disconnect(); },
    async remove() { await (await activeTelegram()).remove(); },
  } : null;

  handleDuress = (action) => {
    const access = tokens.access;
    // wipeLocalData() clears the local token/cache synchronously before its first await. Capture access first,
    // then start local erasure before any network work so physical-device protection never waits on I/O.
    // The pending-reset marker is removed only after the durable/local cleanup has completed.
    const localWipe = Promise.allSettled([wipeTelegram(), session.wipeLocalData()])
      .then(() => appLock.controller.completeLocalReset());
    const network = access
      ? performDuressNetwork(efetch, access, action, i18n.locale)
      : Promise.resolve();
    // The auth gate rerenders immediately from the session event. Only hard same-origin navigation waits
    // for bounded network completion, so unload cannot cancel revoke_all or the optional signal.
    void finishDuressTeardown(localWipe, network, () => location.replace("/"));
  };
  // A fatal refresh (reused/expired/revoked token) clears the session; the app's auth gate reacts.
  // The server has already rejected/revoked this credential. Re-posting /auth/logout from every
  // failing in-flight request creates a 401 storm; perform one local fail-closed wipe instead.
  onAuthLost = () => { void session.wipeLocalData(); };

  // Refresh rotation is persisted inside browserRefreshCoordinator while the origin-wide Web Lock is
  // still held. Never copy the realm-local token again on pagehide: another tab may already have rotated
  // it, and a late unload write would roll durable storage back to the server's prev_refresh_hash,
  // triggering theft/reuse revocation on the next cold boot.


  // The Outbox (optimistic send/edit/delete with the 5 s undo window) and the SyncEngine (long-poll + WS
  // folded into one ordered event stream) build on the durable store created above. CacheSync persists
  // events + the cursor so a warm start replays only the delta. Both the Outbox and the event stream fan
  // out to many feed screens through small emitters that implement the screens-layer ports (OutboxPort /
  // EventFeed) — the UI never imports core.
  const cache = new CacheSync({ store, policy: localCachePolicy, nowSec: () => serverClock.nowSec() });

  const outboxListeners = new Set<(c: OutboxChangeView) => void>();
  const outbox = new Outbox({
    api,
    store,
    persistForChat: (chatId) => localCachePolicy.shouldPersistChat(chatId),
    runExclusive: browserOutboxExclusive(),
    onChange: (change) => { for (const l of [...outboxListeners]) l(change); },
  });
  const outboxPort: OutboxPort = {
    enqueueMessage: (chatId, body) => outbox.enqueueMessage(chatId, body),
    enqueueEdit: (chatId, messageId, text) => outbox.enqueueEdit(chatId, messageId, text),
    enqueueDelete: (chatId, messageId) => outbox.enqueueDelete(chatId, messageId),
    cancel: (id) => outbox.cancel(id),
    retry: (id) => outbox.retry(id),
    subscribe: (handler) => { outboxListeners.add(handler); return () => { outboxListeners.delete(handler); }; },
  };

  const cachePolicyPort = createWebCachePolicyPort(localCachePolicy, outbox);

  const eventListeners = new Set<(e: { type: string; payload: unknown }) => void | Promise<void>>();
  const events: EventFeed = {
    subscribe: (handler) => { eventListeners.add(handler); return () => { eventListeners.delete(handler); }; },
  };
  // ---- call signaling fan-out (V75) -----------------------------------------------------------
  // The socket delivers call.* frames on its own channel (no seq, never replayed). One set of
  // listeners is declared BEFORE the engine so the engine can forward into it and the call
  // controller — built after the API/session exist — can subscribe to it.
  const callFrameListeners = new Set<(frame: Record<string, unknown>) => void>();

  const sync = new SyncEngine({
    api,
    baseUrl: "",
    wsImpl: ews,
    onCallFrame: (frame) => {
      for (const listener of [...callFrameListeners]) {
        try { listener(frame); } catch { /* a call listener can never break transport */ }
      }
    },
    onEvent: (e) => {
      void cache.apply(e).catch(() => { /* K_db may disappear during a lock transition */ });
      const view = { type: e.type, payload: e.payload };
      for (const listener of [...eventListeners]) {
        try { void Promise.resolve(listener(view)).catch(() => undefined); }
        catch { /* a view listener can never break transport */ }
      }
    },
    onResync: async () => {
      // Discard the stale durable snapshot first, then wait for every currently mounted account screen
      // to refetch its authoritative list/history. SyncEngine acknowledges the server head only after
      // this barrier succeeds; a failure is retried with the old cursor.
      await cache.reset();
      const event = { type: "sync.resync", payload: null };
      await Promise.all([...eventListeners].map(async (listener) => { await listener(event); }));
    },
    onCursor: (s) => { void cache.setCursor(s).catch(() => { /* locked */ }); },
    onAuthLost: () => onAuthLost(),
    // T-512 — WebSocket lifecycle breadcrumb (connect/open/reconnect/close). Routing-safe, PII-free.
    onStateChange: (s) => { try { diagBuffer.ws(s); } catch { /* diag best-effort */ } },
  });

  // Media substrate (T-407): the FileUploader (streamed PUT /v1/files with byte-accurate progress and
  // content-addressed resume) + the MediaCache (LRU blob cache over the store; GET /v1/files/:id). The UI
  // reaches both through the structural MediaPort — objectUrl wraps cached bytes in a blob URL the caller
  // revokes. The MediaEnv exposes the live auto-download policy (server `autodownload` setting), the Lite
  // preset (platform Save-Data), the detected network type and the remembered playback speed.
  const uploader = new FileUploader({ baseUrl: "", tokens, clientId: CLIENT_ID, refresh: () => api.refreshTokens(), fetchImpl: efetch });
  const mediaCache = new MediaCache({
    baseUrl: "",
    tokens,
    clientId: CLIENT_ID,
    store,
    session: appLock.controller,
    allowPassthrough: () => appLock.controller.passthroughAllowed(),
    refresh: () => api.refreshTokens(),
    fetchImpl: efetch,
  });
  migrateForAppLock = async ({ dbKey, filesKey }) => {
    // Prepare every ciphertext before opening the lower-store transaction. Then commit ALL non-media
    // records plus media in one batch; IndexedDbStore maps this to one multi-object-store transaction.
    const [dbOps, mediaOps] = await Promise.all([
      encryptedStore.preparePlaintextMigrationOps(dbKey),
      mediaCache.preparePlaintextMigrationOps(filesKey),
    ]);
    await lowerStore.batch([...dbOps, ...mediaOps]);
    await encryptedStore.assertFullyEncryptedAtRest();
    await mediaCache.assertFullyEncryptedAtRest();
  };
  type NativeMediaFilesBridge = {
    saveAndOpen(input: { key: string; name: string; mime: string; bytes: Uint8Array }): Promise<{ saved: boolean; opened: boolean; uri: string }>;
    reset(): void;
  };
  const nativeMediaFiles = (window as Window & { __gcMediaFiles?: NativeMediaFilesBridge }).__gcMediaFiles ?? null;
  const mediaPort: MediaPort = {
    upload: (data, opts) => uploader.upload(data, opts),
    objectUrl: async (fileId, mime, persist = true) => {
      const blob = await mediaCache.get(fileId, { persist });
      // MediaCache bytes are always ArrayBuffer-backed (from res.arrayBuffer); the cast sidesteps the
      // lib's SharedArrayBuffer branch in BlobPart that can never occur here.
      const part = blob.bytes as unknown as BlobPart;
      return URL.createObjectURL(new Blob([part], { type: mime ?? blob.mime }));
    },
    ...(nativeMediaFiles ? {
      openFile: async (fileId: number, options: { name: string; mime: string }) => {
        const blob = await mediaCache.get(fileId, { persist: true });
        const account = session.currentUser()?.id ?? 0;
        return nativeMediaFiles.saveAndOpen({
          key: `${account}:${fileId}`,
          name: options.name,
          mime: options.mime || blob.mime,
          bytes: blob.bytes,
        });
      },
    } : {}),
    revoke: (url) => URL.revokeObjectURL(url),
    setCacheLimit: (bytes) => { void mediaCache.setLimit(bytes).catch(() => undefined); },
  };

  // Auto-download policy is account-scoped. A logout/reset invalidates every old request, so a slow
  // settings response from account A can never overwrite account B after a same-tab switch.
  const liteMode = (): boolean => {
    try { return platformDataSaver() || localStorage.getItem("gc.media.lite") === "1"; }
    catch { return platformDataSaver(); }
  };
  const mediaSettings = createAccountMediaSettings({
    loadSettings: async () => {
      const res = await api.get<{ settings?: Record<string, unknown> }>("/v1/users/me/settings");
      return res?.settings ?? {};
    },
    onCurrentSettled: () => mediaCache.setLimit(cacheLimitBytes(liteMode())).catch(() => undefined),
  });
  const SPEED_KEY = "gc.media.speed";
  const mediaEnv: MediaEnv = {
    policy: () => mediaSettings.policy(),
    dataSaver: liteMode,
    network: () => networkType(),
    speed: () => { try { return normalizeSpeed(localStorage.getItem(SPEED_KEY)); } catch { return 1; } },
    setSpeed: (s) => { try { localStorage.setItem(SPEED_KEY, String(s)); } catch { /* storage may be blocked */ } },
  };

  // T-417 — Telegram import capability: parse (worker) → core driver over the ApiClient + FileUploader
  // (media through the ordinary upload path so the T-119 quota is charged there), plus the folder/zip
  // source builders. The whole conversation lands in a read-only «Импорт: …» archive server-side.
  const importer: { ports: ImportPorts; folderSource: typeof makeFolderSource; zipSource: typeof makeZipSource } = {
    ports: {
      parse: async (text) => {
        const parsed = await parseExport(text);
        return { parsed, title: parsed.title, messageCount: parsed.messages.length, mediaCount: parsed.mediaPaths.length };
      },
      drive: async (parsed, source, importId, onProgress, signal) => {
        const result = await runTelegramImport(parsed as TgParsed, {
          importId,
          readMedia: source.readMedia,
          upload: (data, name, mime, uploadSignal) =>
            uploader.upload(data, uploadSignal ? { name, mime, signal: uploadSignal } : { name, mime }).then((r) => r.file_id),
          sendBatch: (batch) => api.post<TgImportResult>("/v1/import/telegram", batch),
          onProgress: (p: TgImportProgress) => {
            if (p.phase === "media") onProgress({ phase: "media", done: p.done, total: p.total, summary: null });
            else if (p.phase === "batch")
              onProgress({ phase: "sending", done: p.done, total: p.total, summary: p.result.summary });
          },
        }, { signal });
        return { chatId: result.chat_id, messageCount: result.message_count, fileCount: result.file_count, summary: result.summary };
      },
      newImportId,
    },
    folderSource: makeFolderSource,
    zipSource: makeZipSource,
  };

  // Router + the route-gated app (auth / chat list / settings / feed / import).
  const router = new HashRouter(WEB_ROUTES, browserHashEnv());
  // Breadcrumbs for crash reports: record ONLY the route name (never a chat/contact id) so a report carries
  // anonymous navigation context. Wrapped so a telemetry hiccup can never break routing.
  router.subscribe(() => {
    try { diag.recordScreen(router.current().name); } catch { /* never break routing */ }
    try { diagBuffer.route(router.current().name); } catch { /* never break routing */ } // T-512 route breadcrumb
  });
  // T-419 — the «Адрес сервера» port. `current()`/`isDefault()` report the user-configured PRIMARY (not a
  // transient failover target); `save()` normalises + persists the address, repoints the manager, and — when
  // a session is live — logs out (a different server is a different account namespace). The failover toggle
  // persists and flips the manager's auto-rotation. `pendingAddress()` prefills a deep-link host once.
  const serverPort: ServerPort = {
    current: () => configuredServer,
    isDefault: () => configuredServer === "",
    authed: () => session.isAuthed(),
    save: async (address) => {
      const next = normalizeBase(address) ?? "";
      // A different server is a different account namespace. End the session on the CURRENT server (so the
      // best-effort revoke reaches the right host) and wipe ALL local data — persisted stores, the token
      // slice and media caches — BEFORE repointing, so nothing from the old server bleeds into the new one
      // (T-419 «свой сервер» + T-423 privacy). The wipe runs even when signed out, clearing any stale cache.
      await cancelServerConfigSync();
      if (session.isAuthed()) await session.logout();
      else await session.wipeLocalData();
      // ProxyController is process-global for this WebView. Clear the old signed route before changing
      // the user-selected server or the new /v1/config request could be blocked by the old gc-block final.
      const transportStop = await realityTransport.stop();
      if (transportStop.status === "failed") throw new Error("server transport reset failed");
      configuredServer = next;
      saveServerPref(next);
      endpoints.setPrimary(next);
      void syncServerConfig();
    },
    failover: {
      get: () => endpoints.autoFailoverEnabled(),
      set: (on) => { saveFailoverPref(on); endpoints.setAutoFailover(on); },
    },
    pendingAddress: () => pendingHostFromHash(),
  };

  // T-514 (MS-4 / T-113) — the abuse-report hand-off. Opened from the support form's «Пожаловаться…» link
  // (untargeted → the overlay asks for an @username and resolves it via /v1/search/global) and from
  // per-message/per-user surfaces (a preset ReportTarget). A report POSTs /v1/report — it is NOT a
  // ticket (§12) — and closes with a "thanks" toast. Wiring onReport is what un-hides the support link.
  const openReport = (target?: ReportTarget): void => {
    const overlay = createReportOverlay({
      i18n,
      api,
      ...(target ? { target } : {}),
      toast: showToast,
    });
    document.body.appendChild(overlay.root);
    overlay.focus();
  };

  // T-512 (MS-2) — the support/feedback controller: owns POST /v1/support/tickets, the offline queue (S-003,
  // localStorage), and the toast. The overlay mounts on document.body. openSupport() snapshots the CURRENT
  // route + the diagnostics ring AT OPEN TIME, so the «посмотреть, что уйдёт» preview is byte-exact with the
  // send. onReport (T-514) now hands off to the report overlay above, so the overlay shows that link.
  const supportQueue = createSupportQueue(supportQueueStorage());
  const supportController = createSupportController({
    api,
    i18n,
    queue: supportQueue,
    mount: (root) => { document.body.appendChild(root); },
    newClientRef: newSupportRef,
    online: () => { try { return navigator.onLine; } catch { return true; } },
    toast: showToast,
    onReport: () => openReport(),
  });
  const openSupport = (prefill?: SupportPrefill): void => {
    supportController.open({
      auto: { screen: router.current().name, app_version: QUALITY_APP_VERSION, platform: nativePlatform() },
      diagnostics: diagBuffer.snapshot(),
      ...(prefill ? { prefill } : {}),
    });
  };
  // T-514 (MS-4, §2.3 R7 / §14) — offer to send LAST session's crash report. Unlike openSupport (which
  // attaches the CURRENT ring), this attaches the SAVED snapshot so the report describes the crash, not the
  // fresh boot. Prefills category=bug + a short editable description; the preview stays byte-exact.
  const openCrashReport = (saved: CrashSnapshot): void => {
    supportController.open({
      auto: { screen: router.current().name, app_version: APP_VERSION, platform: nativePlatform() },
      diagnostics: saved.snapshot,
      prefill: { category: "bug", text: i18n.t("support.crash.prefill") },
    });
  };
  // Read the persisted snapshot once and, if present, surface the offer. Gated on a live session (sending a
  // ticket needs auth): if signed out we KEEP the snapshot for a later authed launch instead of dropping it.
  const maybeOfferCrashReport = (): void => {
    if (!session.isAuthed() || !appLockAllowsData()) return;
    let saved: CrashSnapshot | null = null;
    try { saved = readCrashSnapshot(crashStore); } catch { saved = null; }
    if (!saved) return;
    const s = saved;
    showCrashOffer(
      { text: i18n.t("support.crash.offer"), send: i18n.t("support.crash.send"), dismiss: i18n.t("support.crash.dismiss") },
      () => { clearCrashSnapshot(crashStore); openCrashReport(s); },
      () => { clearCrashSnapshot(crashStore); },
    );
  };

  // T-514 (MS-4 §3.1.3 / §14) — the service-status probe behind the Help card. A RAW client probe of the
  // PUBLIC GET /health for the service-status card. The router wraps EVERY handler return in the {ok,result}
  // envelope, so /health answers {ok:true,result:{status,uptime_sec,…}} — we unwrap `result` (and still
  // accept a bare object, so a self-hoster/reverse-proxy that serves /health unwrapped keeps working). We hit
  // efetch (not the ApiClient) so a signed-out / still-connecting client can probe too; efetch resolves
  // "/health" against the active endpoint and enforces the anti-exfiltration allowlist. NO new server
  // endpoint. A 4 s abort keeps a dead endpoint from wedging the card.
  const probeHealth = async (): Promise<HealthInfo | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* */ } }, 4000);
    try {
      const res = await efetch("/health", { method: "GET", signal: ctrl.signal });
      if (!res.ok) return null;
      return parseHealth(await res.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const supportStatus: SupportStatusPort = {
    health: probeHealth,
    wsState: () => sync.getWsState(),
    deliveryState: () => sync.getDeliveryState(),
    online: () => { try { return navigator.onLine; } catch { return true; } },
    queued: () => { try { return supportQueue.size(); } catch { return 0; } },
  };

  const screenPrivacy = webScreenPrivacyPort();

  // ---- live calling (V75) ----------------------------------------------------------------------
  // V104: the whole calling subsystem is direct-APK only. D-008 removed calls from the Play edition,
  // but only the /calls route and the `call.*` dictionary entries were ever stripped — the controller,
  // the body-level overlay and the `calls` port survived, so the store build still drew a handset and a
  // camera in every dialog header and still answered inbound rings. With the dictionary gone those
  // surfaces rendered their raw keys ("call.startAudio", "call.kindAudio", "call.endMicDenied"),
  // measured on the signed store AAB 8f3e8dbd. Stripping the port alone would hide the buttons and
  // leave the inbound overlay, so the controller, its media/ICE plumbing and the overlay go together.
  // Everything a call needs that the screens layer may not touch lives here: the socket (signaling),
  // getUserMedia/RTCPeerConnection (call_media.ts) and a body-level overlay that survives every screen
  // swap — a call must not end because the person navigated to Settings mid-conversation.
  const callTones = createBrowserCallTones({
    incomingUrl: `/assets/call-incoming.mp3?v=${encodeURIComponent(BUILD_ID)}`,
    outgoingUrl: `/assets/call-outgoing.mp3?v=${encodeURIComponent(BUILD_ID)}`,
  });
  const callController = new CallController({
    signal: {
      send: (frame) => {
        // A call that cannot signal has already failed; saying so immediately beats a phantom ring.
        if (sync.getWsState() !== "open") return false;
        sync.socket.sendCall(frame as { type: string });
        return true;
      },
      subscribe: (handler) => {
        callFrameListeners.add(handler);
        return () => { callFrameListeners.delete(handler); };
      },
    },
    media: createBrowserCallMedia(),
    // ICE configuration is per-deployment (STUN always, TURN only when configured). A failure yields
    // [] and the call still tries: host candidates work on the same network.
    iceServers: async () => {
      try {
        const cfg = await api.get<{ ice_servers?: IceServer[] }>("/v1/calls/config");
        return Array.isArray(cfg.ice_servers) ? cfg.ice_servers : [];
      } catch { return []; }
    },
    // An inbound frame carries only a user id. Naming the caller is a nicety, never a precondition:
    // a failure here still leaves an answerable ringing call.
    resolvePeer: async (userId) => {
      try {
        const u = await api.get<{ id: number; name?: string; username?: string | null }>(`/v1/users/${userId}`);
        return { id: u.id, name: u.name ?? "", username: u.username ?? null };
      } catch { return null; }
    },
    onState: (state) => {
      callTones.update(state);
      callOverlay.render(state);
    },
    // A finished call becomes a durable service row on the server, so the log must refetch. Reusing
    // the event feed keeps the screens layer free of shell-specific plumbing.
    onFinished: () => {
      const event = { type: "call.finished", payload: null };
      for (const listener of [...eventListeners]) {
        try { void Promise.resolve(listener(event)).catch(() => undefined); }
        catch { /* a view listener can never break the call */ }
      }
    },
    now: () => Date.now(),
  });
  const callOverlay = createCallOverlay({ controller: callController, i18n });
  document.body.appendChild(callOverlay.root);

  // ---- LiveKit group conferences (V178) -------------------------------------------------------
  // Created lazily because main.ts also boots the signed-out shell. A runtime is bound to exactly one
  // account and is destroyed synchronously at the account-clear boundary, before tokens or cache data
  // can be replaced by another account.
  let conferenceController: ConferenceController | null = null;
  let conferenceOverlay: ConferenceOverlay | null = null;
  let conferenceRuntimeUserId: number | null = null;
  let conferenceRuntimeEpoch = 0;
  let conferenceRuntimePromise: Promise<ConferenceController> | null = null;
  let conferenceRuntimePromiseUserId: number | null = null;

  const destroyConferenceRuntime = (): void => {
    conferenceRuntimeEpoch += 1;
    conferenceController?.destroy();
    conferenceOverlay?.destroy();
    conferenceController = null;
    conferenceOverlay = null;
    conferenceRuntimeUserId = null;
    conferenceRuntimePromise = null;
    conferenceRuntimePromiseUserId = null;
  };

  const ensureConferenceRuntime = async (): Promise<ConferenceController> => {
    const user = session.currentUser();
    if (!user || user.id <= 0) throw new Error("conference requires an authenticated account");
    if (conferenceController && conferenceRuntimeUserId === user.id) return conferenceController;
    if (conferenceRuntimePromise && conferenceRuntimePromiseUserId === user.id) return conferenceRuntimePromise;

    destroyConferenceRuntime();
    const userId = user.id;
    const epoch = ++conferenceRuntimeEpoch;
    conferenceRuntimePromiseUserId = userId;
    const task = (async (): Promise<ConferenceController> => {
      // LiveKit is intentionally a lazy chunk: people who only open chats must not pay the SDK's
      // download/parse cost, and the core bundle remains inside the production startup budget.
      const [{ createBrowserConferenceMedia }, { createConferenceOverlay }] = await Promise.all([
        import("./conference_media.ts"),
        import("./conference_overlay.ts"),
      ]);
      if (epoch !== conferenceRuntimeEpoch || session.currentUser()?.id !== userId) {
        throw new Error("conference account changed during initialization");
      }

      let overlay: ConferenceOverlay | null = null;
      const media = createBrowserConferenceMedia({
        onTracks: (tracks) => { overlay?.setTracks(tracks); },
      });
      const controller = new ConferenceController({
        api: {
          join: (conferenceId): Promise<ConferenceJoinGrant> =>
            api.post<ConferenceJoinGrant>(`/v1/conferences/${encodeURIComponent(conferenceId)}/join`, {}),
          screenShareGrant: (conferenceId): Promise<ConferenceScreenShareGrant> =>
            api.post<ConferenceScreenShareGrant>(
              `/v1/conferences/${encodeURIComponent(conferenceId)}/screen-share-grant`,
              {},
            ),
          leave: async (conferenceId) => {
            await api.post(`/v1/conferences/${encodeURIComponent(conferenceId)}/leave`, {});
          },
          raiseHand: async (conferenceId) => {
            await api.post(`/v1/conferences/${encodeURIComponent(conferenceId)}/raise-hand`, {});
          },
          changeRole: async (conferenceId, targetUserId, role) => {
            await api.patch(
              `/v1/conferences/${encodeURIComponent(conferenceId)}/participants/${encodeURIComponent(String(targetUserId))}`,
              { role },
            );
          },
          removeParticipant: async (conferenceId, targetUserId) => {
            await api.delete(
              `/v1/conferences/${encodeURIComponent(conferenceId)}/participants/${encodeURIComponent(String(targetUserId))}`,
            );
          },
          end: async (conferenceId) => {
            await api.post(`/v1/conferences/${encodeURIComponent(conferenceId)}/end`, {});
          },
        },
        media,
        selfUserId: userId,
        onState: (state) => { overlay?.render(state); },
        now: () => Date.now(),
        recoveryTimeoutMs: 45_000,
        tokenRefreshLeadMs: 30_000,
        tokenRetryMs: 5_000,
      });
      overlay = createConferenceOverlay({ controller, locale: i18n.locale, selfUserId: userId, api });
      document.body.appendChild(overlay.root);
      if (epoch !== conferenceRuntimeEpoch || session.currentUser()?.id !== userId) {
        controller.destroy();
        overlay.destroy();
        throw new Error("conference account changed during initialization");
      }
      conferenceController = controller;
      conferenceOverlay = overlay;
      conferenceRuntimeUserId = userId;
      return controller;
    })();
    conferenceRuntimePromise = task;
    try {
      return await task;
    } finally {
      if (conferenceRuntimePromise === task) {
        conferenceRuntimePromise = null;
        conferenceRuntimePromiseUserId = null;
      }
    }
  };

  // Durable conference events carry membership/moderation state. LiveKit owns media events, while the
  // GreenChat control plane remains authoritative for roles, removal and room termination.
  eventListeners.add((event) => {
    if (!event.type.startsWith("conference.") || !conferenceController) return;
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    conferenceController.handleEvent({ ...payload, type: event.type });
  });

  const app = createApp({
    host, api, session, router, i18n, outbox: outboxPort, events, media: mediaPort, mediaEnv, importer,
    diagnostics: {
      get: () => diag.getConsent(),
      set: (on) => diagnosticsConsent.set(on),
    },
    ...(telegramPort ? { telegram: telegramPort } : {}),
    server: serverPort,
    now: () => serverClock.nowSec(),
    registration,
    support: { open: openSupport, status: supportStatus },
    moderation: { openReport },
    // V75: the dialog header's call buttons and the log's redial all land here.
    calls: { start: (peer, video) => { void callController.place(peer, video); } },
    // V178: group rooms are created by the GreenChat control plane, then joined through a short-lived
    // LiveKit grant. Opening the camera is always an explicit consequence of the chosen Video action.
    conferences: {
      join: async (conferenceId, video) => {
        const runtime = await ensureConferenceRuntime();
        await runtime.join(conferenceId, { microphoneOn: true, cameraOn: video });
      },
      create: async (chatId, video) => {
        const room = await api.post<{ id: string }>(`/v1/chats/${encodeURIComponent(String(chatId))}/conference`, {
          mode: "conversation",
          video,
        });
        const runtime = await ensureConferenceRuntime();
        await runtime.join(room.id, { microphoneOn: true, cameraOn: video });
      },
      open: async (chatId, video) => {
        const path = `/v1/chats/${encodeURIComponent(String(chatId))}/conference`;
        type ActiveRoom = { id: string; video?: boolean };
        let active = await api.get<{ conference: ActiveRoom | null }>(path);
        let room = active.conference;
        if (!room) {
          try {
            room = await api.post<ActiveRoom>(path, { mode: "conversation", video });
          } catch (error) {
            // Two members can tap at the same instant. The server reserves creation before awaiting
            // LiveKit, so the losing request may observe CONFERENCE_ACTIVE slightly before the winning
            // room becomes readable. Poll only that explicit race and then join the single winner.
            const code = typeof error === "object" && error !== null
              ? String((error as { code?: unknown }).code ?? "")
              : "";
            if (code !== "CONFERENCE_ACTIVE") throw error;
            for (let attempt = 0; attempt < 24 && !room; attempt += 1) {
              await new Promise<void>((resolve) => setTimeout(resolve, 160));
              active = await api.get<{ conference: ActiveRoom | null }>(path);
              room = active.conference;
            }
            if (!room) throw error;
          }
        }
        const runtime = await ensureConferenceRuntime();
        await runtime.join(room.id, { microphoneOn: true, cameraOn: video && room.video === true });
      },
    },
    lock: appLock.port,
    language: {
      get: () => Promise.resolve(langPref),
      set: (pref: string) => setLangPref(pref as LangPref),
    },
    notifyMode: webNotifyModePort(),

    cachePolicy: cachePolicyPort,
    ...(screenPrivacy ? { screenPrivacy } : {}),
    // 2026-07 redesign: the Settings ui_theme select drives the local ThemeController (palette-less shells).
    onUiTheme: (p) => theme.setPref(p),
  });

  const appLockAllowsData = (): boolean =>
    appLock.controller.state === "DISABLED" || appLock.controller.state === "UNLOCKED";

  // Financial preferences belong to the Wallet/Exchange domain. Messenger sign-in, unlock and inbox
  // boot never prompt for a display currency; users choose it intentionally inside financial surfaces.

  // Ctrl+K palette: language + theme + navigation. Reused verbatim from the T-404 foundation so the
  // whole shell shares one command surface.
  const commands = (): Command[] => [
    { id: "go-home", title: i18n.t("common.appName"), keywords: ["home", "chats", "главная", "чаты"], run: () => router.navigate("/") },
    { id: "go-settings", title: i18n.t("common.settings"), keywords: ["settings", "настройки"], run: () => router.navigate("/settings") },
    { id: "import-telegram", title: i18n.t("import.command"), keywords: ["import", "telegram", "импорт", "телеграм", "переезд"], run: () => router.navigate("/import") },
    { id: "theme-light", title: `${i18n.t("settings.theme")}: ${i18n.t("settings.themeLight")}`, run: () => theme.setPref("light") },
    { id: "theme-dark", title: `${i18n.t("settings.theme")}: ${i18n.t("settings.themeDark")}`, run: () => theme.setPref("dark") },
    { id: "theme-system", title: `${i18n.t("settings.theme")}: ${i18n.t("settings.themeSystem")}`, run: () => theme.setPref("system") },
    { id: "logout", title: i18n.t("auth.logout"), keywords: ["signout", "выход", "выйти"], run: () => { void session.logout(); } },
  ];
  const palette = new CommandPalette({
    commands,
    placeholder: i18n.t("palette.placeholder"),
    emptyText: i18n.t("palette.empty"),
  });
  const shortcuts = new Shortcuts();
  shortcuts.register({ combo: "mod+k", description: i18n.t("palette.title"), run: () => palette.toggle() });
  shortcuts.attach();

  let setAppBadge = (_count: number): void => {};
  // PWA (T-408): register the service worker + «Обновить» update banner, drive the Badging API from the
  // server's unread total, show the iOS install hint, and take in a Web Share Target payload. All browser
  // specifics sit behind browserPwaEnv; banners mount on <body> above the app.
  const pwa = new PwaController({ env: browserPwaEnv(), i18n, host: document.body });
  void pwa.start();
  pwa.maybeShowIosInstall();
  setAppBadge = (count) => pwa.setBadge(count);

  // GC_MESSENGER_DIRECT_APK_ONLY_START
  // APK update discovery (T-413) — NATIVE ONLY. The Capacitor bridge supplies the installed
  // versionName + versionCode before importing this bundle. Web/PWA has no __gcUpdateInfo and remains
  // under the Service Worker above. A direct APK checks now, when connectivity returns, when the app
  // becomes visible, and every 15 minutes: starting offline or leaving the app open before a release
  // can no longer make that release invisible until a full restart. Concurrent triggers collapse into
  // one trailing request and the lifecycle owns exactly one surface, so retries never stack banners.
  // A tap still hands the manifest URL to Capacitor Browser / the system installer; nothing downloads
  // silently. Bare /v1 paths are rewritten by the native shell to the configured server origin.
  try {
    const wupd = window as Window & {
      __gcUpdateInfo?: { platform: string; arch: string; version: string; build: number };
      __gcOpenExternal?: (url: string) => Promise<void>;
    };
    const updId = wupd.__gcUpdateInfo;
    if (updId) {
      startNativeUpdateLifecycle({
        env: browserNativeUpdateLifecycleEnv(),
        load: () => fetchUpdateStatus(
          updId.platform,
          updId.arch,
          updId.version,
          { currentBuild: updId.build },
        ),
        present: (status) => presentUpdateStatus(status, {
          i18n,
          host: document.body,
          current: updId.version,
          openUrl: (url) => {
            const open = wupd.__gcOpenExternal;
            if (open) void open(url).catch(() => { /* browser refused — banner stays for a retry */ });
            else window.open(url, "_blank", "noopener");
          },
        }),
      });
    }
  } catch {
    /* no native bridge → nothing to do */
  }
  // GC_MESSENGER_DIRECT_APK_ONLY_END

  // A share from the OS opens the app at "/" with title/text/url in the query; fold it into one message,
  // stash it for the next chat opened, then strip the query so a reload/back doesn't re-share it.
  try {
    const shared = shareToText(parseShareParams(location.search));
    if (shared) {
      setPendingShare(shared);
      history.replaceState(null, "", location.pathname + location.hash);
    }
  } catch { /* no share payload */ }

  // Badging API: account-scoped, debounced, and latest-request-wins. reset() invalidates both pending
  // timers and already-started requests, so a late unread result cannot resurrect the previous account.
  const badgeRefresh = createBadgeRefreshController({
    allowed: () => session.isAuthed() && appLockAllowsData(),
    loadCount: async () => {
      const b = await api.get<Badge>("/v1/badge");
      return b?.total_unread ?? 0;
    },
    apply: setAppBadge,
  });
  const refreshBadge = (): void => badgeRefresh.request();
  const BADGE_EVENTS = new Set(["message.new", "message.delete", "chat.read", "chat.update"]);
  events.subscribe((e) => { if (BADGE_EVENTS.has(e.type)) refreshBadge(); });

  // Live sync follows the session: start on auth (seeding the cursor from cache so we replay only the
  // delta, then resuming any queued Outbox items), stop on logout so a signed-out tab holds no socket.
  // T-419: best-effort merge of server-advertised backup addresses (/v1/config endpoints[], T-125). The
  // endpoint may not exist yet — any failure is ignored and the hardwired FALLBACK_ENDPOINTS stand.
  let configSyncSeq = 0;
  let configSyncInFlight: Promise<void> | null = null;

  const runServerConfigSync = async (seq: number): Promise<void> => {
    const started = Date.now();
    try {
      const cfg = await api.get<{
        server_time?: unknown;
        endpoints?: unknown;
        policy?: unknown;
        kill_switch?: unknown;
        features?: { registration?: unknown };
      }>("/v1/config");
      const received = Date.now();
      if (seq !== configSyncSeq) return; // an explicit server switch owns state
      if (typeof cfg?.server_time === "number") serverClock.update(cfg.server_time, started, received);
      const mode = cfg?.features?.registration;
      if ((mode === "open" || mode === "invite" || mode === "closed") && mode !== registrationMode) {
        registrationMode = mode;
        for (const listener of [...registrationListeners]) listener();
      }
      // NR-03 + T-605 transaction: verify signature, prepare/rollback the process-global Android proxy,
      // then atomically publish endpoints/policy/kill-switch. A native refusal leaves old client state live.
      const networkConfigApplied = await connectionManager.applyConfigVerified(cfg, prepareRealityConfig);
      if (seq !== configSyncSeq || !networkConfigApplied) return;
      // Initial L0/L1 selection is best-effort, but only after the complete verified transaction commits.
      // Same-origin/single-endpoint builds are inert; every probed address remains anti-exfiltration gated.
      void connectionManager.connect().catch(() => undefined);
    } catch { /* keep local-time/open-registration/build-endpoint compatibility defaults */ }
  };

  const syncServerConfig = (): Promise<void> => {
    // Boot/timer overlap coalesces. Starting an unverified refresh must never cancel the last trusted native
    // engine; only an explicit origin switch invalidates the active config transaction.
    if (configSyncInFlight !== null) return configSyncInFlight;
    const seq = ++configSyncSeq;
    connectionManager.invalidateConfigVerification();
    const run = runServerConfigSync(seq);
    const tracked = run.finally(() => {
      if (configSyncInFlight === tracked) configSyncInFlight = null;
    });
    configSyncInFlight = tracked;
    return tracked;
  };

  const cancelServerConfigSync = async (): Promise<void> => {
    configSyncSeq += 1;
    connectionManager.invalidateConfigVerification();
    const inFlight = configSyncInFlight;
    if (inFlight !== null) await inFlight;
  };
  let syncing = false;

  const noteBackgroundFailure = (operation: string): void => {
    try { diagBuffer.err(`${operation} failed`); } catch { /* diagnostics breadcrumb is best-effort */ }
  };
  const stopDataPlane = (): void => {
    outbox.pause();
    sync.stop();
    syncing = false;
    badgeRefresh.reset();
  };
  stopIntegrityDataPlane = stopDataPlane;
  // A restored container starts COLD before the first state-change callback. Pause the Outbox immediately
  // so no persisted undo timer or ambiguous send is reconstructed until K_db is available again.
  if (!appLockAllowsData()) stopDataPlane();

  const startSync = async (): Promise<void> => {
    if (!appLockAllowsData() || syncing) return;
    syncing = true;
    try {
      await localCachePolicy.load();
      await outbox.applyPersistencePolicy();
      sync.setCursor(await cache.getCursor());
      if (!appLockAllowsData()) { syncing = false; return; }
      sync.start();
      void outbox.resume().catch(() => noteBackgroundFailure("outbox.resume"));
      void mediaSettings.load();

      void localCachePolicy.prune().catch(() => noteBackgroundFailure("localCachePolicy.prune"));
      refreshBadge();
      void supportController.flushQueue(); // T-512 (S-003): drain queued tickets once we're live
    } catch {
      // A lock transition can intentionally revoke K_db while warm-start work is in flight.
      syncing = false;
    }
  };
  // GC_MESSENGER_DIRECT_APK_ONLY_START
  // Native push (§5.4, T-414): on a native shell the bridge installed window.__gcPushBridge BEFORE this
  // app booted; we hand it to the core registrar, which POSTs the device token to /v1/push/subscribe with
  // the live in-memory access token (the bridge itself never authenticates). No-op on web/desktop.
  let push: PushRegistration | null = null;
  const startPush = (): void => {
    if (push) return;
    const bridge = (window as Window & { __gcPushBridge?: PushBridge }).__gcPushBridge;
    if (!bridge) return;
    push = registerPush(api, bridge);
  };
  const stopPush = (): void => {
    if (!push) return;
    void push.stop();
    push = null;
  };
  // GC_MESSENGER_DIRECT_APK_ONLY_END

  invalidateAccountOperations = () => {
    // Session invokes this synchronously BEFORE tokens/user/storage are cleared and before the durable
    // wipe begins. Every old-account writer is invalidated now; async cleanup may finish later, but no
    // late completion can become current-account state.

    callTones.stop();
    suspendTelegram();
    destroyConferenceRuntime();
    stopDataPlane();
    // GC_MESSENGER_DIRECT_APK_ONLY_START
    stopPush();
    // GC_MESSENGER_DIRECT_APK_ONLY_END
    supportController.reset();
    uploader.reset();
    nativeMediaFiles?.reset();
    mediaSettings.reset();
    void cache.reset().catch(() => undefined);
    void mediaCache.reset().catch(() => undefined);
    localCachePolicy.resetMemory();
  };

  finalizeAccountClear = async () => {
    // webLocalData.wipe() hard-deletes IndexedDB. Repeat the account-scoped reset after that delete so
    // the lazy IndexedDbStore recreates an EMPTY, complete schema before signed-out/new-account code can
    // observe it. The barriers also drain any pre-wipe operation that settled during deleteDatabase.
    await Promise.allSettled([cache.reset(), mediaCache.reset()]);
    await wipeTelegram();
  };

  handleExternalAppLockSnapshot = (): void => {
    // Cross-tab app-lock changes invalidate this tab's in-memory key posture. Stop every local writer
    // synchronously, then reload only after any in-flight rotating refresh has durably committed.
    stopDataPlane();
    // GC_MESSENGER_DIRECT_APK_ONLY_START
    stopPush();
    // GC_MESSENGER_DIRECT_APK_ONLY_END
    reloadAfterRefreshBarrier();
  };

  appLock.port.subscribe((state) => {
    if (state === "COLD" || state === "LOCKED" || state === "WIPED") {
      stopDataPlane();

      suspendTelegram();
    } else if (session.isAuthed()) {
      const user = session.currentUser();
      if (user) void bindTelegramAccount(user.id);
      void connectionManager?.connect().catch(() => undefined);
      void startSync();
    }
    if (state === "WIPED") {
      // GC_MESSENGER_DIRECT_APK_ONLY_START
      stopPush();
      // GC_MESSENGER_DIRECT_APK_ONLY_END
      if (!wipedCleanupStarted) {
        wipedCleanupStarted = true;
        // clearLocal() runs synchronously before wipeLocalData's first await, so no authenticated UI
        // survives this callback. The receipt itself is stable: never reload merely because WIPED is
        // rendered, otherwise every cold boot loops forever on the same tombstone.
        void Promise.allSettled([wipeTelegram(), session.wipeLocalData()])
          .then(() => appLock.controller.completeLocalReset())
          .catch(() => undefined);
      }
    } else {
      wipedCleanupStarted = false;
    }
  });

  session.subscribe((user) => {
    if (!user) return; // signed-out invalidation already ran synchronously in Session.onBeforeClear
    if (appLockAllowsData()) void bindTelegramAccount(user.id);
    if (appLockAllowsData()) void startSync();
    else badgeRefresh.reset();
    // GC_MESSENGER_DIRECT_APK_ONLY_START
    startPush();
    // GC_MESSENGER_DIRECT_APK_ONLY_END
  });
  // T-512 (S-003): connectivity returned → drain the offline support queue. Idempotent by client_ref, so a
  // double-fire (this event + startSync) never double-creates a ticket. Only when a user is signed in.
  if (typeof addEventListener === "function") {
    addEventListener("online", () => {
      if (session.isAuthed() && appLockAllowsData()) {
        void supportController.flushQueue();
        // V124: the support queue was drained here and the message queue was not. Measured on the
        // signed artifact (var/ux-audit/v124-offline): a message that failed while offline stayed ⚠
        // «Повторить» after the link returned, on the very screen whose strip was saying
        // «Соединение восстановлено» — the app announced the recovery and then acted on none of it.
        // retryFailed() re-drives ONLY the items that already failed, so undo windows survive and a
        // paused (app-locked) Outbox stays paused; a duplicate send is harmless anyway because the
        // server dedupes messages by client_msg_id.
        void outbox.retryFailed().catch(() => noteBackgroundFailure("outbox.retryFailed"));
      }
      recoverTelegramAccounts();
      void connectionManager?.connect().catch(() => undefined);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recoverTelegramAccounts();
    });
  }

  // Cold start: try to restore a saved session BEFORE the first paint decision, then start the app.
  // restore() refreshes the access token (or keeps an optimistic session while offline); either way the
  // app's auth gate then shows the right screen. A failure just means "not signed in".
  // Config is public and needed even before login (clock, registration mode, mirrors). Refresh once
  // per hour per CLIENTS.md §9; a failure preserves the previous known-good values.
  setInterval(() => { void syncServerConfig(); }, 60 * 60 * 1000);

  // T-529: a long-running foreground session must not keep rows past a finite retention boundary merely
  // because the app was never restarted. Hourly pruning is bounded by the small local encrypted cache.
  setInterval(() => {
    if (session.isAuthed() && appLockAllowsData() && localCachePolicy.isLoaded()) {
      void localCachePolicy.prune().catch(() => undefined);
    }
  }, 60 * 60 * 1000);
  // While a backup is active, periodically probe L0 and return automatically when direct recovers.
  // Same-origin and single-endpoint builds are inert inside recheckDirect().
  setInterval(() => { void connectionManager?.recheckDirect().catch(() => undefined); }, 5 * 60 * 1000);
  void syncServerConfig();
  void localResetRecovery
    .catch(() => undefined)
    .then(async () => {
      // WIPED is a device-security receipt, not an authenticated state. Never exchange a stale refresh
      // token while that receipt gates the UI — even if an unload race recreated gc.session after the
      // initial recovery clear. Resetting the device is the only transition back to ordinary auth.
      if (appLock.port.state === "WIPED") {
        tokens.access = null;
        tokens.refresh = null;
        tokens.accessExpiresAt = null;
        try { storage.clear(); } catch { /* storage adapter is best-effort */ }
        return false;
      }
      // T-529: the retention policy loads only once the crypto container admits data access —
      // and never on a wiped device (the guard above returns before any cache I/O).
      if (appLockAllowsData()) await localCachePolicy.load();
      return session.restore();
    })
    .catch(() => false)
    .finally(() => {
      app.start();
      // The active catalogue was awaited before boot. Warm only the alternate language now, after the
      // first synchronous app render, so later switching is instant without charging startup bytes.
      const alternateLocale: Locale = i18n.locale === "ru" ? "en" : "ru";
      setTimeout(() => { void ensureLocale(alternateLocale).catch(() => undefined); }, 0);
      if (session.isAuthed()) {
        void startSync();
        // GC_MESSENGER_DIRECT_APK_ONLY_START
        startPush();
        // GC_MESSENGER_DIRECT_APK_ONLY_END
      }
      try {
        diagBuffer.perf("boot", Math.round(performance.now()));
      } catch {
        /* no perf API */
      } // T-512 rare perf mark
      // T-514 (MS-4): after the first paint decision, offer last session's crash report (if any, and authed).
      try { setTimeout(maybeOfferCrashReport, 1200); } catch { maybeOfferCrashReport(); }
    });
}

// IndexedDB is the durable store in a normal browser tab; private-mode/quirky embeds may lack it, so
// we degrade to an in-memory store (no warm-start cache, but the app still works).
function supportsIndexedDb(): boolean {
  try { return typeof indexedDB !== "undefined" && indexedDB !== null; }
  catch { return false; }
}

const startBoot = (): void => {
  void boot().catch(() => {
    // A locale chunk is an immutable part of the same release. A failed first fetch is handled like
    // any other broken startup asset: leave the shell's loading/error surface intact instead of
    // rendering untranslated keys or half-initialising account state.
    document.getElementById("app")?.removeAttribute("aria-busy");
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startBoot, { once: true });
} else {
  startBoot();
}
