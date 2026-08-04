// clients/ui/src/screens/chat_model.ts — pure view-model for the chat list (T-405, T-019).
// Turns a server ChatListEntry into the flat strings the row renderer paints: a message preview, a
// short timestamp, the unread badge, and the pin/mute/archive flags. Kept DOM-free so the row logic is
// unit-tested (the server already sorts pinned-first then most-recent; the client only filters+formats).
import type { I18n } from "../i18n.ts";
import type { ChatEntry } from "./types.ts";
import { serviceEventLabel } from "./feed_model.ts";

export type ChatTab = "all" | "archived";

// The main list hides archived chats; the archive tab shows only them (mirrors GET /v1/chats?filter=).
export function filterChats(entries: ChatEntry[], tab: ChatTab): ChatEntry[] {
  return entries.filter((c) => (tab === "archived" ? c.archived : !c.archived));
}

// muted_until is an absolute unix-seconds deadline (0 = never); a chat is muted while it is in the future.
export function mutedNow(entry: ChatEntry, nowSec: number): boolean {
  return entry.muted_until > nowSec;
}

// Unread badge text: empty when zero, capped so a runaway count cannot break the layout.
export function formatUnread(count: number): string {
  if (count <= 0) return "";
  return count > 999 ? "999+" : String(count);
}

const KIND_KEYS: Record<string, string> = {
  photo: "chat.kindPhoto",
  video: "chat.kindVideo",
  voice: "chat.kindVoice",
  file: "chat.kindFile",
  sticker: "chat.kindSticker",
  system: "chat.kindSystem",
  service: "chat.kindService",
};

// Who spoke last, as the prefix every messenger puts in front of a group preview ("Аня: привет").
// Own messages read "Вы:" in ANY chat kind, including a dialog: without it the list cannot distinguish
// "they answered me" from "I am still waiting", which is exactly what the user scans the list for.
// Returns "" when there is nothing honest to print (no author, a service row, or a peer's message in a
// dialog where the title already names them).
function previewAuthor(entry: ChatEntry, i18n: I18n, self?: SelfRef): string {
  const m = entry.last_message;
  if (!m || m.kind === "service") return "";
  if (self && m.sender_id === self.id) return i18n.t("chat.previewYou");
  if (entry.kind === "dialog") return "";
  return m.sender_name ? m.sender_name : "";
}

// The one-line preview under the title: the text for a text message, otherwise a localised media label.
export function messagePreview(entry: ChatEntry, i18n: I18n, self?: SelfRef): string {
  const author = previewAuthor(entry, i18n, self);
  const body = messageBody(entry, i18n);
  return author ? `${author}: ${body}` : body;
}

function messageBody(entry: ChatEntry, i18n: I18n): string {
  const m = entry.last_message;
  if (!m) return i18n.t("chat.noMessages");
  if (m.kind !== "text") {
    // A service row keeps its meaning in service_event, not in text. Falling straight through to the
    // generic "Служебное сообщение" label made every pin, join, rename and call look identical in the
    // list, which is the one place the user decides what happened without opening the chat.
    if (m.kind === "service") return serviceEventLabel(m.service_event, i18n);
    const key = KIND_KEYS[m.kind];
    return key ? i18n.t(key) : m.kind;
  }
  return m.text;
}

// Short right-aligned time: HH:MM for today, DD.MM otherwise (locale-formatted via Intl).
export function timeLabel(entry: ChatEntry, nowSec: number, i18n: I18n): string {
  const m = entry.last_message;
  const ts = m ? m.created_at : entry.updated_at;
  if (!ts) return "";
  const ms = ts * 1000;
  const sameDay = new Date(ms).toDateString() === new Date(nowSec * 1000).toDateString();
  return sameDay
    ? i18n.formatDate(ms, { hour: "2-digit", minute: "2-digit" })
    : i18n.formatDate(ms, { day: "2-digit", month: "2-digit" });
}

export interface ChatRowView {
  id: number;
  title: string;
  subtitle: string;
  time: string;
  unread: number;
  unreadLabel: string;
  muted: boolean;
  pinned: boolean;
  archived: boolean;
  isSelf: boolean; // T-427: the Saved-Messages self-dialog (bookmark avatar + localized title)
}

// T-427: the signed-in user's own identity, enough to recognise their self-dialog.
export interface SelfRef {
  id: number;
  name: string;
  username: string;
}

// T-427: is this the viewer's own "Saved Messages" dialog? The wire carries no peer id, so we detect
// it exactly as the server labels it (server chatTitle): a dialog whose title equals the viewer's own
// display label (name, or username when name is blank). Without `self` we can't tell → false.
export function isSelfDialog(entry: { kind: string; title: string }, self: SelfRef | undefined): boolean {
  if (!self || entry.kind !== "dialog") return false;
  const label = self.name || self.username;
  return label.length > 0 && entry.title === label;
}

export function chatRowView(entry: ChatEntry, nowSec: number, i18n: I18n, self?: SelfRef): ChatRowView {
  const selfDialog = isSelfDialog(entry, self);
  const baseTitle = selfDialog ? i18n.t("chat.savedMessages") : entry.title;
  return {
    id: entry.id,
    title: entry.peer_is_bot && !selfDialog ? `${baseTitle} · ${i18n.t("chat.botBadge")}` : baseTitle,
    subtitle: messagePreview(entry, i18n, self),
    time: timeLabel(entry, nowSec, i18n),
    unread: entry.unread_count,
    unreadLabel: formatUnread(entry.unread_count),
    muted: mutedNow(entry, nowSec),
    pinned: entry.pinned,
    archived: entry.archived,
    isSelf: selfDialog,
  };
}

// ---- live list patching (T-424) -------------------------------------------------------------------
// The chat list must react to the SyncEngine event stream without a full refetch on every event. These
// pure helpers own the "what changes" decision; the screen owns the DOM + the coalesced refetch fallback.

// Sort like the server's GET /v1/chats: pinned chats first, then most-recently-active (by the last
// message time, falling back to updated_at). Stable for equal keys so unrelated rows don't jitter.
export function sortChats(entries: ChatEntry[]): ChatEntry[] {
  const key = (c: ChatEntry): number => c.last_message?.created_at ?? c.updated_at ?? 0;
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return key(b) - key(a);
  });
}

// T-426: slot a just-opened/created dialog into the list. Inserts a new row, or merges into the
// existing one (preserving its richer server preview when ours is empty), then re-sorts. Pure; used so
// a brand-new chat appears in the list immediately without waiting for a full refetch.
export function upsertChat(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const idx = entries.findIndex((c) => c.id === entry.id);
  if (idx < 0) return sortChats([entry, ...entries]);
  const prev = entries[idx]!;
  const merged: ChatEntry = { ...prev, ...entry, last_message: entry.last_message ?? prev.last_message };
  const copy = [...entries];
  copy[idx] = merged;
  return sortChats(copy);
}

// T-426: build a list row from POST /v1/chats/dialog's chat detail. The detail lacks the list-only
// fields (last_message/unread/settings/draft), so they default empty — the next GET /v1/chats refresh
// fills the real values. Structural param (no import of DialogChat) to keep this model dependency-free.
export function dialogToEntry(
  chat: {
    id: number;
    kind: string;
    title: string;
    username?: string | null;
    peer_is_bot?: boolean;
    my_role?: string;
    message_ttl_sec?: number;
    updated_at?: number;
  },
  nowSec: number,
): ChatEntry {
  return {
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    username: chat.username ?? null,
    photo_file_id: null,
    peer_is_bot: chat.peer_is_bot === true,
    last_message: null,
    unread_count: 0,
    muted_until: 0,
    pinned: false,
    archived: false,
    my_role: chat.my_role ?? "member",
    message_ttl_sec: chat.message_ttl_sec ?? 0,
    draft: null,
    updated_at: chat.updated_at ?? nowSec,
  };
}

// The minimal SyncEngine event this layer understands: a type plus an opaque payload.
export interface ListEvent {
  type: string;
  payload: unknown;
}

export interface ListPatchContext {
  selfId: number; // the signed-in user — their own messages must not raise the unread count
  openChatId?: number | null; // the chat currently open (if any) — a message there is read immediately
}

export interface ListPatchResult {
  entries: ChatEntry[];
  changed: boolean; // did the rows actually change (skip a needless repaint otherwise)
  refetch: boolean; // the event needs data we can't synthesise locally → ask the screen to reload (coalesced)
}

// The shape of a `message.new` / `message.edit` payload we can read (a full server Message).
interface EventMessage {
  id: number;
  chat_id: number;
  sender?: { id: number } | null;
  kind?: string;
  text?: string;
  created_at?: number;
}

function readMessage(payload: unknown): EventMessage | null {
  const p = payload as { message?: EventMessage };
  const m = p.message;
  if (m && typeof m.id === "number" && typeof m.chat_id === "number") return m;
  return null;
}

// Fold one event into the list. Returns the (possibly new) array plus flags. Never mutates the input.
export function applyListEvent(entries: ChatEntry[], evt: ListEvent, ctx: ListPatchContext): ListPatchResult {
  const none: ListPatchResult = { entries, changed: false, refetch: false };
  switch (evt.type) {
    case "message.new":
    case "message.edit": {
      const m = readMessage(evt.payload);
      if (!m) return none;
      const idx = entries.findIndex((c) => c.id === m.chat_id);
      // A message for a chat we don't have a row for yet = a brand-new dialog → let the screen refetch it
      // (we can't invent its title/kind/role locally).
      if (idx < 0) return { entries, changed: false, refetch: true };
      const prev = entries[idx]!;
      // Only the NEWEST message updates the preview/order (a late edit of an older message must not rewind).
      const prevTop = prev.last_message?.id ?? 0;
      const isNewest = m.id >= prevTop;
      const last = isNewest
        ? {
            id: m.id,
            sender_id: m.sender?.id ?? null,
            kind: m.kind ?? "text",
            text: m.text ?? "",
            created_at: m.created_at ?? prev.updated_at,
          }
        : prev.last_message;
      const fromSelf = m.sender?.id === ctx.selfId;
      const isOpen = ctx.openChatId != null && ctx.openChatId === m.chat_id;
      // A genuinely NEW incoming message (not mine, not the open chat, actually the newest) bumps unread.
      const raiseUnread = evt.type === "message.new" && isNewest && !fromSelf && !isOpen;
      const next: ChatEntry = {
        ...prev,
        ...(last ? { last_message: last } : {}),
        ...(isNewest ? { updated_at: m.created_at ?? prev.updated_at } : {}),
        unread_count: raiseUnread ? prev.unread_count + 1 : prev.unread_count,
      };
      const copy = [...entries];
      copy[idx] = next;
      return { entries: sortChats(copy), changed: true, refetch: false };
    }
    case "message.delete": {
      const p = evt.payload as { chat_id?: number; message_id?: number };
      const idx = typeof p.chat_id === "number" ? entries.findIndex((c) => c.id === p.chat_id) : -1;
      if (idx < 0) return none;
      // If the deleted message was the row's preview, we can't recompute the new preview locally → refetch.
      if (entries[idx]!.last_message?.id === p.message_id) return { entries, changed: false, refetch: true };
      return none;
    }
    case "chat.read": {
      // The user read a chat (here or another device): clear its unread badge.
      const p = evt.payload as { chat_id?: number };
      const idx = typeof p.chat_id === "number" ? entries.findIndex((c) => c.id === p.chat_id) : -1;
      if (idx < 0 || entries[idx]!.unread_count === 0) return none;
      const copy = [...entries];
      copy[idx] = { ...copy[idx]!, unread_count: 0 };
      return { entries: copy, changed: true, refetch: false };
    }
    case "chat.update": {
      // A settings change (pin / mute / archive) — merge the known fields and re-sort (pin can reorder).
      const p = evt.payload as { chat_id?: number } & Record<string, unknown>;
      const idx = typeof p.chat_id === "number" ? entries.findIndex((c) => c.id === p.chat_id) : -1;
      if (idx < 0) return none;
      const prev = entries[idx]!;
      const merged: ChatEntry = {
        ...prev,
        ...(typeof p.pinned === "boolean" ? { pinned: p.pinned } : {}),
        ...(typeof p.archived === "boolean" ? { archived: p.archived } : {}),
        ...(typeof p.muted_until === "number" ? { muted_until: p.muted_until } : {}),
      };
      const copy = [...entries];
      copy[idx] = merged;
      return { entries: sortChats(copy), changed: true, refetch: false };
    }
    case "chat.new":
      // A dialog/group we've just been added to — we have no row data, so refetch (coalesced).
      return { entries, changed: false, refetch: true };
    default:
      return none;
  }
}

// The event types the chat list cares about — the screen only refetches/patches on these.
export const LIST_EVENTS: ReadonlySet<string> = new Set([
  "message.new",
  "message.edit",
  "message.delete",
  "chat.read",
  "chat.update",
  "chat.new",
]);
