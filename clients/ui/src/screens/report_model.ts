// clients/ui/src/screens/report_model.ts — T-514 (MS-4 / T-113): pure, DOM-free model for the abuse-report
// flow that the support overlay's "Пожаловаться на пользователя или контент" link hands off to (SUPPORT.md
// §3.2/§12). A report is NOT a support ticket: it POSTs /v1/report into the separate moderation table.
//
// The reasons enum + comment cap mirror the server contract (modules/reports.ts). Assembling the exact wire
// payload and resolving an exact @username from a global-search result live here so they are unit-testable
// without a browser (the thin report_overlay.ts renders them).
import type { I18n } from "../i18n.ts";
import type { ReportKind, ReportReason, ReportPayload, SearchUser, GlobalSearchResult } from "./api.ts";

// The closed reason set the server accepts (spam / abuse / csam / other). Order = radio order.
export const REPORT_REASONS: readonly ReportReason[] = ["spam", "abuse", "csam", "other"] as const;
// The server caps comment at 500 chars (COMMENT_MAX in reports.ts); clamp locally so the preview is honest.
export const REPORT_COMMENT_MAX = 500;

export interface ReportDraft {
  reason: ReportReason;
  comment: string;
}

export function reasonLabel(i18n: I18n, reason: string): string {
  return i18n.t(`report.reason.${reason}`);
}

// Assemble the POST /v1/report body. comment is trimmed + capped and OMITTED when empty (the server treats
// an absent comment as none), matching exactOptionalPropertyTypes (never assign `undefined`).
export function buildReportPayload(kind: ReportKind, targetId: number, draft: ReportDraft): ReportPayload {
  const payload: ReportPayload = { kind, target_id: targetId, reason: draft.reason };
  const comment = draft.comment.trim().slice(0, REPORT_COMMENT_MAX);
  if (comment) payload.comment = comment;
  return payload;
}

// Strip a leading "@" (and surrounding space) so "@Alice" and "alice" resolve alike.
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

// Find the EXACT-username match (case-insensitive) in a global-search result. A report needs a concrete
// target_id, so a fuzzy/substring hit is deliberately NOT accepted — only "@name is exactly this user".
export function pickUserByUsername(res: GlobalSearchResult, raw: string): SearchUser | null {
  const q = normalizeUsername(raw).toLowerCase();
  if (!q) return null;
  for (const u of res.users) if (typeof u.username === "string" && u.username.toLowerCase() === q) return u;
  return null;
}
