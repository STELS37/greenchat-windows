// clients/ui/src/screens/call_overlay.ts — the live-call surface (V75).
//
// One overlay renders every phase of a call, because a call is ONE continuous event for the person
// holding the phone: dialing → ringing → connecting → talking → the result. Separate screens per
// phase is how products end up with a dead "Звонок" label that never changes.
//
// Contract with the state machine (call_model.ts): this file is a projection. It never decides what a
// call is doing — it reads CallState and draws it, and every button is one intent on the controller.
// That split is what lets the protocol be tested in Node while the visuals are tested by measurement.
//
// Visual identity (P1.2/P1.3): the surface is a deep GreenChat gradient, not a white sheet, so a call
// is instantly distinguishable from every other screen; the avatar carries a pulsing ring while the
// peer's phone rings; the ending state stays for a moment with its reason instead of vanishing.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { createFocusTrap, type FocusTrap } from "../a11y.ts";
import { icon } from "../icons.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { callDeviceText } from "./call_device_strings.ts";
import {
  callStatusKey,
  endRecovery,
  formatCallTimer,
  type CallController,
  type CallDeviceSnapshot,
  type CallMediaDeviceKind,
  type CallState,
} from "./call_model.ts";
export interface CallOverlayDeps {
  controller: CallController;
  i18n: I18n;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export interface CallOverlay {
  root: HTMLElement;
  render(state: CallState): void;
  destroy(): void;
}

/**
 * Which string decides the peer's colour.
 *
 * V88: this used to be `peer.id ?? name`, and the id is a different string from the name, so the same
 * человек drew tone 6 in the call log and tone 1 on the call screen (measured on the stand:
 * var/ux-audit/tools/m_calltone_v88.mjs). Every other surface in the app seeds the tone from the
 * displayed NAME — chat list, chat header, calls list, new-chat picker, profile — so the call screen
 * now does the same, and the id survives only as a fallback for a caller we cannot name.
 */
export function peerToneSeed(
  peer: { id?: number | string | null; name?: string | null } | null | undefined,
  fallback: string,
): number | string {
  const name = peer?.name?.trim();
  if (name) return name;
  return peer?.id ?? fallback;
}

export function createCallOverlay(deps: CallOverlayDeps): CallOverlay {
  const { controller, i18n } = deps;
  // tabindex="-1": the dialog is not reachable by Tab (it is not a control) but IS focusable in code,
  // which is what a modal needs to receive the caret when it opens. Without it the trap below would
  // have nowhere safe to put focus and would have to pick a button — on this screen that means
  // «Отклонить» or «Завершить», so a stray Enter would drop the call (V152).
  const root = el("div", { class: "gc-call", role: "dialog", "aria-modal": "true", tabindex: "-1", hidden: true });
  const trap = createFocusTrap(root);
  let timerHandle: unknown = null;
  let liveTimerEl: HTMLElement | null = null;
  let lastPhase = "";
  let settingsLayer: HTMLElement | null = null;
  let settingsTrap: FocusTrap | null = null;
  let settingsUnsubscribe: (() => void) | null = null;
  let settingsEpoch = 0;
  const now = (): number => (deps.now ? deps.now() : Date.now());
  const startTimer = (fn: () => void): void => {
    stopTimer();
    timerHandle = deps.setInterval ? deps.setInterval(fn, 1000) : setInterval(fn, 1000);
  };
  const stopTimer = (): void => {
    if (timerHandle === null) return;
    if (deps.clearInterval) deps.clearInterval(timerHandle);
    else clearInterval(timerHandle as ReturnType<typeof setInterval>);
    timerHandle = null;
  };

  const setCallContentInert = (enabled: boolean, layer: HTMLElement | null): void => {
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

  const closeDeviceSettings = (): void => {
    const layer = settingsLayer;
    if (!layer) return;
    settingsEpoch += 1;
    settingsUnsubscribe?.();
    settingsUnsubscribe = null;
    settingsTrap?.release();
    settingsTrap = null;
    setCallContentInert(false, layer);
    root.classList.remove("has-call-settings");
    layer.remove();
    settingsLayer = null;
  };

  const openDeviceSettings = (state: CallState, trigger: HTMLButtonElement): void => {
    closeDeviceSettings();
    const text = (key: Parameters<typeof callDeviceText>[1], vars?: Record<string, string>): string =>
      callDeviceText(i18n.locale, key, vars);
    const epoch = ++settingsEpoch;
    let applying = false;

    const layer = el("div", { class: "gc-call-settings-layer" });
    const backdrop = el("div", { class: "gc-call-settings-backdrop", "aria-hidden": "true" });
    const sheet = el("section", {
      class: "gc-call-settings",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "gc-call-settings-title",
      tabindex: "-1",
    });
    const closeButton = el("button", {
      type: "button",
      class: "gc-call-settings-close",
      title: text("close"),
      "aria-label": text("close"),
    }, [icon("close")]);
    const header = el("header", { class: "gc-call-settings-header" }, [
      el("h2", { id: "gc-call-settings-title" }, [text("title")]),
      closeButton,
    ]);
    const body = el("div", { class: "gc-call-settings-body" });
    const status = el("p", { class: "gc-call-settings-status", role: "status", "aria-live": "polite", hidden: true });
    sheet.append(header, body, status);
    layer.append(backdrop, sheet);

    const setStatus = (message: string, error = false): void => {
      status.textContent = message;
      status.classList.toggle("is-error", error);
      if (message) status.removeAttribute("hidden");
      else status.setAttribute("hidden", "");
    };

    const fallbackName = (kind: CallMediaDeviceKind, index: number): string => {
      const key = kind === "audiooutput" ? "unknownOutput" : kind === "audioinput" ? "unknownMicrophone" : "unknownCamera";
      return text(key, { index: String(index) });
    };

    const deviceRow = (
      snapshot: CallDeviceSnapshot,
      kind: CallMediaDeviceKind,
      label: string,
      iconName: "calls" | "mic" | "video",
    ): HTMLElement => {
      const devices = snapshot.devices.filter((device) => device.kind === kind && device.deviceId !== "default" && device.deviceId !== "communications");
      const selectedId = snapshot.selected[kind];
      const selectedDevice = devices.find((device) => device.deviceId === selectedId);
      const unsupported = kind === "audiooutput" && !snapshot.outputSelectionSupported;
      const selectedLabel = unsupported
        ? text("outputUnsupported")
        : selectedDevice?.label.trim() || (selectedDevice ? fallbackName(kind, devices.indexOf(selectedDevice) + 1) : text("systemDevice"));
      const select = el("select", {
        class: "gc-call-device-select",
        "data-kind": kind,
        "aria-label": label,
        disabled: unsupported,
      });
      select.append(el("option", { value: "" }, [text("systemDevice")]));
      devices.forEach((device, index) => {
        const name = device.label.trim() || fallbackName(kind, index + 1);
        select.append(el("option", { value: device.deviceId }, [name]));
      });
      select.value = selectedId;
      select.addEventListener("change", () => {
        if (applying || settingsEpoch !== epoch) return;
        applying = true;
        for (const control of Array.from(body.querySelectorAll<HTMLSelectElement>("select"))) control.disabled = true;
        setStatus(text("applying"));
        void controller.selectDevice(kind, select.value).then((next) => {
          if (settingsEpoch !== epoch) return;
          applying = false;
          renderSnapshot(next);
        }).catch(() => {
          if (settingsEpoch !== epoch) return;
          applying = false;
          renderSnapshot(snapshot);
          setStatus(text("switchFailed"), true);
        });
      });
      return el("label", { class: `gc-call-device-row${unsupported ? " is-disabled" : ""}`, "data-kind": kind }, [
        el("span", { class: "gc-call-device-icon", "aria-hidden": "true" }, [icon(iconName)]),
        el("span", { class: "gc-call-device-copy" }, [
          el("strong", {}, [label]),
          el("span", { class: "gc-call-device-value" }, [selectedLabel]),
        ]),
        icon("chevron"),
        select,
      ]);
    };

    const renderSnapshot = (snapshot: CallDeviceSnapshot): void => {
      clear(body);
      const soundRows = el("div", { class: "gc-call-device-group" }, [
        deviceRow(snapshot, "audiooutput", text("output"), "calls"),
        deviceRow(snapshot, "audioinput", text("microphone"), "mic"),
      ]);
      body.append(el("section", { class: "gc-call-settings-section" }, [
        el("h3", {}, [text("sound")]),
        soundRows,
      ]));
      if (state.video) {
        body.append(el("section", { class: "gc-call-settings-section" }, [
          el("h3", {}, [text("video")]),
          el("div", { class: "gc-call-device-group" }, [deviceRow(snapshot, "videoinput", text("camera"), "video")]),
        ]));
      }
      setStatus(snapshot.labelsHidden ? text("labelsHidden") : "");
    };

    const refresh = (): void => {
      if (applying || settingsEpoch !== epoch) return;
      void controller.deviceSnapshot().then((snapshot) => {
        if (settingsEpoch === epoch) renderSnapshot(snapshot);
      }).catch(() => {
        if (settingsEpoch === epoch) setStatus(text("refreshFailed"), true);
      });
    };

    closeButton.addEventListener("click", closeDeviceSettings);
    backdrop.addEventListener("click", closeDeviceSettings);
    layer.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDeviceSettings();
    });
    settingsLayer = layer;
    root.classList.add("has-call-settings");
    root.append(layer);
    setCallContentInert(true, layer);
    trigger.focus?.();
    settingsTrap = createFocusTrap(sheet);
    settingsTrap.activate();
    settingsUnsubscribe = controller.subscribeDevices(refresh);
    body.append(el("p", { class: "gc-call-settings-loading" }, [text("loading")]));
    refresh();
  };

  // A round action button. `tone` drives the paint: accept = green, end = red, neutral = glass.
  const action = (
    name: Parameters<typeof icon>[0],
    label: string,
    tone: "accept" | "end" | "neutral",
    onClick: () => void,
    opts?: { pressed?: boolean; big?: boolean },
  ): HTMLElement => {
    const btn = el(
      "button",
      {
        type: "button",
        class: `gc-call-action gc-call-action-${tone}${opts?.big ? " gc-call-action-big" : ""}${opts?.pressed ? " is-on" : ""}`,
        title: label,
        "aria-label": label,
        "aria-pressed": opts?.pressed === undefined ? undefined : opts.pressed,
      },
      [icon(name)],
    );
    btn.addEventListener("click", onClick);
    return el("div", { class: "gc-call-action-slot" }, [btn, el("span", { class: "gc-call-action-label" }, [label])]);
  };

  const render = (state: CallState): void => {
    if (state.phase === "idle") {
      stopTimer();
      liveTimerEl = null;
      lastPhase = "";
      root.setAttribute("hidden", "");
      root.classList.remove("is-open");
      closeDeviceSettings();
      // Release BEFORE the subtree is torn down, while the caret is still provably ours: a call ends
      // by itself (the other side hangs up), so the person did not ask for the surface to disappear
      // and must find the keyboard exactly where they left it before the phone rang.
      trap.release();
      clear(root);
      return;
    }
    root.removeAttribute("hidden");
    root.classList.add("is-open");
    // The phase drives a data attribute so CSS can theme without the view knowing about paint.
    root.dataset.phase = state.phase;
    root.dataset.direction = state.direction;
    if (state.video) root.dataset.video = "1";
    else delete root.dataset.video;

    // Every render rebuilds the whole subtree, so the node holding the caret is about to be detached.
    // Remember where it sat among the controls; the tail of this function puts it back.
    const wasClosed = lastPhase === "";
    const samePhase = lastPhase === state.phase;
    const focusedIndex = trap.indexInside();

    closeDeviceSettings();
    clear(root);
    stopTimer();
    liveTimerEl = null;

    const name = state.peer?.name?.trim() ? state.peer.name : i18n.t("calls.logUnknownPeer");
    const statusText = i18n.t(callStatusKey(state));

    // ---- video surfaces (only for a video call; audio never mounts a <video>) -------------------
    if (state.video) {
      const remoteVideo = el("video", { class: "gc-call-remote", autoplay: true, playsinline: true }) as HTMLVideoElement;
      const localVideo = el("video", { class: "gc-call-local", autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
      root.append(remoteVideo, el("div", { class: "gc-call-local-wrap" }, [localVideo]));
      controller.attachVideo(localVideo, remoteVideo);
    }

    if (state.phase !== "ended") {
      const settingsLabel = callDeviceText(i18n.locale, "open");
      const settingsButton = el("button", {
        type: "button",
        class: "gc-call-settings-trigger",
        title: settingsLabel,
        "aria-label": settingsLabel,
      }, [icon("settings")]);
      settingsButton.addEventListener("click", () => openDeviceSettings(state, settingsButton));
      root.append(settingsButton);
    }
    // ---- identity ------------------------------------------------------------------------------
    const ring = el("div", { class: "gc-callscreen-avatar-ring" });
    // The peer tone travels as an ATTRIBUTE, the same way it does in the chat list and the chat
    // header. The earlier `gc-avatar-tone-N` class matched no rule in either stylesheet, so the one
    // screen that is entirely about a single person drew them as a translucent white circle.
    const avatar = el("div", { class: "gc-callscreen-avatar", "data-tone": String(avatarTone(peerToneSeed(state.peer, name))) }, [
      initials(name),
    ]);
    const identity = el("div", { class: "gc-call-identity" }, [
      el("div", { class: "gc-callscreen-avatar-wrap" }, [ring, avatar]),
      el("h2", { class: "gc-call-name" }, [name]),
      el("p", { class: "gc-call-status", role: "status", "aria-live": "polite" }, [statusText]),
    ]);

    // V87: when the call died for a reason the person can act on, the screen says how. Without this
    // line "Нет доступа к микрофону" was a fact with no next step — the same dead end the finance
    // screens had before V85.
    if (state.phase === "ended") {
      const hintKey = endRecovery(state).hintKey;
      if (hintKey) identity.append(el("p", { class: "gc-call-hint" }, [i18n.t(hintKey)]));
    }

    // The live duration replaces the status line once media is connected: during a conversation the
    // only fact worth a whole line is how long it has been going.
    if ((state.phase === "active" || state.phase === "reconnecting") && state.connectedAt !== null) {
      const connectedAt = state.connectedAt;
      const timer = el("p", { class: "gc-call-timer", role: "timer" }, [formatCallTimer(0)]);
      liveTimerEl = timer;
      const tick = (): void => {
        if (!liveTimerEl) return;
        liveTimerEl.textContent = formatCallTimer((now() - connectedAt) / 1000);
      };
      tick();
      startTimer(tick);
      identity.append(timer);
    }

    const kindBadge = el("span", { class: "gc-call-kind" }, [
      icon(state.video ? "video" : "phone"),
      i18n.t(state.video ? "call.kindVideo" : "call.kindAudio"),
    ]);
    identity.prepend(kindBadge);
    root.append(identity);

    // ---- controls ------------------------------------------------------------------------------
    const bar = el("div", { class: "gc-call-bar" });
    if (state.phase === "incoming") {
      bar.append(
        action("close", i18n.t("call.decline"), "end", () => controller.decline(), { big: true }),
        action("phone", i18n.t("call.accept"), "accept", () => void controller.accept(), { big: true }),
      );
    } else if (state.phase === "ended") {
      // V87: a technical failure keeps the one control that can undo it. Order matches the incoming
      // call — the way out on the left, the thing you most likely want on the right.
      const recovery = endRecovery(state);
      const peer = state.peer;
      bar.append(action("close", i18n.t("call.close"), "neutral", () => controller.dismiss(), { big: true }));
      if (recovery.retry && peer) {
        bar.append(
          action(state.video ? "video" : "phone", i18n.t("call.retry"), "accept", () => {
            void controller.place(peer, state.video);
          }, { big: true }),
        );
      }
    } else {
      bar.append(
        action(state.muted ? "micOff" : "mic", i18n.t(state.muted ? "call.unmute" : "call.mute"), "neutral", () => controller.setMuted(!state.muted), {
          pressed: state.muted,
        }),
      );
      if (state.video) {
        bar.append(
          action(state.cameraOn ? "video" : "videoOff", i18n.t(state.cameraOn ? "call.cameraOff" : "call.cameraOn"), "neutral", () => controller.setCameraOn(!state.cameraOn), {
            pressed: !state.cameraOn,
          }),
        );
      }
      bar.append(action("close", i18n.t("call.hangUp"), "end", () => controller.hangUp(), { big: true }));
    }
    root.append(bar);

    // A phase change re-plays the entrance animation; a repaint inside the same phase (a mute tap)
    // must not, or the screen would twitch on every press.
    if (lastPhase !== state.phase) {
      root.classList.remove("gc-call-enter");
      void root.offsetWidth; // reflow: restart the animation
      root.classList.add("gc-call-enter");
      lastPhase = state.phase;
    }

    // ---- the keyboard, in the same three cases the animation above distinguishes ------------------
    if (wasClosed) {
      // The call surface just appeared over whatever the person was doing. Take the caret (and
      // remember where from) — announcing aria-modal while the keyboard stays in the chat list means
      // the reader has just hidden the page the caret is standing on.
      trap.activate();
    } else if (samePhase) {
      // A repaint the person themselves caused: mute, camera, the ticking timer. Put the caret back
      // on the control they are pressing — losing it here means the next Space toggles nothing.
      trap.restoreInside(focusedIndex);
    } else if (focusedIndex >= 0) {
      // The phase changed under the caret (ringing → talking, talking → ended). The buttons are not
      // the same buttons, so index N now means something else — «Ответить» becomes «Завершить» in the
      // same slot. Re-anchor on the dialog instead of handing a live Enter to a different action.
      root.focus?.();
    }
  };

  return {
    root,
    render,
    destroy() {
      stopTimer();
      liveTimerEl = null;
      closeDeviceSettings();
      trap.release();
      clear(root);
      root.remove();
    },
  };
}
