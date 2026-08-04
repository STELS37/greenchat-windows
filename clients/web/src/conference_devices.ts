import type {
  CallDeviceSnapshot,
  CallMediaDevice,
  CallMediaDeviceKind,
  CallMediaDevicePort,
} from "../../ui/src/screens/call_model.ts";

const STORAGE_KEY = "gc.call.devices.v1";
const KINDS: readonly CallMediaDeviceKind[] = ["audioinput", "audiooutput", "videoinput"];

type SelectedDevices = Record<CallMediaDeviceKind, string>;

export interface ConferenceDeviceRoom {
  getActiveDevice(kind: MediaDeviceKind): string | undefined;
  switchActiveDevice(kind: MediaDeviceKind, deviceId: string, exact?: boolean): Promise<boolean>;
}

interface MediaDevicesLike {
  enumerateDevices(): Promise<readonly MediaDeviceInfo[]>;
  addEventListener?(type: "devicechange", listener: EventListener): void;
  removeEventListener?(type: "devicechange", listener: EventListener): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserConferenceDeviceManager extends CallMediaDevicePort {
  bind(room: ConferenceDeviceRoom): Promise<void>;
  unbind(room: ConferenceDeviceRoom): void;
  destroy(): void;
}

export interface BrowserConferenceDeviceDeps {
  mediaDevices?: MediaDevicesLike;
  storage?: StorageLike | null;
  outputSelectionSupported?: () => boolean;
}

function blankSelection(): SelectedDevices {
  return { audioinput: "", audiooutput: "", videoinput: "" };
}

function browserStorage(): StorageLike | null {
  try { return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage; }
  catch { return null; }
}

function loadSelection(storage: StorageLike | null): SelectedDevices {
  const selected = blankSelection();
  if (!storage) return selected;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<SelectedDevices> | null;
    if (!parsed || typeof parsed !== "object") return selected;
    for (const kind of KINDS) if (typeof parsed[kind] === "string") selected[kind] = parsed[kind]!;
  } catch {
    // A blocked or corrupt preference store must never block a group call.
  }
  return selected;
}

function isKind(kind: MediaDeviceKind): kind is CallMediaDeviceKind {
  return kind === "audioinput" || kind === "audiooutput" || kind === "videoinput";
}

function normalize(raw: readonly MediaDeviceInfo[]): CallMediaDevice[] {
  return raw.filter((item) => isKind(item.kind)).map((item) => ({
    deviceId: item.deviceId,
    groupId: item.groupId,
    kind: item.kind,
    label: item.label,
  }));
}

function outputSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined"
    && typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function";
}

function unavailable(name: string, message: string): Error {
  try { return new DOMException(message, name); }
  catch {
    const error = new Error(message);
    error.name = name;
    return error;
  }
}

export function createBrowserConferenceDevices(
  deps: BrowserConferenceDeviceDeps = {},
): BrowserConferenceDeviceManager {
  const mediaDevices = deps.mediaDevices ?? navigator.mediaDevices;
  const storage = deps.storage === undefined ? browserStorage() : deps.storage;
  const selected = loadSelection(storage);
  const listeners = new Set<() => void>();
  let activeRoom: ConferenceDeviceRoom | null = null;
  let destroyed = false;

  const save = (): void => {
    if (!storage) return;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { /* private mode */ }
  };
  const enumerate = async (): Promise<CallMediaDevice[]> => normalize(await mediaDevices.enumerateDevices());
  const emit = (): void => {
    for (const listener of listeners) {
      try { listener(); } catch { /* one view cannot break device routing */ }
    }
  };
  const apply = async (kind: CallMediaDeviceKind, deviceId: string): Promise<void> => {
    const room = activeRoom;
    if (!room) return;
    const target = deviceId || "default";
    const success = await room.switchActiveDevice(kind, target, deviceId !== "");
    if (!success) throw unavailable("NotReadableError", "device switch was not accepted");
  };

  const reconcile = async (): Promise<void> => {
    if (destroyed) return;
    try {
      const devices = await enumerate();
      for (const kind of KINDS) {
        const wanted = selected[kind];
        if (!wanted || devices.some((item) => item.kind === kind && item.deviceId === wanted)) continue;
        await apply(kind, "").catch(() => undefined);
        selected[kind] = "";
      }
      save();
    } finally {
      emit();
    }
  };
  const onDeviceChange: EventListener = () => { void reconcile(); };
  mediaDevices.addEventListener?.("devicechange", onDeviceChange);

  const manager: BrowserConferenceDeviceManager = {
    async bind(room) {
      activeRoom = room;
      const devices = await enumerate().catch(() => [] as CallMediaDevice[]);
      for (const kind of KINDS) {
        const wanted = selected[kind];
        if (!wanted) continue;
        if (!devices.some((item) => item.kind === kind && item.deviceId === wanted)) {
          selected[kind] = "";
          continue;
        }
        try { await apply(kind, wanted); }
        catch { selected[kind] = ""; }
      }
      save();
      emit();
    },

    unbind(room) {
      if (activeRoom === room) activeRoom = null;
    },

    async snapshot(): Promise<CallDeviceSnapshot> {
      const devices = await enumerate();
      const effective = { ...selected };
      for (const kind of KINDS) {
        if (effective[kind] && !devices.some((item) => item.kind === kind && item.deviceId === effective[kind])) {
          effective[kind] = "";
        }
      }
      const capture = devices.filter((item) => item.kind !== "audiooutput");
      return {
        devices,
        selected: effective,
        outputSelectionSupported: deps.outputSelectionSupported?.() ?? outputSupported(),
        labelsHidden: capture.length > 0 && capture.every((item) => !item.label.trim()),
      };
    },

    async select(kind, deviceId) {
      const devices = await enumerate();
      if (deviceId && !devices.some((item) => item.kind === kind && item.deviceId === deviceId)) {
        throw unavailable("NotFoundError", "selected device is unavailable");
      }
      if (kind === "audiooutput" && !(deps.outputSelectionSupported?.() ?? outputSupported()) && deviceId) {
        throw unavailable("NotSupportedError", "audio output selection is unavailable");
      }
      await apply(kind, deviceId);
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
      activeRoom = null;
    },
  };

  return manager;
}
