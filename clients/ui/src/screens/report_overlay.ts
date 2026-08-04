// clients/ui/src/screens/report_overlay.ts — T-514 (MS-4 / T-113): the minimal "report a user/content" flow
// the support form's "Пожаловаться…" link opens (SUPPORT.md §3.2/§12). A report is NOT a support ticket: it
// POSTs /v1/report into the separate moderation table (T-113), then closes with a "thanks" toast.
//
// Two modes:
//   • targeted   — the caller already knows WHAT is being reported (a message/user/chat): show its label,
//                  reason radios + optional comment, submit.
//   • by @username — the global hand-off has no target: the user types @username, we resolve it to a concrete
//                  user id via GET /v1/users/resolve (authoritative exact match), then report kind:"user".
// Everything renders through el()/textContent (S-004); the overlay never leaves the current screen.
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { createFocusTrap } from "../a11y.ts";
import type {
  ApiLike,
  ReportKind,
  ReportReason,
  ReportResult,
  ResolvedUser,
} from "./api.ts";
import { apiErrorCode, describeError } from "./api.ts";
import {
  REPORT_REASONS,
  REPORT_COMMENT_MAX,
  buildReportPayload,
  reasonLabel,
  normalizeUsername,
  pickUserByUsername,
  type ReportDraft,
} from "./report_model.ts";

import { createReportOverlayEpoch, type ReportOverlayToken } from "./report_overlay_epoch.ts";

// A known target for the report (per-message / per-user surfaces). Absent → the "@username" mode.
export interface ReportTarget {
  kind: ReportKind;
  targetId: number;
  label: string; // shown to the reporter, e.g. a @username or a short message preview
}

export interface ReportOverlayDeps {
  i18n: I18n;
  api: ApiLike;
  target?: ReportTarget;
  toast?: (msg: string) => void;
  onClose?: () => void;
}

export interface ReportOverlay {
  root: HTMLElement;
  focus(): void;
  close(): void;
}

export function createReportOverlay(deps: ReportOverlayDeps): ReportOverlay {
  const { i18n, api } = deps;
  const draft: ReportDraft = { reason: "spam", comment: "" };
  let busy = false;
  let closed = false;

  const lifecycle = createReportOverlayEpoch();

  const report = api.reportContent?.bind(api) ?? null;
  const resolve = api.resolveUser?.bind(api) ?? null;
  const search = api.searchGlobal?.bind(api) ?? null;

  const status = el("p", { class: "gc-chats-status", role: "alert" });
  const note = (text: string): void => {
    if (closed) return;
    status.textContent = text;
    status.style.display = text ? "block" : "none";
  };

  // ---- target vs @username -------------------------------------------------------------------------
  const usernameInput = el("input", {
    type: "text", class: "gc-input", placeholder: i18n.t("report.usernamePlaceholder"), "aria-label": i18n.t("report.usernameLabel"),
  }) as HTMLInputElement;

  const targetRow = deps.target
    ? el("p", { class: "gc-report-target" }, [i18n.t("report.targetLabel"), " ", el("strong", {}, [deps.target.label])])
    : el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [i18n.t("report.usernameLabel")]), usernameInput]);

  // ---- reason radios -------------------------------------------------------------------------------
  const reasons = el("fieldset", { class: "gc-support-cats" }, [el("legend", {}, [i18n.t("report.reasonLegend")])]);
  for (const r of REPORT_REASONS) {
    const radio = el("input", { type: "radio", name: "gc-report-reason", value: r }) as HTMLInputElement;
    if (r === draft.reason) radio.checked = true;
    radio.addEventListener("change", () => { if (radio.checked) draft.reason = r as ReportReason; });
    reasons.append(el("label", { class: "gc-support-cat" }, [radio, reasonLabel(i18n, r)]));
  }

  // ---- comment -------------------------------------------------------------------------------------
  const comment = el("textarea", {
    class: "gc-input gc-support-textarea", rows: "3",
    placeholder: i18n.t("report.commentPlaceholder"), "aria-label": i18n.t("report.commentLabel"),
    maxlength: String(REPORT_COMMENT_MAX),
  }) as HTMLTextAreaElement;
  comment.addEventListener("input", () => { draft.comment = comment.value; });

  // ---- actions -------------------------------------------------------------------------------------
  const cancelBtn = el("button", { type: "button", class: "gc-btn" }, [
    i18n.t("common.cancel"),
  ]);
  const sendBtn = el(
    "button",
    { type: "button", class: "gc-btn gc-btn-accent" },
    [i18n.t("report.send")],
  ) as HTMLButtonElement;

  const setBusy = (b: boolean): void => {
    if (closed) return;
    busy = b;
    sendBtn.disabled = b;
    cancelBtn.setAttribute("aria-disabled", String(b));
  };

  // Resolve the concrete target: the preset one, or an exact @username lookup. Prefer the dedicated
  // resolver while retaining structural compatibility with older searchGlobal-only adapters. Every
  // asynchronous completion is bound to this overlay epoch, so a closed overlay cannot paint or submit.
  const resolveTarget = async (
    token: ReportOverlayToken,
  ): Promise<{ kind: ReportKind; targetId: number } | null> => {
    if (deps.target)
      return { kind: deps.target.kind, targetId: deps.target.targetId };
    const raw = normalizeUsername(usernameInput.value);
    if (!raw) {
      note(i18n.t("report.needUsername"));
      return null;
    }
    if (!resolve && !search) {
      note(i18n.error(null));
      return null;
    }
    let user: ResolvedUser | null;
    try {
      user = resolve
        ? await resolve(raw)
        : pickUserByUsername(await search!(raw), raw);
    } catch (err) {
      if (!lifecycle.isCurrent(token)) return null;
      note(
        apiErrorCode(err) === "NOT_FOUND"
          ? i18n.t("report.userNotFound")
          : describeError(err, i18n),
      );
      return null;
    }
    if (!lifecycle.isCurrent(token)) return null;
    if (
      !user ||
      ("deleted" in user && user.deleted === true) ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      !("username" in user) ||
      typeof user.username !== "string"
    ) {
      note(i18n.t("report.userNotFound"));
      return null;
    }
    return { kind: "user", targetId: user.id };
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    const token = lifecycle.begin();
    if (!token) return;
    if (!report) { note(i18n.error(null)); return; }
    setBusy(true);
    note("");
    try {
      const tgt = await resolveTarget(token);
      if (!lifecycle.isCurrent(token) || !tgt) return;
      await api.reportContent!(buildReportPayload(tgt.kind, tgt.targetId, draft)) as ReportResult;
      if (!lifecycle.isCurrent(token)) return;

      deps.toast?.(i18n.t("report.thanks"));
      close();
    } catch (err) {
      if (!lifecycle.isCurrent(token)) return;
      // A repeat report of the same open target folds server-side (idempotent) → still a success to the user;
      // but a genuine failure (rate cap, validation, network) is surfaced localised. The 10/hour per-account
      // cap (reports.ts) throws RATE_LIMITED → a friendlier, report-specific line; everything else → the
      // Appendix-D catalogue (describeError also maps a NetworkError to the offline text).
      if (apiErrorCode(err) === "RATE_LIMITED") note(i18n.t("report.limit"));
      else note(describeError(err, i18n));
    } finally {
      if (lifecycle.isCurrent(token)) setBusy(false);
    }
  };

  sendBtn.addEventListener("click", () => void submit());

  const body = el("div", { class: "gc-support-body" }, [
    el("p", { class: "gc-support-hint" }, [i18n.t("report.intro")]),
    targetRow, reasons,
    el("div", { class: "gc-field" }, [el("label", { class: "gc-field-label" }, [i18n.t("report.commentLabel")]), comment]),
    status,
  ]);
  const actions = el("div", { class: "gc-support-actions" }, [cancelBtn, sendBtn]);
  // V153: same blurred, click-blocking scrim as the other two sheets, so the same declaration. A
  // report is often opened from a message menu that has just closed, which makes handing the caret
  // back on close() the difference between returning to the conversation and starting from the top.
  const panel = el("div", {
    class: "gc-forward-panel",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": i18n.t("report.title"),
  }, [
    el("h3", { class: "gc-forward-title" }, [i18n.t("report.title")]),
    body, actions,
  ]);
  const overlay = el("div", { class: "gc-overlay" }, [panel]);
  const trap = createFocusTrap(overlay, { initialFocus: deps.target ? sendBtn : usernameInput });

  function close(): void {
    if (!lifecycle.close()) return;
    closed = true;
    trap.release();
    overlay.remove();
    deps.onClose?.();
  }
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") { e.preventDefault(); close(); } });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  note("");
  return {
    root: overlay,
    focus() { trap.activate(); (deps.target ? sendBtn : usernameInput).focus(); },
    close,
  };
}
