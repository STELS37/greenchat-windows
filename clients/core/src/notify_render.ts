// clients/core/src/notify_render.ts — pure notification rendering for push payloads (T-531, DS-13,
// DEVICE_SECURITY §7). Given the push payload and the CLIENT-LOCAL display mode, decide exactly what
// the notification shows:
//   • "full"    — title/body as the server sent them (present only when the RECIPIENT opted in
//                 server-side via notify_preview, default OFF — server/src/modules/users.ts). Without
//                 opt-in the payload has no title/body and full degrades to the generic strings, so
//                 "full" is a safe client default: it can never reveal more than the server sends.
//   • "name"    — the sender/chat title is shown, the body is replaced with the generic string.
//   • "generic" — both title and body are generic («Green Chat» / «Новое сообщение»); no name, no text.
// Hidden chats (T-527, not built yet): the isHiddenChat hook forces "generic" for that chat regardless
// of mode. Until T-527 lands callers pass nothing and every chat counts as visible.
//
// CONTRACT (CLIENTS §8.3, server/src/push/senders.ts buildPayload): the payload carries ONLY
// {chat_id, message_id, kind, sent_at} plus optional {title, body, emoji, urgent}. Rendering reads
// ONLY {chat_id, message_id, kind, title, body}; it NEVER throws and NEVER logs payload content —
// a malformed payload yields a generic notification, not a crash.
//
// This module is the AUTHORITATIVE, node-tested implementation. clients/web/sw.js (a classic
// non-module worker that cannot import ESM/TS) carries a line-for-line mirror of renderNotification;
// clients/core/test/notify_render.test.ts executes sw.js in a vm and pins the two equal on the same
// fixtures — edit both together.
// NOTE: imported by DIRECT path (not via core/src/index.ts — the barrel belongs to another lane).

export type NotifyMode = "full" | "name" | "generic";

export const NOTIFY_MODES: readonly NotifyMode[] = ["full", "name", "generic"];

// Privacy-safe default; see the header — without server-side notify_preview opt-in no text arrives anyway.
export const NOTIFY_MODE_DEFAULT: NotifyMode = "full";

// Where the web shell persists the mode so the SERVICE WORKER can read it with every page closed:
// the shared «gc-diag» IndexedDB, store "kv", this key (same DB sw.js already opens per-push for the
// T-418 consent flag). The mode enum is not a secret — nothing sensitive lands on disk.
export const NOTIFY_MODE_KV_KEY = "notify_mode";

export function normalizeNotifyMode(v: unknown): NotifyMode {
  return v === "full" || v === "name" || v === "generic" ? v : NOTIFY_MODE_DEFAULT;
}

export interface NotifyRenderResult {
  title: string;
  options: {
    body: string;
    icon: string;
    badge: string;
    data: { chat_id: unknown; message_id: unknown; kind: unknown };
    renotify: boolean;
    tag?: string;
  };
}

export interface NotifyRenderHooks {
  // T-527 hook point: return true and the notification collapses to "generic" whatever the mode.
  // A throwing predicate counts as "not hidden" — rendering must never fail. Calls stay recognisable
  // as calls even when hidden (see the call note below); T-527 may tighten that when it defines
  // what a hidden chat's call should look like.
  isHiddenChat?: (chatId: unknown) => boolean;
}

// MIRRORED in clients/web/sw.js (renderNotification) — keep the logic identical; the vm test pins it.
export function renderNotification(payload: unknown, mode: unknown, hooks?: NotifyRenderHooks): NotifyRenderResult {
  const p = (payload !== null && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const kind = p.kind;
  const chatId = p.chat_id;
  let hidden = false;
  if (hooks && typeof hooks.isHiddenChat === "function") {
    try { hidden = hooks.isHiddenChat(chatId) === true; } catch (_err) { hidden = false; }
  }
  const m = hidden ? "generic" : normalizeNotifyMode(mode);
  // kind === "call" stays distinguishable in EVERY mode (incl. generic/hidden): «Входящий звонок»
  // names no one and quotes nothing, while losing the call-ness would break CLIENTS §8.3 urgency
  // (calls are urgent, renotify, and mute must not silence them) — a functional regression, not a
  // privacy gain. DEVICE_SECURITY §7 forbids names/text, which this string carries neither of.
  const isCall = kind === "call";
  const genericBody = isCall ? "Входящий звонок" : "Новое сообщение";
  // Only STRING title/body are honoured — any other shape renders as if absent (contract pin).
  const sentTitle = typeof p.title === "string" && p.title !== "" ? p.title : null;
  const sentBody = typeof p.body === "string" && p.body !== "" ? p.body : null;
  const title = m === "generic" ? "Green Chat" : sentTitle !== null ? sentTitle : "Green Chat";
  const body = m === "full" && sentBody !== null ? sentBody : genericBody;
  const options: NotifyRenderResult["options"] = {
    body,
    icon: "/icon.svg",
    badge: "/icon-maskable.svg",
    data: { chat_id: chatId, message_id: p.message_id, kind },
    renotify: isCall,
  };
  // The per-chat tag is kept in ALL modes (hidden included): it is never displayed, and dropping it
  // would break coalescing — N pushes from one chat would stack N notifications.
  if (chatId !== undefined && chatId !== null) options.tag = "gc-chat-" + String(chatId);
  return { title, options };
}
