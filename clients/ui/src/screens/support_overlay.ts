// clients/ui/src/screens/support_overlay.ts — T-512 (MS-2): the "Report a problem / Contact support"
// form (SUPPORT.md §3.2). A thin DOM shell over support_model.ts: category radios, a 10..4000 text
// field, an "attach technical data" checkbox (default ON) with a "see what will be sent" preview that
// shows the EXACT JSON (privacy invariant), and a "report a user/content" link that hands off to the
// existing T-113 flow (that is NOT a ticket). Reuses the .gc-overlay / .gc-forward-panel chrome.
//
// Everything is rendered via el()/textContent (S-004): no innerHTML ever touches the diagnostics blob
// or the user's text. The overlay never leaves the current screen (it is a modal layer).
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { createFocusTrap } from "../a11y.ts";
import type { SupportCategory, SupportTicketPayload, SupportDiagnostics } from "./api.ts";
import {
  SUPPORT_CATEGORIES, TEXT_MAX, buildPayload, withoutDiagnostics, previewJson,
  validateDraft, isSendable, categoryLabel, type SupportDraft, type SupportAutoFields, type DraftError,
} from "./support_model.ts";

// What the controller reports back after a send attempt (it owns api + offline queue + error mapping).
export type SupportSubmitResult =
  | { kind: "created"; ref: string }
  | { kind: "queued" }                       // offline / transient → queued (S-003)
  | { kind: "oversize" }                      // VALIDATION with diagnostics attached → offer resend (S-002)
  | { kind: "limit"; retryAfter?: number }    // LIMIT_EXCEEDED (S-005)
  | { kind: "disabled" }                       // FEATURE_DISABLED (GC_SUPPORT=0)
  | { kind: "error"; message: string };        // any other failure, already localised

export interface SupportPrefill {
  category?: SupportCategory;
  text?: string;
}

export interface SupportOverlayDeps {
  i18n: I18n;
  auto: SupportAutoFields;
  prefill?: SupportPrefill;
  // The already-redacted diagnostics snapshot to attach (null/undefined => no technical data available).
  diagnostics?: SupportDiagnostics | null;
  newClientRef: () => string;
  submit: (payload: SupportTicketPayload) => Promise<SupportSubmitResult>;
  onReport?: () => void; // "report a user/content" → existing flow; the link is hidden when absent.
  onClose?: () => void;
  toast?: (msg: string) => void;
}

export interface SupportOverlay {
  root: HTMLElement;
  focus(): void;
  close(): void;
}

export function createSupportOverlay(deps: SupportOverlayDeps): SupportOverlay {
  const { i18n } = deps;
  const hasDiag = deps.diagnostics != null;
  // One client_ref for this form instance: the preview shows it and the send (and any S-002 resend)
  // reuse it, so "what you preview" is byte-for-byte "what is sent", and a replay is idempotent (S-001).
  const clientRef = deps.newClientRef();

  const draft: SupportDraft = {
    category: deps.prefill?.category ?? "bug",
    text: deps.prefill?.text ?? "",
    attachDiagnostics: true,
  };

  let busy = false;
  let previewOpen = false;

  const note = (elm: HTMLElement, text: string): void => {
    elm.textContent = text;
    elm.style.display = text ? "block" : "none";
  };

  const errMsg = (e: DraftError): string => {
    if (e === "too_short") return i18n.t("support.err.too_short", { min: 10 });
    if (e === "too_long") return i18n.t("support.err.too_long", { max: TEXT_MAX });
    if (e === "empty") return i18n.t("support.err.empty");
    return "";
  };

  // ---- category radios -----------------------------------------------------------------------------
  const cats = el("fieldset", { class: "gc-support-cats" }, [
    el("legend", {}, [i18n.t("support.categoryLegend")]),
  ]);
  for (const c of SUPPORT_CATEGORIES) {
    const radio = el("input", { type: "radio", name: "gc-support-cat", value: c }) as HTMLInputElement;
    if (c === draft.category) radio.checked = true;
    radio.addEventListener("change", () => { if (radio.checked) { draft.category = c as SupportCategory; refreshPreview(); } });
    cats.append(el("label", { class: "gc-support-cat" }, [radio, categoryLabel(i18n, c)]));
  }

  // ---- text ----------------------------------------------------------------------------------------
  const textarea = el("textarea", {
    class: "gc-input gc-support-textarea",
    placeholder: i18n.t("support.textPlaceholder"),
    "aria-label": i18n.t("support.textLabel"),
    rows: "4",
  }) as HTMLTextAreaElement;
  textarea.value = draft.text;
  const counter = el("span", { class: "gc-support-counter" });
  const status = el("p", { class: "gc-chats-status", role: "alert" });

  // ---- attach-diagnostics + preview ----------------------------------------------------------------
  const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  checkbox.checked = draft.attachDiagnostics;
  const checkRow = el("label", { class: "gc-support-check" }, [checkbox, i18n.t("support.attach")]);
  const attachHint = el("p", { class: "gc-support-hint" }, [i18n.t("support.attachHint")]);
  const previewToggle = el("button", { type: "button", class: "gc-support-linkbtn" }, [i18n.t("support.preview")]);
  const preview = el("pre", { class: "gc-support-preview" });
  const autoNote = el("p", { class: "gc-support-hint" }, [i18n.t("support.autoNote")]);

  const currentPayload = (): SupportTicketPayload =>
    buildPayload(draft, deps.auto, { clientRef, diagnostics: (hasDiag ? deps.diagnostics : null) ?? null });

  const refreshPreview = (): void => {
    if (previewOpen) preview.textContent = previewJson(currentPayload());
  };

  checkbox.addEventListener("change", () => { draft.attachDiagnostics = checkbox.checked; refreshPreview(); });
  previewToggle.addEventListener("click", () => {
    previewOpen = !previewOpen;
    preview.style.display = previewOpen ? "block" : "none";
    previewToggle.textContent = i18n.t(previewOpen ? "support.previewHide" : "support.preview");
    refreshPreview();
  });

  // ---- "report a user/content" (T-113 flow — NOT a ticket) -----------------------------------------
  const reportLink = el("button", { type: "button", class: "gc-support-linkbtn" }, [i18n.t("support.reportLink")]);
  reportLink.addEventListener("click", () => { close(); deps.onReport?.(); });

  // ---- actions -------------------------------------------------------------------------------------
  const cancelBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.cancel")]);
  const sendBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("support.send")]) as HTMLButtonElement;
  const withoutBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("support.sendWithout")]) as HTMLButtonElement;
  withoutBtn.style.display = "none";

  const bodyChildren: (HTMLElement | string)[] = [
    cats,
    el("div", { class: "gc-field" }, [
      el("label", { class: "gc-field-label" }, [i18n.t("support.textLabel")]),
      textarea,
      counter,
    ]),
    status,
  ];
  if (hasDiag) bodyChildren.push(checkRow, attachHint, previewToggle, preview);
  bodyChildren.push(autoNote);
  if (deps.onReport) bodyChildren.push(reportLink);

  const body = el("div", { class: "gc-support-body" }, bodyChildren);
  const actions = el("div", { class: "gc-support-actions" }, [cancelBtn, withoutBtn, sendBtn]);
  // V153: this file's own header calls the surface "a modal layer" and the markup never said so.
  // `.gc-overlay` blurs and blocks the settings screen behind it, so the panel declares the role and
  // aria-modal, and the trap keeps Tab off that screen — a form with radios, a text field, a checkbox
  // and three buttons is exactly where a keyboard walks out unnoticed.
  const panel = el("div", {
    class: "gc-forward-panel",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": i18n.t("support.reportProblem"),
  }, [
    el("h3", { class: "gc-forward-title" }, [i18n.t("support.reportProblem")]),
    body,
    actions,
  ]);
  const overlay = el("div", { class: "gc-overlay" }, [panel]);
  const trap = createFocusTrap(overlay, { initialFocus: textarea });

  function syncSend(): void {
    counter.textContent = `${draft.text.trim().length} / ${TEXT_MAX}`;
    sendBtn.disabled = busy || !isSendable(draft);
    const e = validateDraft(draft);
    // Live guidance only for a too-short/too-long body; an empty field just keeps Send disabled.
    note(status, e === "too_short" || e === "too_long" ? errMsg(e) : "");
  }

  textarea.addEventListener("input", () => {
    draft.text = textarea.value;
    syncSend();
    refreshPreview();
  });

  const setBusy = (b: boolean): void => { busy = b; syncSend(); withoutBtn.disabled = b; };

  const handleResult = (res: SupportSubmitResult, payload: SupportTicketPayload): void => {
    if (res.kind === "created") { deps.toast?.(i18n.t("support.created", { ref: res.ref })); close(); return; }
    if (res.kind === "queued") { deps.toast?.(i18n.t("support.queued")); close(); return; }
    if (res.kind === "oversize") {
      note(status, i18n.t("support.oversizeOffer"));
      withoutBtn.style.display = "";
      withoutBtn.onclick = () => {
        checkbox.checked = false;
        draft.attachDiagnostics = false;
        refreshPreview();
        withoutBtn.style.display = "none";
        void doSubmit(withoutDiagnostics(payload));
      };
      return;
    }
    if (res.kind === "limit") { note(status, i18n.t("support.limit")); return; }
    if (res.kind === "disabled") { note(status, i18n.t("support.disabled")); return; }
    note(status, i18n.t("support.sendFailed", { reason: res.message }));
  };

  async function doSubmit(payload: SupportTicketPayload): Promise<void> {
    if (busy) return;
    setBusy(true);
    note(status, "");
    let res: SupportSubmitResult;
    try {
      res = await deps.submit(payload);
    } catch (err) {
      res = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    } finally {
      setBusy(false);
    }
    handleResult(res, payload);
  }

  sendBtn.addEventListener("click", () => {
    const e = validateDraft(draft);
    if (e) { note(status, errMsg(e)); return; }
    void doSubmit(currentPayload());
  });

  function close(): void {
    trap.release();
    overlay.remove();
    deps.onClose?.();
  }
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") { e.preventDefault(); close(); }
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  preview.style.display = "none";
  syncSend();

  return {
    root: overlay,
    // Arms the trap (recording where the caret came from) and lands on the description field, which
    // is what the person came here to fill in.
    focus() { trap.activate(); textarea.focus(); },
    close,
  };
}
