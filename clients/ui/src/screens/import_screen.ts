// clients/ui/src/screens/import_screen.ts — the Telegram-import screen (T-417, «переезд»).
// DOM-only glue over createImportModel: pick a folder (an <input webkitdirectory>) or the .zip
// Telegram produces, then watch parsing → media upload → batch send → «N сообщений, M файлов». The
// two source builders (folder / zip) are injected by the shell — the folder one is pure File APIs, the
// zip one uses the core ZipArchive — so this file imports neither core nor the DOM file plumbing.
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";

import { icon } from "../icons.ts";
import { createImportModel, type ImportPorts, type ImportSource, type ImportState } from "./import_model.ts";

export interface ImportScreenDeps {
  i18n: I18n;
  ports: ImportPorts;
  // Build an import source from a picked directory's files / a picked .zip's bytes.
  folderSource(files: FileList): ImportSource;
  zipSource(bytes: Uint8Array): ImportSource;
  onBack(): void;
  onOpenChat(chatId: number): void;
}

// A selected file is untrusted input. Some source builders (notably ZipArchive) validate their
// container synchronously and may throw before ImportModel.run() gets a chance to enter its error
// state. Convert that construction failure into an ImportSource whose first read rejects, so the
// existing state machine remains the single owner of user-visible errors and retry behaviour.
export function importSourceOrFailure(build: () => ImportSource): ImportSource {
  try {
    return build();
  } catch (error) {
    return {
      readManifest: async () => { throw error; },
      readMedia: async () => null,
    };
  }
}

export function createImportScreen(deps: ImportScreenDeps): { root: HTMLElement; destroy(): void } {
  const { i18n } = deps;
  const model = createImportModel(deps.ports);
  let disposed = false;

  const root = el("div", { class: "gc-import" });

  const backBtn = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("common.back") }, [icon("back")]);
  backBtn.addEventListener("click", () => deps.onBack());
  const header = el("header", { class: "gc-import-header" }, [
    backBtn,
    el("h1", { class: "gc-import-title" }, [i18n.t("import.title")]),
  ]);

  const body = el("div", { class: "gc-import-body" });
  root.append(header, body);

  // Hidden pickers: a directory picker and a .zip picker, triggered by the two buttons below.
  const folderInput = el("input", {
    type: "file",
    class: "gc-visually-hidden",
    webkitdirectory: true,
    multiple: true,
  }) as HTMLInputElement;
  const zipInput = el("input", { type: "file", class: "gc-visually-hidden", accept: ".zip,application/zip" }) as HTMLInputElement;

  folderInput.addEventListener("change", () => {
    const files = folderInput.files;
    if (files && files.length > 0) {
      void model.run(importSourceOrFailure(() => deps.folderSource(files)));
    }
  });
  zipInput.addEventListener("change", () => {
    const file = zipInput.files?.[0];
    if (!file) return;
    void file.arrayBuffer()
      .then((buf) => model.run(importSourceOrFailure(() => deps.zipSource(new Uint8Array(buf)))))
      .catch((error) => model.run(importSourceOrFailure(() => { throw error; })));
  });

  const render = (s: ImportState): void => {
    if (disposed) return;
    clear(body);
    if (s.status === "idle") {
      const folderBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("import.pickFolder")]);
      const zipBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("import.pickZip")]);
      folderBtn.addEventListener("click", () => folderInput.click());
      zipBtn.addEventListener("click", () => zipInput.click());
      body.append(
        el("p", { class: "gc-import-lead" }, [i18n.t("import.subtitle")]),
        el("div", { class: "gc-import-actions" }, [folderBtn, zipBtn, folderInput, zipInput]),
      );
      return;
    }
    if (s.status === "parsing") {
      body.append(el("p", { class: "gc-import-status", role: "status", "aria-live": "polite" }, [i18n.t("import.parsing")]));
      return;
    }
    if (s.status === "running") {
      const label =
        s.phase === "media"
          ? i18n.t("import.uploading", { done: s.done, total: s.total })
          : i18n.t("import.sending", { done: s.done, total: s.total });
      const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
      // CSSOM, not a `style="…"` attribute: CSP `style-src 'self'` refuses attributes, so the fill
      // never moved and a running import looked frozen at 0% (V84).
      const fill = el("div", { class: "gc-progress-fill" });
      fill.style.width = `${pct}%`;
      const bar = el("div", { class: "gc-progress" }, [fill]);
      body.append(
        el("p", { class: "gc-import-status", role: "status", "aria-live": "polite" }, [
          `${i18n.t("import.archiveName", { title: s.title })} — ${label}`,
        ]),
        bar,
      );
      return;
    }
    if (s.status === "done") {
      const openBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("import.openChat")]);
      openBtn.addEventListener("click", () => deps.onOpenChat(s.chatId));
      const againBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("import.again")]);
      againBtn.addEventListener("click", () => model.reset());
      body.append(
        el("p", { class: "gc-import-done", role: "status", "aria-live": "polite" }, [
          `${i18n.t("import.done")} — ${s.summary}`,
        ]),
        el("div", { class: "gc-import-actions" }, [openBtn, againBtn]),
      );
      return;
    }
    // error
    const retryBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("import.again")]);
    retryBtn.addEventListener("click", () => model.reset());
    body.append(
      el("p", { class: "gc-import-error", role: "alert" }, [`${i18n.t("import.error")}: ${s.message}`]),
      el("div", { class: "gc-import-actions" }, [retryBtn]),
    );
  };

  const unsub = model.subscribe(render);
  render(model.getState());

  return {
    root,
    destroy() {
      disposed = true;
      model.reset();
      unsub();
    },
  };
}
