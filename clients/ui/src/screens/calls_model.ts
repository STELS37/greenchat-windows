// clients/ui/src/screens/calls_model.ts — the pure model behind the call log (V74).
//
// Why this file exists: the server has recorded every finished call since T-202 — finalize() writes a
// service row into the pair's dialog with {status, duration_sec, video} — and FEATURES.md §M2 states
// the call log IS a selection over those rows. Nothing ever selected them: the "Calls" tab listed
// dialogs, and the timeline printed one word ("Звонок") for a 40-minute video call, a decline and a
// missed ring alike. GET /v1/calls/history now returns the real rows; this module turns one row into
// the three strings a log line needs, with no DOM and no network, so the wording is unit-testable.
//
// Wording rules (mirrors what a call log has to answer):
//   status ok        → it connected: "Входящий/Исходящий" + the duration clock
//   status missed    → nobody answered: incoming = "Пропущенный" (the alarming one), outgoing = "Нет ответа"
//   status declined  → someone hung up on purpose: I declined vs they declined are DIFFERENT facts
//   status busy      → the callee was on another call: outgoing = "Занято", incoming = missed-while-busy
//   status unknown   → a row whose meta could not be read: say "Звонок" and never invent an outcome
import type { I18n } from "../i18n.ts";
import { formatDuration } from "./media_model.ts";
import { dayKey, dayLabel } from "./feed_model.ts";

export type CallStatus = "ok" | "missed" | "declined" | "busy" | "unknown";
export type CallDirection = "in" | "out";

// The peer as a HISTORY row describes them. Deliberately a different type from call_model's CallPeer
// (the live-call peer): a log entry may describe someone who has since deleted their account, which a
// live call can never be.
export interface CallLogPeer {
  id: number;
  name: string;
  username: string | null;
  deleted?: boolean;
}

export interface CallHistoryItem {
  id: number;
  chat_id: number;
  direction: CallDirection;
  status: CallStatus;
  duration_sec: number;
  video: boolean;
  peer: CallLogPeer | null;
  created_at: number;
}

export interface CallHistoryPage {
  items: CallHistoryItem[];
  next_before: number | null;
}

export interface CallLogLine {
  // Who the call was with. A deleted account keeps its row (the call happened) under a neutral label.
  title: string;
  // What happened, e.g. "Исходящий · 1:05" / "Пропущенный".
  detail: string;
  // Local clock time of the call, e.g. "14:03".
  time: string;
  // Which direction arrow to draw; "callMissed" is reserved for the unanswered incoming case so the
  // one row a person actually looks for is findable without reading any text.
  icon: "callIn" | "callOut" | "callMissed";
  // True for an unanswered incoming call — the only row painted in the alert tone.
  missed: boolean;
  video: boolean;
}

// The outcome phrase for one row. Kept separate from describeCall so tests can pin the matrix.
export function callOutcomeText(item: CallHistoryItem, i18n: I18n): string {
  const incoming = item.direction === "in";
  switch (item.status) {
    case "ok": {
      const head = i18n.t(incoming ? "calls.logIncoming" : "calls.logOutgoing");
      // A connected call with a zero duration is possible (hang-up in the same second as the answer);
      // printing "0:00" is honest and still better than dropping the clock.
      return `${head} · ${formatDuration(item.duration_sec)}`;
    }
    case "missed":
      return i18n.t(incoming ? "calls.logMissed" : "calls.logNoAnswer");
    case "declined":
      return i18n.t(incoming ? "calls.logDeclinedByMe" : "calls.logDeclined");
    case "busy":
      return i18n.t(incoming ? "calls.logBusyMissed" : "calls.logBusy");
    default:
      return i18n.t("calls.logUnknown");
  }
}

export function peerLabel(peer: CallLogPeer | null, i18n: I18n): string {
  if (!peer) return i18n.t("calls.logUnknownPeer");
  if (peer.deleted) return i18n.t("feed.deletedAccount");
  const name = peer.name.trim();
  if (name) return name;
  return peer.username ? `@${peer.username}` : i18n.t("calls.logUnknownPeer");
}

// An unanswered incoming call — the row a call log exists to surface. A decline is deliberate, so it
// is NOT painted as an alert even though it also never connected.
export function isMissedIncoming(item: CallHistoryItem): boolean {
  return item.direction === "in" && (item.status === "missed" || item.status === "busy");
}

export function describeCall(item: CallHistoryItem, i18n: I18n): CallLogLine {
  const missed = isMissedIncoming(item);
  return {
    title: peerLabel(item.peer, i18n),
    detail: callOutcomeText(item, i18n),
    time: i18n.formatDate(item.created_at * 1000, { hour: "2-digit", minute: "2-digit" }),
    icon: missed ? "callMissed" : item.direction === "in" ? "callIn" : "callOut",
    missed,
    video: item.video,
  };
}

export interface CallDayGroup {
  key: string;
  label: string;
  items: CallHistoryItem[];
}

// Same day grouping the timeline uses (dayKey/dayLabel), so "Сегодня"/"Вчера" mean the same thing on
// both screens. Input order is preserved — the endpoint already returns newest-first.
export function groupCallsByDay(
  items: readonly CallHistoryItem[],
  nowSec: number,
  i18n: I18n,
): CallDayGroup[] {
  const out: CallDayGroup[] = [];
  for (const item of items) {
    const key = dayKey(item.created_at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: dayLabel(item.created_at, nowSec, i18n), items: [item] });
  }
  return out;
}

// How many unanswered incoming calls the log holds — the count the tab badge and the summary line use.
export function missedCount(items: readonly CallHistoryItem[]): number {
  let n = 0;
  for (const item of items) if (isMissedIncoming(item)) n += 1;
  return n;
}

// Defensive parse of GET /v1/calls/history: a screen must not crash on an unexpected payload, and a
// row without a usable id/timestamp is dropped rather than rendered as a blank line.
export function parseCallHistory(raw: unknown): CallHistoryPage {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(source.items) ? source.items : [];
  const items: CallHistoryItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = Number(row.id);
    const createdAt = Number(row.created_at);
    if (!Number.isFinite(id) || !Number.isFinite(createdAt)) continue;
    const status = row.status;
    const peerRaw = row.peer && typeof row.peer === "object" ? (row.peer as Record<string, unknown>) : null;
    items.push({
      id,
      chat_id: Number(row.chat_id) || 0,
      direction: row.direction === "out" ? "out" : "in",
      status:
        status === "ok" || status === "missed" || status === "declined" || status === "busy"
          ? status
          : "unknown",
      duration_sec: Number.isFinite(Number(row.duration_sec)) ? Math.max(0, Math.floor(Number(row.duration_sec))) : 0,
      video: row.video === true,
      peer: peerRaw
        ? {
            id: Number(peerRaw.id) || 0,
            name: typeof peerRaw.name === "string" ? peerRaw.name : "",
            username: typeof peerRaw.username === "string" ? peerRaw.username : null,
            deleted: peerRaw.deleted === true,
          }
        : null,
      created_at: Math.floor(createdAt),
    });
  }
  const cursor = Number(source.next_before);
  return { items, next_before: Number.isFinite(cursor) && cursor > 0 ? cursor : null };
}
