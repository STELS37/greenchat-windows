// clients/ui/src/screens/service_account.ts — T-514 (§4): the client-side contract for a SERVICE account
// (users.is_system on the server, e.g. @support). Pure/DOM-free. The server does not emit is_system on the
// public user payload today, so this is deliberately ADDITIVE and forward-looking: when the flag is present
// and true, a "Сервисный аккаунт" badge is shown and the destructive/1:1 affordances (call, block, "delete
// dialog for both") are withdrawn — blocking @support would silently cut the user's own help channel, which
// the server already refuses (T-169, S-008). When the flag is ABSENT (today) every capability defaults to
// today's behavior, so nothing regresses. Keyed ONLY off is_system — is_bot is an orthogonal concept.
import type { I18n } from "../i18n.ts";

// The structural slice we read off any user-ish payload (Me / SearchUser / a profile). Both keys optional
// so a payload that predates them still satisfies it; `undefined`/absent ⇒ NOT a service account.
export interface ServiceAccountFlags {
  is_system?: boolean;
}

// What a peer surface may do with this account. When it is a service account the 1:1 affordances are
// withdrawn (hide the call button, disable "block", disable "delete for both"); otherwise unchanged.
export interface ServiceAccountCaps {
  isServiceAccount: boolean;
  allowCall: boolean;
  allowBlock: boolean;
  allowDeleteForBoth: boolean;
}

// True only for an explicit is_system === true. A missing/false/undefined flag is a normal account.
export function isServiceAccount(u: ServiceAccountFlags | null | undefined): boolean {
  return !!u && u.is_system === true;
}

// Derive the peer-action gating. All capabilities collapse to false for a service account; otherwise they
// are all true (today's behavior) — the caller hides/disables the corresponding controls.
export function serviceAccountCaps(u: ServiceAccountFlags | null | undefined): ServiceAccountCaps {
  const svc = isServiceAccount(u);
  return { isServiceAccount: svc, allowCall: !svc, allowBlock: !svc, allowDeleteForBoth: !svc };
}

// The localized badge caption ("Сервисный аккаунт" / "Service account"). Exported so DOM + tests agree.
export function serviceAccountLabel(i18n: I18n): string {
  return i18n.t("user.serviceAccount");
}
