import type { Locale } from "../../ui/src/i18n.ts";
import { clear, el } from "../../ui/src/dom.ts";
import { createFocusTrap, type FocusTrap } from "../../ui/src/a11y.ts";
import { icon, type IconName } from "../../ui/src/icons.ts";
import { avatarTone, initials } from "../../ui/src/screens/message_menu.ts";

import type { ApiLike } from "../../ui/src/screens/api.ts";
import { bindAvatarImage, type AvatarImageBinding } from "../../ui/src/screens/avatar_media.ts";
import type { ChatMember } from "../../ui/src/screens/types.ts";

import { callDeviceText } from "../../ui/src/screens/call_device_strings.ts";
import type { CallDeviceSnapshot, CallMediaDeviceKind } from "../../ui/src/screens/call_model.ts";
import {
  conferenceText,
  type ConferenceTextKey,
} from "../../ui/src/screens/conference_strings.ts";
import type {
  ConferenceController,
  ConferenceParticipant,
  ConferenceState,
} from "../../ui/src/screens/conference_model.ts";
import type { ConferenceVideoTrack } from "./conference_media.ts";

export interface ConferenceOverlayDeps {
  controller: ConferenceController;
  locale: Locale;
  selfUserId: number;

  api?: Pick<ApiLike, "get" | "post">;
  title?: string;
}

export interface ConferenceOverlay {
  root: HTMLElement;
  render(state: ConferenceState): void;
  setTracks(tracks: readonly ConferenceVideoTrack[]): void;
  setTitle(title: string): void;
  destroy(): void;
}

interface TrackTile {
  track: ConferenceVideoTrack;
  root: HTMLElement;
  video: HTMLVideoElement;
  name: HTMLElement;
  pin: HTMLButtonElement;
}

const MAX_CONFERENCE_PARTICIPANTS = 5;

const participantOrder = (participant: ConferenceParticipant): number => {
  if (participant.role === "owner") return 0;
  if (participant.handRaised) return 1;
  if (participant.role === "speaker") return 2;
  return 3;
};

export function createConferenceOverlay(deps: ConferenceOverlayDeps): ConferenceOverlay {
  const { controller, locale, selfUserId } = deps;
  const text = (key: ConferenceTextKey, vars?: Record<string, string>): string => conferenceText(locale, key, vars);
  const root = el("div", {
    class: "gc-conference",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": text("callTitle"),
    tabindex: "-1",
    hidden: true,
  });
  const trap = createFocusTrap(root);
  const title = el("h2", { class: "gc-conference-title" }, [deps.title?.trim() || text("callTitle")]);
  const phase = el("p", { class: "gc-conference-phase", role: "status", "aria-live": "polite" });
  const count = el("span", { class: "gc-conference-count" });
  const quality = el("div", { class: "gc-conference-notice", role: "status", hidden: true });
  const audioGate = el("button", { type: "button", class: "gc-conference-audio-gate", hidden: true }, [
    icon("play"), el("span", {}, [text("audioBlocked")]), el("strong", {}, [text("audioResume")]),
  ]);
  const stage = el("div", { class: "gc-conference-stage" });
  const grid = el("div", { class: "gc-conference-grid" });
  const sidebarTitle = el("h3", {}, [text("participantList")]);
  const participantList = el("div", { class: "gc-conference-participants" });
  const inviteButton = el("button", {
    type: "button",
    class: "gc-conference-invite-trigger",
    title: text("addParticipants"),
    "aria-label": text("addParticipants"),
    hidden: true,
  }, [icon("plus"), el("span", {}, [text("addParticipants")])]);
  const sidebar = el("aside", { class: "gc-conference-sidebar", "aria-label": text("participantList") }, [
    sidebarTitle,
    inviteButton,
    participantList,
  ]);
  const controls = el("div", { class: "gc-conference-controls" });
  const settingsLabel = callDeviceText(locale, "open");
  const settingsButton = el("button", {
    type: "button",
    class: "gc-conference-settings-trigger",
    title: settingsLabel,
    "aria-label": settingsLabel,
  }, [icon("settings")]);
  const top = el("header", { class: "gc-conference-top" }, [
    el("div", { class: "gc-conference-heading" }, [title, phase]),
    el("div", { class: "gc-conference-top-actions" }, [count, settingsButton]),
  ]);
  stage.append(grid, sidebar);
  root.append(top, quality, audioGate, stage, controls);

  let state: ConferenceState | null = null;
  let pinnedKey: string | null = null;
  let opened = false;
  let destroyed = false;
  const tiles = new Map<string, TrackTile>();
  let tracks: readonly ConferenceVideoTrack[] = [];

  const profiles = new Map<number, ChatMember>();

  const loadingProfiles = new Set<number>();
  let profileEpoch = 0;
  let profileChatId: number | null = null;
  let stageAvatarBindings: AvatarImageBinding[] = [];
  let listAvatarBindings: AvatarImageBinding[] = [];
  let inviteAvatarBindings: AvatarImageBinding[] = [];
  const pendingInvites = new Map<number, number>();
  let inviteExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  let inviteLayer: HTMLElement | null = null;
  let inviteTrap: FocusTrap | null = null;
  let inviteEpoch = 0;
  let inviteSearchTimer: ReturnType<typeof setTimeout> | null = null;

  let settingsLayer: HTMLElement | null = null;
  let settingsTrap: FocusTrap | null = null;
  let settingsUnsubscribe: (() => void) | null = null;
  let settingsEpoch = 0;

  const destroyAvatarBindings = (bindings: AvatarImageBinding[]): void => {
    for (const binding of bindings) binding.destroy();
    bindings.length = 0;
  };

  const participantName = (userId: number): string => {
    const profile = profiles.get(userId)?.name?.trim();
    if (profile) return profile;
    const named = tracks.find((track) => track.userId === userId)?.name.trim();
    if (named) return named;
    return userId === selfUserId ? (locale === "ru" ? "Вы" : "You") : `#${userId}`;
  };

  const bindParticipantAvatar = (
    target: HTMLElement,
    userId: number,
    name: string,
    bucket: AvatarImageBinding[],
  ): void => {
    const fileId = profiles.get(userId)?.avatar_file_id ?? null;
    if (!deps.api || !Number.isSafeInteger(fileId) || (fileId ?? 0) <= 0) return;
    bucket.push(bindAvatarImage(target, deps.api, fileId, name));
  };

  const loadParticipantProfiles = (current: ConferenceState): void => {
    if (!deps.api || current.chatId === null || current.phase === "idle") return;
    if (profileChatId !== current.chatId) {
      profileChatId = current.chatId;
      profiles.clear();
      loadingProfiles.clear();
      profileEpoch += 1;
    }
    const missing = current.participants
      .map((participant) => participant.userId)
      .filter((userId) => !profiles.has(userId) && !loadingProfiles.has(userId));
    if (missing.length === 0) return;
    const epoch = profileEpoch;
    for (const userId of missing) loadingProfiles.add(userId);
    void Promise.all(missing.map(async (userId) => {
      try {
        return await deps.api!.get<ChatMember>(`/v1/users/${userId}`);
      } catch {
        return null;
      }
    })).then((rows) => {
      if (destroyed || epoch !== profileEpoch) return;
      for (const userId of missing) loadingProfiles.delete(userId);
      for (const row of rows) {
        if (row && Number.isSafeInteger(row.id)) profiles.set(row.id, row);
      }
      renderParticipants();
      layoutStage();
    });
  };

  const control = (
    glyph: IconName,
    label: string,
    run: () => void,
    options: { pressed?: boolean; danger?: boolean; disabled?: boolean } = {},
  ): HTMLButtonElement => {
    const button = el("button", {
      type: "button",
      class: `gc-conference-control${options.danger ? " is-danger" : ""}${options.pressed ? " is-pressed" : ""}`,
      title: label,
      "aria-label": label,
      "aria-pressed": options.pressed === undefined ? undefined : options.pressed,
      disabled: options.disabled ? true : undefined,
    }, [icon(glyph), el("span", {}, [label])]);
    button.addEventListener("click", run);
    return button;
  };

  const setConferenceContentInert = (enabled: boolean, layer: HTMLElement | null): void => {
    for (const child of Array.from(root.children) as HTMLElement[]) {
      if (child === layer) continue;
      if (enabled) {
        child.setAttribute("inert", "");
        child.setAttribute("aria-hidden", "true");
      } else {
        child.removeAttribute("inert");
        child.removeAttribute("aria-hidden");
      }
    }
  };

  const clearInviteExpiryTimer = (): void => {
    if (inviteExpiryTimer) clearTimeout(inviteExpiryTimer);
    inviteExpiryTimer = null;
  };

  const prunePendingInvites = (): void => {
    const now = Math.floor(Date.now() / 1000);
    for (const [userId, expiresAt] of pendingInvites) {
      if (expiresAt <= now || state?.participants.some((participant) => participant.userId === userId)) {
        pendingInvites.delete(userId);
      }
    }
    clearInviteExpiryTimer();
    const nearest = Math.min(...pendingInvites.values());
    if (Number.isFinite(nearest)) {
      inviteExpiryTimer = setTimeout(() => {
        prunePendingInvites();
        syncInviteButton();
      }, Math.max(250, (nearest - now) * 1000 + 100));
    }
  };

  const availableInviteSlots = (): number => {
    prunePendingInvites();
    return Math.max(0, MAX_CONFERENCE_PARTICIPANTS - (state?.participants.length ?? 0) - pendingInvites.size);
  };

  const syncInviteButton = (): void => {
    const terminal = !state || state.phase === "idle" || state.phase === "ended" || state.phase === "error";
    const slots = terminal ? 0 : availableInviteSlots();
    const visible = Boolean(deps.api && state?.conferenceId && state?.chatId !== null && !terminal);
    inviteButton.hidden = !visible;
    inviteButton.disabled = visible && slots <= 0;
    const label = slots > 0 ? text("addParticipants") : text("limitReached");
    inviteButton.title = label;
    inviteButton.setAttribute("aria-label", label);
  };

  const closeDeviceSettings = (restoreFocus = true): void => {
    const layer = settingsLayer;
    if (!layer) return;
    settingsEpoch += 1;
    settingsUnsubscribe?.();
    settingsUnsubscribe = null;
    settingsTrap?.release();
    settingsTrap = null;
    setConferenceContentInert(false, layer);
    root.classList.remove("has-call-settings");
    layer.remove();
    settingsLayer = null;
    if (restoreFocus && !settingsButton.hidden) settingsButton.focus();
  };

  const openDeviceSettings = (): void => {
    if (!state || state.phase === "idle" || state.phase === "ended" || state.phase === "error") return;
    closeInviteSheet(false);
    closeDeviceSettings(false);
    const current = state;
    const deviceText = (
      key: Parameters<typeof callDeviceText>[1],
      vars?: Record<string, string>,
    ): string => callDeviceText(locale, key, vars);
    const epoch = ++settingsEpoch;
    let applying = false;

    const layer = el("div", { class: "gc-call-settings-layer" });
    const backdrop = el("div", { class: "gc-call-settings-backdrop", "aria-hidden": "true" });
    const sheet = el("section", {
      class: "gc-call-settings",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "gc-conference-settings-title",
      tabindex: "-1",
    });
    const closeButton = el("button", {
      type: "button",
      class: "gc-call-settings-close",
      title: deviceText("close"),
      "aria-label": deviceText("close"),
    }, [icon("close")]);
    const body = el("div", { class: "gc-call-settings-body" });
    const status = el("p", {
      class: "gc-call-settings-status",
      role: "status",
      "aria-live": "polite",
      hidden: true,
    });
    sheet.append(
      el("header", { class: "gc-call-settings-header" }, [
        el("h2", { id: "gc-conference-settings-title" }, [deviceText("title")]),
        closeButton,
      ]),
      body,
      status,
    );
    layer.append(backdrop, sheet);

    const setStatus = (message: string, error = false): void => {
      status.textContent = message;
      status.classList.toggle("is-error", error);
      if (message) status.removeAttribute("hidden");
      else status.setAttribute("hidden", "");
    };
    const fallbackName = (kind: CallMediaDeviceKind, index: number): string => {
      const key = kind === "audiooutput"
        ? "unknownOutput"
        : kind === "audioinput"
          ? "unknownMicrophone"
          : "unknownCamera";
      return deviceText(key, { index: String(index) });
    };

    let renderSnapshot: (snapshot: CallDeviceSnapshot) => void;
    const deviceRow = (
      snapshot: CallDeviceSnapshot,
      kind: CallMediaDeviceKind,
      label: string,
      glyph: "calls" | "mic" | "video",
    ): HTMLElement => {
      const devices = snapshot.devices.filter((device) =>
        device.kind === kind && device.deviceId !== "default" && device.deviceId !== "communications");
      const selectedId = snapshot.selected[kind];
      const selectedDevice = devices.find((device) => device.deviceId === selectedId);
      const unsupported = kind === "audiooutput" && !snapshot.outputSelectionSupported;
      const selectedLabel = unsupported
        ? deviceText("outputUnsupported")
        : selectedDevice?.label.trim()
          || (selectedDevice ? fallbackName(kind, devices.indexOf(selectedDevice) + 1) : deviceText("systemDevice"));
      const select = el("select", {
        class: "gc-call-device-select",
        "data-kind": kind,
        "aria-label": label,
        disabled: unsupported,
      });
      select.append(el("option", { value: "" }, [deviceText("systemDevice")]));
      devices.forEach((device, index) => {
        select.append(el("option", { value: device.deviceId }, [device.label.trim() || fallbackName(kind, index + 1)]));
      });
      select.value = selectedId;
      select.addEventListener("change", () => {
        if (applying || settingsEpoch !== epoch) return;
        applying = true;
        for (const control of Array.from(body.querySelectorAll<HTMLSelectElement>("select"))) control.disabled = true;
        setStatus(deviceText("applying"));
        void controller.selectDevice(kind, select.value).then((next) => {
          if (settingsEpoch !== epoch) return;
          applying = false;
          renderSnapshot(next);
        }).catch(() => {
          if (settingsEpoch !== epoch) return;
          applying = false;
          renderSnapshot(snapshot);
          setStatus(deviceText("switchFailed"), true);
        });
      });
      return el("label", {
        class: `gc-call-device-row${unsupported ? " is-disabled" : ""}`,
        "data-kind": kind,
      }, [
        el("span", { class: "gc-call-device-icon", "aria-hidden": "true" }, [icon(glyph)]),
        el("span", { class: "gc-call-device-copy" }, [
          el("strong", {}, [label]),
          el("span", { class: "gc-call-device-value" }, [selectedLabel]),
        ]),
        icon("chevron"),
        select,
      ]);
    };

    renderSnapshot = (snapshot): void => {
      clear(body);
      body.append(el("section", { class: "gc-call-settings-section" }, [
        el("h3", {}, [deviceText("sound")]),
        el("div", { class: "gc-call-device-group" }, [
          deviceRow(snapshot, "audiooutput", deviceText("output"), "calls"),
          deviceRow(snapshot, "audioinput", deviceText("microphone"), "mic"),
        ]),
      ]));
      if (current.video) {
        body.append(el("section", { class: "gc-call-settings-section" }, [
          el("h3", {}, [deviceText("video")]),
          el("div", { class: "gc-call-device-group" }, [
            deviceRow(snapshot, "videoinput", deviceText("camera"), "video"),
          ]),
        ]));
      }
      setStatus(snapshot.labelsHidden ? deviceText("labelsHidden") : "");
    };

    const refresh = (): void => {
      if (applying || settingsEpoch !== epoch) return;
      void controller.deviceSnapshot().then((snapshot) => {
        if (settingsEpoch === epoch) renderSnapshot(snapshot);
      }).catch(() => {
        if (settingsEpoch === epoch) setStatus(deviceText("refreshFailed"), true);
      });
    };

    closeButton.addEventListener("click", () => closeDeviceSettings());
    backdrop.addEventListener("click", () => closeDeviceSettings());
    layer.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDeviceSettings();
    });
    settingsLayer = layer;
    root.classList.add("has-call-settings");
    root.append(layer);
    setConferenceContentInert(true, layer);
    settingsTrap = createFocusTrap(sheet);
    settingsTrap.activate();
    settingsUnsubscribe = controller.subscribeDevices(refresh);
    body.append(el("p", { class: "gc-call-settings-loading" }, [deviceText("loading")]));
    refresh();
  };

  const closeInviteSheet = (restoreFocus = true): void => {
    const layer = inviteLayer;
    if (!layer) return;
    inviteEpoch += 1;
    if (inviteSearchTimer) clearTimeout(inviteSearchTimer);
    inviteSearchTimer = null;
    destroyAvatarBindings(inviteAvatarBindings);
    inviteTrap?.release();
    inviteTrap = null;
    setConferenceContentInert(false, layer);
    root.classList.remove("has-conference-invites");
    layer.remove();
    inviteLayer = null;
    if (restoreFocus && !inviteButton.hidden && !inviteButton.disabled) inviteButton.focus();
  };

  const openInviteSheet = (): void => {
    const current = state;
    if (!deps.api || !current || current.phase === "idle" || current.phase === "ended" || current.phase === "error") return;
    if (!current.conferenceId || current.chatId === null) return;
    if (availableInviteSlots() <= 0) {
      syncInviteButton();
      return;
    }
    closeDeviceSettings(false);
    closeInviteSheet(false);
    const epoch = ++inviteEpoch;
    let loadEpoch = 0;
    let candidates: ChatMember[] = [];
    let sending = false;
    const selected = new Set<number>();

    const layer = el("div", { class: "gc-conference-invite-layer" });
    const backdrop = el("div", { class: "gc-conference-invite-backdrop", "aria-hidden": "true" });
    const sheet = el("section", {
      class: "gc-conference-invite-sheet",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "gc-conference-invite-title",
      tabindex: "-1",
    });
    const closeButton = el("button", {
      type: "button",
      class: "gc-conference-invite-close",
      title: text("close"),
      "aria-label": text("close"),
    }, [icon("close")]);
    const lead = el("p", { class: "gc-conference-invite-lead" });
    const search = el("input", {
      type: "search",
      class: "gc-conference-invite-search",
      placeholder: text("inviteSearch"),
      "aria-label": text("inviteSearch"),
      autocomplete: "off",
    }) as HTMLInputElement;
    const list = el("div", { class: "gc-conference-invite-list" });
    const status = el("p", {
      class: "gc-conference-invite-status",
      role: "status",
      "aria-live": "polite",
    });
    const submit = el("button", {
      type: "button",
      class: "gc-conference-invite-submit",
      disabled: true,
    }, [text("inviteSend")]);
    sheet.append(
      el("header", { class: "gc-conference-invite-header" }, [
        el("h2", { id: "gc-conference-invite-title" }, [text("inviteTitle")]),
        closeButton,
      ]),
      lead,
      search,
      list,
      status,
      el("footer", { class: "gc-conference-invite-footer" }, [submit]),
    );
    layer.append(backdrop, sheet);

    const setStatus = (message: string, error = false): void => {
      status.textContent = message;
      status.classList.toggle("is-error", error);
    };
    const updateSelection = (): void => {
      const capacity = availableInviteSlots();
      lead.textContent = text("inviteLead", { count: String(Math.max(0, capacity - selected.size)) });
      submit.disabled = sending || selected.size === 0;
      submit.textContent = selected.size > 0 ? `${text("inviteSend")} · ${selected.size}` : text("inviteSend");
    };
    const renderCandidates = (): void => {
      destroyAvatarBindings(inviteAvatarBindings);
      clear(list);
      const participants = new Set((state?.participants ?? []).map((participant) => participant.userId));
      const rows = candidates.filter((member) =>
        member.id !== selfUserId
        && member.is_bot !== true
        && !participants.has(member.id)
        && !pendingInvites.has(member.id));
      if (rows.length === 0) {
        list.append(el("p", { class: "gc-conference-invite-empty" }, [text("inviteEmpty")]));
        updateSelection();
        return;
      }
      for (const member of rows) {
        const name = member.name?.trim() || (member.username ? `@${member.username}` : `#${member.id}`);
        const avatar = el("span", {
          class: "gc-conference-invite-avatar",
          "data-tone": String(avatarTone(name)),
          "aria-hidden": "true",
        }, [initials(name)]);
        bindParticipantAvatar(avatar, member.id, name, inviteAvatarBindings);
        const checkbox = el("input", {
          type: "checkbox",
          class: "gc-conference-invite-checkbox",
          checked: selected.has(member.id),
        }) as HTMLInputElement;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            if (selected.size >= availableInviteSlots()) {
              checkbox.checked = false;
              setStatus(text("limitReached"), true);
              return;
            }
            selected.add(member.id);
          } else {
            selected.delete(member.id);
          }
          setStatus("");
          updateSelection();
        });
        list.append(el("label", { class: "gc-conference-invite-row" }, [
          avatar,
          el("span", { class: "gc-conference-invite-copy" }, [
            el("strong", {}, [name]),
            ...(member.username ? [el("small", {}, [`@${member.username}`])] : []),
          ]),
          checkbox,
        ]));
      }
      updateSelection();
    };
    const loadCandidates = (query = ""): void => {
      const request = ++loadEpoch;
      destroyAvatarBindings(inviteAvatarBindings);
      clear(list);
      list.append(el("p", { class: "gc-conference-invite-empty" }, [text("inviteLoading")]));
      const q = query.trim();
      const path = `/v1/chats/${current.chatId}/members?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`;
      void deps.api!.get<ChatMember[]>(path).then((rows) => {
        if (destroyed || inviteEpoch !== epoch || request !== loadEpoch) return;
        candidates = rows;
        for (const member of rows) profiles.set(member.id, member);
        renderCandidates();
        renderParticipants();
        layoutStage();
      }).catch(() => {
        if (destroyed || inviteEpoch !== epoch || request !== loadEpoch) return;
        clear(list);
        list.append(el("p", { class: "gc-conference-invite-empty is-error" }, [text("inviteFailed")]));
      });
    };

    search.addEventListener("input", () => {
      if (inviteSearchTimer) clearTimeout(inviteSearchTimer);
      inviteSearchTimer = setTimeout(() => loadCandidates(search.value), 250);
    });
    submit.addEventListener("click", () => {
      if (sending || selected.size === 0) return;
      sending = true;
      updateSelection();
      const ids = [...selected];
      void deps.api!.post<{
        invited_user_ids?: number[];
        expires_at?: number;
        available_slots?: number;
      }>(`/v1/conferences/${current.conferenceId}/invites`, { user_ids: ids }).then((result) => {
        if (destroyed || inviteEpoch !== epoch) return;
        const expiresAt = Number.isFinite(result.expires_at) ? Number(result.expires_at) : Math.floor(Date.now() / 1000) + 120;
        for (const userId of result.invited_user_ids ?? ids) pendingInvites.set(userId, expiresAt);
        selected.clear();
        sending = false;
        setStatus(text("inviteSent"));
        prunePendingInvites();
        syncInviteButton();
        renderCandidates();
      }).catch((error: unknown) => {
        if (destroyed || inviteEpoch !== epoch) return;
        sending = false;
        const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
        setStatus(code === "CONFERENCE_FULL" ? text("limitReached") : text("inviteFailed"), true);
        updateSelection();
      });
    });
    closeButton.addEventListener("click", () => closeInviteSheet());
    backdrop.addEventListener("click", () => closeInviteSheet());
    layer.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeInviteSheet();
    });

    inviteLayer = layer;
    root.classList.add("has-conference-invites");
    root.append(layer);
    setConferenceContentInert(true, layer);
    inviteTrap = createFocusTrap(sheet);
    inviteTrap.activate();
    updateSelection();
    loadCandidates();
  };

  inviteButton.addEventListener("click", openInviteSheet);
  settingsButton.addEventListener("click", openDeviceSettings);

  const effectivePinned = (): string | null => {
    if (pinnedKey && tracks.some((track) => track.key === pinnedKey)) return pinnedKey;
    return tracks.find((track) => track.source === "screen")?.key ?? null;
  };

  const updatePinButtons = (): void => {
    const effective = effectivePinned();
    for (const [key, tile] of tiles) {
      const on = key === effective;
      tile.root.classList.toggle("is-pinned", on);
      tile.pin.setAttribute("aria-pressed", String(on));
      tile.pin.setAttribute("aria-label", text(on ? "unpin" : "pin"));
      tile.pin.title = text(on ? "unpin" : "pin");
      clear(tile.pin);
      tile.pin.append(icon(on ? "pinOff" : "pin"));
    }
  };

  const makeTrackTile = (track: ConferenceVideoTrack): TrackTile => {
    const video = el("video", {
      class: "gc-conference-video",
      autoplay: true,
      playsinline: true,
      muted: track.local ? true : undefined,
    }) as HTMLVideoElement;
    const name = el("strong", { class: "gc-conference-tile-name" }, [track.name]);
    const pin = el("button", {
      type: "button",
      class: "gc-conference-pin",
      "aria-label": text("pin"),
      "aria-pressed": "false",
      title: text("pin"),
    }, [icon("pin")]);
    const tile = el("article", {
      class: `gc-conference-tile is-${track.source}${track.local ? " is-local" : ""}`,
      "data-user-id": String(track.userId),
      "data-track-key": track.key,
    }, [video, el("div", { class: "gc-conference-tile-meta" }, [name, pin])]);
    const entry: TrackTile = { track, root: tile, video, name, pin };
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      pinnedKey = effectivePinned() === track.key ? null : track.key;
      layoutStage();
    });
    tile.addEventListener("dblclick", () => {
      pinnedKey = effectivePinned() === track.key ? null : track.key;
      layoutStage();
    });
    track.attach(video);
    return entry;
  };

  const placeholder = (participant: ConferenceParticipant): HTMLElement => {
    const name = participantName(participant.userId);
    const avatar = el("span", {
      class: "gc-conference-avatar",
      "data-tone": String(avatarTone(name)),
      "aria-hidden": "true",
    }, [initials(name)]);
    bindParticipantAvatar(avatar, participant.userId, name, stageAvatarBindings);
    const badges: HTMLElement[] = [];
    if (participant.handRaised) badges.push(el("span", { class: "gc-conference-hand" }, ["✋"]));
    if (participant.muted !== false) badges.push(el("span", { class: "gc-conference-muted" }, [icon("micOff")]));
    return el("article", {
      class: `gc-conference-tile is-placeholder${participant.speaking ? " is-speaking" : ""}`,
      "data-user-id": String(participant.userId),
    }, [avatar, el("strong", { class: "gc-conference-tile-name" }, [name]), ...badges]);
  };

  function layoutStage(): void {
    if (!state) return;
    const effective = effectivePinned();
    const ordered = [...tracks].sort((a, b) => {
      if (a.key === effective) return -1;
      if (b.key === effective) return 1;
      if (a.source !== b.source) return a.source === "screen" ? -1 : 1;
      const active = state?.activeSpeakerId;
      if (a.userId === active) return -1;
      if (b.userId === active) return 1;
      return a.userId - b.userId || a.key.localeCompare(b.key);
    });
    destroyAvatarBindings(stageAvatarBindings);
    clear(grid);
    const cameraUsers = new Set(ordered.filter((track) => track.source === "camera").map((track) => track.userId));
    for (const track of ordered) {
      const tile = tiles.get(track.key);
      if (!tile) continue;
      tile.root.classList.toggle("is-speaking", state.activeSpeakerId === track.userId);
      tile.root.classList.toggle("is-muted", track.muted);
      tile.name.textContent = track.name;
      grid.append(tile.root);
    }
    for (const participant of state.participants) {
      if (!cameraUsers.has(participant.userId)) grid.append(placeholder(participant));
    }
    grid.classList.toggle("has-pinned", effective !== null);
    grid.dataset.count = String(grid.children.length);
    updatePinButtons();
  }

  const roleText = (participant: ConferenceParticipant): string => {
    if (participant.role === "owner") return locale === "ru" ? "Владелец" : "Owner";
    if (participant.role === "speaker") return locale === "ru" ? "Спикер" : "Speaker";
    return locale === "ru" ? "Слушатель" : "Listener";
  };

  const renderParticipants = (): void => {
    if (!state) return;
    destroyAvatarBindings(listAvatarBindings);
    clear(participantList);
    const participants = [...state.participants].sort((a, b) =>
      participantOrder(a) - participantOrder(b) || a.joinedAt - b.joinedAt || a.userId - b.userId);
    for (const participant of participants) {
      const name = participantName(participant.userId);
      const avatar = el("span", {
        class: "gc-conference-person-avatar",
        "data-tone": String(avatarTone(name)),
        "aria-hidden": "true",
      }, [initials(name)]);
      bindParticipantAvatar(avatar, participant.userId, name, listAvatarBindings);
      const media = el("span", { class: "gc-conference-person-media" });
      media.append(icon(participant.muted === false ? "mic" : "micOff"));
      if (participant.cameraOn) media.append(icon("video"));
      if (participant.screenSharing) media.append(icon("upload"));
      const actions = el("span", { class: "gc-conference-person-actions" });
      if (state.role === "owner" && participant.userId !== selfUserId && participant.role !== "owner") {
        const role = participant.role === "listener" ? "speaker" : "listener";
        const roleButton = el("button", {
          type: "button",
          class: "gc-conference-person-action",
          title: text(role === "speaker" ? "promote" : "demote"),
          "aria-label": text(role === "speaker" ? "promote" : "demote"),
        }, [icon(role === "speaker" ? "mic" : "micOff")]);
        roleButton.addEventListener("click", () => { void controller.changeParticipantRole(participant.userId, role); });
        const remove = el("button", {
          type: "button",
          class: "gc-conference-person-action is-danger",
          title: text("remove"),
          "aria-label": text("remove"),
        }, [icon("trash")]);
        remove.addEventListener("click", () => { void controller.removeParticipant(participant.userId); });
        actions.append(roleButton, remove);
      }
      participantList.append(el("div", {
        class: `gc-conference-person${participant.speaking ? " is-speaking" : ""}`,
        "data-user-id": String(participant.userId),
      }, [
        avatar,
        el("span", { class: "gc-conference-person-copy" }, [
          el("strong", {}, [name]),
          el("small", {}, [participant.handRaised ? `✋ ${roleText(participant)}` : roleText(participant)]),
        ]),
        media,
        actions,
      ]));
    }
  };

  const sameParticipantView = (left: ConferenceState, right: ConferenceState): boolean =>
    left.role === right.role
    && left.participants.length === right.participants.length
    && left.participants.every((participant, index) => {
      const next = right.participants[index];
      return next !== undefined
        && participant.userId === next.userId
        && participant.role === next.role
        && participant.moderator === next.moderator
        && participant.joinedAt === next.joinedAt
        && participant.handRaised === next.handRaised
        && participant.muted === next.muted
        && participant.cameraOn === next.cameraOn
        && participant.screenSharing === next.screenSharing;
    });

  const updateSpeakingIndicators = (): void => {
    if (!state) return;
    const speaking = new Set(state.participants.filter((participant) => participant.speaking).map((participant) => participant.userId));
    for (const node of Array.from(grid.children) as HTMLElement[]) {
      const userId = Number(node.dataset.userId);
      if (!Number.isSafeInteger(userId)) continue;
      node.classList.toggle("is-speaking", node.dataset.trackKey
        ? state.activeSpeakerId === userId
        : speaking.has(userId));
    }
    for (const node of Array.from(participantList.children) as HTMLElement[]) {
      const userId = Number(node.dataset.userId);
      if (Number.isSafeInteger(userId)) node.classList.toggle("is-speaking", speaking.has(userId));
    }
  };

  const phaseText = (current: ConferenceState): string => {
    if (current.phase === "joining" || current.phase === "connecting") return text("connecting");
    if (current.phase === "reconnecting") return text("reconnecting");
    if (current.phase === "ended") return current.reason === "removed" ? text("removed") : text("ended");
    if (current.phase === "error") return text("failed");
    return conferenceText(locale, current.mode === "stage" ? "modeStage" : current.mode === "broadcast" ? "modeBroadcast" : "modeConversation");
  };

  const renderControls = (): void => {
    if (!state) return;
    clear(controls);
    const terminal = state.phase === "ended" || state.phase === "error";
    if (terminal) {
      controls.append(control("close", text("close"), () => controller.dismiss()));
      return;
    }
    const connecting = state.phase === "joining" || state.phase === "connecting";
    const publishDisabled = state.role === "listener" || connecting;
    const screenDisabled = connecting;
    controls.append(control(state.muted ? "micOff" : "mic", text(state.muted ? "microphoneOff" : "microphoneOn"), () => {
      controller.setMuted(!state!.muted);
    }, { pressed: state.muted, disabled: publishDisabled }));
    if (state.video) {
      controls.append(control(state.cameraOn ? "video" : "videoOff", text(state.cameraOn ? "cameraOn" : "cameraOff"), () => {
        controller.setCameraOn(!state!.cameraOn);
      }, { pressed: !state.cameraOn, disabled: publishDisabled }));
    }
    controls.append(control(state.screenSharing ? "stop" : "upload", text(state.screenSharing ? "screenStop" : "screenStart"), () => {
      if (state!.screenSharing) void controller.stopScreenShare();
      else void controller.startScreenShare();
    }, { pressed: state.screenSharing, disabled: screenDisabled }));
    if (state.role === "listener") {
      controls.append(control("user", text("raiseHand"), () => { void controller.raiseHand(); }, { pressed: state.handRaised }));
    }
    controls.append(control("close", text("leave"), () => { void controller.leave(); }, { danger: true }));
    if (state.role === "owner") {
      controls.append(control("trash", text("end"), () => { void controller.endConference(); }, { danger: true }));
    }
  };

  const renderNotices = (): void => {
    if (!state) return;
    const messages: string[] = [];
    if (state.quality === "critical" || state.cameraAutoPaused) messages.push(text("qualityCritical"));
    if (state.screenShareError) {
      messages.push(text(state.screenShareError === "denied" ? "screenDenied" : state.screenShareError === "unavailable" ? "screenUnavailable" : "screenFailed"));
    }
    quality.hidden = messages.length === 0;
    quality.textContent = messages.join(" ");
    audioGate.hidden = !state.audioPlaybackBlocked;
  };

  audioGate.addEventListener("click", () => { void controller.resumeAudio(); });

  const render = (next: ConferenceState): void => {
    if (destroyed) return;
    const previous = state;
    state = next;
    if (next.phase === "idle") {
      closeDeviceSettings(false);
      closeInviteSheet(false);
      if (opened) trap.release();
      opened = false;
      root.hidden = true;
      root.classList.remove("is-open");
      return;
    }
    const firstOpen = !opened;
    opened = true;
    root.hidden = false;
    root.classList.add("is-open");
    root.dataset.phase = next.phase;
    root.dataset.quality = next.quality;

    const terminal = next.phase === "ended" || next.phase === "error";
    settingsButton.hidden = terminal;
    if (terminal) {
      closeDeviceSettings(false);
      closeInviteSheet(false);
    }
    loadParticipantProfiles(next);
    syncInviteButton();
    if (inviteLayer && availableInviteSlots() <= 0) closeInviteSheet(false);
    phase.textContent = phaseText(next);
    count.textContent = text("participants", { count: String(next.participants.length) });
    renderNotices();
    if (previous && sameParticipantView(previous, next)) updateSpeakingIndicators();
    else {
      renderParticipants();
      layoutStage();
    }
    renderControls();
    if (firstOpen) trap.activate();
  };

  return {
    root,
    render,
    setTracks(next) {
      const incoming = new Map(next.map((track) => [track.key, track]));
      for (const [key, tile] of tiles) {
        const replacement = incoming.get(key);
        if (!replacement || replacement !== tile.track) {
          tile.track.detach(tile.video);
          tile.root.remove();
          tiles.delete(key);
        }
      }
      for (const track of next) {
        if (!tiles.has(track.key)) tiles.set(track.key, makeTrackTile(track));
      }
      tracks = [...next];
      if (pinnedKey && !incoming.has(pinnedKey)) pinnedKey = null;
      renderParticipants();
      layoutStage();
    },
    setTitle(next) {
      title.textContent = next.trim() || text("callTitle");
    },
    destroy() {
      destroyed = true;
      closeDeviceSettings(false);
      closeInviteSheet(false);
      clearInviteExpiryTimer();
      destroyAvatarBindings(stageAvatarBindings);
      destroyAvatarBindings(listAvatarBindings);
      destroyAvatarBindings(inviteAvatarBindings);
      trap.release();
      for (const tile of tiles.values()) tile.track.detach(tile.video);
      tiles.clear();
      clear(root);
      root.remove();
    },
  };
}
