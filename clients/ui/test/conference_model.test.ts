import test from "node:test";
import assert from "node:assert/strict";

import {
  ConferenceController,
  type ConferenceJoinGrant,
  type ConferenceScreenShareGrant,
  type ConferenceMediaSession,
  type ConferenceQualityLevel,
  type ConferenceState,
} from "../src/screens/conference_model.ts";

type ConnectionState = "connecting" | "connected" | "recovering" | "failed" | "closed";

function grant(overrides: Partial<ConferenceJoinGrant> = {}): ConferenceJoinGrant {
  return {
    conference: {
      id: "conf-1",
      chat_id: 55,
      mode: "conversation",
      video: true,
      participants: [
        { user_id: 1, role: "owner", moderator: true, joined_at: 10, hand_raised: false },
        { user_id: 2, role: "speaker", moderator: false, joined_at: 20, hand_raised: false },
      ],
    },
    media_url: "wss://media.greenchat.test",
    token: "token-1",
    expires_at: 1_120,
    role: "speaker",
    ...overrides,
  };
}

class Harness {
  states: ConferenceState[] = [];
  joinCalls: string[] = [];
  screenGrantCalls: string[] = [];
  leaveCalls: string[] = [];
  raiseCalls: string[] = [];
  roleCalls: Array<{ id: string; userId: number; role: "speaker" | "listener" }> = [];
  removeCalls: Array<{ id: string; userId: number }> = [];
  endCalls: string[] = [];
  grants: ConferenceJoinGrant[] = [grant()];
  joinError: Error | null = null;
  pendingJoin: Promise<ConferenceJoinGrant> | null = null;
  openCalls = 0;
  closed = 0;
  muted: boolean[] = [];
  cameras: boolean[] = [];
  screenStarts = 0;
  screenStops = 0;
  audioResumes = 0;
  screenError: Error | null = null;
  tokens: string[] = [];
  clock = 1_000_000;
  timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
  nextTimer = 1;
  onConnection: ((state: ConnectionState) => void) | null = null;
  onQuality: ((level: ConferenceQualityLevel) => void) | null = null;
  onActiveSpeaker: ((userId: number | null) => void) | null = null;
  onParticipantMedia: ((userId: number, state: { muted?: boolean; cameraOn?: boolean; screenSharing?: boolean }) => void) | null = null;
  onAudioBlocked: ((blocked: boolean) => void) | null = null;
  onScreenEnded: (() => void) | null = null;
  readonly controller: ConferenceController;

  constructor() {
    const self = this;
    this.controller = new ConferenceController({
      api: {
        async join(id) {
          self.joinCalls.push(id);
          if (self.pendingJoin) return self.pendingJoin;
          if (self.joinError) throw self.joinError;
          return self.grants.shift() ?? grant({ token: `token-${self.joinCalls.length}` });
        },
        async screenShareGrant(id): Promise<ConferenceScreenShareGrant> {
          self.screenGrantCalls.push(id);
          return {
            media_url: "wss://media.greenchat.test",
            token: "aaa.bbb.ccc",
            expires_at: 1_120,
            identity: "gc-screen-2",
            source: "screen_share",
          };
        },
        async leave(id) { self.leaveCalls.push(id); },
        async raiseHand(id) { self.raiseCalls.push(id); },
        async changeRole(id, userId, role) { self.roleCalls.push({ id, userId, role }); },
        async removeParticipant(id, userId) { self.removeCalls.push({ id, userId }); },
        async end(id) { self.endCalls.push(id); },
      },
      media: {
        async open(opts) {
          self.openCalls += 1;
          self.onConnection = opts.onConnectionState;
          self.onQuality = opts.onQuality;
          self.onActiveSpeaker = opts.onActiveSpeaker;
          self.onParticipantMedia = opts.onParticipantMedia;
          self.onAudioBlocked = opts.onAudioPlaybackBlocked;
          self.onScreenEnded = opts.onLocalScreenEnded;
          void opts.requestScreenShareGrant;
          const session: ConferenceMediaSession = {
            setMuted(value) { self.muted.push(value); },
            setCameraOn(value) { self.cameras.push(value); },
            async startScreenShare() {
              self.screenStarts += 1;
              if (self.screenError) throw self.screenError;
            },
            async stopScreenShare() { self.screenStops += 1; },
            async resumeAudio() { self.audioResumes += 1; },
            async updateToken(value) { self.tokens.push(value); },
            close() {
              self.closed += 1;
              self.onConnection?.("closed");
            },
          };
          return session;
        },
      },
      selfUserId: 2,
      onState(state) { self.states.push(state); },
      now: () => self.clock,
      setTimer(fn, ms) {
        const timer = { id: self.nextTimer++, fn, ms, cleared: false };
        self.timers.push(timer);
        return timer.id;
      },
      clearTimer(handle) {
        const timer = self.timers.find((item) => item.id === handle);
        if (timer) timer.cleared = true;
      },
      recoveryTimeoutMs: 20_000,
      tokenRefreshLeadMs: 30_000,
      tokenRetryMs: 5_000,
    });
  }

  get state(): ConferenceState { return this.controller.current; }

  fireTimer(ms: number): void {
    const timer = this.timers.find((item) => !item.cleared && item.ms === ms);
    assert.ok(timer, `timer ${ms}ms must exist`);
    timer.cleared = true;
    timer.fn();
  }

  async flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }
}

test("V169: a speaker joins through a short-lived media grant and becomes active only on SFU connect", async () => {
  const h = new Harness();
  await h.controller.join("conf-1", { microphoneOn: true, cameraOn: true });
  assert.equal(h.state.phase, "connecting");
  assert.equal(h.state.role, "speaker");
  assert.equal(h.state.muted, false);
  assert.equal(h.state.cameraOn, true);
  assert.equal(h.openCalls, 1);
  assert.equal(h.state.participants.length, 2);

  h.onConnection?.("connected");
  assert.equal(h.state.phase, "active");
  assert.equal(h.state.connectedAt, h.clock);
});

test("V169: malformed or unsafe media grants fail closed before any SFU connection", async () => {
  const h = new Harness();
  h.grants = [grant({ media_url: "https://media.greenchat.test" })];
  await h.controller.join("conf-1");
  assert.equal(h.state.phase, "error");
  assert.equal(h.state.reason, "failed");
  assert.equal(h.openCalls, 0, "an HTTP control-plane URL must never be treated as a WebSocket media endpoint");
});

test("V169: clear-text media is allowed only on loopback development hosts", async () => {
  const remote = new Harness();
  remote.grants = [grant({ media_url: "ws://media.greenchat.test" })];
  await remote.controller.join("conf-1");
  assert.equal(remote.state.phase, "error");
  assert.equal(remote.openCalls, 0, "a remote SFU token must never cross clear-text WebSocket transport");

  const local = new Harness();
  local.grants = [grant({ media_url: "ws://127.0.0.1:7880" })];
  await local.controller.join("conf-1");
  assert.equal(local.state.phase, "connecting", "loopback remains usable for a self-hosted development SFU");
  assert.equal(local.openCalls, 1);
});

test("V169: an already expired media token is rejected before microphone or camera capture", async () => {
  const h = new Harness();
  h.grants = [grant({ expires_at: 999 })];
  await h.controller.join("conf-1", { microphoneOn: true, cameraOn: true });
  assert.equal(h.state.phase, "error");
  assert.equal(h.openCalls, 0);
});

test("V169: leaving while join is pending cannot resurrect or leak an SFU session", async () => {
  const h = new Harness();
  let resolveJoin!: (value: ConferenceJoinGrant) => void;
  h.pendingJoin = new Promise((resolve) => { resolveJoin = resolve; });
  const joining = h.controller.join("conf-1");
  assert.equal(h.state.phase, "joining");

  await h.controller.leave();
  assert.equal(h.state.phase, "ended");
  assert.equal(h.state.reason, "left");
  resolveJoin(grant());
  await joining;
  assert.equal(h.openCalls, 0, "late authorization cannot open media after the person left");
  assert.equal(h.state.phase, "ended");
});

test("V169: critical video degrades to audio-only and never turns the camera back on by itself", async () => {
  const h = new Harness();
  await h.controller.join("conf-1", { cameraOn: true });
  h.onConnection?.("connected");

  h.onQuality?.("critical");
  h.onQuality?.("critical");
  assert.equal(h.state.cameraOn, true);
  h.onQuality?.("critical");
  assert.equal(h.state.phase, "active");
  assert.equal(h.state.muted, false, "speech remains published");
  assert.equal(h.state.cameraOn, false);
  assert.equal(h.state.cameraAutoPaused, true);
  assert.deepEqual(h.cameras, [false]);

  h.onQuality?.("medium");
  assert.equal(h.state.cameraCanResume, true);
  assert.deepEqual(h.cameras, [false], "recovery is a prompt, not surprise camera capture");
  h.controller.setCameraOn(true);
  assert.equal(h.state.cameraOn, true);
  assert.equal(h.state.cameraAutoPaused, false);
  assert.equal(h.state.cameraCanResume, false);
});

test("V169: screen sharing is explicit, recoverable and follows the operating-system stop event", async () => {
  const h = new Harness();
  await h.controller.join("conf-1");
  h.onConnection?.("connected");

  h.screenError = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  await h.controller.startScreenShare();
  assert.equal(h.state.phase, "active");
  assert.equal(h.state.screenSharing, false);
  assert.equal(h.state.screenShareError, "denied");

  h.screenError = null;
  await h.controller.startScreenShare();
  assert.equal(h.state.screenSharing, true);
  assert.equal(h.state.screenShareError, null);
  h.onScreenEnded?.();
  assert.equal(h.state.screenSharing, false, "browser/OS capture ending immediately updates GreenChat");
});

test("V184: listener keeps mic/camera restricted but may explicitly present a screen", async () => {
  const h = new Harness();
  await h.controller.join("conf-1");
  h.onConnection?.("connected");

  h.controller.handleEvent({ type: "conference.muted_by_admin", conference_id: "conf-1", user_id: 2 });
  assert.equal(h.state.muted, true);
  assert.equal(h.state.mutedByAdmin, true);
  assert.deepEqual(h.muted, [true]);
  h.controller.setMuted(false);
  assert.equal(h.state.muted, false, "a speaker explicitly chooses to unmute again");
  assert.equal(h.state.mutedByAdmin, false);

  h.controller.handleEvent({ type: "conference.role_changed", conference_id: "conf-1", user_id: 2, role: "listener" });
  assert.equal(h.state.role, "listener");
  assert.equal(h.state.muted, true);
  h.controller.setMuted(false);
  h.controller.setCameraOn(true);
  await h.controller.startScreenShare();
  assert.equal(h.state.muted, true);
  assert.equal(h.state.cameraOn, false);
  assert.equal(h.state.screenSharing, true);
  assert.equal(h.screenStarts, 1, "listener presentation uses the same explicit screen action");
});

test("V169: participant events are idempotent and a removed self leaves immediately", async () => {
  const h = new Harness();
  await h.controller.join("conf-1");
  h.onConnection?.("connected");

  const joined = {
    type: "conference.participant_joined",
    conference_id: "conf-1",
    participant: { user_id: 9, role: "listener", moderator: false, joined_at: 30, hand_raised: false },
  };
  h.controller.handleEvent(joined);
  h.controller.handleEvent(joined);
  assert.equal(h.state.participants.filter((item) => item.userId === 9).length, 1);
  h.onActiveSpeaker?.(9);
  assert.equal(h.state.activeSpeakerId, 9);
  h.controller.handleEvent({ type: "conference.participant_left", conference_id: "conf-1", user_id: 9 });
  assert.equal(h.state.activeSpeakerId, null);

  h.controller.handleEvent({ type: "conference.participant_removed", conference_id: "conf-1", user_id: 2 });
  assert.equal(h.state.phase, "ended");
  assert.equal(h.state.reason, "removed");
  assert.equal(h.closed, 1);
});

test("V169: reconnect has a bounded deadline and a successful route keeps the original duration", async () => {
  const h = new Harness();
  await h.controller.join("conf-1");
  h.onConnection?.("connected");
  const connectedAt = h.state.connectedAt;
  h.onConnection?.("recovering");
  h.onConnection?.("recovering");
  assert.equal(h.state.phase, "reconnecting");
  assert.equal(h.timers.filter((timer) => !timer.cleared && timer.ms === 20_000).length, 1);

  h.clock += 5_000;
  h.onConnection?.("connected");
  assert.equal(h.state.phase, "active");
  assert.equal(h.state.connectedAt, connectedAt);
  assert.equal(h.timers.some((timer) => timer.ms === 20_000 && timer.cleared), true);

  h.onConnection?.("recovering");
  h.fireTimer(20_000);
  assert.equal(h.state.phase, "ended");
  assert.equal(h.state.reason, "failed");
});

test("V169: a malformed refresh grant keeps the active room and retries instead of expiring silently", async () => {
  const h = new Harness();
  h.grants = [
    grant({ token: "initial", expires_at: 1_120 }),
    grant({ token: "unsafe", media_url: "javascript:alert(1)", expires_at: 1_240 }),
  ];
  await h.controller.join("conf-1");
  h.onConnection?.("connected");

  h.fireTimer(90_000);
  await h.flush();
  assert.equal(h.state.phase, "active");
  assert.deepEqual(h.tokens, [], "an invalid token bundle is never installed into the live SFU session");
  assert.equal(h.timers.some((timer) => !timer.cleared && timer.ms === 5_000), true);
});

test("V169: long conferences refresh the short-lived token before expiry without reconnecting media", async () => {
  const h = new Harness();
  h.grants = [
    grant({ token: "initial", expires_at: 1_120 }),
    grant({ token: "refreshed", expires_at: 1_240 }),
  ];
  await h.controller.join("conf-1");
  h.onConnection?.("connected");
  assert.equal(h.timers.some((timer) => !timer.cleared && timer.ms === 90_000), true);

  h.fireTimer(90_000);
  await h.flush();
  assert.deepEqual(h.tokens, ["refreshed"]);
  assert.equal(h.openCalls, 1, "token rotation updates the live room instead of opening a second connection");
  assert.equal(h.joinCalls.length, 2);
});


test("V178: LiveKit media callbacks update participant state and blocked audio resumes only on a user action", async () => {
  const h = new Harness();
  await h.controller.join("conf-1");
  h.onConnection?.("connected");

  h.onParticipantMedia?.(1, { muted: false, cameraOn: true, screenSharing: true });
  const owner = h.state.participants.find((item) => item.userId === 1)!;
  assert.equal(owner.muted, false);
  assert.equal(owner.cameraOn, true);
  assert.equal(owner.screenSharing, true);

  h.onAudioBlocked?.(true);
  assert.equal(h.state.audioPlaybackBlocked, true);
  await h.controller.resumeAudio();
  assert.equal(h.audioResumes, 1);
  assert.equal(h.state.audioPlaybackBlocked, false);
});

test("V178: conference owner moderation is server-authoritative and updates the local roster after success", async () => {
  const h = new Harness();
  h.grants = [grant({ role: "owner" })];
  await h.controller.join("conf-1");
  h.onConnection?.("connected");
  h.controller.handleEvent({
    type: "conference.participant_joined",
    conference_id: "conf-1",
    participant: { user_id: 3, role: "speaker", moderator: false, joined_at: 30, hand_raised: true },
  });

  await h.controller.changeParticipantRole(3, "listener");
  assert.deepEqual(h.roleCalls, [{ id: "conf-1", userId: 3, role: "listener" }]);
  assert.equal(h.state.participants.find((item) => item.userId === 3)?.role, "listener");

  await h.controller.removeParticipant(3);
  assert.deepEqual(h.removeCalls, [{ id: "conf-1", userId: 3 }]);
  assert.equal(h.state.participants.some((item) => item.userId === 3), false);
});

test("V178: only the owner can end the room for everyone", async () => {
  const speaker = new Harness();
  await speaker.controller.join("conf-1");
  speaker.onConnection?.("connected");
  await speaker.controller.endConference();
  assert.deepEqual(speaker.endCalls, []);
  assert.equal(speaker.state.phase, "active");

  const owner = new Harness();
  owner.grants = [grant({ role: "owner" })];
  await owner.controller.join("conf-1");
  owner.onConnection?.("connected");
  await owner.controller.endConference();
  assert.deepEqual(owner.endCalls, ["conf-1"]);
  assert.equal(owner.state.phase, "ended");
  assert.equal(owner.state.reason, "ended_remote");
});
