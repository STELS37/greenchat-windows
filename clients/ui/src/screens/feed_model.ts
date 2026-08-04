// clients/ui/src/screens/feed_model.ts — pure view-model for the message feed (T-406).
// DOM-free algebra the feed screen renders from: list merge/dedupe (history pages arrive DESC for
// before_id / newest, ASC for after_id — we normalise everything to ascending-by-id), optimistic
// reconciliation, reaction folding, Outbox status ticks, @mention parsing, the edit window, day
// separators and the history query builder. Every branch here is unit-tested (feed_model.test.ts);
// the screen owns only the DOM.
import type { I18n } from "../i18n.ts";
import type { Message, MsgReaction, ChatMember, MsgSender } from "./types.ts";

// ---------------------------------------------------------------------------
// list algebra — the loaded window is always kept sorted ascending by id.
// ---------------------------------------------------------------------------

// Ascending by id (server ids are monotonic); a stable tiebreak keeps equal-id rows deterministic.
export function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => a.id - b.id);
}

// Merge a freshly-fetched/received page into the loaded window, de-duplicating by id (the incoming
// copy wins — it is the fresher serialization), result sorted ascending. Direction-agnostic, so it
// serves the newest page, a before_id prepend and an after_id append identically.
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<number, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return sortMessages([...byId.values()]);
}

// Fold a single message.new / message.edit into the window (upsert by id).
export function upsertMessage(list: Message[], msg: Message): Message[] {
  return mergeMessages(list, [msg]);
}

// A message.delete tombstones the row in place (the bubble becomes "message deleted") — keeping it
// preserves surrounding ordering and any reply that quotes it, mirroring the server tombstone.
export function applyDelete(list: Message[], messageId: number): Message[] {
  return list.map((m) => (m.id === messageId ? { ...m, deleted: true } : m));
}

// Drop a row entirely (used for "delete for me" / optimistic removal that must not leave a tombstone).
export function removeMessage(list: Message[], messageId: number): Message[] {
  return list.filter((m) => m.id !== messageId);
}

// Apply a reaction.update broadcast: it carries only {emoji,count} (the per-viewer `me` is stripped
// server-side), so preserve this viewer's existing `me` flags while replacing the counts. Empty
// buckets are dropped; the result is ordered by count desc (the server's own order).
export function applyReactionUpdate(
  list: Message[],
  messageId: number,
  incoming: Array<{ emoji: string; count: number }>,
): Message[] {
  return list.map((m) => {
    if (m.id !== messageId) return m;
    const mine = new Map<string, boolean>();
    for (const r of m.reactions ?? []) mine.set(r.emoji, r.me);
    const reactions: MsgReaction[] = incoming
      .filter((r) => r.count > 0)
      .map((r) => ({ emoji: r.emoji, count: r.count, me: mine.get(r.emoji) ?? false }))
      .sort((a, b) => b.count - a.count);
    return { ...m, reactions };
  });
}

// Optimistic local toggle for the actor before the server round-trips: flip `me`, adjust the count,
// drop a bucket that hits zero, add a new bucket for a first reaction. Ordered by count desc.
export function toggleReaction(reactions: MsgReaction[] | undefined, emoji: string): MsgReaction[] {
  const next = (reactions ?? []).map((r) => ({ ...r }));
  const idx = next.findIndex((r) => r.emoji === emoji);
  if (idx < 0) {
    next.push({ emoji, count: 1, me: true });
  } else {
    const bucket = next[idx]!;
    if (bucket.me) {
      bucket.count -= 1;
      bucket.me = false;
      if (bucket.count <= 0) next.splice(idx, 1);
    } else {
      bucket.count += 1;
      bucket.me = true;
    }
  }
  return next.sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// pagination — before_id / after_id / newest, plus a bounded retained window.
// ---------------------------------------------------------------------------

export interface HistoryQuery {
  before_id?: number;
  after_id?: number;
  limit: number;
}

// GET /v1/chats/:id/messages — before_id OR after_id (never both), else the newest page.
export function historyPath(chatId: number, q: HistoryQuery): string {
  const p = new URLSearchParams();
  if (q.before_id !== undefined) p.set("before_id", String(q.before_id));
  else if (q.after_id !== undefined) p.set("after_id", String(q.after_id));
  p.set("limit", String(q.limit));
  return `/v1/chats/${chatId}/messages?${p.toString()}`;
}

export function oldestId(list: Message[]): number | null {
  return list.length > 0 ? list[0]!.id : null;
}

export function newestId(list: Message[]): number | null {
  return list.length > 0 ? list[list.length - 1]!.id : null;
}

// Keep the DOM bounded: after merging a page, retain at most `max` messages from the side we are
// scrolled toward ("bottom" keeps the newest, "top" keeps the oldest). Trimming the far end lets the
// feed page indefinitely without unbounded nodes — the trimmed side reloads on scroll-back.
export function trimWindow(list: Message[], max: number, keep: "top" | "bottom"): Message[] {
  if (list.length <= max) return list;
  return keep === "bottom" ? list.slice(list.length - max) : list.slice(0, max);
}

// ---------------------------------------------------------------------------
// Outbox status ticks (часики / галка / failed+retry).
// ---------------------------------------------------------------------------

export type Tick = "clock" | "check" | "failed";

export function tickFor(status: "queued" | "sending" | "sent" | "failed"): Tick {
  if (status === "failed") return "failed";
  if (status === "sent") return "check";
  return "clock"; // queued (inside the undo window) or in-flight
}

export function tickGlyph(t: Tick): string {
  return t === "check" ? "✓" : t === "failed" ? "⚠" : "🕓";
}

// Server-authoritative message receipt for an already stored outgoing message. Read wins over
// delivered, and invalid/stale cursor values degrade to the single stored check rather than lying.
export type MessageReceipt = "sent" | "delivered" | "read";

const positiveSafeCursor = (raw: number): number =>
  Number.isSafeInteger(raw) && raw > 0 ? raw : 0;

export function receiptForMessage(
  messageId: number,
  deliveredUpToMessageId: number,
  readUpToMessageId: number,
): MessageReceipt {
  const id = positiveSafeCursor(messageId);
  if (id === 0) return "sent";
  if (positiveSafeCursor(readUpToMessageId) >= id) return "read";
  if (positiveSafeCursor(deliveredUpToMessageId) >= id) return "delivered";
  return "sent";
}

export function receiptGlyph(receipt: MessageReceipt): string {
  return receipt === "sent" ? "✓" : "✓✓";
}

// ---------------------------------------------------------------------------
// bubble view — the flat strings a message bubble paints.
// ---------------------------------------------------------------------------

const MEDIA_KIND_KEYS: Record<string, string> = {
  photo: "chat.kindPhoto",
  video: "chat.kindVideo",
  voice: "chat.kindVoice",
  file: "chat.kindFile",
  sticker: "chat.kindSticker",
  system: "chat.kindSystem",
};

// Localised line for a kind="service" timeline row. Two label sets exist for the same events: the
// anonymous one below ("Участник присоединился") and the named one further down ("Иван присоединился").
// The anonymous set stays the fallback for rows the server could not attribute (a deleted account, an
// anonymous admin, a chat created by the system) and for the chat-list preview, where the row is one
// line of text next to the chat title and the actor's name is already visible above it.
const SERVICE_EVENT_KEYS: Record<string, string> = {
  group_created: "feed.svcGroupCreated",
  member_joined: "feed.svcMemberJoined",
  member_left: "feed.svcMemberLeft",
  title_changed: "feed.svcTitleChanged",
  photo_changed: "feed.svcPhotoChanged",
  pinned_message: "feed.svcPinned",
  call: "feed.svcCall",
  envelope: "feed.svcEnvelope",
  invoice: "feed.svcInvoice",
};

// The named variant of the same events. postService() stores the actor in messages.sender_id and the
// serialiser returns it as `sender`, so the chip can say WHO acted — the way every messenger writes it.
// Only events with one meaningful actor are listed; a call/envelope/invoice row carries its own wording.
const SERVICE_ACTOR_KEYS: Record<string, string> = {
  group_created: "feed.svcGroupCreatedBy",
  member_joined: "feed.svcMemberJoinedBy",
  member_left: "feed.svcMemberLeftBy",
  title_changed: "feed.svcTitleChangedBy",
  photo_changed: "feed.svcPhotoChangedBy",
  pinned_message: "feed.svcPinnedBy",
};

// Events whose consecutive rows fold into ONE chip that lists the actors. Creating a group posts one
// member_joined per invitee (chats.ts), so a six-person group opened with six identical chips stacked
// above the first real message — the single ugliest thing in the timeline.
const SERVICE_RUN_KEYS: Record<string, string> = {
  member_joined: "feed.svcMemberJoinedMany",
  member_left: "feed.svcMemberLeftMany",
};

const LOCALE_TAGS: Record<string, string> = { ru: "ru-RU", en: "en-US" };

// A service row renders as a centered chip (like the day separator), not a bubble.
export function isServiceMessage(msg: Message): boolean {
  return msg.kind === "service";
}

// The actor's display name, or "" when the row is unattributed. A live `message.new` frame carries the
// actor as a bare id (postService emits `sender: actorId`), and a tombstone/anonymous sender has no
// name — both must degrade to the anonymous wording rather than print "undefined".
export function serviceActorName(msg: Message): string {
  const sender: unknown = msg.sender;
  if (!sender || typeof sender !== "object" || !("username" in sender)) return "";
  const name = (sender as { name?: unknown }).name;
  return typeof name === "string" ? name.trim() : "";
}

// Non-null when this row may be folded with its neighbours: the event repeats per person AND the row
// knows the person. Returns the event id, so a run only groups identical events.
export function serviceFoldKey(msg: Message): string | null {
  if (msg.deleted || !isServiceMessage(msg)) return null;
  const ev = typeof msg.service_event === "string" ? msg.service_event : "";
  if (!SERVICE_RUN_KEYS[ev]) return null;
  return serviceActorName(msg) ? ev : null;
}

// "Иван" · "Иван и Пётр" · "Иван, Пётр и Мария" · "Иван, Пётр, Мария и ещё 4". Intl.ListFormat owns the
// conjunction for the locale; the plural tail keeps a long run on one line.
export function nameList(names: readonly string[], i18n: I18n, maxNamed = 3): string {
  const unique = [...new Set(names.filter((n) => n.length > 0))];
  const shown = unique.slice(0, maxNamed);
  const rest = unique.length - shown.length;
  const parts = rest > 0 ? [...shown, i18n.t("feed.svcNameAndMore", { count: rest })] : shown;
  const ListFormat = (Intl as { ListFormat?: typeof Intl.ListFormat }).ListFormat;
  if (parts.length < 2 || !ListFormat) return parts.join(", ");
  return new ListFormat(LOCALE_TAGS[i18n.locale] ?? i18n.locale, { style: "long", type: "conjunction" }).format(parts);
}

// Shared by the timeline and by the chat-list preview (chat_model.ts): both must name the same event
// with the same wording, so the map has exactly one owner.
export function serviceEventLabel(event: unknown, i18n: I18n): string {
  const ev = typeof event === "string" ? event : "";
  const key = SERVICE_EVENT_KEYS[ev];
  return i18n.t(key ?? "feed.svcGeneric");
}

export function serviceText(msg: Message, i18n: I18n): string {
  if (msg.deleted) return i18n.t("feed.deleted");
  const ev = typeof msg.service_event === "string" ? msg.service_event : "";
  const actor = serviceActorName(msg);
  const namedKey = SERVICE_ACTOR_KEYS[ev];
  if (actor && namedKey) return i18n.t(namedKey, { name: actor });
  return serviceEventLabel(msg.service_event, i18n);
}

// One chip for a folded run of identical events (see serviceFoldKey). A single-row "run" is just the
// ordinary named line, so the caller never needs to branch.
export function serviceRunText(run: readonly Message[], i18n: I18n): string {
  const head = run[0];
  if (!head) return "";
  if (run.length < 2) return serviceText(head, i18n);
  const ev = typeof head.service_event === "string" ? head.service_event : "";
  const key = SERVICE_RUN_KEYS[ev];
  const names = run.map(serviceActorName).filter((n) => n.length > 0);
  if (!key || names.length < 2) return serviceText(head, i18n);
  return i18n.t(key, { names: nameList(names, i18n) });
}

// True when the message was written by the viewer (a real authored message, not an anonymous-admin or
// deleted-account tombstone) — drives right-alignment and the delivery tick.
export function isMine(sender: MsgSender | undefined, selfId: number): boolean {
  return !!sender && "username" in sender && sender.id === selfId;
}

// The author label: real name, a localised "Deleted account", a localised "Anonymous", or "" for a
// service/system line with no sender.
export function senderName(sender: MsgSender | undefined, i18n: I18n): string {
  if (!sender) return "";
  if ("username" in sender) return sender.name;
  if ("deleted" in sender) return i18n.t("feed.deletedAccount");
  return i18n.t("feed.anonymous");
}

// The body text: the tombstone for a deleted message, the caption/text when present, else a localised
// media label (Photo / Video / …), else the raw kind.
export function messageBody(msg: Message, i18n: I18n): string {
  if (msg.deleted) return i18n.t("feed.deleted");
  const text = typeof msg.text === "string" ? msg.text : "";
  if (text.length > 0) return text;
  const kind = msg.kind ?? "text";
  if (kind === "text") return "";
  const key = MEDIA_KIND_KEYS[kind];
  return key ? i18n.t(key) : kind;
}

// Short clock label (HH:MM) for a bubble; empty when the row carries no timestamp (optimistic).
export function timeLabel(tsSec: number | undefined, i18n: I18n): string {
  if (!tsSec) return "";
  return i18n.formatDate(tsSec * 1000, { hour: "2-digit", minute: "2-digit" });
}

export interface BubbleView {
  id: number;
  mine: boolean;
  deleted: boolean;
  author: string;
  body: string;
  time: string;
  edited: boolean;
  reactions: MsgReaction[];
  reply?: { id: number; text: string };
  forwarded?: string;
}

export function bubbleView(msg: Message, selfId: number, i18n: I18n): BubbleView {
  const mine = isMine(msg.sender, selfId);
  const reply =
    msg.reply_to && typeof msg.reply_to.id === "number"
      ? { id: msg.reply_to.id, text: msg.reply_to.text || i18n.t("feed.replyUnavailable") }
      : undefined;
  const fwdName = typeof msg.forward_from_name === "string" ? msg.forward_from_name : null;
  const forwarded = fwdName ? i18n.t("feed.forwardedFrom", { name: fwdName }) : undefined;
  return {
    id: msg.id,
    mine,
    deleted: !!msg.deleted,
    author: senderName(msg.sender, i18n),
    body: messageBody(msg, i18n),
    time: timeLabel(msg.created_at, i18n),
    edited: !msg.deleted && !!msg.edited_at,
    reactions: msg.reactions ?? [],
    ...(reply ? { reply } : {}),
    ...(forwarded ? { forwarded } : {}),
  };
}

// ---------------------------------------------------------------------------
// edit window — a text edit is allowed to the author within EDIT_WINDOW_SEC.
// ---------------------------------------------------------------------------

export function canEdit(msg: Message, selfId: number, nowSec: number, windowSec: number): boolean {
  if (msg.deleted) return false;
  if (!isMine(msg.sender, selfId)) return false;
  if (typeof msg.created_at !== "number") return true; // optimistic, still local
  return nowSec - msg.created_at <= windowSec;
}

// ---------------------------------------------------------------------------
// cross-device drafts — decide whether a targeted draft.update may touch this composer.
// ---------------------------------------------------------------------------

export interface RemoteDraftDecision {
  apply: boolean;
  text: string;
}

// While the user is typing locally, their live text wins over the server echo. Once the composer is
// inactive, both server clear forms (`null` and an empty string) must erase a stale draft left by
// another device; absent or malformed payloads are ignored.
export function remoteDraftDecision(draft: unknown, composerActive: boolean): RemoteDraftDecision {
  if (composerActive) return { apply: false, text: "" };
  if (draft === null) return { apply: true, text: "" };
  if (typeof draft === "string") return { apply: true, text: draft };
  return { apply: false, text: "" };
}

// ---------------------------------------------------------------------------
// @mentions — parse the token under the caret and filter the roster.
// ---------------------------------------------------------------------------

export interface MentionQuery {
  active: boolean;
  query: string; // the text after '@', may be empty just after typing '@'
  start: number; // index of '@'
  end: number; // caret position (exclusive)
}

const NO_MENTION: MentionQuery = { active: false, query: "", start: -1, end: -1 };

// A mention is active when the caret sits at the end of a run [A-Za-z0-9_]* that is immediately
// preceded by '@', and that '@' is at the start of the text or follows whitespace (never mid-word).
export function parseMention(text: string, caret: number): MentionQuery {
  let i = caret;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]!)) i -= 1;
  if (i === 0 || text[i - 1] !== "@") return NO_MENTION;
  const at = i - 1;
  if (at > 0 && !/\s/.test(text[at - 1]!)) return NO_MENTION;
  return { active: true, query: text.slice(i, caret), start: at, end: caret };
}

// Members whose username or name matches the (case-insensitive) query prefix/substring, capped.
export function filterMembers(members: ChatMember[], query: string, limit: number): ChatMember[] {
  const q = query.toLowerCase();
  const hits = members.filter(
    (m) => m.username.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
  );
  return hits.slice(0, limit);
}

// Replace the '@query' token with '@username ' and return the new text + caret position.
export function applyMention(
  text: string,
  mq: MentionQuery,
  username: string,
): { text: string; caret: number } {
  const before = text.slice(0, mq.start);
  const after = text.slice(mq.end);
  const insert = `@${username} `;
  return { text: before + insert + after, caret: before.length + insert.length };
}

// ---------------------------------------------------------------------------
// day separators.
// ---------------------------------------------------------------------------

// A stable calendar-day key (local time) for grouping — messages share a separator iff keys match.
export function dayKey(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// The separator label: "Today" / "Yesterday" for the two most recent days, else a localised date.
export function dayLabel(tsSec: number, nowSec: number, i18n: I18n): string {
  const key = dayKey(tsSec);
  if (key === dayKey(nowSec)) return i18n.t("feed.today");
  if (key === dayKey(nowSec - 86400)) return i18n.t("feed.yesterday");
  return i18n.formatDate(tsSec * 1000, { day: "2-digit", month: "long", year: "numeric" });
}

// ---------------------------------------------------------------------------
// presence (V7).
// ---------------------------------------------------------------------------

// The server has always broadcast `presence.update {user_id, online, last_seen}` over the WebSocket and
// serves `last_seen` on the public profile, where an exact timestamp is replaced by the string
// "recently" when the owner's privacy setting hides it. No client screen consumed either, so a 1:1
// conversation header showed the constant string "Личный чат" forever — the one line every messenger
// uses for "online / last seen at 12:30". This is the pure formatter for that line.
export interface PresenceState {
  online: boolean;
  // number = exact unix seconds; "recently" = privacy-blurred; null = not known yet.
  lastSeen: number | "recently" | null;
}

export function presenceLabel(state: PresenceState, nowSec: number, i18n: I18n): string | null {
  if (state.online) return i18n.t("chat.online");
  if (state.lastSeen === null) return null;
  if (state.lastSeen === "recently") return i18n.t("chat.lastSeenRecently");
  const seen = state.lastSeen;
  // V163: `last_seen_at` is 0 for an account that never opened a session — the server's "never"
  // sentinel, not a moment in time (server/src/modules/users.ts::lastSeenFor returns the raw column,
  // and server/src/modules/account.ts skips rows with 0 for exactly this reason). Measured live:
  // GET /v1/users/59 -> {"last_seen":0} rendered as "был(а) в сети 01.01.1970" — the Unix epoch,
  // 20 668 days before the reading. A sentinel is the absence of knowledge, so it reads like an
  // unknown timestamp (no line at all) and the kind label stays.
  if (seen <= 0) return null;
  // A clock that has drifted forward (or a timestamp written during the same second) must not produce
  // "last seen in 3 seconds"; anything not in the past reads as the freshest bucket.
  const delta = nowSec - seen;
  if (delta < 60) return i18n.t("chat.lastSeenJustNow");
  if (delta < 3600) {
    const minutes = Math.max(1, Math.floor(delta / 60));
    return i18n.t("chat.lastSeenMinutes", { count: String(minutes) });
  }
  const time = i18n.formatDate(seen * 1000, { hour: "2-digit", minute: "2-digit" });
  if (dayKey(seen) === dayKey(nowSec)) return i18n.t("chat.lastSeenAt", { time });
  if (dayKey(seen) === dayKey(nowSec - 86400)) return i18n.t("chat.lastSeenYesterday", { time });
  const date = i18n.formatDate(seen * 1000, { day: "2-digit", month: "2-digit", year: "numeric" });
  return i18n.t("chat.lastSeenOn", { date });
}

// True when a day separator should be inserted before `msg` given the previous rendered message.
export function needsDaySeparator(prev: Message | null, msg: Message): boolean {
  if (typeof msg.created_at !== "number") return false;
  if (!prev || typeof prev.created_at !== "number") return true;
  return dayKey(prev.created_at) !== dayKey(msg.created_at);
}
