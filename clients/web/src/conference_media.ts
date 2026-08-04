import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type TrackPublication,
} from "livekit-client";
import type {
  ConferenceMediaOpenOptions,
  ConferenceMediaPort,
  ConferenceMediaSession,
  ConferenceQualityLevel,
} from "../../ui/src/screens/conference_model.ts";

import { createBrowserConferenceDevices } from "./conference_devices.ts";

export type ConferenceVideoSource = "camera" | "screen";

export interface ConferenceVideoTrack {
  key: string;
  userId: number;
  name: string;
  local: boolean;
  source: ConferenceVideoSource;
  muted: boolean;
  attach(element: HTMLVideoElement): void;
  detach(element: HTMLVideoElement): void;
}

interface NativeConferenceScreenShareBridge {
  availability(): Promise<{ supported: boolean; mode: "media_projection" | "replaykit_in_app" | "none" }>;
  start(grant: { mediaUrl: string; token: string; expiresAt: number; identity: string }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ active: boolean }>;
  onStopped(callback: (reason: string) => void): () => void;
}

export interface BrowserConferenceMediaDeps {
  onTracks(tracks: readonly ConferenceVideoTrack[]): void;
  document?: Document;
  nativeScreenShare?: NativeConferenceScreenShareBridge;
}

function metadataUserId(metadata: string | undefined): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const value = Number(parsed.user_id);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function conferenceUserId(identity: string, metadata?: string): number | null {
  const fromMetadata = metadataUserId(metadata);
  if (fromMetadata !== null) return fromMetadata;
  const match = /^gc-(?:user|screen)-(\d+)$/.exec(identity);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function conferenceIsScreenPublisher(identity: string, metadata?: string): boolean {
  if (/^gc-screen-[1-9][0-9]*$/.test(identity)) return true;
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed.screen_share === true;
  } catch {
    return false;
  }
}

export interface ConferenceParticipantMediaInput {
  identity: string;
  metadata: string | undefined;
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  isScreenShareEnabled: boolean;
}

/**
 * Merge the primary LiveKit identity and the native screen-only identity back into one GreenChat
 * participant. This prevents the auxiliary publisher (which has no mic/camera) from overwriting the
 * real microphone/camera state and makes screen state deterministic regardless of participant order.
 */
export function conferenceParticipantMediaSnapshot(
  participants: readonly ConferenceParticipantMediaInput[],
): Array<{ userId: number; state: { muted?: boolean; cameraOn?: boolean; screenSharing: boolean } }> {
  const merged = new Map<number, { muted?: boolean; cameraOn?: boolean; screenSharing: boolean }>();
  for (const participant of participants) {
    const userId = conferenceUserId(participant.identity, participant.metadata);
    if (userId === null) continue;
    const state = merged.get(userId) ?? { screenSharing: false };
    if (conferenceIsScreenPublisher(participant.identity, participant.metadata)) {
      state.screenSharing = state.screenSharing || participant.isScreenShareEnabled;
    } else {
      state.muted = !participant.isMicrophoneEnabled;
      state.cameraOn = participant.isCameraEnabled;
      state.screenSharing = state.screenSharing || participant.isScreenShareEnabled;
    }
    merged.set(userId, state);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a - b)
    .map(([userId, state]) => ({ userId, state }));
}

export function conferenceQuality(quality: ConnectionQuality): ConferenceQualityLevel {
  if (quality === ConnectionQuality.Excellent) return "high";
  if (quality === ConnectionQuality.Good || quality === ConnectionQuality.Unknown) return "medium";
  if (quality === ConnectionQuality.Poor) return "low";
  return "critical";
}

function trackSource(source: Track.Source): ConferenceVideoSource | null {
  if (source === Track.Source.Camera) return "camera";
  if (source === Track.Source.ScreenShare) return "screen";
  return null;
}

function mediaError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function createBrowserConferenceMedia(deps: BrowserConferenceMediaDeps): ConferenceMediaPort {
  const doc = deps.document ?? document;
  const nativeScreenShare = deps.nativeScreenShare ?? (
    globalThis as typeof globalThis & { __gcConferenceScreenShare?: NativeConferenceScreenShareBridge }
  ).__gcConferenceScreenShare;
  let latestTracks: ConferenceVideoTrack[] = [];

  const devices = createBrowserConferenceDevices();

  const publishTracks = (tracks: ConferenceVideoTrack[]): void => {
    latestTracks = tracks;
    deps.onTracks([...latestTracks]);
  };

  return {
    devices,
    destroy() { devices.destroy(); },
    async open(opts: ConferenceMediaOpenOptions): Promise<ConferenceMediaSession> {
      const audioHost = doc.createElement("div");
      audioHost.hidden = true;
      audioHost.className = "gc-conference-audio-host";
      doc.body.append(audioHost);
      const audioElements = new Map<string, HTMLAudioElement>();
      let closing = false;
      let connected = false;
      let nativeScreenActive = false;
      let removeNativeStoppedListener: (() => void) | null = null;

      let devicesBound = false;

      const room = new Room({
        adaptiveStream: { pauseVideoInBackground: true, pixelDensity: "screen" },
        dynacast: true,
        disconnectOnPageLeave: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution,
          facingMode: "user",
        },
        publishDefaults: {
          simulcast: true,
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        },
      });

      const participantId = (participant: Participant): number | null =>
        conferenceUserId(participant.identity, participant.metadata);

      const allParticipants = (): Participant[] => [
        room.localParticipant,
        ...room.remoteParticipants.values(),
      ];

      const syncParticipantMedia = (): void => {
        const snapshot = conferenceParticipantMediaSnapshot(allParticipants().map((participant) => ({
          identity: participant.identity,
          metadata: participant.metadata,
          isMicrophoneEnabled: participant.isMicrophoneEnabled,
          isCameraEnabled: participant.isCameraEnabled,
          isScreenShareEnabled: participant.isScreenShareEnabled,
        })));
        for (const item of snapshot) {
          // The auxiliary Android room may need one signalling round-trip before its participant is
          // visible in the primary room. Keep the explicit local state authoritative during that gap.
          if (item.userId === opts.selfUserId && nativeScreenActive) item.state.screenSharing = true;
          opts.onParticipantMedia(item.userId, item.state);
        }
      };

      const detachAudio = (key: string): void => {
        const element = audioElements.get(key);
        if (!element) return;
        element.pause();
        element.srcObject = null;
        element.remove();
        audioElements.delete(key);
      };

      const syncAudio = (): void => {
        const expected = new Set<string>();
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.audioTrackPublications.values()) {
            const track = publication.track;
            if (!track || publication.isMuted) continue;
            const key = `${participant.identity}:${publication.trackSid}`;
            expected.add(key);
            if (audioElements.has(key)) continue;
            const audio = doc.createElement("audio");
            audio.autoplay = true;
            audio.dataset.conferenceTrack = key;
            track.attach(audio);
            audioHost.append(audio);
            audioElements.set(key, audio);
          }
        }
        for (const key of [...audioElements.keys()]) {
          if (!expected.has(key)) detachAudio(key);
        }
        opts.onAudioPlaybackBlocked(!room.canPlaybackAudio);
      };

      const toVideoView = (participant: Participant, publication: TrackPublication): ConferenceVideoTrack | null => {
        const source = trackSource(publication.source);
        const track = publication.track;
        const userId = participantId(participant);
        if (!source || !track || userId === null) return null;
        const key = `${participant.identity}:${publication.trackSid}`;
        return {
          key,
          userId,
          name: participant.name?.trim() || participant.identity,
          local: participant.isLocal,
          source,
          muted: publication.isMuted,
          attach(element) { track.attach(element); },
          detach(element) { track.detach(element); },
        };
      };

      const syncTracks = (): void => {
        const next: ConferenceVideoTrack[] = [];
        syncParticipantMedia();
        for (const participant of allParticipants()) {
          for (const publication of participant.videoTrackPublications.values()) {
            const view = toVideoView(participant, publication);
            if (view) next.push(view);
          }
        }
        next.sort((a, b) => {
          if (a.source !== b.source) return a.source === "screen" ? -1 : 1;
          if (a.local !== b.local) return a.local ? 1 : -1;
          return a.userId - b.userId || a.key.localeCompare(b.key);
        });
        publishTracks(next);
        syncAudio();
      };

      room
        .on(RoomEvent.Connected, () => {
          connected = true;
          opts.onConnectionState("connected");
          syncTracks();
        })
        .on(RoomEvent.Reconnecting, () => { opts.onConnectionState("recovering"); })
        .on(RoomEvent.SignalReconnecting, () => { opts.onConnectionState("recovering"); })
        .on(RoomEvent.Reconnected, () => {
          opts.onConnectionState("connected");
          syncTracks();
        })
        .on(RoomEvent.Disconnected, () => {
          connected = false;
          opts.onConnectionState(closing ? "closed" : "failed");
          publishTracks([]);
        })
        .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
          const first = participants[0];
          opts.onActiveSpeaker(first ? participantId(first) : null);
        })
        .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
          if (participant.isLocal) opts.onQuality(conferenceQuality(quality));
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          opts.onAudioPlaybackBlocked(!room.canPlaybackAudio);
        })
        .on(RoomEvent.ParticipantConnected, () => { syncTracks(); })
        .on(RoomEvent.ParticipantDisconnected, () => { syncTracks(); })
        .on(RoomEvent.TrackSubscribed, () => { syncTracks(); })
        .on(RoomEvent.TrackUnsubscribed, () => { syncTracks(); })
        .on(RoomEvent.TrackPublished, () => { syncTracks(); })
        .on(RoomEvent.TrackUnpublished, () => { syncTracks(); })
        .on(RoomEvent.TrackMuted, () => { syncTracks(); })
        .on(RoomEvent.TrackUnmuted, () => { syncTracks(); })
        .on(RoomEvent.LocalTrackPublished, () => { syncTracks(); })
        .on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (publication.source === Track.Source.ScreenShare) opts.onLocalScreenEnded();
          syncTracks();
        });

      if (nativeScreenShare) {
        removeNativeStoppedListener = nativeScreenShare.onStopped(() => {
          nativeScreenActive = false;
          opts.onParticipantMedia(opts.selfUserId, { screenSharing: false });
          opts.onLocalScreenEnded();
        });
      }

      try {
        opts.onConnectionState("connecting");
        await room.connect(opts.mediaUrl, opts.token, {
          autoSubscribe: true,
          maxRetries: 3,
          peerConnectionTimeout: 15_000,
          websocketTimeout: 15_000,
        });
        // Apply the shared call-device preference before publishing local tracks. LiveKit updates its
        // capture defaults while no microphone/camera track exists, so the first published frame
        // already comes from the requested hardware instead of briefly opening the system default.
        await devices.bind(room);
        devicesBound = true;
        // Capture happens only after the authenticated SFU session is established. A denied device is
        // local degradation, not a reason to tear down audio from everyone else.
        if (opts.microphoneOn) {
          try { await room.localParticipant.setMicrophoneEnabled(true); }
          catch { opts.onParticipantMedia(opts.selfUserId, { muted: true }); }
        }
        if (opts.cameraOn) {
          try { await room.localParticipant.setCameraEnabled(true); }
          catch { opts.onParticipantMedia(opts.selfUserId, { cameraOn: false }); }
        }
        syncTracks();
      } catch (error) {
        closing = true;
        if (devicesBound) devices.unbind(room);
        await room.disconnect(true).catch(() => undefined);
        audioHost.remove();
        publishTracks([]);
        throw error;
      }

      return {
        async setMuted(muted) {
          if (!connected || closing) return;
          await room.localParticipant.setMicrophoneEnabled(!muted);
          syncTracks();
        },
        async setCameraOn(on) {
          if (!connected || closing) return;
          await room.localParticipant.setCameraEnabled(on);
          syncTracks();
        },
        async startScreenShare() {
          if (!connected || closing) throw mediaError("InvalidStateError", "conference is not connected");
          if (nativeScreenShare) {
            const availability = await nativeScreenShare.availability();
            if (!availability.supported) throw mediaError("NotSupportedError", "native screen capture is unavailable");
            const grant = await opts.requestScreenShareGrant();
            await nativeScreenShare.start({
              mediaUrl: grant.media_url,
              token: grant.token,
              expiresAt: grant.expires_at,
              identity: grant.identity,
            });
            nativeScreenActive = true;
            opts.onParticipantMedia(opts.selfUserId, { screenSharing: true });
            return;
          }
          if (!navigator.mediaDevices?.getDisplayMedia) {
            throw mediaError("NotSupportedError", "screen capture is unavailable");
          }
          await room.localParticipant.setScreenShareEnabled(true, { audio: false }, { simulcast: true });
          syncTracks();
        },
        async stopScreenShare() {
          if (nativeScreenShare && nativeScreenActive) {
            nativeScreenActive = false;
            await nativeScreenShare.stop();
            opts.onParticipantMedia(opts.selfUserId, { screenSharing: false });
            return;
          }
          if (!connected || closing) return;
          await room.localParticipant.setScreenShareEnabled(false);
          syncTracks();
        },
        async resumeAudio() {
          if (!connected || closing) return;
          await room.startAudio();
          opts.onAudioPlaybackBlocked(!room.canPlaybackAudio);
        },
        // LiveKit rotates reconnect credentials over the signal connection. The GreenChat controller
        // still refreshes its short-lived control-plane grant to observe role/revocation changes; a
        // connected Room must not be torn down merely to inject that HTTP response token.
        updateToken(_token: string) {},
        close() {
          if (closing) return;
          closing = true;
          if (devicesBound) {
            devices.unbind(room);
            devicesBound = false;
          }
          removeNativeStoppedListener?.();
          removeNativeStoppedListener = null;
          if (nativeScreenShare && nativeScreenActive) {
            nativeScreenActive = false;
            void nativeScreenShare.stop().catch(() => undefined);
          }
          for (const key of [...audioElements.keys()]) detachAudio(key);
          audioHost.remove();
          for (const track of latestTracks) {
            // The overlay detaches its elements when the empty snapshot arrives.
            void track;
          }
          publishTracks([]);
          void room.disconnect(true).catch(() => undefined);
        },
      };
    },
  };
}
