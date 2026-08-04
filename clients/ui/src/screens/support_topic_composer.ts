// clients/ui/src/screens/support_topic_composer.ts — lazy support-topic reply composer.
//
// Kept out of the initial app shell: the upload/reply machinery is needed only after a person opens an
// active support ticket. The lightweight ticket list remains immediately available from Chats/Settings.
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import type { ApiLike, SupportTicketDetail } from "./api.ts";
import { describeError } from "./api.ts";
import type { MediaPort } from "./media.ts";

export type SupportMessageKind = "photo" | "video" | "audio" | "file";

/** The support transport accepts every file; common media retain their native chat presentation. */
export function supportMessageKind(mime: string): SupportMessageKind {
  const value = mime.trim().toLocaleLowerCase();
  if (value.startsWith("image/")) return "photo";
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "audio";
  return "file";
}

function clientMessageId(): string {
  const randomUUID = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID === "function") return `support:${randomUUID.call(globalThis.crypto)}`;
  return `support:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

export interface SupportTopicComposerDeps {
  api: ApiLike;
  i18n: I18n;
  ticket: SupportTicketDetail;
  media?: Pick<MediaPort, "upload">;
  isDisposed(): boolean;
  refresh(): Promise<void>;
}

export function createSupportTopicComposer(deps: SupportTopicComposerDeps): HTMLElement {
  const { api, i18n, ticket } = deps;
  let busy = false;
  let selected: File | null = null;
  const draft = el("textarea", {
    class: "gc-input gc-support-textarea",
    rows: "3",
    maxlength: "4000",
    placeholder: i18n.t("support.textPlaceholder"),
    "aria-label": i18n.t("support.textLabel"),
  }) as HTMLTextAreaElement;
  const status = el("p", { class: "gc-settings-status", role: "status", "aria-live": "polite" });
  const fileName = el("span", { class: "gc-support-hint" });
  const send = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("support.send")]) as HTMLButtonElement;
  const actions = el("div", { class: "gc-support-actions" });
  let fileInput: HTMLInputElement | null = null;

  const sync = (): void => {
    send.disabled = busy || (String(draft.value ?? "").trim().length === 0 && selected === null);
    fileName.textContent = selected?.name ?? "";
  };

  if (deps.media) {
    fileInput = el("input", {
      type: "file",
      hidden: true,
      "aria-label": i18n.t("media.attach"),
    }) as HTMLInputElement;
    const attach = el("button", { type: "button", class: "gc-btn" }, [i18n.t("media.attach")]);
    attach.addEventListener("click", () => fileInput?.click());
    fileInput.addEventListener("change", () => {
      selected = fileInput?.files?.[0] ?? null;
      sync();
    });
    actions.append(attach, fileInput, fileName);
  }
  actions.append(send);
  draft.addEventListener("input", sync);
  send.addEventListener("click", () => {
    if (busy) return;
    const text = String(draft.value ?? "").trim();
    const file = selected;
    if (!text && !file) return;
    busy = true;
    sync();
    status.textContent = i18n.t("common.loading");
    void (async () => {
      try {
        let fileId: number | undefined;
        let kind: SupportMessageKind | undefined;
        if (file) {
          if (!deps.media) throw new Error("support media upload is unavailable");
          const uploaded = await deps.media.upload(new Uint8Array(await file.arrayBuffer()), {
            name: file.name || "attachment",
            mime: file.type || "application/octet-stream",
            onProgress: (loaded, total) => {
              if (!deps.isDisposed() && total > 0) {
                status.textContent = `${file.name} · ${Math.round((loaded / total) * 100)}%`;
              }
            },
          });
          fileId = uploaded.file_id;
          kind = supportMessageKind(uploaded.mime || file.type);
        }
        await api.post(`/v1/support/tickets/${encodeURIComponent(ticket.ref)}/messages`, {
          text,
          ...(fileId !== undefined ? { file_id: fileId, kind } : {}),
          client_msg_id: clientMessageId(),
        });
        if (!deps.isDisposed()) await deps.refresh();
      } catch (err) {
        if (deps.isDisposed()) return;
        status.textContent = describeError(err, i18n);
        busy = false;
        sync();
      }
    })();
  });
  sync();

  return el("section", { class: "gc-support-section", "data-support-topic": ticket.ref }, [
    el("label", { class: "gc-field" }, [
      el("span", { class: "gc-field-label" }, [i18n.t("support.textLabel")]),
      draft,
    ]),
    actions,
    status,
  ]);
}
