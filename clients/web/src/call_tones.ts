import type { CallState } from "../../ui/src/screens/call_model.ts";

export type CallToneKind = "incoming" | "outgoing";

export interface CallToneAudio {
  loop: boolean;
  preload: string;
  currentTime: number;
  volume: number;
  play(): void | Promise<void>;
  pause(): void;
  load?(): void;
}

export interface CallToneEnvironment {
  createAudio(src: string): CallToneAudio;
  onUserGesture(listener: () => void): () => void;
}

export interface CallToneController {
  update(state: Pick<CallState, "phase" | "direction" | "awaitingMedia">): void;
  stop(): void;
  destroy(): void;
  current(): CallToneKind | null;
}

export interface CallToneOptions {
  incomingUrl: string;
  outgoingUrl: string;
  environment?: CallToneEnvironment;
}

/**
 * The incoming tone stops as soon as the user accepts: CallController marks awaitingMedia before it
 * waits for microphone/camera permission. The outgoing ringback stops on call.answer, when the phase
 * changes to connecting, rather than leaking underneath the remote media stream.
 */
export function callToneForState(
  state: Pick<CallState, "phase" | "direction" | "awaitingMedia">,
): CallToneKind | null {
  if (state.direction === "in" && state.phase === "incoming" && !state.awaitingMedia) {
    return "incoming";
  }
  if (state.direction === "out" && (state.phase === "dialing" || state.phase === "ringing")) {
    return "outgoing";
  }
  return null;
}

function browserEnvironment(): CallToneEnvironment {
  return {
    createAudio: (src) => {
      const audio = new Audio(src);
      audio.loop = true;
      audio.preload = "auto";
      audio.volume = 1;
      return audio;
    },
    onUserGesture: (listener) => {
      const options: AddEventListenerOptions = { capture: true, passive: true };
      document.addEventListener("pointerdown", listener, options);
      document.addEventListener("touchstart", listener, options);
      document.addEventListener("keydown", listener, { capture: true });
      return () => {
        document.removeEventListener("pointerdown", listener, options);
        document.removeEventListener("touchstart", listener, options);
        document.removeEventListener("keydown", listener, { capture: true });
      };
    },
  };
}

function rewind(audio: CallToneAudio): void {
  try { audio.pause(); } catch { /* a media failure must never break call signaling */ }
  try { audio.currentTime = 0; } catch { /* metadata may not be available yet */ }
}

/**
 * Owns exactly two preloaded audio elements and never allows them to overlap. HTML autoplay policy can
 * reject an unsolicited incoming ring; in that case one capture listener retries synchronously on the
 * next user gesture, but only while the same call state is still current.
 */
export function createBrowserCallTones(options: CallToneOptions): CallToneController {
  const environment = options.environment ?? browserEnvironment();
  const audio: Record<CallToneKind, CallToneAudio> = {
    incoming: environment.createAudio(options.incomingUrl),
    outgoing: environment.createAudio(options.outgoingUrl),
  };
  for (const item of Object.values(audio)) {
    item.loop = true;
    item.preload = "auto";
    item.volume = 1;
    try { item.load?.(); } catch { /* best-effort warm-up */ }
  }

  let active: CallToneKind | null = null;
  let generation = 0;
  let removeGestureListener: (() => void) | null = null;
  let destroyed = false;

  const disarmGestureRetry = (): void => {
    const remove = removeGestureListener;
    removeGestureListener = null;
    try { remove?.(); } catch { /* listener cleanup is non-fatal */ }
  };

  const stopAll = (): void => {
    disarmGestureRetry();
    rewind(audio.incoming);
    rewind(audio.outgoing);
  };

  const play = (kind: CallToneKind, token: number): void => {
    if (destroyed || active !== kind || generation !== token) return;
    let result: void | Promise<void>;
    try {
      result = audio[kind].play();
    } catch {
      result = Promise.reject(new Error("call tone playback rejected"));
    }
    if (!result || typeof (result as Promise<void>).then !== "function") return;
    void Promise.resolve(result).then(
      () => {
        if (destroyed || active !== kind || generation !== token) rewind(audio[kind]);
      },
      () => {
        if (destroyed || active !== kind || generation !== token || removeGestureListener) return;
        removeGestureListener = environment.onUserGesture(() => {
          disarmGestureRetry();
          play(kind, token);
        });
      },
    );
  };

  const stop = (): void => {
    generation += 1;
    active = null;
    stopAll();
  };

  const start = (kind: CallToneKind): void => {
    generation += 1;
    const token = generation;
    active = kind;
    stopAll();
    // stopAll rewinds both tracks but deliberately does not alter `active` or `generation`.
    audio[kind].loop = true;
    play(kind, token);
  };

  return {
    update(state) {
      if (destroyed) return;
      const desired = callToneForState(state);
      if (desired === active) return;
      if (desired === null) stop();
      else start(desired);
    },
    stop,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
    },
    current: () => active,
  };
}
