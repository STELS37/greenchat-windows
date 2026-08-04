import {
  EMPTY_CALL_DEVICE_SNAPSHOT,
  type CallDeviceSnapshot,
  type CallMediaDeviceKind,
  type CallMediaDevicePort,
} from "./call_model.ts";

// Pure conference state machine for group audio/video calls.
//
// The GreenChat API owns membership, roles and moderation. A replaceable SFU adapter owns media. This
// controller is the boundary between them: it keeps long calls alive through token refresh and route
// recovery, preserves audio before video, and makes screen sharing an explicit, revocable user action.

export type ConferencePhase =
  | "idle"
  | "joining"
  | "connecting"
  | "active"
  | "reconnecting"
  | "leaving"
  | "ended"
  | "error";

export type ConferenceMode = "conversation" | "stage" | "broadcast";
export type ConferenceRole = "owner" | "speaker" | "listener";
export type ConferenceQualityLevel = "high" | "medium" | "low" | "critical";
export type ConferenceEndReason = "left" | "ended_remote" | "removed" | "failed";
export type ScreenShareError = "denied" | "unavailable" | "failed";

export interface ConferenceParticipant {
  userId: number;
  role: ConferenceRole;
  moderator: boolean;
  joinedAt: number;
  handRaised: boolean;
  muted?: boolean;
  cameraOn?: boolean;
  screenSharing?: boolean;
  speaking?: boolean;
}

export interface ConferenceState {
  phase: ConferencePhase;
  conferenceId: string | null;
  chatId: number | null;
  mode: ConferenceMode;
  video: boolean;
  role: ConferenceRole;
  participants: ConferenceParticipant[];
  activeSpeakerId: number | null;
  connectedAt: number | null;
  quality: ConferenceQualityLevel;
  audioPlaybackBlocked: boolean;
  muted: boolean;
  mutedByAdmin: boolean;
  cameraOn: boolean;
  cameraAutoPaused: boolean;
  cameraCanResume: boolean;
  screenSharing: boolean;
  screenShareError: ScreenShareError | null;
  handRaised: boolean;
  reason: ConferenceEndReason | null;
  error: string | null;
}

export const IDLE_CONFERENCE_STATE: ConferenceState = {
  phase: "idle",
  conferenceId: null,
  chatId: null,
  mode: "conversation",
  video: false,
  role: "listener",
  participants: [],
  activeSpeakerId: null,
  connectedAt: null,
  quality: "high",
  audioPlaybackBlocked: false,
  muted: true,
  mutedByAdmin: false,
  cameraOn: false,
  cameraAutoPaused: false,
  cameraCanResume: false,
  screenSharing: false,
  screenShareError: null,
  handRaised: false,
  reason: null,
  error: null,
};

interface RawConferenceParticipant {
  user_id: number;
  role: ConferenceRole;
  moderator: boolean;
  joined_at: number;
  hand_raised: boolean;
}

export interface ConferenceJoinGrant {
  conference: {
    id: string;
    chat_id: number;
    mode: ConferenceMode;
    video: boolean;
    participants: RawConferenceParticipant[];
  };
  media_url: string;
  token: string;
  expires_at: number;
  role: ConferenceRole;
}

export interface ConferenceScreenShareGrant {
  media_url: string;
  token: string;
  expires_at: number;
  identity: string;
  source: "screen_share";
}

export interface ConferenceApiPort {
  join(conferenceId: string): Promise<ConferenceJoinGrant>;
  screenShareGrant(conferenceId: string): Promise<ConferenceScreenShareGrant>;
  leave(conferenceId: string): Promise<void>;
  raiseHand(conferenceId: string): Promise<void>;
  changeRole(conferenceId: string, userId: number, role: "speaker" | "listener"): Promise<void>;
  removeParticipant(conferenceId: string, userId: number): Promise<void>;
  end(conferenceId: string): Promise<void>;
}

export interface ConferenceMediaSession {
  setMuted(muted: boolean): void;
  setCameraOn(on: boolean): void;
  startScreenShare(): Promise<void>;
  stopScreenShare(): Promise<void> | void;
  resumeAudio(): Promise<void>;
  updateToken(token: string): Promise<void> | void;
  close(): void;
}

export interface ConferenceMediaOpenOptions {
  mediaUrl: string;
  token: string;
  selfUserId: number;
  microphoneOn: boolean;
  cameraOn: boolean;
  onConnectionState(state: "connecting" | "connected" | "recovering" | "failed" | "closed"): void;
  onQuality(level: ConferenceQualityLevel): void;
  onActiveSpeaker(userId: number | null): void;
  onParticipantMedia(userId: number, state: { muted?: boolean; cameraOn?: boolean; screenSharing?: boolean }): void;
  onAudioPlaybackBlocked(blocked: boolean): void;
  requestScreenShareGrant(): Promise<ConferenceScreenShareGrant>;
  onLocalScreenEnded(): void;
}

export interface ConferenceMediaPort {
  open(opts: ConferenceMediaOpenOptions): Promise<ConferenceMediaSession>;
  devices?: CallMediaDevicePort;
  destroy?(): void;
}

export interface ConferenceControllerDeps {
  api: ConferenceApiPort;
  media: ConferenceMediaPort;
  selfUserId: number;
  onState(state: ConferenceState): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  recoveryTimeoutMs?: number;
  tokenRefreshLeadMs?: number;
  tokenRetryMs?: number;
}

function participantFromFrame(raw: unknown): ConferenceParticipant | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const userId = Number(value.user_id);
  const role = String(value.role ?? "listener") as ConferenceRole;
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (role !== "owner" && role !== "speaker" && role !== "listener") return null;
  return {
    userId,
    role,
    moderator: value.moderator === true,
    joinedAt: Number.isFinite(Number(value.joined_at)) ? Number(value.joined_at) : 0,
    handRaised: value.hand_raised === true,
  };
}

function screenError(error: unknown): ScreenShareError {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  if (/notallowed|permission|denied|abort/i.test(text)) return "denied";
  if (/notsupported|notfound|unavailable|displaymedia/i.test(text)) return "unavailable";
  return "failed";
}

function conferenceMediaUrlAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost"
      || host.endsWith(".localhost")
      || host === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(host);
    return url.protocol === "wss:" || (url.protocol === "ws:" && loopback);
  } catch {
    return false;
  }
}

function validGrant(grant: ConferenceJoinGrant, expectedId: string, nowMs: number): boolean {
  if (grant.conference?.id !== expectedId) return false;
  if (!Number.isSafeInteger(grant.conference.chat_id) || grant.conference.chat_id <= 0) return false;
  if (grant.conference.mode !== "conversation" && grant.conference.mode !== "stage" && grant.conference.mode !== "broadcast") return false;
  if (grant.role !== "owner" && grant.role !== "speaker" && grant.role !== "listener") return false;
  if (typeof grant.token !== "string" || grant.token.length === 0 || !Number.isFinite(grant.expires_at)) return false;
  if (grant.expires_at * 1000 <= nowMs) return false;
  return conferenceMediaUrlAllowed(grant.media_url);
}

export class ConferenceController {
  private readonly deps: ConferenceControllerDeps;
  private state: ConferenceState = { ...IDLE_CONFERENCE_STATE };
  private session: ConferenceMediaSession | null = null;
  private epoch = 0;
  private recoveryTimer: unknown = null;
  private tokenTimer: unknown = null;
  private criticalVideoStreak = 0;
  private tokenRefreshInFlight = false;
  private closingSession = false;

  constructor(deps: ConferenceControllerDeps) {
    this.deps = deps;
  }

  get current(): ConferenceState { return this.state; }

  get busy(): boolean {
    return this.state.phase !== "idle" && this.state.phase !== "ended" && this.state.phase !== "error";
  }

  async join(conferenceId: string, preferences: { microphoneOn?: boolean; cameraOn?: boolean } = {}): Promise<void> {
    if (this.busy || !conferenceId) return;
    const epoch = ++this.epoch;
    this.clearTimers();
    const microphoneOn = preferences.microphoneOn !== false;
    const cameraRequested = preferences.cameraOn === true;
    this.set({
      ...IDLE_CONFERENCE_STATE,
      phase: "joining",
      conferenceId,
      muted: !microphoneOn,
      cameraOn: cameraRequested,
    });

    let grant: ConferenceJoinGrant;
    try {
      grant = await this.deps.api.join(conferenceId);
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
      return;
    }
    if (epoch !== this.epoch) return;
    if (!validGrant(grant, conferenceId, this.now())) {
      this.fail(new Error("invalid conference grant"));
      return;
    }

    const role = grant.role;
    const canPublish = role !== "listener";
    const cameraOn = canPublish && grant.conference.video && cameraRequested;
    const muted = !canPublish || !microphoneOn;
    this.set({
      ...this.state,
      phase: "connecting",
      chatId: grant.conference.chat_id,
      mode: grant.conference.mode,
      video: grant.conference.video,
      role,
      participants: grant.conference.participants
        .map((participant) => participantFromFrame(participant))
        .filter((participant): participant is ConferenceParticipant => participant !== null),
      muted,
      cameraOn,
    });

    try {
      const session = await this.deps.media.open({
        mediaUrl: grant.media_url,
        token: grant.token,
        selfUserId: this.deps.selfUserId,
        microphoneOn: !muted,
        cameraOn,
        onConnectionState: (state) => { if (epoch === this.epoch) this.onConnectionState(state); },
        onQuality: (level) => { if (epoch === this.epoch) this.onQuality(level); },
        onActiveSpeaker: (userId) => {
          if (epoch === this.epoch && this.busy && this.state.activeSpeakerId !== userId) {
            const participants = this.state.participants.map((participant) => ({
              ...participant,
              speaking: participant.userId === userId,
            }));
            this.set({ ...this.state, participants, activeSpeakerId: userId });
          }
        },
        onParticipantMedia: (userId, mediaState) => {
          if (epoch === this.epoch && this.busy) this.patchParticipant(userId, mediaState);
        },
        onAudioPlaybackBlocked: (blocked) => {
          if (epoch === this.epoch && this.busy && this.state.audioPlaybackBlocked !== blocked) {
            this.set({ ...this.state, audioPlaybackBlocked: blocked });
          }
        },
        requestScreenShareGrant: () => this.deps.api.screenShareGrant(conferenceId),
        onLocalScreenEnded: () => {
          if (epoch === this.epoch && this.busy && this.state.screenSharing) {
            this.set({ ...this.state, screenSharing: false });
          }
        },
      });
      if (epoch !== this.epoch) {
        session.close();
        return;
      }
      this.session = session;
      this.scheduleTokenRefresh(grant.expires_at);
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    }
  }

  async leave(): Promise<void> {
    if (this.state.phase === "idle" || this.state.phase === "ended") return;
    const id = this.state.conferenceId;
    ++this.epoch;
    this.clearTimers();
    this.closeSession();
    this.set({ ...this.state, phase: "leaving", cameraOn: false, screenSharing: false });
    if (id) {
      try { await this.deps.api.leave(id); } catch { /* local exit must never trap the person */ }
    }
    this.set({ ...this.state, phase: "ended", reason: "left", cameraOn: false, screenSharing: false });
  }

  dismiss(): void {
    if (this.state.phase !== "ended" && this.state.phase !== "error") return;
    this.set({ ...IDLE_CONFERENCE_STATE });
  }

  destroy(): void {
    ++this.epoch;
    this.clearTimers();
    this.closeSession();
    this.deps.media.destroy?.();
    this.state = { ...IDLE_CONFERENCE_STATE };
  }

  setMuted(muted: boolean): void {
    if (!this.busy || this.state.role === "listener") return;
    this.session?.setMuted(muted);
    this.set({ ...this.state, muted, mutedByAdmin: muted ? this.state.mutedByAdmin : false });
  }

  setCameraOn(on: boolean): void {
    if (!this.busy || !this.state.video || this.state.role === "listener") return;
    this.criticalVideoStreak = 0;
    this.session?.setCameraOn(on);
    this.set({
      ...this.state,
      cameraOn: on,
      cameraAutoPaused: false,
      cameraCanResume: false,
    });
  }

  async deviceSnapshot(): Promise<CallDeviceSnapshot> {
    const devices = this.deps.media.devices;
    if (!devices) return EMPTY_CALL_DEVICE_SNAPSHOT;
    return devices.snapshot();
  }

  async selectDevice(kind: CallMediaDeviceKind, deviceId: string): Promise<CallDeviceSnapshot> {
    const devices = this.deps.media.devices;
    if (!devices) return EMPTY_CALL_DEVICE_SNAPSHOT;
    return devices.select(kind, deviceId);
  }

  subscribeDevices(listener: () => void): () => void {
    return this.deps.media.devices?.subscribe?.(listener) ?? (() => {});
  }

  async startScreenShare(): Promise<void> {
    if (this.state.phase !== "active" || this.state.screenSharing) return;
    const session = this.session;
    const epoch = this.epoch;
    if (!session) return;
    this.set({ ...this.state, screenShareError: null });
    try {
      await session.startScreenShare();
      if (epoch === this.epoch && session === this.session && this.state.phase === "active") {
        this.set({ ...this.state, screenSharing: true, screenShareError: null });
      }
    } catch (error) {
      if (epoch === this.epoch && session === this.session && this.busy) {
        this.set({ ...this.state, screenSharing: false, screenShareError: screenError(error) });
      }
    }
  }

  async stopScreenShare(): Promise<void> {
    const session = this.session;
    if (!session || !this.state.screenSharing) return;
    try { await session.stopScreenShare(); } catch { /* the OS may have already stopped capture */ }
    if (session === this.session && this.busy) this.set({ ...this.state, screenSharing: false });
  }

  async resumeAudio(): Promise<void> {
    const session = this.session;
    if (!session || !this.busy) return;
    try {
      await session.resumeAudio();
      if (session === this.session && this.busy) this.set({ ...this.state, audioPlaybackBlocked: false });
    } catch (error) {
      if (session === this.session && this.busy) this.set({ ...this.state, error: String(error) });
    }
  }

  async changeParticipantRole(userId: number, role: "speaker" | "listener"): Promise<void> {
    const id = this.state.conferenceId;
    const epoch = this.epoch;
    if (!id || !this.busy || this.state.role !== "owner" || userId === this.deps.selfUserId) return;
    const participant = this.state.participants.find((item) => item.userId === userId);
    if (!participant || participant.role === "owner" || participant.role === role) return;
    try {
      await this.deps.api.changeRole(id, userId, role);
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) {
        this.patchParticipant(userId, { role, handRaised: false, ...(role === "listener" ? { muted: true, cameraOn: false } : {}) });
      }
    } catch (error) {
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) this.set({ ...this.state, error: String(error) });
    }
  }

  async removeParticipant(userId: number): Promise<void> {
    const id = this.state.conferenceId;
    const epoch = this.epoch;
    if (!id || !this.busy || this.state.role !== "owner" || userId === this.deps.selfUserId) return;
    const participant = this.state.participants.find((item) => item.userId === userId);
    if (!participant || participant.role === "owner") return;
    try {
      await this.deps.api.removeParticipant(id, userId);
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) this.removeParticipantLocal(userId);
    } catch (error) {
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) this.set({ ...this.state, error: String(error) });
    }
  }

  async endConference(): Promise<void> {
    const id = this.state.conferenceId;
    const epoch = this.epoch;
    if (!id || !this.busy || this.state.role !== "owner") return;
    try {
      await this.deps.api.end(id);
      if (epoch === this.epoch && id === this.state.conferenceId) this.finish("ended_remote");
    } catch (error) {
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) this.set({ ...this.state, error: String(error) });
    }
  }

  async raiseHand(): Promise<void> {
    const id = this.state.conferenceId;
    const epoch = this.epoch;
    if (!id || this.state.phase !== "active" || this.state.handRaised) return;
    try {
      await this.deps.api.raiseHand(id);
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) {
        this.set({ ...this.state, handRaised: true });
      }
    } catch (error) {
      if (epoch === this.epoch && id === this.state.conferenceId && this.busy) {
        this.set({ ...this.state, error: String(error) });
      }
    }
  }

  handleEvent(frame: Record<string, unknown>): void {
    const id = String(frame.conference_id ?? (frame.conference as Record<string, unknown> | undefined)?.id ?? "");
    if (!id || id !== this.state.conferenceId) return;
    const type = String(frame.type ?? "");
    if (type === "conference.ended") {
      this.finish("ended_remote");
      return;
    }
    if (type === "conference.participant_joined") {
      const participant = participantFromFrame(frame.participant);
      if (participant) this.upsertParticipant(participant);
      return;
    }
    const target = Number(frame.user_id);
    if (!Number.isSafeInteger(target) || target <= 0) return;
    if (type === "conference.participant_left") {
      this.removeParticipantLocal(target);
      return;
    }
    if (type === "conference.participant_removed") {
      if (frame.self === true || target === this.deps.selfUserId) this.finish("removed");
      else this.removeParticipantLocal(target);
      return;
    }
    if (type === "conference.hand_raised") {
      this.patchParticipant(target, { handRaised: true });
      return;
    }
    if (type === "conference.role_changed") {
      const role = String(frame.role ?? "") as ConferenceRole;
      if (role !== "speaker" && role !== "listener") return;
      this.patchParticipant(target, { role, handRaised: false });
      if (frame.self === true || target === this.deps.selfUserId) this.applyOwnRole(role);
      return;
    }
    if (type === "conference.muted_by_admin" && (frame.self === true || target === this.deps.selfUserId)) {
      this.session?.setMuted(true);
      this.set({ ...this.state, muted: true, mutedByAdmin: true });
    }
  }

  private applyOwnRole(role: ConferenceRole): void {
    if (role === "listener") {
      this.session?.setMuted(true);
      this.session?.setCameraOn(false);
      this.set({
        ...this.state,
        role,
        muted: true,
        cameraOn: false,
        cameraAutoPaused: false,
        cameraCanResume: false,
        // Screen sharing is a separate, source-scoped grant and remains available to listeners.
        screenSharing: this.state.screenSharing,
        handRaised: false,
      });
    } else {
      this.set({ ...this.state, role, handRaised: false });
    }
  }

  private onConnectionState(state: "connecting" | "connected" | "recovering" | "failed" | "closed"): void {
    if (!this.busy || this.closingSession || this.state.phase === "leaving") return;
    if (state === "connected") {
      this.clearRecoveryTimer();
      this.set({
        ...this.state,
        phase: "active",
        connectedAt: this.state.connectedAt ?? this.now(),
        error: null,
      });
      return;
    }
    if (state === "recovering") {
      if (this.state.phase !== "reconnecting") this.set({ ...this.state, phase: "reconnecting" });
      this.startRecoveryTimer();
      return;
    }
    if (state === "failed" || state === "closed") {
      if (this.state.connectedAt !== null) {
        if (this.state.phase !== "reconnecting") this.set({ ...this.state, phase: "reconnecting" });
        this.startRecoveryTimer();
      } else {
        this.finish("failed");
      }
    }
  }

  private onQuality(level: ConferenceQualityLevel): void {
    if (!this.busy) return;
    if (this.state.quality !== level) this.set({ ...this.state, quality: level });
    if (!this.state.video || this.state.role === "listener") return;
    if (level === "critical" && this.state.cameraOn) {
      this.criticalVideoStreak += 1;
      if (this.criticalVideoStreak >= 3) {
        this.criticalVideoStreak = 0;
        this.session?.setCameraOn(false);
        this.set({
          ...this.state,
          cameraOn: false,
          cameraAutoPaused: true,
          cameraCanResume: false,
        });
      }
      return;
    }
    this.criticalVideoStreak = 0;
    if (this.state.cameraAutoPaused) {
      const canResume = level === "medium" || level === "high";
      if (this.state.cameraCanResume !== canResume) this.set({ ...this.state, cameraCanResume: canResume });
    }
  }

  private scheduleTokenRefresh(expiresAtSec: number): void {
    this.clearTokenTimer();
    const lead = this.deps.tokenRefreshLeadMs ?? 30_000;
    const delay = Math.max(1_000, expiresAtSec * 1000 - this.now() - lead);
    this.tokenTimer = this.setTimer(() => void this.refreshToken(), delay);
  }

  private async refreshToken(): Promise<void> {
    if (this.tokenRefreshInFlight || !this.busy || !this.state.conferenceId || !this.session) return;
    const id = this.state.conferenceId;
    const session = this.session;
    const epoch = this.epoch;
    this.tokenRefreshInFlight = true;
    try {
      const grant = await this.deps.api.join(id);
      if (epoch !== this.epoch || session !== this.session) return;
      if (!validGrant(grant, id, this.now())) throw new Error("invalid refreshed conference grant");
      await session.updateToken(grant.token);
      if (epoch === this.epoch && session === this.session) this.scheduleTokenRefresh(grant.expires_at);
    } catch {
      if (epoch === this.epoch && session === this.session && this.busy) {
        this.clearTokenTimer();
        this.tokenTimer = this.setTimer(() => void this.refreshToken(), this.deps.tokenRetryMs ?? 5_000);
      }
    } finally {
      this.tokenRefreshInFlight = false;
    }
  }

  private startRecoveryTimer(): void {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = this.setTimer(() => {
      this.recoveryTimer = null;
      if (this.state.phase === "reconnecting") this.finish("failed");
    }, this.deps.recoveryTimeoutMs ?? 30_000);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer === null) return;
    this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private clearTokenTimer(): void {
    if (this.tokenTimer === null) return;
    this.clearTimer(this.tokenTimer);
    this.tokenTimer = null;
  }

  private clearTimers(): void {
    this.clearRecoveryTimer();
    this.clearTokenTimer();
    this.tokenRefreshInFlight = false;
  }

  private upsertParticipant(participant: ConferenceParticipant): void {
    const participants = this.state.participants.filter((item) => item.userId !== participant.userId);
    participants.push(participant);
    participants.sort((a, b) => a.joinedAt - b.joinedAt || a.userId - b.userId);
    this.set({ ...this.state, participants });
  }

  private patchParticipant(userId: number, patch: Partial<ConferenceParticipant>): void {
    let changed = false;
    const participants = this.state.participants.map((participant) => {
      if (participant.userId !== userId) return participant;
      changed = true;
      return { ...participant, ...patch };
    });
    if (changed) this.set({ ...this.state, participants });
  }

  private removeParticipantLocal(userId: number): void {
    const participants = this.state.participants.filter((participant) => participant.userId !== userId);
    if (participants.length !== this.state.participants.length) {
      this.set({
        ...this.state,
        participants,
        activeSpeakerId: this.state.activeSpeakerId === userId ? null : this.state.activeSpeakerId,
      });
    }
  }

  private fail(error: unknown): void {
    ++this.epoch;
    this.clearTimers();
    this.closeSession();
    this.set({ ...this.state, phase: "error", reason: "failed", error: error instanceof Error ? error.message : String(error) });
  }

  private finish(reason: ConferenceEndReason): void {
    ++this.epoch;
    this.clearTimers();
    this.closeSession();
    this.set({
      ...this.state,
      phase: "ended",
      reason,
      cameraOn: false,
      screenSharing: false,
      activeSpeakerId: null,
      audioPlaybackBlocked: false,
    });
  }

  private closeSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    this.closingSession = true;
    try { session.close(); } finally { this.closingSession = false; }
  }

  private set(state: ConferenceState): void {
    this.state = { ...state, participants: [...state.participants] };
    this.deps.onState(this.state);
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
