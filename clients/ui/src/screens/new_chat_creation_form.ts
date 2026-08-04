// Lazy-loaded advanced creation form for groups, broadcasts and channels. The lightweight creation
// hub stays in the initial web bundle; contacts, participant search and channel visibility controls are
// fetched only after the person chooses one of these creation modes.
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";
import { describeError } from "./api.ts";
import type { DialogChat, GlobalSearchResult } from "./api.ts";
import type { SelfRef } from "./chat_model.ts";
import {
  SearchController,
  userRows,
  type DirectoryRow,
  type SearchState,
} from "./new_chat_model.ts";
import { serviceAccountLabel } from "./service_account.ts";
import { icon } from "../icons.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { contactSubtitle, contactTitle, type ContactRow } from "./contacts_model.ts";
import type { NewChatStringKey } from "./new_chat_strings.ts";

export interface NewGroupInput {
  title: string;
  about: string;
  memberIds: number[];
}

export interface NewChannelInput {
  title: string;
  about: string;
  username: string | null;
  joinMode: "open" | "approve";
}

export type NewChatCreationTarget = "group" | "broadcast" | "channel";

type Text = (
  key: NewChatStringKey,
  vars?: Readonly<Record<string, string | number>>,
) => string;

type MemberPicker = {
  root: HTMLElement;
  selectedIds(): number[];
  cancel(): void;
};

export interface NewChatCreationFormDeps {
  i18n: I18n;
  self: SelfRef;
  text: Text;
  search(q: string): Promise<GlobalSearchResult>;
  listContacts?(): Promise<ContactRow[]>;
  createGroup?(input: NewGroupInput): Promise<DialogChat>;
  createChannel?(input: NewChannelInput): Promise<DialogChat>;
  addMembers?(chatId: number, userIds: number[]): Promise<DialogChat>;
  onCreated?(chat: DialogChat): void;
  finishCreated(chat: DialogChat, alreadyPublished?: boolean): void;
  isClosed(): boolean;
  isBusy(): boolean;
  setBusy(value: boolean): void;
  debounceMs?: number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface NewChatCreationForm {
  root: HTMLElement;
  cleanup(): void;
}

export function createNewChatCreationForm(
  target: NewChatCreationTarget,
  deps: NewChatCreationFormDeps,
): NewChatCreationForm {
  const { i18n, self, text } = deps;

  const note = (node: HTMLElement, value: string): void => {
    node.textContent = value;
    node.style.display = value ? "block" : "none";
  };

  const field = (label: string, control: HTMLElement, hint = ""): HTMLElement => el("label", {
    class: "gc-new-chat-field",
  }, [
    el("span", { class: "gc-new-chat-field-label" }, [label]),
    control,
    hint ? el("span", { class: "gc-new-chat-field-hint" }, [hint]) : "",
  ]);

  const avatarNode = (row: DirectoryRow): HTMLElement => {
    const seed = row.avatarSeed ?? row.title;
    return el("div", {
      class: "gc-avatar",
      "data-tone": String(avatarTone(seed)),
      "aria-hidden": "true",
    }, [initials(seed)]);
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

  const makeMemberPicker = (): MemberPicker => {
    const selected = new Map<number, DirectoryRow>();
    let state: SearchState = { phase: "idle" };
    let contacts: DirectoryRow[] = [];
    let contactsPhase: "loading" | "ready" | "error" = deps.listContacts ? "loading" : "ready";
    let contactsError: unknown = null;
    let cancelled = false;
    const selectedBar = el("div", { class: "gc-new-chat-selected", "aria-live": "polite" });
    const input = el("input", {
      type: "search",
      class: "gc-input gc-new-chat-member-search",
      autocomplete: "off",
      placeholder: text("searchParticipants"),
      "aria-label": text("searchParticipants"),
    }) as HTMLInputElement;
    const results = el("div", { class: "gc-new-chat-member-results" });
    const status = el("p", { class: "gc-new-chat-member-status", "aria-live": "polite" });

    const contactRows = (rows: ContactRow[]): DirectoryRow[] => rows
      .filter((row) => row.id !== self.id)
      .map((row) => ({
        kind: "user" as const,
        userId: row.id,
        title: contactTitle(row),
        subtitle: contactSubtitle(row),
        avatarSeed: row.name.trim() || row.username || contactTitle(row),
      }));

    const visibleRows = (): DirectoryRow[] => {
      const query = input.value.trim().replace(/^@+/, "").toLocaleLowerCase();
      const local = contacts.filter((row) => !query || [row.title, row.subtitle]
        .some((value) => value.toLocaleLowerCase().includes(query)));
      const remote = state.phase === "results" ? userRows(state.users, self.id) : [];
      const merged = new Map<number, DirectoryRow>();
      for (const row of local) merged.set(row.userId, row);
      for (const row of remote) if (!merged.has(row.userId)) merged.set(row.userId, row);
      return [...merged.values()];
    };

    const paintRow = (row: DirectoryRow): void => {
      const chosen = selected.has(row.userId);
      const button = el("button", {
        type: "button",
        class: `gc-new-chat-member-row${chosen ? " is-selected" : ""}`,
        "aria-pressed": chosen,
        "data-user-id": String(row.userId),
      }, [
        avatarNode(row),
        personCopy(row),
        el("span", { class: "gc-new-chat-member-check", "aria-hidden": "true" }, [
          icon(chosen ? "check" : "plus"),
        ]),
      ]);
      button.addEventListener("click", () => {
        if (selected.has(row.userId)) selected.delete(row.userId);
        else selected.set(row.userId, row);
        paint();
      });
      results.append(button);
    };

    const paint = (): void => {
      clear(selectedBar);
      selectedBar.append(el("span", { class: "gc-new-chat-selected-count" }, [
        text("selectedCount", { count: selected.size }),
      ]));
      for (const row of selected.values()) {
        const chip = el("button", {
          type: "button",
          class: "gc-new-chat-member-chip",
          "data-user-id": String(row.userId),
          "aria-label": `${row.title} ×`,
        }, [row.title, icon("close")]);
        chip.addEventListener("click", () => {
          selected.delete(row.userId);
          paint();
        });
        selectedBar.append(chip);
      }

      clear(results);
      const rows = visibleRows();
      for (const row of rows) paintRow(row);

      if (state.phase === "loading") {
        note(status, i18n.t("common.loading"));
      } else if (state.phase === "error" && rows.length === 0) {
        note(status, describeError(state.error, i18n));
      } else if (state.phase === "empty" && rows.length === 0) {
        note(status, i18n.t("chatList.noResults"));
      } else if (contactsPhase === "loading" && rows.length === 0) {
        note(status, i18n.t("common.loading"));
      } else if (contactsPhase === "error" && rows.length === 0 && state.phase === "idle") {
        note(status, describeError(contactsError, i18n));
      } else if (rows.length > 0) {
        note(status, input.value.trim()
          ? ""
          : i18n.t("contacts.count", { count: String(contacts.length) }));
      } else if (contactsPhase === "ready" && state.phase === "idle") {
        note(status, i18n.t("contacts.empty"));
      } else {
        note(status, text("searchParticipantsHint"));
      }
    };

    const controller = new SearchController({
      search: async (query) => (await deps.search(query)).users ?? [],
      onState: (next) => { state = next; paint(); },
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    });
    input.addEventListener("input", () => controller.input(input.value));
    paint();
    if (deps.listContacts) {
      void deps.listContacts().then((rows) => {
        if (cancelled) return;
        contacts = contactRows(rows);
        contactsPhase = "ready";
        paint();
      }).catch((error: unknown) => {
        if (cancelled) return;
        contactsError = error;
        contactsPhase = "error";
        paint();
      });
    }
    return {
      root: el("section", { class: "gc-new-chat-members" }, [
        el("div", { class: "gc-new-chat-members-heading" }, [
          el("div", {}, [
            el("strong", {}, [text("participants")]),
            el("span", {}, [text("participantsHint")]),
          ]),
        ]),
        selectedBar,
        el("div", { class: "gc-new-chat-member-search-box" }, [
          el("span", { "aria-hidden": "true" }, [icon("search")]),
          input,
        ]),
        status,
        results,
      ]),
      selectedIds: () => [...selected.keys()],
      cancel: () => { cancelled = true; controller.cancel(); },
    };
  };

  const title = el("input", {
    class: "gc-input gc-new-chat-name",
    type: "text",
    autocomplete: "off",
    maxlength: "120",
    placeholder: text(target === "group"
      ? "groupNamePlaceholder"
      : target === "broadcast"
        ? "broadcastNamePlaceholder"
        : "channelNamePlaceholder"),
  }) as HTMLInputElement;
  const about = el("textarea", {
    class: "gc-input gc-textarea gc-new-chat-about",
    rows: "3",
    maxlength: "500",
    placeholder: text("descriptionOptional"),
  }) as HTMLTextAreaElement;
  const error = el("p", { class: "gc-chats-status gc-new-chat-form-error", role: "alert" });
  const memberPicker = makeMemberPicker();
  let publicChannel = false;
  let createdChannel: DialogChat | null = null;

  const username = el("input", {
    class: "gc-input gc-new-chat-username",
    type: "text",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    placeholder: text("usernamePlaceholder"),
  }) as HTMLInputElement;
  const usernameField = field(text("username"), username, text("usernameHint"));
  usernameField.hidden = true;
  const visibilityHint = el("p", { class: "gc-new-chat-visibility-hint" }, [text("privateHint")]);
  const privateButton = el("button", { type: "button", class: "gc-new-chat-choice is-active" }, [
    icon("lock"), text("private"),
  ]);
  const publicButton = el("button", { type: "button", class: "gc-new-chat-choice" }, [
    icon("globe"), text("public"),
  ]);
  const paintVisibility = (): void => {
    privateButton.setAttribute("class", `gc-new-chat-choice${publicChannel ? "" : " is-active"}`);
    publicButton.setAttribute("class", `gc-new-chat-choice${publicChannel ? " is-active" : ""}`);
    privateButton.setAttribute("aria-pressed", String(!publicChannel));
    publicButton.setAttribute("aria-pressed", String(publicChannel));
    usernameField.hidden = !publicChannel;
    visibilityHint.textContent = text(publicChannel ? "publicHint" : "privateHint");
  };
  privateButton.addEventListener("click", () => { publicChannel = false; paintVisibility(); });
  publicButton.addEventListener("click", () => { publicChannel = true; paintVisibility(); username.focus(); });
  paintVisibility();

  const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent gc-new-chat-submit" }, [
    text(target === "group" ? "createGroup" : target === "broadcast" ? "createBroadcast" : "createChannel"),
  ]) as HTMLButtonElement;
  const openCreated = el("button", {
    type: "button",
    class: "gc-btn gc-new-chat-open-created",
    hidden: true,
  }, [text("openCreated")]) as HTMLButtonElement;
  openCreated.addEventListener("click", () => {
    if (createdChannel) deps.finishCreated(createdChannel, true);
  });

  const setSubmitting = (submitting: boolean): void => {
    deps.setBusy(submitting);
    title.disabled = submitting;
    about.disabled = submitting;
    username.disabled = submitting;
    submit.disabled = submitting;
    privateButton.disabled = submitting;
    publicButton.disabled = submitting;
    submit.textContent = submitting
      ? text("creating")
      : text(target === "group" ? "createGroup" : target === "broadcast" ? "createBroadcast" : "createChannel");
  };

  const formChildren: Array<Node | string> = [
    field(text("name"), title),
    field(text("description"), about),
  ];
  if (target === "channel") {
    formChildren.push(
      el("section", { class: "gc-new-chat-visibility" }, [
        el("div", { class: "gc-new-chat-choice-row", role: "group" }, [privateButton, publicButton]),
        visibilityHint,
      ]),
      usernameField,
    );
  }
  formChildren.push(memberPicker.root, error, el("div", { class: "gc-new-chat-form-actions" }, [openCreated, submit]));

  const form = el("form", { class: "gc-new-chat-form" }, formChildren);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (deps.isBusy()) return;
    const cleanTitle = title.value.trim();
    if (!cleanTitle) {
      note(error, text("nameRequired"));
      title.focus();
      return;
    }
    const cleanAbout = about.value.trim();
    const cleanUsername = username.value.trim().replace(/^@+/, "");
    if (target === "channel" && publicChannel && !cleanUsername) {
      note(error, text("usernameRequired"));
      username.focus();
      return;
    }
    note(error, "");
    const memberIds = memberPicker.selectedIds();
    setSubmitting(true);
    void (async () => {
      try {
        if (target === "group") {
          if (!deps.createGroup) throw new Error(text("unavailable"));
          const chat = await deps.createGroup({
            title: cleanTitle,
            about: cleanAbout,
            memberIds,
          });
          deps.finishCreated(chat);
          return;
        }

        if (!deps.createChannel) throw new Error(text("unavailable"));
        let chat = createdChannel;
        if (!chat) {
          chat = await deps.createChannel(target === "broadcast"
            ? { title: cleanTitle, about: cleanAbout, username: null, joinMode: "approve" }
            : {
                title: cleanTitle,
                about: cleanAbout,
                username: publicChannel ? cleanUsername : null,
                joinMode: publicChannel ? "open" : "approve",
              });
          createdChannel = chat;
          deps.onCreated?.(chat);
        }
        if (memberIds.length > 0) {
          if (!deps.addMembers) throw new Error(text("unavailable"));
          chat = await deps.addMembers(chat.id, memberIds);
          createdChannel = chat;
        }
        deps.finishCreated(chat, true);
      } catch (cause) {
        if (deps.isClosed()) return;
        setSubmitting(false);
        note(error, cause instanceof Error && cause.message === text("unavailable")
          ? text("unavailable")
          : describeError(cause, i18n));
        // The channel itself may already exist if adding selected contacts failed. Keep it visible
        // and retry only the member step on the next submit instead of creating a duplicate channel.
        openCreated.hidden = createdChannel === null;
      }
    })();
  });

  return {
    root: form,
    cleanup() { memberPicker.cancel(); },
  };
}
