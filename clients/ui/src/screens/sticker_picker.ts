// clients/ui/src/screens/sticker_picker.ts — installed/recent GreenChat sticker tray.
// It deliberately reuses the measured emoji-panel primitives: same footprint, touch targets and motion,
// while every sticker byte still travels through MediaCache rather than an unsafe raw URL.
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";
import { describeError, type ApiLike } from "./api.ts";
import type { MediaPort } from "./media.ts";
import {
  normalizeStickerLibrary,
  rememberRecent,
  stickerSections,
  type StickerLibrary,
  type StickerSection,
  type StickerView,
} from "./sticker_model.ts";

export interface StickerPickerDeps {
  i18n: I18n;
  api: Pick<ApiLike, "get">;
  media: Pick<MediaPort, "objectUrl" | "revoke">;
  onPick: (sticker: StickerView) => Promise<void> | void;
}

export interface StickerPicker {
  root: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  reload(): Promise<void>;
  subscribeOpenChange(handler: (open: boolean) => void): () => void;
  destroy(): void;
}

let pickerSeq = 0;
const EMPTY_LIBRARY: StickerLibrary = { recent: [], packs: [] };

export function createStickerPicker(deps: StickerPickerDeps): StickerPicker {
  const id = `gc-sticker-panel-${++pickerSeq}`;
  const grid = el("div", { class: "gc-emoji-grid gc-sticker-grid" });
  const tabs = el("div", { class: "gc-emoji-tabs gc-sticker-tabs", role: "tablist" });
  const root = el("div", {
    id,
    class: "gc-emoji-panel gc-sticker-panel",
    role: "dialog",
    "aria-label": deps.i18n.t("sticker.title"),
    hidden: true,
  }, [grid, tabs]);

  let open = false;
  let loading = false;
  let loaded = false;
  let destroyed = false;
  let activeKey = "";
  let error: unknown = null;
  let library: StickerLibrary = EMPTY_LIBRARY;
  let requestEpoch = 0;
  let imageEpoch = 0;
  const urls = new Set<string>();
  const listeners = new Set<(state: boolean) => void>();

  const emit = (): void => { for (const handler of listeners) handler(open); };
  const releaseImages = (): void => {
    imageEpoch += 1;
    for (const url of urls) deps.media.revoke(url);
    urls.clear();
  };

  const paintImage = async (button: HTMLButtonElement, sticker: StickerView, epoch: number): Promise<void> => {
    let url: string;
    try {
      url = await deps.media.objectUrl(sticker.file.id, sticker.file.mime, true);
    } catch {
      // The emoji/placeholder remains usable and the whole pack must not fail because one blob is gone.
      return;
    }
    if (destroyed || !open || epoch !== imageEpoch) {
      deps.media.revoke(url);
      return;
    }
    urls.add(url);
    clear(button);
    button.append(el("img", {
      class: "gc-media-img gc-sticker-img",
      src: url,
      alt: "",
      "aria-hidden": true,
      draggable: false,
    }));
  };

  const currentSections = (): StickerSection[] => stickerSections(library, deps.i18n.t("sticker.recent"));

  const render = (): void => {
    releaseImages();
    clear(grid);
    clear(tabs);
    if (!open) return;
    if (loading) {
      grid.append(el("p", { class: "gc-emoji-empty", role: "status" }, [deps.i18n.t("sticker.loading")]));
      return;
    }
    if (error) {
      grid.append(
        el("p", { class: "gc-emoji-empty", role: "alert" }, [describeError(error, deps.i18n)]),
        el("button", { type: "button", class: "gc-btn gc-sticker-retry" }, [deps.i18n.t("common.retry")]),
      );
      const retry = grid.children[grid.children.length - 1] as HTMLButtonElement;
      retry.addEventListener("click", () => { void reload(); });
      return;
    }
    const sections = currentSections();
    if (sections.length === 0) {
      grid.append(el("p", { class: "gc-emoji-empty", role: "status" }, [deps.i18n.t("sticker.empty")]));
      return;
    }
    if (!sections.some((section) => section.key === activeKey)) activeKey = sections[0]!.key;
    const selected = sections.find((section) => section.key === activeKey) ?? sections[0]!;
    const epoch = imageEpoch;

    for (const section of sections) {
      const tab = el("button", {
        type: "button",
        class: section.key === activeKey ? "gc-emoji-tab gc-sticker-tab is-active" : "gc-emoji-tab gc-sticker-tab",
        role: "tab",
        title: section.title,
        "aria-label": section.title,
        "aria-selected": section.key === activeKey,
      }, [section.marker]) as HTMLButtonElement;
      tab.addEventListener("click", () => {
        if (activeKey === section.key) return;
        activeKey = section.key;
        render();
      });
      tabs.append(tab);
    }

    for (const sticker of selected.stickers) {
      const button = el("button", {
        type: "button",
        class: "gc-emoji-cell gc-sticker-cell",
        title: sticker.emoji || deps.i18n.t("sticker.title"),
        "aria-label": sticker.emoji || deps.i18n.t("sticker.title"),
      }, [sticker.emoji || "▣"]) as HTMLButtonElement;
      button.addEventListener("click", () => {
        if (button.disabled) return;
        button.disabled = true;
        void Promise.resolve(deps.onPick(sticker)).then(() => {
          library = { ...library, recent: rememberRecent(library.recent, sticker) };
          setOpen(false);
        }).catch((err: unknown) => {
          error = err;
          button.disabled = false;
          render();
        });
      });
      grid.append(button);
      void paintImage(button, sticker, epoch);
    }
  };

  async function reload(): Promise<void> {
    const epoch = ++requestEpoch;
    loading = true;
    error = null;
    render();
    try {
      const [packs, recent] = await Promise.all([
        deps.api.get<unknown>("/v1/stickers/my"),
        deps.api.get<unknown>("/v1/stickers/recent"),
      ]);
      if (destroyed || epoch !== requestEpoch) return;
      library = normalizeStickerLibrary(packs, recent);
      loaded = true;
      loading = false;
      error = null;
      render();
    } catch (err) {
      if (destroyed || epoch !== requestEpoch) return;
      loading = false;
      error = err;
      render();
    }
  }

  function setOpen(next: boolean): void {
    if (destroyed || open === next) return;
    open = next;
    root.hidden = !open;
    if (open) {
      render();
      if (!loaded && !loading) void reload();
    } else {
      releaseImages();
      clear(grid);
    }
    emit();
  }

  return {
    root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    reload,
    subscribeOpenChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      requestEpoch += 1;
      open = false;
      root.hidden = true;
      releaseImages();
      listeners.clear();
      clear(grid);
      clear(tabs);
    },
  };
}
