// Adaptive media policy for GreenChat calls.
// Pure helpers live here so the thresholds and SDP changes are testable without browser globals.

export type CallQualityLevel = "high" | "medium" | "low" | "critical";

export interface CallNetworkSample {
  packetLossRatio: number;
  roundTripTimeMs: number;
  jitterMs?: number | null;
  availableOutgoingBitrate?: number | null;
}

export interface CallEncodingProfile {
  audioBitrate: number;
  videoBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}
export interface CallPacketCounters {
  packetsLost: number;
  packetsSent: number;
  // WebRTC may expose an interval-native fractionLost. Prefer it when present.
  fractionLost?: number | null;
}

// WebRTC packet counters are cumulative. This window converts them into per-interval loss so one old
// outage cannot keep the call degraded forever. A counter reset (ICE restart/new SSRC) starts a new base.
export class CallPacketLossWindow {
  private previous: { lost: number; sent: number } | null = null;

  update(input: CallPacketCounters): number {
    const native = input.fractionLost;
    if (typeof native === "number" && Number.isFinite(native) && native >= 0) {
      this.previous = {
        lost: Math.max(0, input.packetsLost),
        sent: Math.max(0, input.packetsSent),
      };
      return Math.min(1, native);
    }
    const current = {
      lost: Math.max(0, Number.isFinite(input.packetsLost) ? input.packetsLost : 0),
      sent: Math.max(0, Number.isFinite(input.packetsSent) ? input.packetsSent : 0),
    };
    const before = this.previous;
    this.previous = current;
    if (!before || current.lost < before.lost || current.sent < before.sent) {
      return current.lost / Math.max(1, current.sent);
    }
    const lost = current.lost - before.lost;
    const sent = current.sent - before.sent;
    return lost / Math.max(1, sent);
  }

  reset(): void { this.previous = null; }
}


// A slow getStats()/setParameters round must never overlap the next interval. Without this gate,
// delayed mobile WebViews can apply stale quality samples out of order and oscillate bitrate harder
// precisely when the radio is already congested.
export class CallStatsPollGate {
  private active = false;

  begin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  end(): void { this.active = false; }
}

// Network Information `change` fires for estimated downlink/effectiveType fluctuations, not only a
// Wi-Fi↔cellular route handover. Treating every such event as ICE failure causes restart storms. Only
// an observed offline→online cycle is a proactive recovery signal; RTCPeerConnection state remains the
// source of truth for all other route changes.
export class CallNetworkRecoveryPolicy {
  private sawOffline = false;

  onOffline(everConnected: boolean): boolean {
    if (!everConnected || this.sawOffline) return false;
    this.sawOffline = true;
    return true;
  }

  onOnline(everConnected: boolean): boolean {
    const shouldRecover = everConnected && this.sawOffline;
    this.sawOffline = false;
    return shouldRecover;
  }

  onConnected(): void { this.sawOffline = false; }
}

export const CALL_ENCODING_PROFILES: Readonly<Record<CallQualityLevel, CallEncodingProfile>> = {
  high: { audioBitrate: 40_000, videoBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
  medium: { audioBitrate: 32_000, videoBitrate: 700_000, maxFramerate: 20, scaleResolutionDownBy: 1.25 },
  low: { audioBitrate: 24_000, videoBitrate: 300_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
  critical: { audioBitrate: 16_000, videoBitrate: 100_000, maxFramerate: 8, scaleResolutionDownBy: 3 },
};

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function classifyCallQuality(sample: CallNetworkSample): CallQualityLevel {
  const loss = Math.min(1, finiteNonNegative(sample.packetLossRatio));
  const rtt = finiteNonNegative(sample.roundTripTimeMs);
  const jitter = finiteNonNegative(sample.jitterMs ?? 0);
  const bitrate = sample.availableOutgoingBitrate;
  if (loss >= 0.15 || rtt >= 800 || jitter >= 250 || (typeof bitrate === "number" && bitrate > 0 && bitrate < 120_000)) {
    return "critical";
  }
  if (loss >= 0.08 || rtt >= 500 || jitter >= 120 || (typeof bitrate === "number" && bitrate > 0 && bitrate < 300_000)) {
    return "low";
  }
  if (loss >= 0.03 || rtt >= 250 || jitter >= 60 || (typeof bitrate === "number" && bitrate > 0 && bitrate < 700_000)) {
    return "medium";
  }
  return "high";
}

const QUALITY_RANK: Record<CallQualityLevel, number> = { critical: 0, low: 1, medium: 2, high: 3 };

// Worsen immediately; improve only after three consecutive better samples. This prevents resolution
// and bitrate oscillation on a marginal mobile link while still reacting quickly to real congestion.
export class CallQualityHysteresis {
  private level: CallQualityLevel = "high";
  private improvingStreak = 0;

  current(): CallQualityLevel { return this.level; }

  update(sample: CallNetworkSample): CallQualityLevel {
    const measured = classifyCallQuality(sample);
    if (QUALITY_RANK[measured] < QUALITY_RANK[this.level]) {
      this.level = measured;
      this.improvingStreak = 0;
      return this.level;
    }
    if (QUALITY_RANK[measured] > QUALITY_RANK[this.level]) {
      this.improvingStreak += 1;
      if (this.improvingStreak >= 3) {
        // Recover one rung at a time; a single good interval never jumps from critical to HD.
        const nextRank = Math.min(QUALITY_RANK.high, QUALITY_RANK[this.level] + 1);
        this.level = (Object.keys(QUALITY_RANK) as CallQualityLevel[])
          .find((key) => QUALITY_RANK[key] === nextRank) ?? this.level;
        this.improvingStreak = 0;
      }
    } else {
      this.improvingStreak = 0;
    }
    return this.level;
  }
}

function setFmtpParameter(line: string, key: string, value: string): string {
  const [head, raw = ""] = line.split(/\s+/, 2);
  const pairs = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const next = pairs.filter((part) => part.split("=", 1)[0]?.toLowerCase() !== key.toLowerCase());
  next.push(`${key}=${value}`);
  return `${head} ${next.join(";")}`;
}

// Opus FEC protects short packet-loss bursts; DTX avoids spending radio/battery while nobody speaks.
// The transform is idempotent and touches only the Opus payload inside the audio media section.
export function tuneCallSdp(sdp: string, maxAverageBitrate = 40_000): string {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r?\n/);
  let inAudio = false;
  let opusPayload: string | null = null;
  for (const line of lines) {
    if (line.startsWith("m=")) inAudio = line.startsWith("m=audio ");
    if (!inAudio) continue;
    const match = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
    if (match) { opusPayload = match[1] ?? null; break; }
  }
  if (!opusPayload) return sdp;
  const fmtpPrefix = `a=fmtp:${opusPayload}`;
  let fmtpIndex = -1;
  let audioEnd = lines.length;
  inAudio = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("m=")) {
      if (inAudio) { audioEnd = i; break; }
      inAudio = line.startsWith("m=audio ");
    }
    if (inAudio && line.startsWith(fmtpPrefix)) fmtpIndex = i;
  }
  let fmtp = fmtpIndex >= 0 ? (lines[fmtpIndex] ?? fmtpPrefix) : fmtpPrefix;
  for (const [key, value] of [
    ["useinbandfec", "1"], ["usedtx", "1"], ["stereo", "0"], ["sprop-stereo", "0"],
    ["maxaveragebitrate", String(Math.max(12_000, Math.floor(maxAverageBitrate)))],
  ] as const) fmtp = setFmtpParameter(fmtp, key, value);
  if (fmtpIndex >= 0) lines[fmtpIndex] = fmtp;
  else lines.splice(audioEnd, 0, fmtp);
  return lines.join("\r\n");
}
