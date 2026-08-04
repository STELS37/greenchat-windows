// clients/ui/src/screens/support_model.ts — T-512 (MS-2): pure, DOM-free model for the support form.
//
// Validation of the draft, assembly of the EXACT wire payload, and the "посмотреть, что уйдёт" preview
// string live here so they are unit-testable without a DOM (the thin support_overlay.ts renders them).
//
// Privacy invariant (§3.2): the preview is the byte-for-byte JSON that will be POSTed. Auto-fields
// (category/screen/app_version/platform) ride OUTSIDE the "attach diagnostics" checkbox; only the
// `diagnostics` blob is gated by it. The diagnostics object is ALREADY redacted by the diag buffer
// (R1–R7 at write time) — this model never inspects or transforms it, it only includes or omits it.
import type { I18n } from "../i18n.ts";
import type { SupportCategory, SupportTicketPayload, SupportDiagnostics } from "./api.ts";

export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  "bug",
  "question",
  "feedback",
  "account",
  "payments",
] as const;

// §3.2: free text 10…4000. The server sanitises + caps at 4000; the client enforces a friendly minimum.
export const TEXT_MIN = 10;
export const TEXT_MAX = 4000;

// Always-sent, non-diagnostic context (§3.2). screen is a redacted route breadcrumb; platform may be "".
export interface SupportAutoFields {
  screen: string;
  app_version: string;
  platform: string;
}

export interface SupportDraft {
  category: SupportCategory;
  text: string;
  attachDiagnostics: boolean;
}

export type DraftError = "empty" | "too_short" | "too_long" | null;

export function validateDraft(draft: SupportDraft): DraftError {
  const t = draft.text.trim();
  if (t.length === 0) return "empty";
  if (t.length < TEXT_MIN) return "too_short";
  if (t.length > TEXT_MAX) return "too_long";
  return null;
}

export function isSendable(draft: SupportDraft): boolean {
  return validateDraft(draft) === null;
}

export interface BuildOpts {
  clientRef: string;
  diagnostics?: SupportDiagnostics | null;
}

// Assemble the payload the shell will POST. Empty auto-fields are omitted (the server treats them as
// absent); diagnostics is included ONLY when the checkbox is ticked AND a snapshot exists.
export function buildPayload(draft: SupportDraft, auto: SupportAutoFields, opts: BuildOpts): SupportTicketPayload {
  const payload: SupportTicketPayload = {
    category: draft.category,
    text: draft.text.trim(),
    client_ref: opts.clientRef,
  };
  if (auto.screen) payload.screen = auto.screen;
  if (auto.app_version) payload.app_version = auto.app_version;
  if (auto.platform) payload.platform = auto.platform;
  if (draft.attachDiagnostics && opts.diagnostics) payload.diagnostics = opts.diagnostics;
  return payload;
}

// S-002: a resend that drops the diagnostics blob (offered when an oversize diag fails VALIDATION).
export function withoutDiagnostics(p: SupportTicketPayload): SupportTicketPayload {
  const { diagnostics: _drop, ...rest } = p;
  return rest;
}

// EXACTLY what will be sent, pretty-printed for the preview pane (rendered via textContent — S-004).
export function previewJson(p: SupportTicketPayload): string {
  return JSON.stringify(p, null, 2);
}

export function categoryLabel(i18n: I18n, cat: string): string {
  return i18n.t(`support.category.${cat}`);
}

// A known status → its localised label; anything unexpected falls back to the raw token (never blank).
const KNOWN_STATUS = new Set([
  "open", "ack", "in_progress", "waiting_user", "answered", "resolved", "closed",
]);
export function statusLabel(i18n: I18n, status: string): string {
  return KNOWN_STATUS.has(status) ? i18n.t(`support.status.${status}`) : status;
}

// §3.3 system status line for the @support dialog, e.g. "Обращение GC-000123: решено".
export function statusLine(i18n: I18n, ref: string, status: string): string {
  return i18n.t("support.statusLine", { ref, status: statusLabel(i18n, status) });
}
