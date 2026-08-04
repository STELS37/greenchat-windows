// Browser recorder for Telegram-style voice messages. It owns the microphone for exactly one modal
// lifecycle, records Opus when available, derives a compact waveform, and releases capture on every
// close/error/background path. The composer may ask it to auto-start after a long press.
import type { I18n } from "../i18n.ts";
import { createFocusTrap } from "../a11y.ts";
import { el } from "../dom.ts";
import { icon } from "../icons.ts";
import {
  VOICE_NOTE_MAX_DURATION_SEC,
  pickVoiceNoteMime,
  voiceNoteConstraints,
  voiceNoteDuration,
  voiceNoteFileName,
  voiceNoteRecorderOptionCandidates,
  voiceNoteWaveform,
} from "./voice_note_model.ts";
import { voiceNoteStrings } from "./voice_note_strings.ts";

export interface RecordedVoiceNote {
  data: Uint8Array;
  name: string;
  mime: string;
  duration: number;
  waveform: number[];
}

export interface VoiceNoteRecorderDeps {
  i18n: I18n;
  onSend(note: RecordedVoiceNote, signal: AbortSignal): Promise<void> | void;
  onClose?: () => void;
  autoStart?: boolean;
  maxDurationSec?: number;
  now?: () => number;
}

export interface VoiceNoteRecorder {
  root: HTMLElement;
  start(): Promise<void>;
  focus(): void;
  destroy(): void;
}

type Phase = "starting" | "ready" | "recording" | "review" | "error";
type AudioContextCtor = new () => AudioContext;

function clock(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function errorMessage(error: unknown, text: ReturnType<typeof voiceNoteStrings>): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return text.denied;
  if (
    name === "NotFoundError" || name === "OverconstrainedError" ||
    name === "NotReadableError" || name === "TrackStartError"
  ) return text.unavailable;
  return text.failed;
}

const VOICE_NOTE_STYLE_ID = "gc-voice-note-styles";
let voiceNoteStyleReady: Promise<void> | null = null;

function ensureVoiceNoteStyles(): Promise<void> {
  if (voiceNoteStyleReady) return voiceNoteStyleReady;
  const doc = globalThis.document;
  if (!doc?.head) return Promise.resolve();
  if (doc.getElementById(VOICE_NOTE_STYLE_ID)) return Promise.resolve();
  voiceNoteStyleReady = new Promise<void>((resolve) => {
    const link = doc.createElement("link");
    link.id = VOICE_NOTE_STYLE_ID;
    link.rel = "stylesheet";
    try {
      link.href = new URL("assets/voice-note.css", doc.baseURI).toString();
    } catch {
      link.href = "assets/voice-note.css";
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 1_500);
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
    doc.head.append(link);
  });
  return voiceNoteStyleReady;
}

export function createVoiceNoteRecorder(deps: VoiceNoteRecorderDeps): VoiceNoteRecorder {
  const text = voiceNoteStrings(deps.i18n.locale);
  const now = deps.now ?? (() => Date.now());
  const maxDurationSec = Number.isFinite(deps.maxDurationSec) && (deps.maxDurationSec ?? 0) > 0
    ? Math.min(VOICE_NOTE_MAX_DURATION_SEC, Math.floor(deps.maxDurationSec!))
    : VOICE_NOTE_MAX_DURATION_SEC;

  const styleReady = ensureVoiceNoteStyles();

  let phase: Phase = "starting";
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let objectUrl: string | null = null;
  let note: RecordedVoiceNote | null = null;
  let closed = false;
  let releasingTracks = false;
  let sending = false;
  let recordingFailed = false;
  let autoStartPending = deps.autoStart === true;
  let sendAbort: AbortController | null = null;

  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserBytes: Uint8Array<ArrayBuffer> | null = null;
  let meterSamples: number[] = [];

  let meterEpoch = 0;

  const visual = el("div", { class: "gc-voice-note-visual", "aria-hidden": "true" }, [
    el("span", { class: "gc-voice-note-pulse" }, [icon("mic")]),
    el("span", { class: "gc-voice-note-livebars" }, Array.from({ length: 12 }, (_, i) =>
      el("i", { class: "gc-voice-note-livebar", "data-bar": String(i) }),
    )),
  ]);
  const preview = el("audio", { class: "gc-voice-note-preview", controls: true, hidden: true }) as HTMLAudioElement;
  const status = el("p", { class: "gc-voice-note-status", role: "status", "aria-live": "polite" }, [text.preparing]);
  const error = el("p", { class: "gc-voice-note-error", role: "alert", hidden: true });

  const cancel = el("button", {
    type: "button",
    class: "gc-icon-btn gc-voice-note-close",
    title: deps.i18n.t("common.cancel"),
    "aria-label": deps.i18n.t("common.cancel"),
  }, [icon("close")]) as HTMLButtonElement;
  const record = el("button", {
    type: "button",
    class: "gc-voice-note-record",
    title: text.record,
    "aria-label": text.record,
  }, [el("span", { "aria-hidden": "true" })]) as HTMLButtonElement;
  const retry = el("button", { type: "button", class: "gc-btn", hidden: true }, [deps.i18n.t("common.retry")]) as HTMLButtonElement;
  const retake = el("button", { type: "button", class: "gc-btn", hidden: true }, [text.retake]) as HTMLButtonElement;
  const send = el("button", { type: "button", class: "gc-btn gc-btn-accent", hidden: true }, [text.send]) as HTMLButtonElement;
  const actions = el("div", { class: "gc-voice-note-actions" }, [record, retry, retake, send]);
  const panel = el("section", { class: "gc-voice-note-panel" }, [
    el("header", { class: "gc-voice-note-head" }, [el("h2", {}, [text.title]), cancel]),
    visual,
    preview,
    status,
    error,
    actions,
  ]);
  const root = el("div", {
    class: "gc-overlay gc-voice-note-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": text.title,
    "data-phase": phase,
  }, [panel]);
  const trap = createFocusTrap(root);

  root.style.visibility = "hidden";
  void styleReady.finally(() => {
    if (!closed) root.style.removeProperty("visibility");
  });

  function clearTimers(): void {
    if (clockTimer !== null) clearInterval(clockTimer);
    if (deadline !== null) clearTimeout(deadline);
    clockTimer = null;
    deadline = null;
  }

  function revokeReview(): void {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    note = null;
    preview.pause?.();
    preview.removeAttribute("src");
    preview.load?.();
    preview.hidden = true;
  }

  function releaseStream(target: MediaStream | null): void {
    if (!target) return;
    releasingTracks = true;
    try {
      for (const track of target.getTracks()) track.stop();
    } finally {
      releasingTracks = false;
    }
  }

  function stopTracks(): void {
    const current = stream;
    stream = null;
    releaseStream(current);
  }

  async function stopMeter(): Promise<void> {
    meterEpoch += 1;
    analyser = null;
    analyserBytes = null;
    const current = audioContext;
    audioContext = null;
    if (current) await current.close().catch(() => undefined);
  }

  async function startMeter(target: MediaStream): Promise<void> {
    const epoch = ++meterEpoch;
    meterSamples = [];
    const scope = globalThis as typeof globalThis & {
      AudioContext?: AudioContextCtor;
      webkitAudioContext?: AudioContextCtor;
    };
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) return;
    let context: AudioContext | null = null;
    try {
      context = new Ctor();
      await context.resume().catch(() => undefined);
      // A very short recording can stop while AudioContext.resume() is pending. Never install its
      // analyser after stopMeter()/close() has already invalidated this capture generation.
      if (epoch !== meterEpoch || closed || stream !== target) {
        await context.close().catch(() => undefined);
        return;
      }
      const source = context.createMediaStreamSource(target);
      const nextAnalyser = context.createAnalyser();
      nextAnalyser.fftSize = 256;
      nextAnalyser.smoothingTimeConstant = 0.65;
      source.connect(nextAnalyser);
      audioContext = context;
      analyser = nextAnalyser;
      analyserBytes = new Uint8Array(nextAnalyser.fftSize);
    } catch {
      if (context) await context.close().catch(() => undefined);
      if (epoch === meterEpoch) {
        analyser = null;
        analyserBytes = null;
        audioContext = null;
      }
    }
  }

  function sampleMeter(): void {
    if (!analyser || !analyserBytes) return;
    analyser.getByteTimeDomainData(analyserBytes);
    let sum = 0;
    for (const value of analyserBytes) sum += Math.abs(value - 128);
    const level = Math.max(0, Math.min(1, sum / Math.max(1, analyserBytes.length * 48)));
    meterSamples.push(level);
    visual.style.setProperty("--gc-voice-level", level.toFixed(3));
  }

  function setPhase(next: Phase): void {
    phase = next;
    root.dataset.phase = next;
    const isReady = next === "ready";
    const isRecording = next === "recording";
    const isReview = next === "review";
    record.hidden = !(isReady || isRecording);
    record.classList.toggle("is-recording", isRecording);
    record.title = isRecording ? text.stop : text.record;
    record.setAttribute("aria-label", record.title);
    retry.hidden = next !== "error";
    retry.disabled = next !== "error";
    retake.hidden = !isReview;
    send.hidden = !isReview;
    send.disabled = sending;
    visual.hidden = isReview;
    preview.hidden = !isReview;
    status.hidden = next === "error";
    error.hidden = next !== "error";
  }

  function fail(message: string): void {
    clearTimers();
    if (recorder && recorder.state !== "inactive") recordingFailed = true;
    stopTracks();
    void stopMeter();
    status.textContent = "";
    error.textContent = message;
    setPhase("error");
  }

  function onTrackEnded(): void {
    if (closed || releasingTracks) return;
    if (phase === "recording" && recorder?.state === "recording") {
      try { recorder.stop(); } catch { fail(text.failed); }
      return;
    }
    if (phase === "ready") fail(text.unavailable);
  }

  async function openStream(): Promise<void> {
    clearTimers();
    stopTracks();
    await stopMeter();
    revokeReview();
    error.hidden = true;
    status.textContent = text.preparing;
    setPhase("starting");
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fail(text.unsupported);
      return;
    }
    try {
      const next = await mediaDevices.getUserMedia(voiceNoteConstraints());
      if (closed || document.visibilityState === "hidden") {
        releaseStream(next);
        if (!closed) close();
        return;
      }
      stream = next;
      for (const track of next.getTracks()) {
        track.addEventListener("ended", () => {
          if (stream === next) onTrackEnded();
        }, { once: true });
      }
      status.textContent = text.ready;
      setPhase("ready");
      if (autoStartPending) {
        autoStartPending = false;
        startRecording();
      }
    } catch (caught) {
      fail(errorMessage(caught, text));
    }
  }

  async function finishRecording(active: MediaRecorder, selectedMime: string): Promise<void> {
    clearTimers();
    recorder = null;
    await stopMeter();
    if (recordingFailed || phase === "error") {
      chunks = [];
      recordingFailed = false;
      stopTracks();
      return;
    }
    const endedAt = now();
    const duration = voiceNoteDuration(startedAt, endedAt, maxDurationSec);
    const mime = active.mimeType || chunks.find((chunk) => chunk.type)?.type || selectedMime || "audio/webm";
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    stopTracks();
    if (closed) return;
    if (blob.size === 0 || duration === 0) {
      fail(text.failed);
      return;
    }
    const data = new Uint8Array(await blob.arrayBuffer());
    if (closed) return;
    note = {
      data,
      name: voiceNoteFileName(mime, endedAt),
      mime,
      duration,
      waveform: voiceNoteWaveform(meterSamples),
    };
    objectUrl = URL.createObjectURL(blob);
    preview.src = objectUrl;
    preview.hidden = false;
    status.textContent = text.review;
    setPhase("review");
  }

  function startRecording(): void {
    if (!stream || phase !== "ready" || closed) return;
    const selectedMime = typeof MediaRecorder.isTypeSupported === "function"
      ? pickVoiceNoteMime((mime) => MediaRecorder.isTypeSupported(mime))
      : "";
    let active: MediaRecorder | null = null;
    let constructionError: unknown = null;
    for (const options of voiceNoteRecorderOptionCandidates(selectedMime)) {
      try {
        active = new MediaRecorder(stream, options);
        break;
      } catch (caught) {
        constructionError = caught;
      }
    }
    if (!active) {
      fail(errorMessage(constructionError, text));
      return;
    }
    recorder = active;
    chunks = [];
    recordingFailed = false;
    startedAt = now();
    active.addEventListener("dataavailable", (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    active.addEventListener("error", () => fail(text.failed), { once: true });
    active.addEventListener("stop", () => { void finishRecording(active!, selectedMime); }, { once: true });
    try {
      active.start(1000);
    } catch (caught) {
      recorder = null;
      fail(errorMessage(caught, text));
      return;
    }
    void startMeter(stream);
    setPhase("recording");
    const paintClock = (): void => {
      const elapsed = Math.min(maxDurationSec, Math.max(0, (now() - startedAt) / 1000));
      sampleMeter();
      status.textContent = `${text.recording} ${clock(elapsed)} / ${clock(maxDurationSec)}`;
    };
    paintClock();
    clockTimer = setInterval(paintClock, 100);
    deadline = setTimeout(() => {
      if (recorder === active && active.state === "recording") active.stop();
    }, maxDurationSec * 1000);
  }

  function stopRecording(): void {
    if (phase !== "recording" || recorder?.state !== "recording") return;
    recorder.stop();
  }

  function close(): void {
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
    void stopMeter();
    revokeReview();
    trap.release();
    root.remove();
    window.removeEventListener("pagehide", close);
    document.removeEventListener("visibilitychange", onVisibility);
    deps.onClose?.();
  }

  function onVisibility(): void {
    // Android's permission sheet temporarily hides the WebView before getUserMedia resolves. Once the
    // microphone is live, background capture is never allowed.
    if (document.visibilityState === "hidden" && phase !== "starting") close();
  }

  cancel.addEventListener("click", close);
  root.addEventListener("click", (event) => { if (event.target === root) close(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
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
    status.textContent = text.uploading;
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
      status.textContent = text.uploadFailed;
      error.textContent = text.uploadFailed;
      error.hidden = false;
    });
  });
  window.addEventListener("pagehide", close);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    root,
    async start() {
      // Capture begins immediately; local styling resolves in parallel and never delays Android's
      // permission prompt or the first sample of a held recording.
      void styleReady;
      if (!closed) await openStream();
    },
    focus() { trap.activate(); },
    destroy: close,
  };
}
