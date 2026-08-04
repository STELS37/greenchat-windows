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
  const hero = el("div", { class: "gc-info-hero" }, [
    heroAvatar,
    el("h3", { class: "gc-info-name" }, [deps.title]),
    el("p", { class: "gc-info-subtitle" }, [deps.subtitle]),
    heroActions,
  ]);

  const facts = el("div", { class: "gc-info-facts" });
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
    el("div", { class: "gc-info-scroll" }, [hero, facts, roster, requests, status]),
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

  const memberRow = (member: ChatMember): HTMLElement => {
    const name = member.name?.trim() || member.username;
    const avatar = el("span", {
      class: "gc-info-member-avatar gc-avatar",
      "aria-hidden": "true",
      "data-tone": String(avatarTone(name)),
    }, [initials(name)]);
    const avatarFileId = (member as ChatMember & { avatar_file_id?: number | null }).avatar_file_id ?? null;
    if (deps.photoApi) void bindAvatarImage(avatar, deps.photoApi, avatarFileId, name);
    const row = el(deps.onOpenMember ? "button" : "div", {
      class: "gc-info-member",
      ...(deps.onOpenMember ? { type: "button" } : {}),
    }, [
      avatar,
      el("span", { class: "gc-info-member-body" }, [
        el("span", { class: "gc-info-member-name" }, [name]),
        el("span", { class: "gc-info-member-handle" }, [member.username ? `@${member.username}` : ""]),
      ]),
      ...(member.role && member.role !== "member"
        ? [el("span", { class: "gc-info-member-role" }, [i18n.t(`chatInfo.role.${member.role}`)])]
        : []),
    ]);
    if (deps.onOpenMember) row.addEventListener("click", () => { close(); deps.onOpenMember?.(member.id); });
    return row;
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

  paintRoster(deps.members, null);

  void (async () => {
    try {
      const detail = await deps.loadChat();
      if (closed) return;
      clear(facts);
      shownValues.clear();
      const rows: Array<HTMLElement | null> = [];
      const about = (detail.about ?? "").trim();
      if (about) rows.push(fact(i18n.t("chatInfo.about"), about, "info"));
      const handle = (detail.username ?? "").trim();
      const isDialog = deps.peerId !== null;
      if (handle) rows.push(fact(
        i18n.t(isDialog ? "chatInfo.username" : "chatInfo.link"),
        `@${handle}`,
        isDialog ? "user" : "globe",
      ));
      appendFacts(rows);
      if (typeof detail.members_count === "number") paintRoster(deps.members, detail.members_count);
      if (!isDialog) paintHeroPhoto(detail.photo_file_id ?? null);
      paintPhotoEditor(detail);
      const staff = detail.my_role === "owner" || detail.my_role === "admin";
      if (detail.join_mode === "approve" && staff && detail.my_rights?.can_invite !== false) {
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
