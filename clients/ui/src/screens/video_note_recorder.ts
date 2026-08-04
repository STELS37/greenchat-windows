// Browser recorder for Telegram-style round video notes. It owns camera/microphone tracks for exactly
// one modal lifecycle, records at a bounded bitrate for weak networks, and never leaves capture active
// after cancel, navigation, permission failure, review or send.
import type { I18n } from "../i18n.ts";
import { createFocusTrap } from "../a11y.ts";
import { el } from "../dom.ts";
import { icon } from "../icons.ts";
import {
  VIDEO_NOTE_MAX_DURATION_SEC,
  nextVideoNoteFacing,
  pickVideoNoteMime,
  videoNoteConstraints,
  videoNoteDuration,
  videoNoteFileName,
  videoNoteLayoutEdge,
  videoNoteRecorderOptionCandidates,
  type VideoNoteFacing,
} from "./video_note_model.ts";

export interface RecordedVideoNote {
  data: Uint8Array;
  name: string;
  mime: string;
  duration: number;
  width: number;
  height: number;
}

export interface VideoNoteRecorderDeps {
  i18n: I18n;
  onSend(note: RecordedVideoNote, signal: AbortSignal): Promise<void> | void;
  onClose?: () => void;
  autoStart?: boolean;
  maxDurationSec?: number;
  now?: () => number;
}

export interface VideoNoteRecorder {
  root: HTMLElement;
  start(): Promise<void>;
  focus(): void;
  destroy(): void;
}

type Phase = "starting" | "preview" | "recording" | "review" | "error";

function clock(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function errorKey(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "media.videoNoteDenied";
  if (
    name === "NotFoundError" || name === "OverconstrainedError" ||
    name === "NotReadableError" || name === "TrackStartError"
  ) return "media.videoNoteUnavailable";
  return "media.videoNoteFailed";
}

export function createVideoNoteRecorder(deps: VideoNoteRecorderDeps): VideoNoteRecorder {
  const { i18n } = deps;
  const now = deps.now ?? (() => Date.now());
  const maxDurationSec = Number.isFinite(deps.maxDurationSec) && (deps.maxDurationSec ?? 0) > 0
    ? Math.min(VIDEO_NOTE_MAX_DURATION_SEC, Math.floor(deps.maxDurationSec!))
    : VIDEO_NOTE_MAX_DURATION_SEC;

  let phase: Phase = "starting";
  let facing: VideoNoteFacing = "user";
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let objectUrl: string | null = null;
  let note: RecordedVideoNote | null = null;
  let closed = false;
  let releasingTracks = false;
  let sending = false;
  let recordingFailed = false;

  let autoStartPending = deps.autoStart === true;
  let sendAbort: AbortController | null = null;

  const preview = el("video", {
    class: "gc-video-note-preview is-mirrored",
    autoplay: true,
    muted: true,
    playsinline: true,
  }) as HTMLVideoElement;
  const status = el("p", { class: "gc-video-note-status", role: "status", "aria-live": "polite" }, [
    i18n.t("media.videoNotePreparing"),
  ]);
  const error = el("p", { class: "gc-video-note-error", role: "alert", hidden: true });
  const progress = el("span", { class: "gc-video-note-progress", "aria-hidden": "true" });
  const ring = el("div", { class: "gc-video-note-ring" }, [preview, progress]);

  const cancel = el("button", {
    type: "button",
    class: "gc-icon-btn gc-video-note-close",
    title: i18n.t("common.cancel"),
    "aria-label": i18n.t("common.cancel"),
  }, [icon("close")]) as HTMLButtonElement;
  const switchCamera = el("button", {
    type: "button",
    class: "gc-btn gc-video-note-switch",
    title: i18n.t("media.videoNoteSwitch"),
    "aria-label": i18n.t("media.videoNoteSwitch"),
  }, [icon("refresh"), el("span", {}, [i18n.t("media.videoNoteSwitch")])]) as HTMLButtonElement;
  const record = el("button", {
    type: "button",
    class: "gc-video-note-record",
    title: i18n.t("media.videoNoteRecord"),
    "aria-label": i18n.t("media.videoNoteRecord"),
  }, [el("span", { "aria-hidden": "true" })]) as HTMLButtonElement;
  const retry = el("button", { type: "button", class: "gc-btn", hidden: true }, [
    i18n.t("common.retry"),
  ]) as HTMLButtonElement;
  const retake = el("button", { type: "button", class: "gc-btn", hidden: true }, [
    i18n.t("media.videoNoteRetake"),
  ]) as HTMLButtonElement;
  const send = el("button", { type: "button", class: "gc-btn gc-btn-accent", hidden: true }, [
    i18n.t("media.videoNoteSend"),
  ]) as HTMLButtonElement;
  const actions = el("div", { class: "gc-video-note-actions" }, [switchCamera, record, retry, retake, send]);
  const panel = el("section", { class: "gc-video-note-panel" }, [
    el("header", { class: "gc-video-note-head" }, [
      el("h2", {}, [i18n.t("media.videoNoteTitle")]),
      cancel,
    ]),
    ring,
    status,
    error,
    actions,
  ]);
  const root = el("div", {
    class: "gc-overlay gc-video-note-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": i18n.t("media.videoNoteTitle"),
    "data-phase": phase,
  }, [panel]);
  const trap = createFocusTrap(root);

  const clearTimers = (): void => {
    if (timer !== null) clearInterval(timer);
    if (deadline !== null) clearTimeout(deadline);
    timer = null;
    deadline = null;
  };

  const revokeReview = (): void => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    note = null;
    preview.removeAttribute("src");
    preview.load?.();
  };

  const releaseStream = (target: MediaStream | null): void => {
    if (!target) return;
    releasingTracks = true;
    try {
      for (const track of target.getTracks()) track.stop();
    } finally {
      releasingTracks = false;
    }
  };

  const stopTracks = (): void => {
    const current = stream;
    stream = null;
    preview.srcObject = null;
    releaseStream(current);
  };

  const setPhase = (next: Phase): void => {
    phase = next;
    root.dataset.phase = next;
    const isPreview = next === "preview";
    const isRecording = next === "recording";
    const isReview = next === "review";
    switchCamera.hidden = !isPreview;
    switchCamera.disabled = !isPreview;
    record.hidden = !(isPreview || isRecording);
    record.classList.toggle("is-recording", isRecording);
    record.title = i18n.t(isRecording ? "media.videoNoteStop" : "media.videoNoteRecord");
    record.setAttribute("aria-label", record.title);
    retry.hidden = next !== "error";
    retry.disabled = next !== "error";
    retake.hidden = !isReview;
    send.hidden = !isReview;
    send.disabled = sending;
    status.hidden = next === "error";
    error.hidden = next !== "error";
  };

  const fail = (key: string): void => {
    clearTimers();
    if (recorder && recorder.state !== "inactive") recordingFailed = true;
    stopTracks();
    status.textContent = "";
    error.textContent = i18n.t(key);
    setPhase("error");
  };

  const onTrackEnded = (): void => {
    if (closed || releasingTracks) return;
    if (phase === "recording" && recorder?.state === "recording") {
      try { recorder.stop(); } catch { fail("media.videoNoteFailed"); }
      return;
    }
    if (phase === "preview") fail("media.videoNoteUnavailable");
  };

  const bindStream = async (
    next: MediaStream,
    nextFacing: VideoNoteFacing,
    previous: MediaStream | null = stream,
  ): Promise<void> => {
    stream = next;
    facing = nextFacing;
    for (const track of next.getTracks()) {
      track.addEventListener("ended", () => {
        if (stream !== next) return;
        onTrackEnded();
      }, { once: true });
    }
    preview.src = "";
    preview.srcObject = next;
    preview.controls = false;
    preview.loop = false;
    preview.muted = true;
    preview.classList.toggle("is-mirrored", nextFacing === "user");
    await preview.play().catch(() => {});
    if (previous && previous !== next) releaseStream(previous);
  };

  const openStream = async (): Promise<void> => {
    clearTimers();
    stopTracks();
    revokeReview();
    error.hidden = true;
    status.textContent = i18n.t("media.videoNotePreparing");
    setPhase("starting");
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fail("media.videoNoteUnsupported");
      return;
    }
    try {
      const next = await mediaDevices.getUserMedia(videoNoteConstraints(facing));
      if (closed || document.visibilityState === "hidden") {
        releaseStream(next);
        if (!closed) close();
        return;
      }
      await bindStream(next, facing, null);
      status.textContent = i18n.t("media.videoNoteReady");
      setPhase("preview");
      if (autoStartPending) {
        autoStartPending = false;
        startRecording();
      }
    } catch (err) {
      fail(errorKey(err));
    }
  };

  const switchStream = async (): Promise<void> => {
    const previous = stream;
    if (phase !== "preview" || !previous || closed) return;
    const previousFacing = facing;
    const targetFacing = nextVideoNoteFacing(previousFacing);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) return;
    status.textContent = i18n.t("media.videoNotePreparing");
    setPhase("starting");
    try {
      const next = await mediaDevices.getUserMedia(videoNoteConstraints(targetFacing));
      if (closed || document.visibilityState === "hidden") {
        releaseStream(next);
        if (!closed) close();
        return;
      }
      // Keep the old camera live until its replacement has opened. Phones with a single camera and
      // WebViews that overstate facingMode support therefore remain usable after a failed switch.
      if (stream !== previous) {
        releaseStream(next);
        return;
      }
      await bindStream(next, targetFacing, previous);
      status.textContent = i18n.t("media.videoNoteReady");
      setPhase("preview");
    } catch (err) {
      if (closed) return;
      const previousStillLive = stream === previous
        && previous.getTracks().some((track) => track.readyState === "live");
      if (previousStillLive) {
        facing = previousFacing;
        preview.srcObject = previous;
        preview.classList.toggle("is-mirrored", previousFacing === "user");
        status.textContent = i18n.t("media.videoNoteUnavailable");
        setPhase("preview");
        return;
      }
      fail(errorKey(err));
    }
  };

  const finishRecording = async (active: MediaRecorder, selectedMime: string): Promise<void> => {
    clearTimers();
    recorder = null;
    if (recordingFailed || phase === "error") {
      chunks = [];
      recordingFailed = false;
      stopTracks();
      return;
    }
    const endedAt = now();
    const duration = videoNoteDuration(startedAt, endedAt, maxDurationSec);
    const mime = active.mimeType || chunks.find((chunk) => chunk.type)?.type || selectedMime || "video/webm";
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    const edge = videoNoteLayoutEdge(preview.videoWidth, preview.videoHeight);
    stopTracks();
    if (closed) return;
    if (blob.size === 0 || duration === 0) {
      fail("media.videoNoteFailed");
      return;
    }
    const data = new Uint8Array(await blob.arrayBuffer());
    if (closed) return;
    note = {
      data,
      name: videoNoteFileName(mime, endedAt),
      mime,
      duration,
      width: edge,
      height: edge,
    };
    objectUrl = URL.createObjectURL(blob);
    preview.srcObject = null;
    preview.src = objectUrl;
    preview.controls = true;
    preview.loop = true;
    preview.muted = false;
    preview.classList.remove("is-mirrored");
    await preview.play().catch(() => {});
    status.textContent = i18n.t("media.videoNoteReview");
    setPhase("review");
  };

  const startRecording = (): void => {
    if (!stream || phase !== "preview" || closed) return;
    const selectedMime = typeof MediaRecorder.isTypeSupported === "function"
      ? pickVideoNoteMime((mime) => MediaRecorder.isTypeSupported(mime))
      : "";
    let active: MediaRecorder | null = null;
    let constructionError: unknown = null;
    for (const options of videoNoteRecorderOptionCandidates(selectedMime)) {
      try {
        active = new MediaRecorder(stream, options);
        break;
      } catch (err) {
        constructionError = err;
      }
    }
    if (!active) {
      fail(errorKey(constructionError));
      return;
    }
    recorder = active;
    chunks = [];
    recordingFailed = false;
    startedAt = now();
    active.addEventListener("dataavailable", (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    active.addEventListener("error", () => fail("media.videoNoteFailed"), { once: true });
    active.addEventListener("stop", () => { void finishRecording(active, selectedMime); }, { once: true });
    try {
      active.start(1000);
    } catch (err) {
      recorder = null;
      fail(errorKey(err));
      return;
    }
    setPhase("recording");
    const paintClock = (): void => {
      const elapsed = Math.min(maxDurationSec, Math.max(0, (now() - startedAt) / 1000));
      status.textContent = `${i18n.t("media.videoNoteRecording")} ${clock(elapsed)} / ${clock(maxDurationSec)}`;
      progress.style.setProperty("--gc-video-note-progress", String(elapsed / maxDurationSec));
    };
    paintClock();
    timer = setInterval(paintClock, 250);
    deadline = setTimeout(() => {
      if (recorder === active && active.state === "recording") active.stop();
    }, maxDurationSec * 1000);
  };

  const stopRecording = (): void => {
    if (phase !== "recording" || recorder?.state !== "recording") return;
    recorder.stop();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    sendAbort?.abort();
    sendAbort = null;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* already terminal */ }
    }
    recorder = null;
    chunks = [];
    stopTracks();
    revokeReview();
    trap.release();
    root.remove();
    window.removeEventListener("pagehide", close);
    document.removeEventListener("visibilitychange", onVisibility);
    deps.onClose?.();
  };

  const onVisibility = (): void => {
    // Native permission prompts can temporarily hide the document before getUserMedia resolves.
    // Closing during that phase discards a permission the user just granted; once capture exists,
    // background recording is forbidden and the recorder closes immediately.
    if (document.visibilityState === "hidden" && phase !== "starting") close();
  };

  cancel.addEventListener("click", close);
  root.addEventListener("click", (event) => { if (event.target === root) close(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  switchCamera.addEventListener("click", () => { void switchStream(); });
  record.addEventListener("click", () => {
    if (phase === "recording") stopRecording();
    else startRecording();
  });
  retry.addEventListener("click", () => { if (!sending && phase === "error") void openStream(); });
  retake.addEventListener("click", () => { if (!sending) void openStream(); });
  send.addEventListener("click", () => {
    if (!note || sending) return;
    sending = true;
    send.disabled = true;
    status.textContent = i18n.t("media.videoNoteUploading");
    const controller = new AbortController();
    sendAbort = controller;
    Promise.resolve(deps.onSend(note, controller.signal)).then(() => {
      if (sendAbort === controller) sendAbort = null;
      close();
    }).catch(() => {
      if (sendAbort === controller) sendAbort = null;
      if (closed || controller.signal.aborted) return;
      sending = false;
      send.disabled = false;
      status.textContent = i18n.t("media.videoNoteUploadFailed");
      error.textContent = i18n.t("media.videoNoteUploadFailed");
      error.hidden = false;
    });
  });
  window.addEventListener("pagehide", close);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    root,
    start: openStream,
    focus() { trap.activate(); },
    destroy: close,
  };
}
