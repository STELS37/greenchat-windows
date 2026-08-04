// Device management for Settings. Lists every live GreenChat session, opens the QR-linking camera,
// and requires an explicit account-password reauthentication before another device can be detached.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { describeError } from "./api.ts";
import { skeletonLine } from "./state_view.ts";

export interface DeviceSession {
  id: number;
  device: string;
  device_label: string;
  ip: string;
  created_at: number;
  last_active_at: number;
  current: boolean;
  device_bound: boolean;
  wiped: boolean;
  wipe_delivered: boolean;
}

export interface DevicesScreenDeps {
  api: ApiLike;
  i18n: I18n;
  /** Router seam for tests/native shells. The hash route is the portable default. */
  onOpenQr?: (token: string) => void;
}

type MediaTrack = { stop(): void };
type MediaStreamLike = { getTracks(): MediaTrack[] };
type BarcodeResult = { rawValue?: string };
type BarcodeDetectorLike = { detect(source: unknown): Promise<BarcodeResult[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export function qrLoginToken(value: string): string | null {
  const input = value.trim();
  if (/^[0-9a-f]{96}$/i.test(input)) return input;
  const match = input.match(/(?:greenchat:\/\/|https?:\/\/[^\s#?]+(?:\/[^\s#?]*)?#?\/?)?auth\/qr\/([0-9a-f]{96})(?:[/?#].*)?$/i)
    ?? input.match(/[#/]auth\/qr\/([0-9a-f]{96})(?:[/?#].*)?$/i);
  return match?.[1] ?? null;
}

export function createDevicesScreen(deps: DevicesScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  let disposed = false;
  let generation = 0;
  let sessions: DeviceSession[] = [];
  let loading = true;
  let loadError: unknown = null;
  let target: DeviceSession | null = null;
  let revokeBusy = false;
  let cameraBusy = false;
  let stream: MediaStreamLike | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  const root = el("div", { class: "gc-devices" });
  const status = el("p", { class: "gc-settings-status", role: "status", "aria-live": "polite" });
  const body = el("div", { class: "gc-devices-body" });
  root.append(status, body);

  const stopCamera = (): void => {
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    cameraBusy = false;
  };

  const openToken = (value: string): boolean => {
    const token = qrLoginToken(value);
    if (!token) {
      status.textContent = i18n.t("devices.qrInvalid");
      return false;
    }
    stopCamera();
    if (deps.onOpenQr) deps.onOpenQr(token);
    else {
      const locationLike = (globalThis as { location?: { hash: string } }).location;
      if (locationLike) locationLike.hash = `#/auth/qr/${encodeURIComponent(token)}`;
    }
    return true;
  };

  const beginCamera = async (panel: HTMLElement, video: HTMLVideoElement): Promise<void> => {
    if (cameraBusy) return;
    const Detector = barcodeDetectorCtor();
    const nav = (globalThis as {
      navigator?: { mediaDevices?: { getUserMedia(constraints: unknown): Promise<MediaStreamLike> } };
    }).navigator;
    if (!Detector || !nav?.mediaDevices?.getUserMedia) {
      status.textContent = i18n.t("devices.cameraUnavailable");
      return;
    }
    cameraBusy = true;
    status.textContent = i18n.t("devices.cameraStarting");
    try {
      stream = await nav.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (disposed || !cameraBusy) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        return;
      }
      video.srcObject = stream as unknown as MediaStream;
      video.muted = true;
      video.autoplay = true;
      video.setAttribute("playsinline", "");
      await video.play();
      panel.hidden = false;
      status.textContent = i18n.t("devices.cameraPoint");
      const detector = new Detector({ formats: ["qr_code"] });
      const scan = async (): Promise<void> => {
        if (disposed || !cameraBusy) return;
        try {
          const result = await detector.detect(video);
          const raw = result.find((item) => typeof item.rawValue === "string")?.rawValue;
          if (raw && openToken(raw)) return;
        } catch {
          // Some WebViews reject detect() until the first decoded video frame; retry below.
        }
        scanTimer = setTimeout(() => { void scan(); }, 180);
      };
      void scan();
    } catch (error) {
      stopCamera();
      status.textContent = describeError(error, i18n) || i18n.t("devices.cameraFailed");
    }
  };

  const formatTime = (seconds: number): string => i18n.formatDate(seconds * 1_000, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const renderLinkCard = (): HTMLElement => {
    const paste = el("input", {
      type: "text",
      class: "gc-input",
      autocomplete: "off",
      inputmode: "text",
      placeholder: i18n.t("devices.pastePlaceholder"),
      "aria-label": i18n.t("devices.pasteLabel"),
    }) as HTMLInputElement;
    const useCode = el("button", {
      type: "button",
      class: "gc-btn",
      "data-action": "open-qr",
    }, [i18n.t("devices.openQr")]) as HTMLButtonElement;
    useCode.addEventListener("click", () => openToken(paste.value));
    paste.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") openToken(paste.value);
    });

    const cameraPanel = el("div", { class: "gc-connector-qr-frame", hidden: true });
    const video = el("video", {
      class: "gc-connector-qr gc-device-scanner-video",
      "aria-label": i18n.t("devices.cameraPreview"),
    }) as HTMLVideoElement;
    cameraPanel.append(video);
    const scan = el("button", {
      type: "button",
      class: "gc-btn gc-btn-accent",
      "data-action": "scan-qr",
    }, [icon("qr"), el("span", {}, [i18n.t("devices.scanQr")])]) as HTMLButtonElement;
    scan.addEventListener("click", () => {
      if (cameraBusy) {
        stopCamera();
        cameraPanel.hidden = true;
        status.textContent = "";
        return;
      }
      void beginCamera(cameraPanel, video);
    });

    return el("section", { class: "gc-server-card gc-device-link-card" }, [
      el("h2", {}, [i18n.t("devices.linkTitle")]),
      el("p", { class: "gc-settings-note" }, [i18n.t("devices.linkHint")]),
      scan,
      cameraPanel,
      el("p", { class: "gc-settings-note" }, [i18n.t("devices.pasteHint")]),
      el("div", { class: "gc-server-actions" }, [paste, useCode]),
    ]);
  };

  const renderDevice = (session: DeviceSession): HTMLElement => {
    const label = session.device_label || session.device || i18n.t("devices.unknown");
    const meta = session.current
      ? i18n.t("devices.thisDevice")
      : i18n.t("devices.lastActive", { time: formatTime(session.last_active_at) });
    const details = el("div", { class: "gc-setting-list" }, [
      el("div", { class: "gc-setting-row" }, [
        el("span", { class: "gc-setting-label" }, [i18n.t("devices.ip")]),
        el("span", { class: "gc-setting-value" }, [session.ip]),
      ]),
      el("div", { class: "gc-setting-row" }, [
        el("span", { class: "gc-setting-label" }, [i18n.t("devices.signedIn")]),
        el("span", { class: "gc-setting-value" }, [formatTime(session.created_at)]),
      ]),
    ]);
    const actions: HTMLElement[] = [];
    if (!session.current) {
      const revoke = el("button", {
        type: "button",
        class: "gc-btn",
        "data-action": "disconnect-device",
        "data-session-id": session.id,
      }, [i18n.t("devices.disconnect")]) as HTMLButtonElement;
      revoke.addEventListener("click", () => {
        stopCamera();
        target = session;
        status.textContent = "";
        render();
        const input = body.querySelector?.("input[type=password]") as HTMLInputElement | null;
        input?.focus();
      });
      actions.push(revoke);
    }
    return el("article", {
      class: `gc-server-card gc-device-card${session.current ? " is-current" : ""}`,
      "data-session-id": session.id,
    }, [
      el("div", { class: "gc-account-card-copy" }, [
        el("h3", {}, [label]),
        ...(session.device && session.device !== label
          ? [el("p", { class: "gc-settings-note" }, [session.device])]
          : []),
        el("p", { class: "gc-settings-note" }, [meta]),
        ...(session.device_bound
          ? [el("p", { class: "gc-settings-note" }, [i18n.t("devices.keyProtected")])]
          : []),
      ]),
      details,
      ...(actions.length ? [el("div", { class: "gc-server-actions" }, actions)] : []),
    ]);
  };

  const renderPasswordConfirm = (session: DeviceSession): HTMLElement => {
    const password = el("input", {
      type: "password",
      class: "gc-input",
      autocomplete: "current-password",
      placeholder: i18n.t("devices.passwordLabel"),
      "aria-label": i18n.t("devices.passwordLabel"),
      disabled: revokeBusy,
    }) as HTMLInputElement;
    const cancel = el("button", {
      type: "button",
      class: "gc-btn",
      "data-action": "cancel-disconnect",
      disabled: revokeBusy,
    }, [i18n.t("common.cancel")]) as HTMLButtonElement;
    cancel.addEventListener("click", () => {
      target = null;
      status.textContent = "";
      render();
    });
    const confirm = el("button", {
      type: "submit",
      class: "gc-btn gc-btn-accent",
      "data-action": "confirm-disconnect",
      disabled: revokeBusy,
    }, [revokeBusy ? i18n.t("devices.disconnecting") : i18n.t("devices.confirmDisconnect")]) as HTMLButtonElement;
    const form = el("form", { class: "gc-server-card gc-device-confirm" }, [
      el("h2", {}, [i18n.t("devices.passwordTitle")]),
      el("p", { class: "gc-settings-note" }, [
        i18n.t("devices.passwordHint", { device: session.device_label || session.device }),
      ]),
      password,
      el("div", { class: "gc-server-actions" }, [cancel, confirm]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (revokeBusy || !password.value) {
        if (!password.value) status.textContent = i18n.t("devices.passwordRequired");
        return;
      }
      const requestedId = session.id;
      const secret = password.value;
      password.value = "";
      revokeBusy = true;
      status.textContent = "";
      render();
      void api.post<{ revoked: boolean }>(`/v1/auth/sessions/${requestedId}/revoke`, { password: secret })
        .then(() => {
          if (disposed) return;
          sessions = sessions.filter((item) => item.id !== requestedId);
          target = null;
          status.textContent = i18n.t("devices.disconnected");
        })
        .catch((error) => {
          if (disposed) return;
          status.textContent = describeError(error, i18n);
        })
        .finally(() => {
          if (disposed) return;
          revokeBusy = false;
          render();
        });
    });
    return form;
  };

  const render = (): void => {
    if (disposed) return;
    clear(body);
    body.append(
      el("h2", { class: "gc-settings-section-title" }, [i18n.t("devices.title")]),
      el("p", { class: "gc-settings-note" }, [i18n.t("devices.intro")]),
      renderLinkCard(),
      el("h2", { class: "gc-settings-section-title" }, [i18n.t("devices.connectedTitle")]),
    );
    if (loading) {
      body.append(el("div", { class: "gc-server-card" }, [skeletonLine("is-title"), skeletonLine()]));
      return;
    }
    if (loadError) {
      const retry = el("button", { type: "button", class: "gc-btn", "data-action": "retry" }, [
        i18n.t("common.retry"),
      ]);
      retry.addEventListener("click", () => void load());
      body.append(el("section", { class: "gc-server-card" }, [
        el("p", { class: "gc-settings-note" }, [describeError(loadError, i18n)]),
        retry,
      ]));
      return;
    }
    const active = sessions.filter((session) => !session.wiped);
    if (active.length === 0) body.append(el("p", { class: "gc-settings-note" }, [i18n.t("devices.empty")]));
    else for (const session of active) body.append(renderDevice(session));
    if (target) body.append(renderPasswordConfirm(target));
  };

  const load = async (): Promise<void> => {
    const mine = ++generation;
    loading = true;
    loadError = null;
    target = null;
    render();
    try {
      const result = await api.get<DeviceSession[]>("/v1/auth/sessions");
      if (disposed || mine !== generation) return;
      sessions = Array.isArray(result) ? result : [];
    } catch (error) {
      if (disposed || mine !== generation) return;
      loadError = error;
    } finally {
      if (!disposed && mine === generation) {
        loading = false;
        render();
      }
    }
  };

  void load();
  return {
    root,
    destroy() {
      disposed = true;
      generation += 1;
      stopCamera();
    },
  };
}
