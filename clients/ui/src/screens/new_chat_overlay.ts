// The unified creation hub opened by the chat-list + button. It keeps the fast people search and
// Saved Messages shortcut, but also exposes every object a person reasonably means by “create”:
// group, broadcast, channel and bot. Group/channel creation stays inside the sheet; Bot Center is an
// existing full screen and receives a one-shot navigation intent from the owner screen.
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";
import { createFocusTrap } from "../a11y.ts";
import { describeError } from "./api.ts";
import type { ApiLike, GlobalSearchResult, DialogChat } from "./api.ts";
import type { SelfRef } from "./chat_model.ts";
import {
  SearchController,
  savedRow,
  savedRowVisible,
  userRows,
  type DirectoryRow,
  type SearchState,
} from "./new_chat_model.ts";
import { serviceAccountLabel } from "./service_account.ts";
import { icon, type IconName } from "../icons.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { bindAvatarImage, type AvatarImageBinding } from "./avatar_media.ts";
import { newChatText, type NewChatStringKey } from "./new_chat_strings.ts";
import type { ContactRow } from "./contacts_model.ts";
import type {
  NewChannelInput,
  NewChatCreationTarget,
  NewGroupInput,
} from "./new_chat_creation_form.ts";

export type { NewChannelInput, NewGroupInput } from "./new_chat_creation_form.ts";

export interface NewChatOverlayDeps {
  i18n: I18n;
  self: SelfRef;
  search(q: string): Promise<GlobalSearchResult>;
  avatarApi?: Pick<ApiLike, "get" | "resolveUrl">;
  listContacts?(): Promise<ContactRow[]>;
  createDialog(userId: number): Promise<DialogChat>;
  createGroup?(input: NewGroupInput): Promise<DialogChat>;
  createChannel?(input: NewChannelInput): Promise<DialogChat>;
  addMembers?(chatId: number, userIds: number[]): Promise<DialogChat>;
  onCreateBot?(): void;
  onOpenChat(chatId: number): void;
  onCreated?(chat: DialogChat): void;
  onClose?(): void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NewChatOverlay {
  root: HTMLElement;
  focus(): void;
  close(): void;
}

type CreationMode = "home" | NewChatCreationTarget;

export function createNewChatOverlay(deps: NewChatOverlayDeps): NewChatOverlay {
  const { i18n, self } = deps;
  const text = (key: NewChatStringKey, vars?: Readonly<Record<string, string | number>>): string =>
    newChatText(i18n.locale, key, vars);
  let busy = false;
  let mode: CreationMode = "home";
  let closed = false;
  let activeCleanup: (() => void) | null = null;
  let creationRevision = 0;
  let trap: ReturnType<typeof createFocusTrap> | null = null;
  let directoryAvatarBindings: AvatarImageBinding[] = [];
  const resetDirectoryAvatars = (): void => {
    for (const binding of directoryAvatarBindings) binding.destroy();
    directoryAvatarBindings = [];
  };

  const note = (node: HTMLElement, value: string): void => {
    node.textContent = value;
    node.style.display = value ? "block" : "none";
  };

  const directoryInput = el("input", {
    type: "search",
    class: "gc-palette-input gc-new-chat-search-input",
    autocomplete: "off",
    placeholder: i18n.t("chatList.searchPeople"),
    "aria-label": i18n.t("chatList.searchPeople"),
  }) as HTMLInputElement;
  const directoryList = el("div", { class: "gc-forward-list gc-new-chat-directory", role: "list" });
  const directoryHint = el("p", { class: "gc-palette-empty" });
  const homeError = el("p", { class: "gc-chats-status gc-new-chat-error", role: "alert" });

  const avatarNode = (row: DirectoryRow): HTMLElement => {
    const seed = row.avatarSeed ?? row.title;
    if (row.kind === "self") {
      return el("div", { class: "gc-avatar is-saved", "aria-hidden": "true" }, [icon("spark", "gc-icon gc-avatar-icon")]);
    }
    const avatar = el("div", { class: "gc-avatar", "data-tone": String(avatarTone(seed)), "aria-hidden": "true" }, [
      initials(seed),
    ]);
    if (deps.avatarApi) directoryAvatarBindings.push(bindAvatarImage(avatar, deps.avatarApi, row.avatarFileId ?? null, row.title));
    return avatar;
  };

  const personCopy = (row: DirectoryRow): HTMLElement => {
    const top: Array<Node | string> = [el("span", { class: "gc-row-title" }, [row.title])];
    if (row.serviceAccount) {
      top.push(el("span", { class: "gc-badge gc-badge-service" }, [serviceAccountLabel(i18n)]));
    }
    return el("span", { class: "gc-new-chat-person-copy" }, [
      el("span", { class: "gc-row-top" }, top),
      row.subtitle
        ? el("span", { class: "gc-row-bottom" }, [el("span", { class: "gc-row-sub" }, [row.subtitle])])
        : "",
    ]);
  };

  const close = (): void => {
    directoryController.cancel();
    creationRevision += 1;
    activeCleanup?.();
    activeCleanup = null;
    resetDirectoryAvatars();
    trap?.release();
    overlay.remove();
    if (closed) return;
    closed = true;
    deps.onClose?.();
  };

  const finishCreated = (chat: DialogChat, alreadyPublished = false): void => {
    if (!alreadyPublished) deps.onCreated?.(chat);
    close();
    deps.onOpenChat(chat.id);
  };

  const openDialog = async (userId: number): Promise<void> => {
    if (busy) return;
    busy = true;
    note(homeError, "");
    try {
      const chat = await deps.createDialog(userId);
      finishCreated(chat);
    } catch (error) {
      busy = false;
      note(homeError, describeError(error, i18n));
    }
  };

  const directoryRow = (row: DirectoryRow): HTMLElement => {
    const open = el("button", {
      type: "button",
      class: "gc-chat-open gc-new-chat-person-button",
      "aria-label": row.title,
    }, [personCopy(row), icon("chevron", "gc-icon gc-new-chat-chevron")]);
    open.addEventListener("click", () => void openDialog(row.userId));
    return el("div", { class: "gc-chat-row gc-new-chat-person", role: "listitem" }, [avatarNode(row), open]);
  };

  const renderDirectory = (state: SearchState): void => {
    resetDirectoryAvatars();
    clear(directoryList);
    const savedLabel = i18n.t("chat.savedMessages");
    if (savedRowVisible(directoryInput.value, savedLabel)) {
      directoryList.append(directoryRow(savedRow(self, savedLabel)));
    }
    note(homeError, "");
    switch (state.phase) {
      case "idle":
        note(directoryHint, i18n.t("chatList.searchHint"));
        break;
      case "loading":
        note(directoryHint, i18n.t("common.loading"));
        break;
      case "results":
        note(directoryHint, "");
        for (const row of userRows(state.users, self.id)) directoryList.append(directoryRow(row));
        break;
      case "empty":
        note(directoryHint, i18n.t("chatList.noResults"));
        break;
      case "error":
        note(directoryHint, "");
        note(homeError, describeError(state.error, i18n));
        break;
    }
  };

  const controllerPorts = {
    setTimer: deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clearTimer: deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  };
  const directoryController = new SearchController({
    search: async (query) => (await deps.search(query)).users ?? [],
    onState: renderDirectory,
    ...controllerPorts,
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
  });
  directoryInput.addEventListener("input", () => directoryController.input(directoryInput.value));

  const actionButton = (
    action: string,
    glyph: IconName,
    label: string,
    hint: string,
    run: () => void,
    primary = false,
  ): HTMLButtonElement => {
    const button = el("button", {
      type: "button",
      class: `gc-new-chat-action${primary ? " is-primary" : ""}`,
      "data-action": action,
    }, [
      el("span", { class: "gc-new-chat-action-icon", "aria-hidden": "true" }, [icon(glyph)]),
      el("span", { class: "gc-new-chat-action-copy" }, [
        el("strong", {}, [label]),
        el("span", {}, [hint]),
      ]),
      icon("chevron", "gc-icon gc-new-chat-action-chevron"),
    ]);
    button.addEventListener("click", run);
    return button;
  };

  const actions = el("div", { class: "gc-new-chat-actions" }, [
    actionButton("direct", "user", text("direct"), text("directHint"), () => directoryInput.focus(), true),
    actionButton("group", "users", text("group"), text("groupHint"), () => { void showCreation("group"); }),
    actionButton("broadcast", "send", text("broadcast"), text("broadcastHint"), () => { void showCreation("broadcast"); }),
    actionButton("channel", "globe", text("channel"), text("channelHint"), () => { void showCreation("channel"); }),
    actionButton("bot", "spark", text("bot"), text("botHint"), () => {
      if (!deps.onCreateBot) {
        note(homeError, text("unavailable"));
        return;
      }
      close();
      deps.onCreateBot();
    }),
  ]);

  const searchBox = el("div", { class: "gc-new-chat-search-box" }, [
    el("span", { class: "gc-new-chat-search-icon", "aria-hidden": "true" }, [icon("search")]),
    directoryInput,
  ]);
  const homeRoot = el("div", { class: "gc-new-chat-home" }, [
    el("p", { class: "gc-new-chat-lead" }, [text("hubLead")]),
    actions,
    el("section", { class: "gc-new-chat-people", "aria-label": text("people") }, [
      el("div", { class: "gc-new-chat-section-title" }, [text("people")]),
      searchBox,
      directoryHint,
      homeError,
      directoryList,
    ]),
  ]);

  const backButton = el("button", {
    type: "button",
    class: "gc-icon-btn gc-new-chat-back",
    "aria-label": i18n.t("common.back"),
    hidden: true,
  }, [icon("back")]);
  const titleNode = el("h3", { class: "gc-forward-title gc-new-chat-title" }, [text("hubTitle")]);
  const closeButton = el("button", {
    type: "button",
    class: "gc-icon-btn gc-new-chat-close",
    "aria-label": i18n.t("common.close"),
  }, [icon("close")]);
  const header = el("div", { class: "gc-new-chat-header" }, [backButton, titleNode, closeButton]);
  const body = el("div", { class: "gc-new-chat-body" });
  const panel = el("div", {
    class: "gc-forward-panel gc-new-chat-panel",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": text("hubTitle"),
  }, [header, body]);
  const overlay = el("div", { class: "gc-overlay gc-new-chat-overlay" }, [panel]);
  // Do not summon the software keyboard on open: the purpose of this first screen is to let the
  // person choose WHAT to create. “Direct message” and the search field explicitly focus search.
  trap = createFocusTrap(overlay);



  function showHome(focus = false): void {
    if (busy || closed) return;
    creationRevision += 1;
    activeCleanup?.();
    activeCleanup = null;
    mode = "home";
    titleNode.textContent = text("hubTitle");
    backButton.hidden = true;
    clear(body);
    body.append(homeRoot);
    if (focus) directoryInput.focus();
  }

  async function showCreation(target: NewChatCreationTarget): Promise<void> {
    if (busy || closed) return;
    const revision = ++creationRevision;
    directoryController.cancel();
    activeCleanup?.();
    activeCleanup = null;
    mode = target;
    titleNode.textContent = text(target === "group" ? "groupTitle" : target === "broadcast" ? "broadcastTitle" : "channelTitle");
    backButton.hidden = false;
    const loading = el("p", { class: "gc-palette-empty", "aria-live": "polite" }, [i18n.t("common.loading")]);
    clear(body);
    body.append(loading);

    try {
      const { createNewChatCreationForm } = await import("./new_chat_creation_form.ts");
      if (closed || revision !== creationRevision || mode !== target) return;
      const view = createNewChatCreationForm(target, {
        i18n,
        self,
        text,
        search: deps.search,
        ...(deps.avatarApi ? { avatarApi: deps.avatarApi } : {}),
        finishCreated,
        isClosed: () => closed,
        isBusy: () => busy,
        setBusy: (value) => { busy = value; },
        setTimer: controllerPorts.setTimer,
        clearTimer: controllerPorts.clearTimer,
        ...(deps.listContacts ? { listContacts: deps.listContacts } : {}),
        ...(deps.createGroup ? { createGroup: deps.createGroup } : {}),
        ...(deps.createChannel ? { createChannel: deps.createChannel } : {}),
        ...(deps.addMembers ? { addMembers: deps.addMembers } : {}),
        ...(deps.onCreated ? { onCreated: deps.onCreated } : {}),
        ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
      });
      activeCleanup = view.cleanup;
      clear(body);
      body.append(view.root);
      const first = view.root.querySelector?.("input") as HTMLInputElement | null | undefined;
      first?.focus();
    } catch (cause) {
      if (closed || revision !== creationRevision || mode !== target) return;
      loading.textContent = describeError(cause, i18n);
    }
  }

  backButton.addEventListener("click", () => showHome(true));
  closeButton.addEventListener("click", close);
  overlay.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    if (mode === "home") close();
    else showHome(true);
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

  renderDirectory({ phase: "idle" });
  showHome();

  return {
    root: overlay,
    focus() { trap?.activate(); },
    close,
  };
}
