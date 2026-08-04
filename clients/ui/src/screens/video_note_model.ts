// Pure decisions for Telegram-style round video notes. Browser media capture and DOM wiring live in
// video_note_recorder.ts; keeping negotiation and limits here makes every compatibility branch testable.

export type VideoNoteFacing = "user" | "environment";

export const VIDEO_NOTE_MAX_DURATION_SEC = 60;
export const VIDEO_NOTE_IDEAL_EDGE = 720;
export const VIDEO_NOTE_VIDEO_BITRATE = 1_200_000;
export const VIDEO_NOTE_AUDIO_BITRATE = 48_000;

/**
 * MediaRecorder support in mobile WebViews is not perfectly trustworthy: a container may be reported
 * as supported and still make the constructor throw when bitrate hints are present. Try the most
 * explicit, bandwidth-bounded shape first, then progressively remove optional hints without changing
 * the captured stream. The final empty options object lets the browser choose its native container.
 */
export function videoNoteRecorderOptionCandidates(mime: string): MediaRecorderOptions[] {
  const bitrateOnly: MediaRecorderOptions = {
    videoBitsPerSecond: VIDEO_NOTE_VIDEO_BITRATE,
    audioBitsPerSecond: VIDEO_NOTE_AUDIO_BITRATE,
  };
  const candidates: MediaRecorderOptions[] = mime
    ? [
        { ...bitrateOnly, mimeType: mime },
        { mimeType: mime },
        bitrateOnly,
        {},
      ]
    : [bitrateOnly, {}];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const identity = JSON.stringify(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
] as const;

export function pickVideoNoteMime(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // A partial WebView may throw for an unknown codec string. Continue to the simpler candidates.
    }
  }
  return "";
}

export function videoNoteExtension(mime: string): "webm" | "mp4" {
  return mime.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

export function videoNoteFileName(mime: string, nowMs: number): string {
  const stamp = new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString().replace(/[:.]/g, "-");
  return `video-note-${stamp}.${videoNoteExtension(mime)}`;
}

export function videoNoteDuration(startedAtMs: number, endedAtMs: number, maxSec = VIDEO_NOTE_MAX_DURATION_SEC): number {
  const ceiling = Number.isFinite(maxSec) && maxSec > 0 ? Math.floor(maxSec) : VIDEO_NOTE_MAX_DURATION_SEC;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs <= startedAtMs) return 0;
  return Math.min(ceiling, Math.max(1, Math.ceil((endedAtMs - startedAtMs) / 1000)));
}

export function nextVideoNoteFacing(current: VideoNoteFacing): VideoNoteFacing {
  return current === "user" ? "environment" : "user";
}

export function videoNoteConstraints(facing: VideoNoteFacing): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
    },
    video: {
      facingMode: { ideal: facing },
      width: { ideal: VIDEO_NOTE_IDEAL_EDGE, max: 1280 },
      height: { ideal: VIDEO_NOTE_IDEAL_EDGE, max: 1280 },
      frameRate: { ideal: 24, max: 30 },
      aspectRatio: { ideal: 1 },
    },
  };
}

export function videoNoteLayoutEdge(videoWidth: number, videoHeight: number): number {
  const valid = [videoWidth, videoHeight].filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length === 0) return VIDEO_NOTE_IDEAL_EDGE;
  return Math.max(1, Math.min(VIDEO_NOTE_IDEAL_EDGE, Math.floor(Math.min(...valid))));
}
