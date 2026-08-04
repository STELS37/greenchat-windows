// clients/web/src/call_media.ts — the browser half of a call (V75).
//
// The screens layer owns the call STATE MACHINE (ui/src/screens/call_model.ts) and knows nothing about
// WebRTC; this adapter is the only place in the product that touches RTCPeerConnection, getUserMedia
// and an <audio> sink. Keeping it in the web shell (like the FileUploader/MediaCache ports) means the
// state machine stays unit-testable in plain Node, and a future native shell can supply its own
// implementation of the same port without rewriting a single transition.
//
// Two properties this file must guarantee, because the state machine cannot:
//  1. Remote audio plays even when the call overlay is not rendered — the sink is an <audio> element
//     owned here, not a DOM node borrowed from a view that may unmount.
//  2. Every track and the peer connection are released on close(). A leaked getUserMedia track keeps
//     the phone's microphone indicator lit after the call ended, which reads as spyware.
import type {
  CallMediaDevicePort,
  CallMediaPort,
  CallMediaSession,
  IceServer,
} from "../../ui/src/screens/call_model.ts";
import {
  CALL_ENCODING_PROFILES,
  CallNetworkRecoveryPolicy,
  CallPacketLossWindow,
  CallQualityHysteresis,
  CallStatsPollGate,
  tuneCallSdp,
  type CallNetworkSample,
  type CallQualityLevel,
} from "./call_quality.ts";
import type { BrowserCallDeviceBinding, BrowserCallDeviceManager } from "./call_devices.ts";
type ConnectionState = "connecting" | "connected" | "recovering" | "failed" | "closed";

function mapState(pc: RTCPeerConnection, everConnected: boolean): ConnectionState {
  // connectionState is the aggregate signal (ICE + DTLS). Safari/older WebViews may only move
  // iceConnectionState, so both are observed and folded into one vocabulary.
  const connection = pc.connectionState ?? "new";
  const ice = pc.iceConnectionState;
  if (connection === "connected" || ice === "connected" || ice === "completed") return "connected";
  if (connection === "closed" || ice === "closed") return "closed";
  if (connection === "failed" || ice === "failed") return everConnected ? "recovering" : "failed";
  if (connection === "disconnected" || ice === "disconnected") return everConnected ? "recovering" : "connecting";
  return "connecting";
}

async function applyProfile(pc: RTCPeerConnection, level: CallQualityLevel): Promise<void> {
  const profile = CALL_ENCODING_PROFILES[level];
  await Promise.all(pc.getSenders().map(async (sender) => {
    if (!sender.track) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}];
    const encoding = parameters.encodings[0]!;
    const prioritized = encoding as RTCRtpEncodingParameters & {
      priority?: "very-low" | "low" | "medium" | "high";
      networkPriority?: "very-low" | "low" | "medium" | "high";
    };
    if (sender.track.kind === "audio") {
      encoding.maxBitrate = profile.audioBitrate;
      prioritized.priority = "high";
      prioritized.networkPriority = "high";
    } else if (sender.track.kind === "video") {
      encoding.maxBitrate = profile.videoBitrate;
      prioritized.priority = "low";
      prioritized.networkPriority = "low";
      encoding.maxFramerate = profile.maxFramerate;
      encoding.scaleResolutionDownBy = profile.scaleResolutionDownBy;
      (parameters as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = "balanced";
    }
    try { await sender.setParameters(parameters); } catch { /* older WebView: negotiation still works */ }
  }));
}

function readNetworkSample(report: RTCStatsReport, lossWindow: CallPacketLossWindow): CallNetworkSample | null {
  let lost = 0;
  let sent = 0;
  let fractionLost: number | null = null;
  let rttMs = 0;
  let jitterMs = 0;
  let available: number | null = null;
  report.forEach((raw) => {
    const stat = raw as RTCStats & Record<string, unknown>;
    if (stat.type === "remote-inbound-rtp") {
      const packetsLost = Number(stat.packetsLost ?? 0);
      if (Number.isFinite(packetsLost) && packetsLost > 0) lost += packetsLost;
      const fraction = Number(stat.fractionLost ?? Number.NaN);
      if (Number.isFinite(fraction) && fraction >= 0) fractionLost = Math.max(fractionLost ?? 0, fraction);
      const rtt = Number(stat.roundTripTime ?? 0);
      if (Number.isFinite(rtt) && rtt > 0) rttMs = Math.max(rttMs, rtt * 1000);
      const jitter = Number(stat.jitter ?? 0);
      if (Number.isFinite(jitter) && jitter > 0) jitterMs = Math.max(jitterMs, jitter * 1000);
    }
    if (stat.type === "outbound-rtp" && stat.isRemote !== true) {
      const packetsSent = Number(stat.packetsSent ?? 0);
      if (Number.isFinite(packetsSent) && packetsSent > 0) sent += packetsSent;
    }
    if (stat.type === "candidate-pair" && (stat.nominated === true || stat.selected === true)) {
      const rtt = Number(stat.currentRoundTripTime ?? 0);
      if (Number.isFinite(rtt) && rtt > 0) rttMs = Math.max(rttMs, rtt * 1000);
      const bitrate = Number(stat.availableOutgoingBitrate ?? 0);
      if (Number.isFinite(bitrate) && bitrate > 0) available = bitrate;
    }
  });
  if (lost === 0 && sent === 0 && rttMs === 0 && jitterMs === 0 && available === null) return null;
  return {
    packetLossRatio: lossWindow.update({ packetsLost: lost, packetsSent: sent, fractionLost }),
    roundTripTimeMs: rttMs,
    jitterMs,
    availableOutgoingBitrate: available,
  };
}

export function createBrowserCallMedia(): CallMediaPort {
  // Device enumeration and switching are call-only capabilities. Capture remains the browser/native
  // WebView `mediaDevices.getUserMedia` path; loading its router lazily keeps the messenger's initial
  // bundle inside the strict startup budget while preserving one shared manager for the settings panel
  // and the active RTCPeerConnection.
  let devicesPromise: Promise<BrowserCallDeviceManager> | null = null;
  const loadDevices = (): Promise<BrowserCallDeviceManager> => {
    devicesPromise ??= import("./call_devices.ts")
      .then(({ createBrowserCallDevices }) => createBrowserCallDevices())
      .catch((error) => {
        devicesPromise = null;
        throw error;
      });
    return devicesPromise;
  };
  const devicePort: CallMediaDevicePort = {
    snapshot: async () => (await loadDevices()).snapshot(),
    select: async (kind, deviceId) => (await loadDevices()).select(kind, deviceId),
    subscribe(listener) {
      let active = true;
      let unsubscribe = (): void => {};
      void loadDevices().then((manager) => {
        const off = manager.subscribe?.(listener) ?? (() => {});
        if (active) unsubscribe = off;
        else off();
      }).catch(() => undefined);
      return () => {
        active = false;
        unsubscribe();
      };
    },
  };
  return {
    devices: devicePort,
    async open(opts) {
      // The device router applies the remembered microphone/camera, falls back when remembered USB or
      // Bluetooth hardware disappeared, and remains attached for live switching during the call.
      // Permission denial still rejects here and is translated by the controller into media_denied.
      const devices = await loadDevices();
      const local = await devices.acquire(opts.video);


      let pc: RTCPeerConnection;
      try {
        pc = new RTCPeerConnection({ iceServers: opts.iceServers as RTCIceServer[] });
      } catch (e) {
        for (const t of local.getTracks()) t.stop();
        throw e;
      }
      for (const track of local.getTracks()) {
        try { track.contentHint = track.kind === "audio" ? "speech" : "motion"; } catch { /* older WebView */ }
        pc.addTrack(track, local);
      }
      void applyProfile(pc, "high");

      const remote = new MediaStream();
      // The audio sink lives here, hidden, so the conversation survives an overlay unmount.
      const sink = document.createElement("audio");
      sink.autoplay = true;
      sink.setAttribute("aria-hidden", "true");
      sink.style.display = "none";
      document.body.appendChild(sink);
      sink.srcObject = remote;
      const deviceBinding: BrowserCallDeviceBinding = { local, pc, sink, video: opts.video };
      await devices.bind(deviceBinding);

      let localVideoEl: HTMLVideoElement | null = null;
      let remoteVideoEl: HTMLVideoElement | null = null;
      let closed = false;
      let everConnected = false;
      const pendingRemoteIce: RTCIceCandidateInit[] = [];
      const quality = new CallQualityHysteresis();
      const lossWindow = new CallPacketLossWindow();
      const statsGate = new CallStatsPollGate();
      const networkRecovery = new CallNetworkRecoveryPolicy();
      let criticalStreak = 0;
      let videoWasAutoPaused = false;
      let videoResumeAvailable = false;
      let statsTimer: ReturnType<typeof setInterval> | null = null;

      const flushRemoteIce = async (): Promise<void> => {
        if (!pc.remoteDescription) return;
        while (pendingRemoteIce.length > 0) {
          const candidate = pendingRemoteIce.shift()!;
          try { await pc.addIceCandidate(candidate); } catch { /* stale path candidate */ }
        }
      };

      const setVideoResumeAvailable = (available: boolean): void => {
        if (videoResumeAvailable === available) return;
        videoResumeAvailable = available;
        opts.onVideoResumeAvailable?.(available);
      };

      const pollQuality = (): void => {
        if (closed || !statsGate.begin()) return;
        void pc.getStats().then(async (stats) => {
          if (closed) return;
          const sample = readNetworkSample(stats, lossWindow);
          if (!sample) return;
          const level = quality.update(sample);
          await applyProfile(pc, level);
          if (closed) return;
          const cameraEnabled = local.getVideoTracks().some((track) => track.enabled);
          if (level === "critical" && cameraEnabled) {
            criticalStreak += 1;
            if (criticalStreak >= 3) {
              for (const track of local.getVideoTracks()) track.enabled = false;
              criticalStreak = 0;
              videoWasAutoPaused = true;
              setVideoResumeAvailable(false);
              opts.onVideoAutoPaused?.();
            }
          } else {
            criticalStreak = 0;
            if (videoWasAutoPaused) setVideoResumeAvailable(level === "medium" || level === "high");
          }
        }).catch(() => undefined).finally(() => statsGate.end());
      };

      pc.addEventListener("track", (ev) => {
        for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
          if (!remote.getTracks().includes(track)) remote.addTrack(track);
        }
        if (remoteVideoEl) remoteVideoEl.srcObject = remote;
        void sink.play().catch(() => {
          /* autoplay policy: the call UI is a user gesture already, a rejection here is harmless */
        });
      });
      pc.addEventListener("icecandidate", (ev) => {
        if (ev.candidate) opts.onIce(ev.candidate.toJSON());
      });
      const report = (): void => {
        if (closed) return;
        const state = mapState(pc, everConnected);
        if (state === "connected") {
          everConnected = true;
          if (navigator.onLine !== false) networkRecovery.onConnected();
          if (statsTimer === null) {
            statsTimer = setInterval(pollQuality, 2_000);
            pollQuality();
          }
        } else if (state === "recovering") {
          setVideoResumeAvailable(false);
          void applyProfile(pc, "critical");
        }
        opts.onConnectionState(state);
      };
      const networkOffline = (): void => {
        if (!closed && networkRecovery.onOffline(everConnected)) opts.onConnectionState("recovering");
      };
      const networkOnline = (): void => {
        if (closed) return;
        if (networkRecovery.onOnline(everConnected)) opts.onConnectionState("recovering");
        else report();
      };
      // effectiveType/downlink changes are quality hints, not proof that the ICE route was lost.
      const networkEstimateChanged = (): void => { if (!closed) report(); };
      pc.addEventListener("connectionstatechange", report);
      pc.addEventListener("iceconnectionstatechange", report);
      globalThis.addEventListener?.("offline", networkOffline);
      globalThis.addEventListener?.("online", networkOnline);
      const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
      connection?.addEventListener("change", networkEstimateChanged);

      const session: CallMediaSession = {
        async offer() {
          const desc = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: opts.video });
          const sdp = tuneCallSdp(desc.sdp ?? "");
          await pc.setLocalDescription({ type: "offer", sdp });
          return sdp;
        },
        async answerTo(remoteSdp) {
          await pc.setRemoteDescription({ type: "offer", sdp: remoteSdp });
          await flushRemoteIce();
          const desc = await pc.createAnswer();
          const sdp = tuneCallSdp(desc.sdp ?? "");
          await pc.setLocalDescription({ type: "answer", sdp });
          return sdp;
        },
        async applyAnswer(remoteSdp) {
          await pc.setRemoteDescription({ type: "answer", sdp: remoteSdp });
          await flushRemoteIce();
        },
        async restartOffer() {
          try { pc.restartIce(); } catch { /* createOffer(iceRestart) is the compatibility path */ }
          lossWindow.reset();
          const desc = await pc.createOffer({ iceRestart: true, offerToReceiveAudio: true, offerToReceiveVideo: opts.video });
          const sdp = tuneCallSdp(desc.sdp ?? "", CALL_ENCODING_PROFILES.critical.audioBitrate);
          await pc.setLocalDescription({ type: "offer", sdp });
          return sdp;
        },
        async answerRestart(remoteSdp) {
          lossWindow.reset();
          await pc.setRemoteDescription({ type: "offer", sdp: remoteSdp });
          await flushRemoteIce();
          const desc = await pc.createAnswer();
          const sdp = tuneCallSdp(desc.sdp ?? "", CALL_ENCODING_PROFILES.critical.audioBitrate);
          await pc.setLocalDescription({ type: "answer", sdp });
          return sdp;
        },
        async addIce(candidate) {
          const init = candidate as RTCIceCandidateInit;
          if (!pc.remoteDescription) pendingRemoteIce.push(init);
          else await pc.addIceCandidate(init);
        },
        setMuted(muted) {
          // Disabling the track (rather than removing it) keeps the negotiated session intact: the
          // peer keeps receiving silence and no renegotiation storm happens on every mute tap.
          for (const t of local.getAudioTracks()) t.enabled = !muted;
        },
        setCameraOn(on) {
          criticalStreak = 0;
          videoWasAutoPaused = false;
          setVideoResumeAvailable(false);
          for (const t of local.getVideoTracks()) t.enabled = on;
        },
        attachVideo(localEl, remoteEl) {
          localVideoEl = localEl;
          remoteVideoEl = remoteEl;
          if (localEl) {
            localEl.srcObject = local;
            localEl.muted = true; // never echo our own microphone
            void localEl.play().catch(() => undefined);
          }
          if (remoteEl) {
            remoteEl.srcObject = remote;
            void remoteEl.play().catch(() => undefined);
          }
        },
        close() {
          if (closed) return;
          closed = true;
          devices.unbind(deviceBinding);
          for (const t of local.getTracks()) t.stop();
          for (const t of remote.getTracks()) t.stop();
          if (statsTimer !== null) clearInterval(statsTimer);
          statsTimer = null;
          globalThis.removeEventListener?.("offline", networkOffline);
          globalThis.removeEventListener?.("online", networkOnline);
          connection?.removeEventListener("change", networkEstimateChanged);
          try {
            pc.close();
          } catch {
            /* already closed */
          }
          if (localVideoEl) localVideoEl.srcObject = null;
          if (remoteVideoEl) remoteVideoEl.srcObject = null;
          sink.srcObject = null;
          sink.remove();
        },
      };
      return session;
    },
  };
}

export type { IceServer };
