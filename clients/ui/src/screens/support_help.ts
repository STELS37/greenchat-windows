// clients/ui/src/screens/support_help.ts — lightweight lazy boundary for Help & Support.
//
// The support hub is opened deliberately and is absent from nearly every cold app start. Keeping its FAQ,
// service probe, ticket history and reply UI behind one dynamic import protects the 300 KB initial-shell
// budget without removing any capability. The returned shell preserves the existing synchronous API.
import type { I18n } from "../i18n.ts";
import type { ApiLike } from "./api.ts";
import { el, clear } from "../dom.ts";
import type { SupportStatusPort } from "./support_status.ts";
import type { MediaPort } from "./media.ts";

export interface SupportHelpPort {
  onOpenChat(chatId: number): void;
  onContact?(): void;
  status?: SupportStatusPort;
}

export interface SupportHelpDeps extends SupportHelpPort {
  api: ApiLike;
  i18n: I18n;
  media?: Pick<MediaPort, "upload">;
}

export interface SupportHelpView {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createSupportHelp(deps: SupportHelpDeps): SupportHelpView {
  const root = el("div", { class: "gc-support-help" });
  const loading = el(
    "p",
    { class: "gc-settings-status", role: "status", "aria-live": "polite" },
    [deps.i18n.t("common.loading")],
  );
  root.append(loading);

  let disposed = false;
  let inner: SupportHelpView | null = null;
  let refreshQueued = false;

  void import("./support_help_impl.ts").then(({ createSupportHelpImpl }) => {
    if (disposed) return;
    clear(root);
    inner = createSupportHelpImpl(deps, root);
    if (refreshQueued) {
      refreshQueued = false;
      inner.refresh();
    }
  }).catch(() => {
    if (!disposed) loading.textContent = deps.i18n.t("errors.unknown");
  });

  return {
    root,
    refresh() {
      if (inner) inner.refresh();
      else refreshQueued = true;
    },
    destroy() {
      disposed = true;
      inner?.destroy();
      inner = null;
      clear(root);
    },
  };
}
