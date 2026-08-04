// clients/ui/test/call_model.test.ts — the V75 call state machine, tested without a browser.
//
// The live probe (var/ux-audit/tools/m_call_live_v75.mjs, 2026-07-30) proved the happy path on two
// real browsers: ringing → incoming → accept → active (timer 0:03 → 0:06) → ended, and the call
// landed in the log as «Исходящий · 0:07». What a live probe cannot prove is the set of races that
// make calls fail in the field — an answer after a local hang-up, ICE before the session exists, a
// dead socket, a denied microphone. Those are this file.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CallController,
  callStatusKey,
  endReasonKey,
  formatCallTimer,
  type CallMediaSession,
  type CallState,
} from "../src/screens/call_model.ts";

type Frame = Record<string, unknown>;

class Harness {
  sent: Frame[] = [];
  states: CallState[] = [];
  open = 0;
  closed = 0;
  socketOpen = true;
  mediaFails = false;
  onIce: ((c: unknown) => void) | null = null;
  onConn: ((s: "connecting" | "connected" | "recovering" | "failed" | "closed") => void) | null = null;
  onVideoAutoPaused: (() => void) | null = null;
  onVideoResumeAvailable: ((available: boolean) => void) | null = null;
  ice: unknown[] = [];
  appliedAnswers: string[] = [];
  restartOffers = 0;
  restartAnswers = 0;
  private handler: ((f: Frame) => void) | null = null;
  private timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  private nextTimer = 1;
  clock = 1_000_000;
  readonly controller: CallController;

  constructor() {
    const self = this;
    this.controller = new CallController({
      signal: {
        send(frame) {
          if (!self.socketOpen) return false;
          self.sent.push(frame);
          return true;
        },
        subscribe(h) {
          self.handler = h;
          return () => { self.handler = null; };
        },
      },
      media: {
        async open(opts) {
          if (self.mediaFails) throw new Error("NotAllowedError");
          self.open += 1;
          self.onIce = opts.onIce;
          self.onConn = opts.onConnectionState;
          self.onVideoAutoPaused = opts.onVideoAutoPaused ?? null;
          self.onVideoResumeAvailable = opts.onVideoResumeAvailable ?? null;
          const session: CallMediaSession = {
            async offer() { return "SDP-OFFER"; },
            async answerTo() { return "SDP-ANSWER"; },
            async applyAnswer(sdp) { self.appliedAnswers.push(sdp); },
            async restartOffer() { self.restartOffers += 1; return "SDP-RESTART-OFFER"; },
            async answerRestart() { self.restartAnswers += 1; return "SDP-RESTART-ANSWER"; },
            async addIce(c) { self.ice.push(c); },
            setMuted() {},
            setCameraOn() {},
            close() { self.closed += 1; },
          };
          return session;
        },
      },
      async iceServers() { return []; },
      async resolvePeer(id) { return { id, name: "Пётр Смирнов" }; },
      onState(s) { self.states.push(s); },
      now: () => self.clock,
      setTimer: (fn, ms) => { const id = self.nextTimer++; self.timers.push({ fn, ms, id }); return id; },
      clearTimer: (h) => { self.timers = self.timers.filter((t) => t.id !== h); },
      recoveryTimeoutMs: 20,
      recoveryRetryMs: 5,
    });
  }

  deliver(frame: Frame): void { this.handler?.(frame); }
  runTimers(): void { const due = this.timers; this.timers = []; for (const t of due) t.fn(); }
  runTimer(ms: number): void {
    const at = this.timers.findIndex((timer) => timer.ms === ms);
    if (at < 0) throw new Error(`timer ${ms} not found: ${this.timers.map((t) => t.ms).join(",")}`);
    const [timer] = this.timers.splice(at, 1);
    timer!.fn();
  }
  get phase(): string { return this.controller.current.phase; }
  types(): string[] { return this.sent.map((f) => String(f.type)); }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("V75: an outgoing call stays 'dialing' until the server says the peer is ringing", async () => {
  const h = new Harness();
  const call = h.controller.place({ id: 78, name: "Пётр" }, false);
  // The permission prompt is its own visible state — not a ringing UI for a call nobody heard yet.
  assert.equal(h.phase, "dialing");
  assert.equal(h.controller.current.awaitingMedia, true, "the mic prompt is announced, not hidden");
  await call;
  assert.equal(h.phase, "dialing", "sending the offer is not the same as the peer's phone ringing");
  assert.deepEqual(h.types(), ["call.offer"]);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  assert.equal(h.phase, "ringing");
  assert.equal(h.controller.current.callId, "c1");
});

test("V168: outgoing ICE gathered before call.ringing is queued until call_id exists", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, true);

  h.onIce?.({ candidate: "host-fast" });
  h.onIce?.({ candidate: "relay-fast" });
  assert.deepEqual(h.types(), ["call.offer"], "ICE cannot be addressed before the server assigns call_id");

  h.deliver({ type: "call.ringing", call_id: "c-fast" });
  assert.deepEqual(h.sent.slice(1), [
    { type: "call.ice", call_id: "c-fast", candidate: { candidate: "host-fast" } },
    { type: "call.ice", call_id: "c-fast", candidate: { candidate: "relay-fast" } },
  ], "every early candidate is replayed in order instead of being silently lost");
});

test("V168: local ICE survives a temporary signaling outage after call_id exists", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c-retry" });
  h.sent = [];

  h.socketOpen = false;
  h.onIce?.({ candidate: "relay-during-ws-gap" });
  assert.deepEqual(h.sent, [], "a closed socket cannot consume the candidate");

  h.socketOpen = true;
  h.deliver({ type: "call.answer", call_id: "c-retry", sdp: "SDP-ANSWER" });
  assert.deepEqual(h.sent[0], {
    type: "call.ice",
    call_id: "c-retry",
    candidate: { candidate: "relay-during-ws-gap" },
  }, "the first matching frame proving signaling recovery replays queued ICE");
});

test("V75: a refused call ends with its own reason instead of ringing forever", async () => {
  for (const [code, reason] of [
    ["CALLS_NOT_ALLOWED", "not_allowed"],
    ["ALREADY_IN_CALL", "already_in_call"],
    ["RECIPIENT_UNAVAILABLE", "unavailable"],
    ["WHATEVER", "failed"],
  ] as const) {
    const h = new Harness();
    await h.controller.place({ id: 78, name: "Пётр" }, false);
    h.deliver({ type: "call.error", code });
    assert.equal(h.phase, "ended", `${code} must end the call`);
    assert.equal(h.controller.current.reason, reason);
    assert.notEqual(endReasonKey(h.controller.current), "call.endUnknown", `${code} needs wording`);
  }
});

test("V75: a call that cannot be signalled fails immediately rather than showing a phantom ring", async () => {
  const h = new Harness();
  h.socketOpen = false;
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  assert.equal(h.phase, "ended");
  assert.equal(h.controller.current.reason, "offline");
  assert.equal(h.closed, 1, "the microphone is released, not left hot");
});

test("V75: a denied microphone is an ending with a reason, not a dead screen", async () => {
  const h = new Harness();
  h.mediaFails = true;
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  assert.equal(h.controller.current.reason, "media_denied");
  assert.deepEqual(h.types(), [], "nothing is sent for a call that never had audio");
});

test("V75: an inbound call resolves the caller's name without blocking the ring", async () => {
  const h = new Harness();
  h.deliver({ type: "call.incoming", call_id: "c9", from_user_id: 77, sdp: "SDP-OFFER", video: true });
  assert.equal(h.phase, "incoming");
  assert.equal(h.controller.current.peer?.name, "", "the call rings before the name is known");
  assert.equal(h.controller.current.video, true);
  await tick();
  assert.equal(h.controller.current.peer?.name, "Пётр Смирнов", "the name arrives and lands");
});

test("V75: accepting sends the answer and only then claims to be connecting", async () => {
  const h = new Harness();
  h.deliver({ type: "call.incoming", call_id: "c9", from_user_id: 77, sdp: "SDP-OFFER" });
  await h.controller.accept();
  assert.deepEqual(h.types(), ["call.answer"]);
  assert.equal(h.phase, "connecting", "no audio path yet — 'active' would be a lie");
  h.onConn?.("connected");
  assert.equal(h.phase, "active");
  assert.equal(h.controller.current.connectedAt, h.clock, "the clock starts at media, not at accept");
});

test("V167: an active outgoing call survives route loss through an ICE restart", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.deliver({ type: "call.answer", call_id: "c1", sdp: "SDP-ANSWER" });
  await tick();
  h.onConn?.("connected");
  const connectedAt = h.controller.current.connectedAt;
  h.sent = [];

  h.onConn?.("recovering");
  await tick();
  assert.equal(h.phase, "reconnecting");
  assert.equal(h.restartOffers, 1);
  assert.deepEqual(h.sent, [{ type: "call.restart_offer", call_id: "c1", sdp: "SDP-RESTART-OFFER" }]);

  h.deliver({ type: "call.restart_answer", call_id: "c1", sdp: "SDP-RESTART-ANSWER" });
  await tick();
  assert.deepEqual(h.appliedAnswers.slice(-1), ["SDP-RESTART-ANSWER"]);
  h.onConn?.("connected");
  assert.equal(h.phase, "active");
  assert.equal(h.controller.current.connectedAt, connectedAt, "recovery must not reset call duration");
});

test("V167: the callee requests the caller's restart and answers the recovery offer", async () => {
  const h = new Harness();
  h.deliver({ type: "call.incoming", call_id: "c9", from_user_id: 77, sdp: "SDP-OFFER" });
  await h.controller.accept();
  h.onConn?.("connected");
  h.sent = [];

  h.onConn?.("recovering");
  assert.deepEqual(h.sent[0], { type: "call.restart_request", call_id: "c9" });
  h.deliver({ type: "call.restart_offer", call_id: "c9", sdp: "REMOTE-RESTART" });
  await tick();
  assert.equal(h.restartAnswers, 1);
  assert.ok(h.sent.some((frame) => frame.type === "call.restart_answer" && frame.sdp === "SDP-RESTART-ANSWER"));
});

test("V167: persistent critical quality can pause video without ending the call", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, true);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.deliver({ type: "call.answer", call_id: "c1", sdp: "SDP-ANSWER" });
  await tick();
  h.onConn?.("connected");
  h.onVideoAutoPaused?.();
  assert.equal(h.phase, "active");
  assert.equal(h.controller.current.cameraOn, false);
  assert.equal(h.controller.current.videoAutoPaused, true);
  assert.equal(h.controller.current.videoCanResume, false);
  assert.equal(callStatusKey(h.controller.current), "call.stateAudioOnly");
  h.onVideoResumeAvailable?.(true);
  assert.equal(h.controller.current.videoCanResume, true);
  assert.equal(callStatusKey(h.controller.current), "call.stateVideoCanResume");
  h.controller.setCameraOn(true);
  assert.equal(h.controller.current.cameraOn, true);
  assert.equal(h.controller.current.videoAutoPaused, false);
  assert.equal(h.controller.current.videoCanResume, false);
});

test("V167: recovery has a bounded deadline instead of leaving a silent zombie call", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.deliver({ type: "call.answer", call_id: "c1", sdp: "SDP-ANSWER" });
  await tick();
  h.onConn?.("connected");
  h.sent = [];
  h.onConn?.("recovering");
  await tick();

  h.runTimer(20);
  assert.equal(h.phase, "ended");
  assert.equal(h.controller.current.reason, "failed");
  assert.ok(h.sent.some((frame) => frame.type === "call.hangup" && frame.call_id === "c1"));
});

test("V75: a second inbound call is refused as busy instead of stealing the screen", async () => {
  const h = new Harness();
  h.deliver({ type: "call.incoming", call_id: "c9", from_user_id: 77, sdp: "SDP-OFFER" });
  await h.controller.accept();
  h.sent = [];
  h.deliver({ type: "call.incoming", call_id: "c10", from_user_id: 79, sdp: "SDP-2" });
  assert.equal(h.controller.current.callId, "c9", "the live call keeps the device");
  assert.deepEqual(h.sent, [{ type: "call.reject", call_id: "c10", busy: true }]);
});

test("V75: ICE that arrives before the session exists is replayed, not dropped", async () => {
  const h = new Harness();
  h.deliver({ type: "call.incoming", call_id: "c9", from_user_id: 77, sdp: "SDP-OFFER" });
  h.deliver({ type: "call.ice", call_id: "c9", candidate: { c: 1 } });
  h.deliver({ type: "call.ice", call_id: "c9", candidate: { c: 2 } });
  assert.deepEqual(h.ice, [], "there is no peer connection yet");
  await h.controller.accept();
  await tick();
  assert.deepEqual(h.ice, [{ c: 1 }, { c: 2 }], "both candidates reach the session after accept");
});

test("V75: frames for another call never touch the live one", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.deliver({ type: "call.hangup", call_id: "OTHER" });
  assert.equal(h.phase, "ringing", "a stale call_id must not hang up the live call");
  h.deliver({ type: "call.hangup", call_id: "c1" });
  assert.equal(h.phase, "ended");
  assert.equal(h.controller.current.reason, "hangup_remote");
});

test("V75: hanging up tells the peer, releases the mic and cannot be repeated", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.sent = [];
  h.controller.hangUp();
  assert.deepEqual(h.sent, [{ type: "call.hangup", call_id: "c1" }]);
  assert.equal(h.closed, 1);
  h.controller.hangUp();
  assert.equal(h.sent.length, 1, "a second tap on a finished call sends nothing");
});

test("V75: the terminal card lingers with its reason and then clears itself", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.deliver({ type: "call.reject", call_id: "c1", busy: true });
  assert.equal(h.phase, "ended");
  assert.equal(endReasonKey(h.controller.current), "call.endBusy");
  assert.equal(h.controller.busy, false, "an ended call no longer occupies the device");
  h.runTimers();
  assert.equal(h.phase, "idle", "the overlay does not sit on the screen forever");
});

test("V75: a late answer cannot resurrect a call the person already ended", async () => {
  const h = new Harness();
  await h.controller.place({ id: 78, name: "Пётр" }, false);
  h.deliver({ type: "call.ringing", call_id: "c1" });
  h.controller.hangUp();
  h.deliver({ type: "call.answer", call_id: "c1", sdp: "SDP-ANSWER" });
  h.onConn?.("connected");
  await tick();
  assert.equal(h.phase, "ended", "the machine stays ended");
});

test("V75: every phase says something specific — no single word for four situations", () => {
  const base = { callId: "c", peer: null, direction: "out" as const, video: false, connectedAt: null,
    reason: null, muted: false, cameraOn: false, videoAutoPaused: false, videoCanResume: false,
    awaitingMedia: false };
  const keys = new Set([
    callStatusKey({ ...base, phase: "dialing" }),
    callStatusKey({ ...base, phase: "dialing", awaitingMedia: true }),
    callStatusKey({ ...base, phase: "ringing" }),
    callStatusKey({ ...base, phase: "incoming" }),
    callStatusKey({ ...base, phase: "connecting" }),
    callStatusKey({ ...base, phase: "active" }),
    callStatusKey({ ...base, phase: "reconnecting" }),
  ]);
  assert.equal(keys.size, 7, "each phase carries its own line");
  // The same reason must read differently depending on whether audio ever flowed.
  assert.equal(endReasonKey({ ...base, phase: "ended", reason: "hangup_local" }), "call.endCancelled");
  assert.equal(
    endReasonKey({ ...base, phase: "ended", reason: "hangup_local", connectedAt: 1 }),
    "call.endFinished",
  );
});

test("V75: the timer is mm:ss and grows an hour field only when there is one", () => {
  assert.equal(formatCallTimer(0), "0:00");
  assert.equal(formatCallTimer(7), "0:07");
  assert.equal(formatCallTimer(65), "1:05");
  assert.equal(formatCallTimer(3600), "1:00:00");
  assert.equal(formatCallTimer(3671), "1:01:11");
  assert.equal(formatCallTimer(-5), "0:00", "a clock skew never prints a negative call");
});
