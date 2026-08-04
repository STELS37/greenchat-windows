// Chat/profile information sheet reached from the conversation header. The sheet paints data already
// known by the caller immediately, then enriches it with profile/chat reads. V183 adds the two missing
// ownership flows: staff can change a group/channel photo and moderate request-only channel admission.
import type { I18n } from "../i18n.ts";
import type { ApiLike } from "./api.ts";
import { describeError } from "./api.ts";
import { el, clear } from "../dom.ts";
import { createFocusTrap } from "../a11y.ts";
import { icon } from "../icons.ts";
import { avatarTone, initials } from "./message_menu.ts";
import type { ChatMember } from "./types.ts";
import {
  avatarText,
  bindAvatarImage,
  uploadAvatarFile,
  type AvatarImageBinding,
  type AvatarUploadPort,
} from "./avatar_media.ts";

export interface ChatInfoDetail {
  kind?: string;
  title?: string;
  about?: string | null;
  username?: string | null;
  photo_file_id?: number | null;
  members_count?: number;
  my_role?: string;
  my_rights?: Record<string, boolean>;
  join_mode?: string;
  slow_mode_sec?: number;
  history_for_new?: "visible" | "hidden";
  noforwards?: boolean;
  sensitive?: boolean;
}

export interface ChatInfoProfile {
  username?: string;
  name?: string;
  bio?: string | null;
  avatar_file_id?: number | null;
  is_bot?: boolean;
}

export interface ChatJoinRequest {
  id: number;
  username?: string;
  name?: string;
  avatar_file_id?: number | null;
  requested_at?: number;
}

export interface ChatInfoDeps {
  i18n: I18n;
  title: string;
  subtitle: string;
  kind: string;
  peerId: number | null;
  members: ChatMember[];
  loadChat(): Promise<ChatInfoDetail>;
  loadUser(userId: number): Promise<ChatInfoProfile>;
  onOpenMember?(userId: number): void;
  /** Signed-media URL provider. Omitted by tests or legacy shells; initials remain a complete fallback. */
  photoApi?: Pick<ApiLike, "get">;
  media?: AvatarUploadPort;
  updatePhoto?(fileId: number): Promise<ChatInfoDetail>;
  onPhotoChanged?(fileId: number): void;
  loadJoinRequests?(): Promise<ChatJoinRequest[]>;
  approveJoinRequest?(userId: number): Promise<unknown>;
  denyJoinRequest?(userId: number): Promise<unknown>;
  selfId?: number;
  saveAdmin?(userId: number, payload: { rights: Record<string, boolean>; custom_title: string | null; anonymous?: boolean }): Promise<unknown>;
  removeAdmin?(userId: number): Promise<unknown>;
  removeMember?(userId: number): Promise<unknown>;
  saveGroup?(payload: {
    title: string;
    about: string;
    slow_mode_sec: number;
    join_mode: "open" | "approve";
    history_for_new: "visible" | "hidden";
    noforwards?: boolean;
  }): Promise<ChatInfoDetail>;
  onTitleChanged?(title: string): void;
  onClose?(): void;
}

export interface ChatInfoOverlay {
  root: HTMLElement;
  focus(): void;
  close(): void;
}

export function createChatInfoOverlay(deps: ChatInfoDeps): ChatInfoOverlay {
  const { i18n } = deps;
  let closed = false;
  let detail: ChatInfoDetail | null = null;
  let members: ChatMember[] = deps.members.map((member) => member.rights
    ? { ...member, rights: { ...member.rights } }
    : { ...member });
  let heroBinding: AvatarImageBinding | null = null;

  const closeBtn = el("button", {
    type: "button",
    class: "gc-icon-btn gc-info-close",
    title: i18n.t("common.close"),
    "aria-label": i18n.t("common.close"),
  }, [icon("close")]);

  const heroAvatar = el("span", {
    class: "gc-info-avatar gc-avatar",
    "aria-hidden": "true",
    "data-tone": String(avatarTone(deps.title)),
  }, [initials(deps.title)]);
  const heroActions = el("div", { class: "gc-info-photo-actions" });
  const heroName = el("h3", { class: "gc-info-name" }, [deps.title]);
  const hero = el("div", { class: "gc-info-hero" }, [
    heroAvatar,
    heroName,
    el("p", { class: "gc-info-subtitle" }, [deps.subtitle]),
    heroActions,
  ]);

  const facts = el("div", { class: "gc-info-facts" });
  const management = el("section", { class: "gc-info-management" });
  const roster = el("div", { class: "gc-info-roster" });
  const requests = el("section", { class: "gc-info-requests" });
  const status = el("p", { class: "gc-info-status", role: "status", "aria-live": "polite" });

  const panel = el("div", {
    class: "gc-info-panel",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": i18n.t("chatInfo.title"),
  }, [
    el("div", { class: "gc-info-bar" }, [
      el("span", { class: "gc-info-bar-title" }, [i18n.t("chatInfo.title")]),
      closeBtn,
    ]),
    el("div", { class: "gc-info-scroll" }, [hero, facts, management, roster, requests, status]),
  ]);
  const overlay = el("div", { class: "gc-overlay gc-info-overlay" }, [panel]);
  const trap = createFocusTrap(overlay, { initialFocus: closeBtn });
  const shownValues = new Set<string>();

  const fact = (label: string, value: string, glyph: Parameters<typeof icon>[0]): HTMLElement | null => {
    const key = value.trim().toLowerCase();
    if (shownValues.has(key)) return null;
    shownValues.add(key);
    return el("div", { class: "gc-info-fact" }, [
      el("span", { class: "gc-info-fact-icon", "aria-hidden": "true" }, [icon(glyph)]),
      el("span", { class: "gc-info-fact-body" }, [
        el("span", { class: "gc-info-fact-value" }, [value]),
        el("span", { class: "gc-info-fact-label" }, [label]),
      ]),
    ]);
  };

  const appendFacts = (rows: Array<HTMLElement | null>): void => {
    facts.append(...rows.filter((row): row is HTMLElement => row !== null));
  };

  const ADMIN_RIGHTS = [
    "can_post",
    "can_edit_chat",
    "can_invite",
    "can_pin",
    "can_delete_others",
    "can_manage_admins",
  ] as const;
  const defaultAdminRights = (): Record<string, boolean> => ({
    can_post: true,
    can_edit_chat: true,
    can_invite: true,
    can_pin: true,
    can_delete_others: true,
    can_manage_admins: false,
  });
  const rank = (role?: string): number => role === "owner" ? 2 : role === "admin" ? 1 : 0;
  const canManageAdmins = (): boolean =>
    detail?.my_role === "owner" || detail?.my_rights?.can_manage_admins === true;
  const canRemoveMembers = (): boolean =>
    detail?.my_role === "owner" || detail?.my_rights?.can_delete_others === true;
  const option = (value: string, label: string, selected: boolean): HTMLOptionElement =>
    el("option", { value, selected }, [label]) as HTMLOptionElement;

  function renderGroupSettings(): void {
    clear(management);
    if (!detail || (deps.kind !== "group" && deps.kind !== "channel")) return;
    if (!deps.saveGroup || detail.my_rights?.can_edit_chat !== true) return;
    const title = el("input", {
      type: "text",
      class: "gc-input",
      value: detail.title ?? deps.title,
      maxlength: "128",
      "aria-label": i18n.t("chatInfo.groupTitle"),
    }) as HTMLInputElement;
    const about = el("textarea", {
      class: "gc-input gc-info-about-input",
      maxlength: "1024",
      "aria-label": i18n.t("chatInfo.groupAbout"),
    }) as HTMLTextAreaElement;
    about.value = detail.about ?? "";
    const slow = el("select", { class: "gc-select", "aria-label": i18n.t("chatInfo.slowMode") }, [
      ...[0, 10, 30, 60, 300, 900, 3600].map((seconds) => option(
        String(seconds),
        seconds === 0 ? i18n.t("chatInfo.slowOff") : i18n.t("chatInfo.slowSeconds", { seconds }),
        (detail?.slow_mode_sec ?? 0) === seconds,
      )),
    ]) as HTMLSelectElement;
    const join = el("select", { class: "gc-select", "aria-label": i18n.t("chatInfo.joinMode") }, [
      option("open", i18n.t("chatInfo.joinOpen"), detail.join_mode !== "approve"),
      option("approve", i18n.t("chatInfo.joinApprove"), detail.join_mode === "approve"),
    ]) as HTMLSelectElement;
    const history = el("select", { class: "gc-select", "aria-label": i18n.t("chatInfo.history") }, [
      option("visible", i18n.t("chatInfo.historyVisible"), detail.history_for_new !== "hidden"),
      option("hidden", i18n.t("chatInfo.historyHidden"), detail.history_for_new === "hidden"),
    ]) as HTMLSelectElement;
    const protect = el("input", { type: "checkbox", checked: detail.noforwards === true }) as HTMLInputElement;
    const save = el("button", {
      type: "submit",
      class: "gc-btn gc-btn-accent",
      "data-action": "save-group-settings",
    }, [i18n.t("common.save")]) as HTMLButtonElement;
    const fields: HTMLElement[] = [
      el("label", { class: "gc-info-field" }, [el("span", {}, [i18n.t("chatInfo.groupTitle")]), title]),
      el("label", { class: "gc-info-field" }, [el("span", {}, [i18n.t("chatInfo.groupAbout")]), about]),
      el("label", { class: "gc-info-field" }, [el("span", {}, [i18n.t("chatInfo.slowMode")]), slow]),
      el("label", { class: "gc-info-field" }, [el("span", {}, [i18n.t("chatInfo.joinMode")]), join]),
      el("label", { class: "gc-info-field" }, [el("span", {}, [i18n.t("chatInfo.history")]), history]),
    ];
    if (detail.my_role === "owner") {
      fields.push(el("label", { class: "gc-info-check" }, [protect, el("span", {}, [i18n.t("chatInfo.protectedContent")])]));
    }
    const form = el("form", { class: "gc-server-card gc-info-group-settings" }, [
      el("h4", {}, [i18n.t("chatInfo.groupSettings")]),
      ...fields,
      el("div", { class: "gc-server-actions" }, [save]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      status.textContent = i18n.t("common.loading");
      void deps.saveGroup!({
        title: title.value.trim(),
        about: about.value.trim(),
        slow_mode_sec: Number(slow.value),
        join_mode: join.value === "approve" ? "approve" : "open",
        history_for_new: history.value === "hidden" ? "hidden" : "visible",
        ...(detail?.my_role === "owner" ? { noforwards: protect.checked } : {}),
      }).then((saved) => {
        if (closed) return;
        detail = { ...detail, ...saved };
        const nextTitle = saved.title ?? title.value.trim();
        heroName.textContent = nextTitle;
        deps.onTitleChanged?.(nextTitle);
        status.textContent = i18n.t("settings.saved");
        renderGroupSettings();
      }).catch((error) => {
        if (!closed) status.textContent = describeError(error, i18n);
      }).finally(() => { if (!closed) save.disabled = false; });
    });
    management.append(form);
  }

  function openMemberEditor(member: ChatMember): void {
    clear(management);
    const name = member.name?.trim() || member.username || String(member.id);
    const rights = { ...defaultAdminRights(), ...(member.rights ?? {}) };
    const checks = new Map<string, HTMLInputElement>();
    const fields: HTMLElement[] = [];
    if (deps.saveAdmin && canManageAdmins()) {
      const customTitle = el("input", {
        type: "text",
        class: "gc-input",
        maxlength: "16",
        value: member.custom_title ?? "",
        "aria-label": i18n.t("chatInfo.adminTitle"),
      }) as HTMLInputElement;
      fields.push(el("label", { class: "gc-info-field" }, [
        el("span", {}, [i18n.t("chatInfo.adminTitle")]),
        customTitle,
      ]));
      for (const key of ADMIN_RIGHTS) {
        const check = el("input", { type: "checkbox", checked: rights[key] === true }) as HTMLInputElement;
        checks.set(key, check);
        fields.push(el("label", { class: "gc-info-check" }, [check, el("span", {}, [i18n.t(`chatInfo.right.${key}`)])]));
      }
      const anonymous = el("input", { type: "checkbox", checked: member.anonymous === true }) as HTMLInputElement;
      if (detail?.my_role === "owner") {
        fields.push(el("label", { class: "gc-info-check" }, [anonymous, el("span", {}, [i18n.t("chatInfo.anonymousAdmin")])]));
      }
      const saveAdmin = el("button", {
        type: "button",
        class: "gc-btn gc-btn-accent",
        "data-action": "save-admin",
      }, [member.role === "admin" ? i18n.t("common.save") : i18n.t("chatInfo.promoteAdmin")]) as HTMLButtonElement;
      saveAdmin.addEventListener("click", () => {
        if (saveAdmin.disabled) return;
        saveAdmin.disabled = true;
        const nextRights = Object.fromEntries(ADMIN_RIGHTS.map((key) => [key, checks.get(key)?.checked === true]));
        void deps.saveAdmin!(member.id, {
          rights: nextRights,
          custom_title: customTitle.value.trim() || null,
          ...(detail?.my_role === "owner" ? { anonymous: anonymous.checked } : {}),
        }).then(() => {
          if (closed) return;
          members = members.map((item) => item.id === member.id ? {
            ...item,
            role: "admin",
            rights: nextRights,
            custom_title: customTitle.value.trim() || null,
            ...(detail?.my_role === "owner" ? { anonymous: anonymous.checked } : {}),
          } : item);
          status.textContent = i18n.t("settings.saved");
          renderGroupSettings();
          paintRoster(members, detail?.members_count ?? members.length);
        }).catch((error) => {
          if (!closed) status.textContent = describeError(error, i18n);
        }).finally(() => { if (!closed) saveAdmin.disabled = false; });
      });
      fields.push(el("div", { class: "gc-server-actions" }, [saveAdmin]));
    }
    const destructive: HTMLElement[] = [];
    if (member.role === "admin" && deps.removeAdmin && canManageAdmins()) {
      const demote = el("button", { type: "button", class: "gc-btn", "data-action": "remove-admin" }, [
        i18n.t("chatInfo.demoteAdmin"),
      ]) as HTMLButtonElement;
      demote.addEventListener("click", () => {
        demote.disabled = true;
        void deps.removeAdmin!(member.id).then(() => {
          if (closed) return;
          members = members.map((item) => {
            if (item.id !== member.id) return item;
            const { rights: _rights, ...rest } = item;
            return { ...rest, role: "member", custom_title: null, anonymous: false };
          });
          status.textContent = i18n.t("settings.saved");
          renderGroupSettings();
          paintRoster(members, detail?.members_count ?? members.length);
        }).catch((error) => { if (!closed) status.textContent = describeError(error, i18n); })
          .finally(() => { if (!closed) demote.disabled = false; });
      });
      destructive.push(demote);
    }
    if (deps.removeMember && canRemoveMembers() && rank(member.role) < rank(detail?.my_role)) {
      const remove = el("button", { type: "button", class: "gc-btn gc-btn-danger", "data-action": "remove-member" }, [
        i18n.t("chatInfo.removeMember"),
      ]) as HTMLButtonElement;
      remove.addEventListener("click", () => {
        remove.disabled = true;
        void deps.removeMember!(member.id).then(() => {
          if (closed) return;
          members = members.filter((item) => item.id !== member.id);
          status.textContent = i18n.t("chatInfo.memberRemoved");
          renderGroupSettings();
          paintRoster(members, members.length);
        }).catch((error) => { if (!closed) status.textContent = describeError(error, i18n); })
          .finally(() => { if (!closed) remove.disabled = false; });
      });
      destructive.push(remove);
    }
    const cancel = el("button", { type: "button", class: "gc-btn", "data-action": "cancel-member-edit" }, [
      i18n.t("common.cancel"),
    ]);
    cancel.addEventListener("click", () => renderGroupSettings());
    management.append(el("section", { class: "gc-server-card gc-info-member-editor" }, [
      el("h4", {}, [i18n.t("chatInfo.manageMember", { name })]),
      ...fields,
      ...(destructive.length ? [el("div", { class: "gc-server-actions gc-info-danger-actions" }, destructive)] : []),
      cancel,
    ]));
  }

  const memberRow = (member: ChatMember): HTMLElement => {
    const name = member.name?.trim() || member.username || String(member.id);
    const avatar = el("span", {
      class: "gc-info-member-avatar gc-avatar",
      "aria-hidden": "true",
      "data-tone": String(avatarTone(name)),
    }, [initials(name)]);
    if (deps.photoApi) void bindAvatarImage(avatar, deps.photoApi, member.avatar_file_id ?? null, name);
    const open = el(deps.onOpenMember ? "button" : "span", {
      class: "gc-info-member-open",
      ...(deps.onOpenMember ? { type: "button" } : {}),
    }, [
      avatar,
      el("span", { class: "gc-info-member-body" }, [
        el("span", { class: "gc-info-member-name" }, [name]),
        el("span", { class: "gc-info-member-handle" }, [member.username ? `@${member.username}` : ""]),
      ]),
    ]);
    if (deps.onOpenMember) open.addEventListener("click", () => { close(); deps.onOpenMember?.(member.id); });
    const roleLabel = member.custom_title?.trim()
      || (member.role && member.role !== "member" ? i18n.t(`chatInfo.role.${member.role}`) : "");
    const mayEditAdmin = member.role !== "owner" && member.id !== deps.selfId && canManageAdmins();
    const mayRemove = member.role !== "owner"
      && member.id !== deps.selfId
      && canRemoveMembers()
      && rank(member.role) < rank(detail?.my_role);
    const manage = mayEditAdmin || mayRemove
      ? el("button", {
          type: "button",
          class: "gc-btn gc-info-member-manage",
          "data-action": "manage-member",
          "data-user-id": String(member.id),
        }, [i18n.t("chatInfo.manage")])
      : null;
    manage?.addEventListener("click", () => openMemberEditor(member));
    return el("div", { class: "gc-info-member", role: "listitem" }, [
      open,
      ...(roleLabel ? [el("span", { class: "gc-info-member-role" }, [roleLabel])] : []),
      ...(manage ? [manage] : []),
    ]);
  };

  const paintRoster = (list: ChatMember[], total: number | null): void => {
    clear(roster);
    if (deps.kind !== "group" && deps.kind !== "channel") return;
    if (list.length === 0) return;
    roster.append(
      el("div", { class: "gc-info-section" }, [
        el("h4", {}, [i18n.t("chatInfo.members")]),
        el("span", {}, [String(total ?? list.length)]),
      ]),
      el("div", { class: "gc-info-member-list", role: "list" }, list.map(memberRow)),
    );
  };

  const paintHeroPhoto = (fileId: number | null): void => {
    if (!deps.photoApi) return;
    heroBinding?.destroy();
    heroBinding = bindAvatarImage(heroAvatar, deps.photoApi, fileId, deps.title);
  };

  const paintPhotoEditor = (detail: ChatInfoDetail): void => {
    clear(heroActions);
    if (!deps.media || !deps.updatePhoto || detail.my_rights?.can_edit_chat !== true) return;
    if (deps.kind !== "group" && deps.kind !== "channel") return;
    const input = el("input", {
      type: "file",
      class: "gc-visually-hidden",
      accept: "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif",
      "aria-label": avatarText(i18n.locale, "change"),
    }) as HTMLInputElement;
    const button = el("button", { type: "button", class: "gc-btn", title: avatarText(i18n.locale, "change") }, [
      icon("camera"), avatarText(i18n.locale, "change"),
    ]) as HTMLButtonElement;
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file || !deps.media || !deps.updatePhoto) return;
      button.disabled = true;
      status.textContent = i18n.t("common.loading");
      void (async () => {
        try {
          const uploaded = await uploadAvatarFile(file, deps.media as AvatarUploadPort);
          const changed = await deps.updatePhoto!(uploaded.file_id);
          if (closed) return;
          const fileId = changed.photo_file_id ?? uploaded.file_id;
          paintHeroPhoto(fileId);
          deps.onPhotoChanged?.(fileId);
          status.textContent = i18n.t("settings.saved");
        } catch (err) {
          if (closed) return;
          const code = err instanceof Error ? err.message : "";
          status.textContent = code === "AVATAR_TOO_LARGE"
            ? avatarText(i18n.locale, "tooLarge")
            : code === "AVATAR_IMAGE_REQUIRED"
              ? avatarText(i18n.locale, "invalid")
              : describeError(err, i18n);
        } finally {
          if (!closed) button.disabled = false;
        }
      })();
    });
    heroActions.append(button, input);
  };

  const requestRow = (request: ChatJoinRequest): HTMLElement => {
    const name = request.name?.trim() || request.username || String(request.id);
    const avatar = el("span", {
      class: "gc-info-member-avatar gc-avatar",
      "aria-hidden": "true",
      "data-tone": String(avatarTone(name)),
    }, [initials(name)]);
    if (deps.photoApi) void bindAvatarImage(avatar, deps.photoApi, request.avatar_file_id ?? null, name);
    const approve = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [
      avatarText(i18n.locale, "approve"),
    ]) as HTMLButtonElement;
    const deny = el("button", { type: "button", class: "gc-btn" }, [avatarText(i18n.locale, "deny")]) as HTMLButtonElement;
    const row = el("div", { class: "gc-info-request", role: "listitem" }, [
      avatar,
      el("span", { class: "gc-info-member-body" }, [
        el("span", { class: "gc-info-member-name" }, [name]),
        el("span", { class: "gc-info-member-handle" }, [request.username ? `@${request.username}` : ""]),
      ]),
      el("span", { class: "gc-info-request-actions" }, [approve, deny]),
    ]);
    const resolve = async (action: "approve" | "deny"): Promise<void> => {
      approve.disabled = true;
      deny.disabled = true;
      try {
        if (action === "approve") await deps.approveJoinRequest?.(request.id);
        else await deps.denyJoinRequest?.(request.id);
        if (closed) return;
        row.remove();
        const list = requests.querySelector?.(".gc-info-request-list");
        if (list && list.children.length === 0) {
          clear(requests);
          requests.append(
            el("h4", {}, [avatarText(i18n.locale, "requests")]),
            el("p", { class: "gc-settings-note" }, [avatarText(i18n.locale, "empty")]),
          );
        }
      } catch (err) {
        if (!closed) status.textContent = describeError(err, i18n);
        if (!closed) { approve.disabled = false; deny.disabled = false; }
      }
    };
    approve.addEventListener("click", () => { void resolve("approve"); });
    deny.addEventListener("click", () => { void resolve("deny"); });
    return row;
  };

  const loadAndPaintRequests = async (): Promise<void> => {
    if (!deps.loadJoinRequests || !deps.approveJoinRequest || !deps.denyJoinRequest) return;
    clear(requests);
    requests.append(
      el("h4", {}, [avatarText(i18n.locale, "requests")]),
      el("p", { class: "gc-settings-note" }, [avatarText(i18n.locale, "pending")]),
    );
    try {
      const rows = await deps.loadJoinRequests();
      if (closed) return;
      clear(requests);
      requests.append(el("h4", {}, [avatarText(i18n.locale, "requests")]), rows.length > 0
        ? el("div", { class: "gc-info-request-list", role: "list" }, rows.map(requestRow))
        : el("p", { class: "gc-settings-note" }, [avatarText(i18n.locale, "empty")]));
    } catch (err) {
      if (!closed) status.textContent = describeError(err, i18n);
      clear(requests);
    }
  };

  paintRoster(members, null);

  void (async () => {
    try {
      const loaded = await deps.loadChat();
      if (closed) return;
      detail = loaded;
      clear(facts);
      shownValues.clear();
      const rows: Array<HTMLElement | null> = [];
      const about = (loaded.about ?? "").trim();
      if (about) rows.push(fact(i18n.t("chatInfo.about"), about, "info"));
      const handle = (loaded.username ?? "").trim();
      const isDialog = deps.peerId !== null;
      if (handle) rows.push(fact(
        i18n.t(isDialog ? "chatInfo.username" : "chatInfo.link"),
        `@${handle}`,
        isDialog ? "user" : "globe",
      ));
      appendFacts(rows);
      paintRoster(members, typeof loaded.members_count === "number" ? loaded.members_count : members.length);
      if (!isDialog) paintHeroPhoto(loaded.photo_file_id ?? null);
      paintPhotoEditor(loaded);
      renderGroupSettings();
      const staff = loaded.my_role === "owner" || loaded.my_role === "admin";
      if (loaded.join_mode === "approve" && staff && loaded.my_rights?.can_invite !== false) {
        void loadAndPaintRequests();
      }
    } catch {
      if (!closed) status.textContent = i18n.t("chatInfo.partial");
    }
    if (closed || deps.peerId === null) return;
    try {
      const profile = await deps.loadUser(deps.peerId);
      if (closed) return;
      paintHeroPhoto(profile.avatar_file_id ?? null);
      const rows: Array<HTMLElement | null> = [];
      const bio = (profile.bio ?? "").trim();
      if (bio) rows.push(fact(i18n.t("chatInfo.bio"), bio, "info"));
      const handle = (profile.username ?? "").trim();
      if (handle) rows.push(fact(i18n.t("chatInfo.username"), `@${handle}`, "user"));
      appendFacts(rows);
    } catch {
      if (!closed) status.textContent = i18n.t("chatInfo.partial");
    }
  })();

  function close(): void {
    if (closed) return;
    closed = true;
    heroBinding?.destroy();
    heroBinding = null;
    trap.release();
    overlay.remove();
    deps.onClose?.();
  }

  closeBtn.addEventListener("click", () => close());
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") { event.stopPropagation(); close(); }
  });

  return {
    root: overlay,
    focus() { trap.activate(); closeBtn.focus(); },
    close,
  };
}
