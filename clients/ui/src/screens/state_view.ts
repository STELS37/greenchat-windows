// clients/ui/src/screens/state_view.ts — one language for the four states every data screen has (V76).
//
// Why this file exists. Measured on the running client at 390x844 (probe var/ux-audit/tools/m_states_v76.mjs,
// 2026-07-30) with the network cut for an account that has six chats:
//
//   offline-chats  → «Пока нет чатов» + a full-width accent CTA «Начать первый чат»
//                    + a red line «Нет соединения. Действие поставлено в очередь.»
//
// Three separate lies in one screen: the account is not empty, no action was queued (the failure was a
// READ), and the only offered move creates a new chat instead of retrying. Elsewhere the same three
// situations were drawn three different ways: the calls screen used `.gc-finance-empty` for BOTH an
// empty result and a 500, with no way to retry, and the settings header printed a green disc with a
// literal "?" while loading.
//
// So: an empty result, a lost connection and a server failure are DIFFERENT facts and get different
// wording, different glyphs and different actions — but one shape, so the app reads as one app.
// This module is DOM-only (no network, no timers), so screens stay unit-testable.

import { el } from "../dom.ts";
import { icon, type IconName } from "../icons.ts";
import type { I18n } from "../i18n.ts";
import { describeError, isNetworkError } from "./api.ts";

export type StateTone = "empty" | "offline" | "error";

export interface StateSpec {
  tone: StateTone;
  icon: IconName;
  title: string;
  body?: string;
  // The one move that makes sense here. Offline/error → retry; empty → the creating action, if any.
  actionLabel?: string;
  onAction?: () => void;
}

// The block itself. `.gc-state` is the shared shape; `data-tone` carries the meaning so the sheet can
// tint the glyph without the screen knowing any colour.
export function stateView(spec: StateSpec): HTMLElement {
  const children: HTMLElement[] = [
    el("span", { class: "gc-state-icon", "aria-hidden": true }, [icon(spec.icon)]),
    el("h2", { class: "gc-state-title" }, [spec.title]),
  ];
  if (spec.body) children.push(el("p", { class: "gc-state-body" }, [spec.body]));
  if (spec.actionLabel && spec.onAction) {
    const btn = el("button", {
      type: "button",
      class: spec.tone === "empty" ? "gc-btn gc-btn-accent gc-state-action" : "gc-btn gc-state-action",
    }, [spec.actionLabel]) as HTMLButtonElement;
    btn.addEventListener("click", () => spec.onAction?.());
    children.push(btn);
  }
  return el("div", { class: "gc-state", "data-tone": spec.tone, role: "status" }, children);
}

// Turn a thrown value into the honest failure state. A transport drop (clients/core NetworkError) is
// "we cannot reach the server" — the user's move is to wait and retry. Anything that DID reach the
// server keeps the Appendix-D message, because that text is the only clue for a report.
export function failureState(err: unknown, i18n: I18n, onRetry: () => void): HTMLElement {
  const offline = isNetworkError(err);
  return stateView({
    tone: offline ? "offline" : "error",
    icon: offline ? "offline" : "warning",
    title: i18n.t(offline ? "state.offlineTitle" : "state.errorTitle"),
    body: offline ? i18n.t("state.offlineBody") : describeError(err, i18n),
    actionLabel: i18n.t("common.retry"),
    onAction: onRetry,
  });
}

// The one-line version, for a screen that ALREADY shows data and only failed to refresh it. Never
// claim an action was queued: this path is a read.
export function failureLine(err: unknown, i18n: I18n): string {
  return i18n.t(isNetworkError(err) ? "state.staleOffline" : "state.staleError");
}

// A loading list. Real geometry — avatar disc + two text lines at the row height the list will use —
// so the screen does not visibly jump when the data lands. `aria-hidden`: a screen reader is told
// "busy" by the container, and reading eight fake rows would be noise.
export function skeletonList(rows: number, opts: { avatar?: boolean; height?: number } = {}): HTMLElement {
  const avatar = opts.avatar !== false;
  const items: HTMLElement[] = [];
  for (let i = 0; i < rows; i += 1) {
    const parts: HTMLElement[] = [];
    if (avatar) parts.push(el("span", { class: "gc-skeleton-avatar" }));
    parts.push(el("span", { class: "gc-skeleton-lines" }, [
      el("span", { class: "gc-skeleton-line is-title" }),
      el("span", { class: "gc-skeleton-line is-body" }),
    ]));
    const row = el("div", { class: "gc-skeleton-row" }, parts);
    if (opts.height) row.style.height = `${opts.height}px`;
    items.push(row);
  }
  return el("div", { class: "gc-skeleton-list", "aria-hidden": true }, items);
}

// A single shimmering bar, for a card that is one value wide (the account card's name).
export function skeletonLine(className = ""): HTMLElement {
  return el("span", { class: `gc-skeleton-line ${className}`.trim(), "aria-hidden": true });
}
