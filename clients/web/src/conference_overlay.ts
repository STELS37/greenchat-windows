import type { Locale } from "../../ui/src/i18n.ts";
import { clear, el } from "../../ui/src/dom.ts";
import { createFocusTrap } from "../../ui/src/a11y.ts";
import { icon, type IconName } from "../../ui/src/icons.ts";
import { avatarTone, initials } from "../../ui/src/screens/message_menu.ts";
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
  const sidebar = el("aside", { class: "gc-conference-sidebar", "aria-label": text("participantList") }, [
    sidebarTitle,
    participantList,
  ]);
  const controls = el("div", { class: "gc-conference-controls" });
  const top = el("header", { class: "gc-conference-top" }, [
    el("div", { class: "gc-conference-heading" }, [title, phase]),
    count,
  ]);
  stage.append(grid, sidebar);
  root.append(top, quality, audioGate, stage, controls);

  let state: ConferenceState | null = null;
  let pinnedKey: string | null = null;
  let opened = false;
  let destroyed = false;
  const tiles = new Map<string, TrackTile>();
  let tracks: readonly ConferenceVideoTrack[] = [];

  const participantName = (userId: number): string => {
    const named = tracks.find((track) => track.userId === userId)?.name.trim();
    if (named) return named;
    return userId === selfUserId ? (locale === "ru" ? "Вы" : "You") : `#${userId}`;
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
    state = next;
    if (next.phase === "idle") {
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
    phase.textContent = phaseText(next);
    count.textContent = text("participants", { count: String(next.participants.length) });
    renderNotices();
    renderParticipants();
    renderControls();
    layoutStage();
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
      trap.release();
      for (const tile of tiles.values()) tile.track.detach(tile.video);
      tiles.clear();
      clear(root);
      root.remove();
    },
  };
}
