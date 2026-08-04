import type {
  CallDeviceSnapshot,
  CallMediaDevice,
  CallMediaDeviceKind,
  CallMediaDevicePort,
} from "../../ui/src/screens/call_model.ts";

const STORAGE_KEY = "gc.call.devices.v1";
const KINDS: readonly CallMediaDeviceKind[] = ["audioinput", "audiooutput", "videoinput"];

type SelectedDevices = Record<CallMediaDeviceKind, string>;
type SinkElement = HTMLMediaElement & { setSinkId?: (deviceId: string) => Promise<void> };

interface MediaDevicesLike {
  enumerateDevices(): Promise<readonly MediaDeviceInfo[]>;
  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  addEventListener?(type: "devicechange", listener: EventListener): void;
  removeEventListener?(type: "devicechange", listener: EventListener): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserCallDeviceBinding {
  local: MediaStream;
  pc: RTCPeerConnection;
  sink: HTMLMediaElement;
  video: boolean;
}

export interface BrowserCallDeviceManager extends CallMediaDevicePort {
  acquire(video: boolean): Promise<MediaStream>;
  bind(binding: BrowserCallDeviceBinding): Promise<void>;
  unbind(binding: BrowserCallDeviceBinding): void;
  destroy(): void;
}

export interface BrowserCallDeviceDeps {
  mediaDevices?: MediaDevicesLike;
  storage?: StorageLike | null;
  outputSelectionSupported?: () => boolean;
}

function emptySelection(): SelectedDevices {
  return { audioinput: "", audiooutput: "", videoinput: "" };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function loadSelection(storage: StorageLike | null): SelectedDevices {
  const selected = emptySelection();
  if (!storage) return selected;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<SelectedDevices> | null;
    if (!parsed || typeof parsed !== "object") return selected;
    for (const kind of KINDS) if (typeof parsed[kind] === "string") selected[kind] = parsed[kind]!;
  } catch {
    // Corrupt or blocked storage is not a call blocker. Defaults remain usable.
  }
  return selected;
}

function isDeviceKind(kind: MediaDeviceKind): kind is CallMediaDeviceKind {
  return kind === "audioinput" || kind === "audiooutput" || kind === "videoinput";
}

function normalizeDevices(raw: readonly MediaDeviceInfo[]): CallMediaDevice[] {
  return raw.filter((device) => isDeviceKind(device.kind)).map((device) => ({
    deviceId: device.deviceId,
    groupId: device.groupId,
    kind: device.kind,
    label: device.label,
  }));
}

function captureConstraints(kind: "audioinput" | "videoinput", deviceId: string): MediaTrackConstraints {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  if (kind === "audioinput") {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...device };
  }
  return {
    facingMode: "user",
    width: { ideal: 960, max: 1280 },
    height: { ideal: 540, max: 720 },
    frameRate: { ideal: 24, max: 30 },
    ...device,
  };
}

function missingDeviceError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "OverconstrainedError" || name === "NotFoundError" || name === "DevicesNotFoundError";
}

function deviceError(name: string, message: string): Error {
  try {
    return new DOMException(message, name);
  } catch {
    const error = new Error(message);
    error.name = name;
    return error;
  }
}

export function createBrowserCallDevices(deps: BrowserCallDeviceDeps = {}): BrowserCallDeviceManager {
  const mediaDevices = deps.mediaDevices ?? navigator.mediaDevices;
  const storage = deps.storage === undefined ? browserStorage() : deps.storage;
  const selected = loadSelection(storage);
  const listeners = new Set<() => void>();
  let active: BrowserCallDeviceBinding | null = null;
  let destroyed = false;

  const save = (): void => {
    if (!storage) return;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { /* private/blocked storage */ }
  };

  const supportsOutput = (): boolean => {
    if (deps.outputSelectionSupported) return deps.outputSelectionSupported();
    if (active && typeof (active.sink as SinkElement).setSinkId === "function") return true;
    return typeof HTMLMediaElement !== "undefined" && typeof (HTMLMediaElement.prototype as SinkElement).setSinkId === "function";
  };

  const enumerate = async (): Promise<CallMediaDevice[]> => normalizeDevices(await mediaDevices.enumerateDevices());

  const emit = (): void => {
    for (const listener of listeners) {
      try { listener(); } catch { /* one view must not break the others */ }
    }
  };

  const applyOutput = async (deviceId: string): Promise<void> => {
    const sink = active?.sink as SinkElement | undefined;
    if (!sink) return;
    if (typeof sink.setSinkId !== "function") {
      if (deviceId) throw deviceError("NotSupportedError", "audio output selection is unavailable");
      return;
    }
    await sink.setSinkId(deviceId);
  };

  const replaceInput = async (kind: "audioinput" | "videoinput", deviceId: string): Promise<void> => {
    const binding = active;
    if (!binding) return;
    if (kind === "videoinput" && !binding.video) return;
    const mediaKind = kind === "audioinput" ? "audio" : "video";
    const replacement = await mediaDevices.getUserMedia({
      audio: kind === "audioinput" ? captureConstraints(kind, deviceId) : false,
      video: kind === "videoinput" ? captureConstraints(kind, deviceId) : false,
    });
    const next = replacement.getTracks().find((track) => track.kind === mediaKind);
    if (!next) {
      for (const track of replacement.getTracks()) track.stop();
      throw deviceError("NotFoundError", `${mediaKind} track is unavailable`);
    }
    const old = binding.local.getTracks().filter((track) => track.kind === mediaKind);
    const sender = binding.pc.getSenders().find((candidate) => candidate.track?.kind === mediaKind);
    if (!sender) {
      for (const track of replacement.getTracks()) track.stop();
      throw deviceError("InvalidStateError", `${mediaKind} sender is unavailable`);
    }
    next.enabled = old[0]?.enabled ?? true;
    try { next.contentHint = mediaKind === "audio" ? "speech" : "motion"; } catch { /* older WebView */ }
    try {
      await sender.replaceTrack(next);
    } catch (error) {
      for (const track of replacement.getTracks()) track.stop();
      throw error;
    }
    binding.local.addTrack(next);
    for (const track of old) {
      binding.local.removeTrack(track);
      track.stop();
    }
    for (const track of replacement.getTracks()) if (track !== next) track.stop();
  };

  const reconcileAfterDeviceChange = async (): Promise<void> => {
    if (destroyed) return;
    try {
      const devices = await enumerate();
      for (const kind of KINDS) {
        const wanted = selected[kind];
        if (!wanted || devices.some((device) => device.kind === kind && device.deviceId === wanted)) continue;
        if (kind === "audiooutput") await applyOutput("").catch(() => undefined);
        else await replaceInput(kind, "").catch(() => undefined);
        selected[kind] = "";
      }
      save();
    } finally {
      emit();
    }
  };

  const onDeviceChange: EventListener = () => { void reconcileAfterDeviceChange(); };
  mediaDevices.addEventListener?.("devicechange", onDeviceChange);

  const manager: BrowserCallDeviceManager = {
    async acquire(video) {
      const constraints = (): MediaStreamConstraints => ({
        audio: captureConstraints("audioinput", selected.audioinput),
        video: video ? captureConstraints("videoinput", selected.videoinput) : false,
      });
      try {
        return await mediaDevices.getUserMedia(constraints());
      } catch (error) {
        if (!missingDeviceError(error) || (!selected.audioinput && (!video || !selected.videoinput))) throw error;
        // A remembered USB/Bluetooth device disappeared while the app was closed. Falling back to the
        // platform default is safer than making the call look permission-denied forever.
        selected.audioinput = "";
        if (video) selected.videoinput = "";
        save();
        return mediaDevices.getUserMedia({
          audio: captureConstraints("audioinput", ""),
          video: video ? captureConstraints("videoinput", "") : false,
        });
      }
    },

    async bind(binding) {
      active = binding;
      try {
        await applyOutput(selected.audiooutput);
      } catch {
        selected.audiooutput = "";
        save();
        await applyOutput("").catch(() => undefined);
      }
    },

    unbind(binding) {
      if (active === binding) active = null;
    },

    async snapshot(): Promise<CallDeviceSnapshot> {
      const devices = await enumerate();
      const effective = { ...selected };
      for (const kind of KINDS) {
        if (effective[kind] && !devices.some((device) => device.kind === kind && device.deviceId === effective[kind])) {
          effective[kind] = "";
        }
      }
      const captureDevices = devices.filter((device) => device.kind !== "audiooutput");
      return {
        devices,
        selected: effective,
        outputSelectionSupported: supportsOutput(),
        labelsHidden: captureDevices.length > 0 && captureDevices.every((device) => !device.label.trim()),
      };
    },

    async select(kind, deviceId) {
      const devices = await enumerate();
      if (deviceId && !devices.some((device) => device.kind === kind && device.deviceId === deviceId)) {
        throw deviceError("NotFoundError", "selected device is unavailable");
      }
      if (kind === "audiooutput") await applyOutput(deviceId);
      else await replaceInput(kind, deviceId);
      selected[kind] = deviceId;
      save();
      emit();
      return manager.snapshot();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      destroyed = true;
      mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
      listeners.clear();
      active = null;
    },
  };

  return manager;
}
