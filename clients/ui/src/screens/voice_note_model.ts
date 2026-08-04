// Pure compatibility and metadata decisions for Telegram-style voice notes. Browser capture and DOM
// lifecycle live in voice_note_recorder.ts; this module stays deterministic and unit-testable.

export const VOICE_NOTE_MAX_DURATION_SEC = 10 * 60;
export const VOICE_NOTE_AUDIO_BITRATE = 32_000;
export const VOICE_NOTE_WAVEFORM_BARS = 48;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
] as const;

export function pickVoiceNoteMime(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // Partial Android WebViews sometimes throw for codec strings they do not recognise.
    }
  }
  return "";
}

export function voiceNoteRecorderOptionCandidates(mime: string): MediaRecorderOptions[] {
  const bounded: MediaRecorderOptions = { audioBitsPerSecond: VOICE_NOTE_AUDIO_BITRATE };
  const candidates: MediaRecorderOptions[] = mime
    ? [{ ...bounded, mimeType: mime }, { mimeType: mime }, bounded, {}]
    : [bounded, {}];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function voiceNoteConstraints(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 },
    },
    video: false,
  };
}

export function voiceNoteDuration(
  startedAtMs: number,
  endedAtMs: number,
  maxSec = VOICE_NOTE_MAX_DURATION_SEC,
): number {
  const ceiling = Number.isFinite(maxSec) && maxSec > 0
    ? Math.floor(maxSec)
    : VOICE_NOTE_MAX_DURATION_SEC;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs <= startedAtMs) return 0;
  return Math.min(ceiling, Math.max(1, Math.ceil((endedAtMs - startedAtMs) / 1000)));
}

export function voiceNoteExtension(mime: string): "ogg" | "m4a" | "webm" {
  const normalized = mime.toLowerCase();
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  return "webm";
}

export function voiceNoteFileName(mime: string, nowMs: number): string {
  const stamp = new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString().replace(/[:.]/g, "-");
  return `voice-note-${stamp}.${voiceNoteExtension(mime)}`;
}

/**
 * Convert live analyser amplitudes into the server/player's compact 0..255 waveform. Resampling is
 * max-pooling rather than averaging, so a short spoken consonant remains visible instead of vanishing.
 */
export function voiceNoteWaveform(samples: readonly number[], bars = VOICE_NOTE_WAVEFORM_BARS): number[] {
  const count = Number.isFinite(bars) ? Math.max(1, Math.min(128, Math.floor(bars))) : VOICE_NOTE_WAVEFORM_BARS;
  const clean = samples.map((sample) => Number.isFinite(sample) ? Math.max(0, sample) : 0);
  if (clean.length === 0) return [];
  const peak = Math.max(...clean, 0);
  if (peak <= 0) return Array.from({ length: Math.min(count, clean.length) }, () => 0);
  const out: number[] = [];
  const target = Math.min(count, clean.length);
  for (let i = 0; i < target; i += 1) {
    const start = Math.floor((i * clean.length) / target);
    const end = Math.max(start + 1, Math.floor(((i + 1) * clean.length) / target));
    let local = 0;
    for (let j = start; j < end && j < clean.length; j += 1) local = Math.max(local, clean[j]!);
    out.push(Math.max(0, Math.min(255, Math.round((local / peak) * 255))));
  }
  return out;
}
