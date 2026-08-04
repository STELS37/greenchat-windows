// clients/ui/src/screens/call_model.ts — the pure state machine behind a live 1:1 call (V75).
//
// Why this file exists: the server has owned the call state machine since T-202 (offer → ringing →
// answer → active → outcome, with ring TTL, busy, block/privacy refusals and a durable service row),
// and V74 finally surfaced the OUTCOMES as a call log. But nothing on the client ever placed a call:
// no screen sent call.offer, no screen listened for call.incoming, so a phone could read its call
// history and never take part in one. The tab named "Звонки" was a log of calls that could not happen.
//
// This module is the half that can be reasoned about without a browser: given local intents (place,
// accept, decline, hang up, mute) and the frames the socket delivers, what state is the call in and
// what must be sent next. It owns NO DOM, NO WebRTC and NO network — media and transport are ports,
// so the whole protocol (including the ugly races: an answer that arrives after a local hangup, ICE
// candidates that arrive before the peer connection exists, a socket that dies mid-ring) is unit
// tested. Wording lives in the locales; this file only names states and reasons.

// The phases a person actually perceives. "dialing" is the honest gap the old designs skipped: the
// microphone permission prompt and offer creation happen BEFORE the peer's phone rings, and on a cold
// permission grant that gap is seconds long, so it needs its own visible state rather than a frozen
// "ringing" that is a lie.
export type CallPhase =
  | "idle"
  | "dialing" // local: acquiring media + creating the offer, nothing sent yet
  | "ringing" // outgoing: the server acked call.ringing, the peer's device is ringing
  | "incoming" // inbound: call.incoming received, waiting for the person to accept/decline
  | "connecting" // SDP exchanged, ICE still negotiating — no audio path yet
  | "active" // media connected; the duration clock runs from here
  | "reconnecting" // audio path was live, network changed, ICE restart is preserving the call
  | "ended"; // terminal, held briefly so the reason is readable, then back to idle

// Every way a call can end, kept separate from the wording so the same reason can read differently for
// the caller and the callee ("Вы отклонили" vs "Отклонён").
export type CallEndReason =
  | "hangup_local"
  | "hangup_remote"
  | "declined_local"
  | "declined_remote"
  | "busy"
  | "answered_elsewhere"
  | "timeout"
  | "unavailable" // blocked, deleted or otherwise not reachable — deliberately one neutral reason
  | "not_allowed" // privacy key `calls` refused this caller
  | "already_in_call"
  | "media_denied" // no microphone permission / no device — grantable, so the screen offers a retry
  | "media_blocked" // V111: this shell can never capture; retrying and "grant it in settings" are lies
  | "offline" // the socket was not open, so the offer could not even be sent
  | "failed"; // ICE failure or a protocol error after the call started

export interface CallPeer {
  id: number;
  name: string;
  username?: string | null;
}

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  peer: CallPeer | null;
  direction: "in" | "out";
  video: boolean;
  // Wall-clock ms when media connected; null until then. The view derives the timer from it so a
  // re-render never resets the clock.
  connectedAt: number | null;
  reason: CallEndReason | null;
  muted: boolean;
  cameraOn: boolean;
  // True only when the media adapter paused video to protect audio on a persistently critical link.
  videoAutoPaused: boolean;
  // The link recovered enough that the person can safely turn video back on. It remains an explicit
  // user action: the app never surprises them by re-enabling camera capture in the background.
  videoCanResume: boolean;
  // True while the local side is waiting on the microphone permission prompt.
  awaitingMedia: boolean;
}

export const IDLE_STATE: CallState = {
  phase: "idle",
  callId: null,
  peer: null,
  direction: "out",
  video: false,
  connectedAt: null,
  reason: null,
  muted: false,
  cameraOn: false,
  videoAutoPaused: false,
  videoCanResume: false,
  awaitingMedia: false,
};

// ---- ports ----------------------------------------------------------------------------------

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type CallMediaDeviceKind = "audioinput" | "audiooutput" | "videoinput";

export interface CallMediaDevice {
  deviceId: string;
  groupId: string;
  kind: CallMediaDeviceKind;
  label: string;
}

export interface CallDeviceSnapshot {
  devices: readonly CallMediaDevice[];
  selected: Readonly<Record<CallMediaDeviceKind, string>>;
  outputSelectionSupported: boolean;
  labelsHidden: boolean;
}

export interface CallMediaDevicePort {
  snapshot(): Promise<CallDeviceSnapshot>;
  select(kind: CallMediaDeviceKind, deviceId: string): Promise<CallDeviceSnapshot>;
  subscribe?(listener: () => void): () => void;
}

export const EMPTY_CALL_DEVICE_SNAPSHOT: CallDeviceSnapshot = {
  devices: [],
  selected: { audioinput: "", audiooutput: "", videoinput: "" },
  outputSelectionSupported: false,
  labelsHidden: false,
};
// The media half of a call. One session per call; the controller closes it exactly once. Implemented
// over RTCPeerConnection in call_media.ts and faked in tests — the state machine must never touch a
// browser global.
export interface CallMediaSession {
  // Outgoing: create the SDP offer (setLocalDescription already applied).
  offer(): Promise<string>;
  // Incoming: apply the caller's offer and produce our answer.
  answerTo(remoteSdp: string): Promise<string>;
  // Outgoing: apply the answer that came back.
  applyAnswer(remoteSdp: string): Promise<void>;
  // Active-call recovery. Only the original caller creates restart offers; the callee answers them,
  // which avoids perfect-negotiation glare when both phones notice the same network handover.
  restartOffer(): Promise<string>;
  answerRestart(remoteSdp: string): Promise<string>;
  addIce(candidate: unknown): Promise<void>;
  setMuted(muted: boolean): void;
  setCameraOn(on: boolean): void;
  // Point the media at the view's surfaces. Audio needs nothing (the adapter plays the remote track
  // itself, so a call is audible even with the overlay closed); only video needs real elements, and
  // the view may hand them over before or after the session exists.
  attachVideo?(local: HTMLVideoElement | null, remote: HTMLVideoElement | null): void;
  close(): void;
}

export interface CallMediaPort {
  // Acquire mic (+camera) and build the peer connection. Rejects when permission is denied — the
  // controller turns that into the media_denied ending rather than a silent dead call.
  open(opts: {
    video: boolean;
    iceServers: IceServer[];
    onIce(candidate: unknown): void;
    // "recovering" means ICE/route loss after media was live. The controller keeps the call, performs
    // an ICE restart and only ends after a bounded recovery window. "failed" is non-recoverable media.
    onConnectionState(state: "connecting" | "connected" | "recovering" | "failed" | "closed"): void;
    // On a persistently critical uplink, preserve speech by pausing the local video track. The state
    // machine reflects that change so the UI never claims the camera is still transmitting.
    onVideoAutoPaused?(): void;
    // Once medium/high quality is stable again, offer a manual resume. Never turn the camera on here.
    onVideoResumeAvailable?(available: boolean): void;
  }): Promise<CallMediaSession>;
  // Compatibility capability for a constrained shell that can prove capture is permanently absent.
  // Canonical Android/Web GreenChat editions do not set it: RECORD_AUDIO/CAMERA are declared and an OS
  // denial is recoverable through settings. Absent ⇒ false.
  captureBlocked?(): boolean;
  // Optional browser/native device router. Keeping it on the media port makes the call UI platform-
  // agnostic while still allowing live microphone/camera replacement and audio-output selection.
  devices?: CallMediaDevicePort;
}

export interface CallSignalPort {
  // Send a call.* frame. Returns false when the socket is not open — a call that cannot signal has
  // already failed, and saying so immediately beats a phantom ring.
  send(frame: Record<string, unknown>): boolean;
  subscribe(handler: (frame: Record<string, unknown>) => void): () => void;
  // Volatile signaling cannot rely on durable replay. On a reconnect, the live controller rebinds its
  // call_id to the new socket so the server can cancel the stale-line disconnect timer.
  subscribeState?(handler: (state: string) => void): () => void;
}

export interface CallControllerDeps {
  signal: CallSignalPort;
  media: CallMediaPort;
  // ICE configuration from GET /v1/calls/config. Fetched lazily by the shell; a failure yields [] and
  // the call still tries (host candidates work on the same LAN).
  iceServers(): Promise<IceServer[]>;
  // Resolve the person behind a bare from_user_id on an inbound call (GET /v1/users/:id). A failure
  // must NOT drop the call — an unnamed ringing call is still answerable.
  resolvePeer(userId: number): Promise<CallPeer | null>;
  onState(state: CallState): void;
  // Called once when a call reaches a terminal state, so the shell can refresh the call log.
  onFinished?(state: CallState): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  // How long the terminal state stays on screen before the overlay dismisses itself.
  endLingerMs?: number;
  // Active-call route recovery. Defaults favour surviving a Wi-Fi ↔ mobile handover without leaving
  // a dead call on screen indefinitely.
  recoveryTimeoutMs?: number;
  recoveryRetryMs?: number;
}

const DEFAULT_LINGER_MS = 2_600;
export const DEFAULT_CALL_RECOVERY_TIMEOUT_MS = 20_000;
export const DEFAULT_CALL_RECOVERY_RETRY_MS = 4_000;

// ---- controller -----------------------------------------------------------------------------

export class CallController {
  private readonly deps: CallControllerDeps;
  private state: CallState = { ...IDLE_STATE };
  private session: CallMediaSession | null = null;
  // Candidates that arrived before the session could take them (inbound call not yet accepted, or the
  // remote description not applied). Dropping them silently is the classic "call connects only on the
  // same Wi-Fi" bug.
  private pendingIce: unknown[] = [];
  // Local candidates can arrive immediately after setLocalDescription, before the server has replied
  // with call.ringing and assigned call_id. Dropping that fast host/relay set makes otherwise healthy
  // calls fail depending on scheduler and network speed, so hold it until it can be addressed.
  private pendingLocalIce: unknown[] = [];
  private pendingOffer: string | null = null;
  private lingerTimer: unknown = null;
  private recoveryDeadlineTimer: unknown = null;
  private recoveryRetryTimer: unknown = null;
  private restartInFlight = false;
  private restartOfferSdp: string | null = null;
  // Video surfaces handed over by the view. Remembered because an inbound call renders its overlay
  // (and its <video> tags) before the person accepts and the session is built.
  private videoTargets: { local: HTMLVideoElement | null; remote: HTMLVideoElement | null } | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
  // Monotonic guard: an async media/SDP step that finishes after the call already ended must not
  // resurrect it.
  private epoch = 0;

  constructor(deps: CallControllerDeps) {
    this.deps = deps;
    this.unsubscribe = deps.signal.subscribe((frame) => this.onFrame(frame));
    this.unsubscribeState = deps.signal.subscribeState?.((state) => this.onSignalState(state)) ?? null;
  }

  get current(): CallState {
    return this.state;
  }

  // True while a call occupies the device — the shell uses it to refuse a second call and to keep the
  // overlay mounted.
  get busy(): boolean {
    return this.state.phase !== "idle" && this.state.phase !== "ended";
  }

  destroy(): void {
    // Account switch, logout and shell teardown are real call endings. Closing media without telling
    // the server used to leave both participants stuck in `byUser`, causing the next call to say busy.
    if (this.busy && this.state.callId) {
      this.deps.signal.send({ type: "call.hangup", call_id: this.state.callId });
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clearLinger();
    this.clearRecovery();
    this.closeSession();
    this.pendingIce = [];
    this.pendingLocalIce = [];
    this.pendingOffer = null;
    this.state = { ...IDLE_STATE };
  }

  // ---- local intents --------------------------------------------------------------------------

  async place(peer: CallPeer, video: boolean): Promise<void> {
    if (this.busy) return;
    const epoch = ++this.epoch;
    this.clearLinger();
    this.pendingLocalIce = [];
    this.set({
      ...IDLE_STATE,
      phase: "dialing",
      peer,
      direction: "out",
      video,
      cameraOn: video,
      awaitingMedia: true,
    });

    let session: CallMediaSession;
    let sdp: string;
    try {
      session = await this.openMedia(video);
      if (epoch !== this.epoch) {
        session.close();
        return;
      }
      this.session = session;
      this.applyVideoTargets();
      this.set({ ...this.state, awaitingMedia: false });
      sdp = await session.offer();
    } catch {
      if (epoch !== this.epoch) return;
      this.finish(this.mediaFailureReason());
      return;
    }
    if (epoch !== this.epoch) return;

    const sent = this.deps.signal.send({
      type: "call.offer",
      to_user_id: peer.id,
      sdp,
      video,
    });
    if (!sent) {
      this.finish("offline");
      return;
    }
    // Stay in "dialing" until call.ringing acks the offer: only then is the peer's device actually
    // ringing. Claiming "ringing" the moment we hit send would show a ringing UI for a call the
    // server may refuse a tick later (blocked, privacy, busy).
  }

  async accept(): Promise<void> {
    if (this.state.phase !== "incoming" || !this.pendingOffer || !this.state.callId) return;
    const epoch = ++this.epoch;
    const offer = this.pendingOffer;
    const callId = this.state.callId;
    this.set({ ...this.state, awaitingMedia: true });

    let session: CallMediaSession;
    let answer: string;
    try {
      session = await this.openMedia(this.state.video);
      if (epoch !== this.epoch) {
        session.close();
        return;
      }
      this.session = session;
      this.applyVideoTargets();
      answer = await session.answerTo(offer);
    } catch {
      if (epoch !== this.epoch) return;
      // We could not open the mic: tell the caller instead of leaving them ringing into a void.
      this.deps.signal.send({ type: "call.reject", call_id: callId, busy: false });
      this.finish(this.mediaFailureReason());
      return;
    }
    if (epoch !== this.epoch) return;

    this.pendingOffer = null;
    const sent = this.deps.signal.send({ type: "call.answer", call_id: callId, sdp: answer });
    if (!sent) {
      this.finish("offline");
      return;
    }
    this.set({ ...this.state, awaitingMedia: false, phase: "connecting" });
    void this.flushIce();
  }

  decline(): void {
    if (this.state.phase !== "incoming" || !this.state.callId) return;
    this.deps.signal.send({ type: "call.reject", call_id: this.state.callId, busy: false });
    this.finish("declined_local");
  }

  hangUp(): void {
    if (!this.busy) return;
    if (this.state.callId) {
      this.deps.signal.send({ type: "call.hangup", call_id: this.state.callId });
    }
    this.finish("hangup_local");
  }

  setMuted(muted: boolean): void {
    if (!this.busy) return;
    this.session?.setMuted(muted);
    this.set({ ...this.state, muted });
  }

  setCameraOn(on: boolean): void {
    if (!this.busy || !this.state.video) return;
    this.session?.setCameraOn(on);
    this.set({ ...this.state, cameraOn: on, videoAutoPaused: false, videoCanResume: false });
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
  // The view calls this on mount; the controller replays it onto whatever session exists now or later.
  attachVideo(local: HTMLVideoElement | null, remote: HTMLVideoElement | null): void {
    this.videoTargets = { local, remote };
    this.session?.attachVideo?.(local, remote);
  }

  // Dismiss the terminal card early (the person tapped "Закрыть").
  dismiss(): void {
    if (this.state.phase !== "ended") return;
    this.clearLinger();
    this.set({ ...IDLE_STATE });
  }

  private onSignalState(state: string): void {
    if (state === "open") {
      if (this.busy && this.state.callId) {
        if (this.deps.signal.send({ type: "call.resume", call_id: this.state.callId })) {
          this.flushLocalIce();
          if (this.state.phase === "reconnecting") this.retryRecovery();
        }
      }
      return;
    }
    // An offer sent immediately before the socket closed has no call_id, therefore it cannot be
    // resumed or safely matched after reconnect. End this narrow pre-ack state instead of playing a
    // ringback forever. Calls with a call_id stay visible through the server's reconnect grace.
    if (this.state.phase === "dialing" && !this.state.callId && !this.state.awaitingMedia) {
      this.finish("offline");
    }
  }

  // ---- inbound frames -------------------------------------------------------------------------

  private onFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" ? frame.type : "";
    if (this.state.callId && str(frame.call_id) === this.state.callId) this.flushLocalIce();
    switch (type) {
      case "call.ringing": {
        // Only meaningful for the call we are dialing right now.
        if (this.state.phase !== "dialing" || this.state.direction !== "out") return;
        const callId = str(frame.call_id);
        if (!callId) return;
        this.set({ ...this.state, phase: "ringing", callId });
        this.flushLocalIce();
        void this.flushIce();
        return;
      }
      case "call.incoming":
        this.onIncoming(frame);
        return;
      case "call.answer":
        this.onAnswer(frame);
        return;
      case "call.ice":
        this.onIce(frame);
        return;
      case "call.restart_request":
        this.onRestartRequest(frame);
        return;
      case "call.restart_offer":
        this.onRestartOffer(frame);
        return;
      case "call.restart_answer":
        this.onRestartAnswer(frame);
        return;
      case "call.reject":
        if (!this.matches(frame)) return;
        this.finish(frame.busy === true ? "busy" : "declined_remote");
        return;
      case "call.taken":
        if (!this.matches(frame) || this.state.direction !== "in") return;
        this.finish("answered_elsewhere");
        return;
      case "call.hangup":
        if (!this.matches(frame)) return;
        this.finish("hangup_remote");
        return;
      case "call.timeout":
        if (!this.matches(frame)) return;
        this.finish("timeout");
        return;
      case "call.error":
        this.onError(frame);
        return;
      default:
        return;
    }
  }

  private onIncoming(frame: Record<string, unknown>): void {
    const callId = str(frame.call_id);
    const from = typeof frame.from_user_id === "number" ? frame.from_user_id : 0;
    const sdp = str(frame.sdp);
    if (!callId || !from || !sdp) return;
    if (this.busy) {
      // The server already refuses a second call, but a second socket of ours might still be told
      // about one. Reject as busy so the caller learns the truth immediately.
      this.deps.signal.send({ type: "call.reject", call_id: callId, busy: true });
      return;
    }
    const epoch = ++this.epoch;
    this.clearLinger();
    this.pendingOffer = sdp;
    this.pendingIce = [];
    this.pendingLocalIce = [];
    const video = frame.video === true;
    this.set({
      ...IDLE_STATE,
      phase: "incoming",
      callId,
      direction: "in",
      video,
      cameraOn: video,
      peer: { id: from, name: "" },
    });
    void this.deps
      .resolvePeer(from)
      .then((peer) => {
        // A late name must not overwrite a newer call, and must not resurrect a finished one.
        if (!peer || epoch !== this.epoch || this.state.callId !== callId) return;
        this.set({ ...this.state, peer });
      })
      .catch(() => undefined);
  }

  private onAnswer(frame: Record<string, unknown>): void {
    if (!this.matches(frame) || this.state.direction !== "out") return;
    const sdp = str(frame.sdp);
    const session = this.session;
    if (!sdp || !session) return;
    const epoch = this.epoch;
    this.set({ ...this.state, phase: "connecting" });
    void session
      .applyAnswer(sdp)
      .then(() => {
        if (epoch !== this.epoch) return;
        return this.flushIce();
      })
      .catch(() => {
        if (epoch !== this.epoch) return;
        this.hangUpWith("failed");
      });
  }

  private onIce(frame: Record<string, unknown>): void {
    if (!this.matches(frame)) return;
    const candidate = frame.candidate;
    if (candidate === undefined) return;
    if (!this.session) {
      this.pendingIce.push(candidate);
      return;
    }
    void this.session.addIce(candidate).catch(() => {
      // A single bad candidate is normal (a stale relay, an IPv6 route that is gone). ICE fails as a
      // whole through onConnectionState; dropping one candidate must not end the call.
    });
  }

  private onRestartRequest(frame: Record<string, unknown>): void {
    if (!this.matches(frame) || this.state.direction !== "out" || !this.session) return;
    this.beginRecovery();
  }

  private onRestartOffer(frame: Record<string, unknown>): void {
    if (!this.matches(frame) || this.state.direction !== "in" || !this.session) return;
    const sdp = str(frame.sdp);
    if (!sdp) return;
    this.beginRecovery(false);
    const epoch = this.epoch;
    void this.session.answerRestart(sdp).then((answer) => {
      if (epoch !== this.epoch || !this.state.callId) return;
      this.deps.signal.send({ type: "call.restart_answer", call_id: this.state.callId, sdp: answer });
      void this.flushIce();
    }).catch(() => {
      if (epoch === this.epoch) this.retryRecovery();
    });
  }

  private onRestartAnswer(frame: Record<string, unknown>): void {
    if (!this.matches(frame) || this.state.direction !== "out" || !this.session) return;
    const sdp = str(frame.sdp);
    if (!sdp) return;
    const epoch = this.epoch;
    void this.session.applyAnswer(sdp).then(() => {
      if (epoch !== this.epoch) return;
      this.restartOfferSdp = null;
      void this.flushIce();
    }).catch(() => {
      if (epoch === this.epoch) this.retryRecovery();
    });
  }

  private onError(frame: Record<string, unknown>): void {
    if (this.state.phase !== "dialing" && this.state.phase !== "ringing") return;
    const code = str(frame.code);
    const reason: CallEndReason =
      code === "CALLS_NOT_ALLOWED"
        ? "not_allowed"
        : code === "ALREADY_IN_CALL"
          ? "already_in_call"
          : code === "RECIPIENT_UNAVAILABLE" || code === "NOT_FOUND"
            ? "unavailable"
            : "failed";
    this.finish(reason);
  }

  // ---- internals ------------------------------------------------------------------------------

  // Which ending a refused microphone deserves. A browser refusal is recoverable (grant it and call
  // again); a shell that can never capture has to say so, or the person keeps tapping a retry that is
  // guaranteed to fail. A shell that reports nothing keeps the V87 behaviour.
  private mediaFailureReason(): CallEndReason {
    try {
      return this.deps.media.captureBlocked?.() === true ? "media_blocked" : "media_denied";
    } catch {
      return "media_denied";
    }
  }

  private async openMedia(video: boolean): Promise<CallMediaSession> {
    let iceServers: IceServer[] = [];
    try {
      iceServers = await this.deps.iceServers();
    } catch {
      iceServers = [];
    }
    return this.deps.media.open({
      video,
      iceServers,
      onIce: (candidate) => {
        const callId = this.state.callId;
        if (!callId) {
          if (this.busy && this.state.direction === "out") this.pendingLocalIce.push(candidate);
          return;
        }
        if (!this.deps.signal.send({ type: "call.ice", call_id: callId, candidate })) {
          // Media may survive a signaling reconnect. Keep the candidate until any later call frame
          // proves that the socket is writable again instead of silently losing the recovery path.
          this.pendingLocalIce.push(candidate);
        }
      },
      onConnectionState: (s) => this.onConnectionState(s),
      onVideoAutoPaused: () => {
        if (!this.busy || !this.state.video || !this.state.cameraOn) return;
        this.set({ ...this.state, cameraOn: false, videoAutoPaused: true, videoCanResume: false });
      },
      onVideoResumeAvailable: (available) => {
        if (!this.busy || !this.state.video || !this.state.videoAutoPaused) return;
        if (this.state.videoCanResume !== available) this.set({ ...this.state, videoCanResume: available });
      },
    });
  }

  private onConnectionState(s: "connecting" | "connected" | "recovering" | "failed" | "closed"): void {
    if (!this.busy) return;
    if (s === "connected") {
      const connectedAt = this.state.connectedAt ?? this.now();
      this.clearRecovery();
      if (this.state.phase !== "active" || this.state.connectedAt === null) {
        this.set({ ...this.state, phase: "active", connectedAt });
      }
      return;
    }
    if (s === "recovering" && this.state.connectedAt !== null) {
      this.beginRecovery();
      return;
    }
    if (s === "failed" || s === "closed") this.hangUpWith("failed");
  }

  private beginRecovery(initiate = true): void {
    if (!this.busy || !this.session || !this.state.callId || this.state.connectedAt === null) return;
    if (this.state.phase !== "reconnecting") this.set({ ...this.state, phase: "reconnecting" });
    if (this.recoveryDeadlineTimer === null) {
      const timeout = this.deps.recoveryTimeoutMs ?? DEFAULT_CALL_RECOVERY_TIMEOUT_MS;
      this.recoveryDeadlineTimer = this.setTimer(() => {
        this.recoveryDeadlineTimer = null;
        if (this.state.phase === "reconnecting") this.hangUpWith("failed");
      }, timeout);
    }
    if (initiate) {
      if (this.state.direction === "out") void this.sendRestartOffer();
      else this.requestCallerRestart();
    }
    this.scheduleRecoveryRetry();
  }

  private requestCallerRestart(): void {
    if (!this.state.callId) return;
    this.deps.signal.send({ type: "call.restart_request", call_id: this.state.callId });
  }

  private async sendRestartOffer(): Promise<void> {
    const session = this.session;
    const callId = this.state.callId;
    if (!session || !callId || this.restartInFlight || this.state.direction !== "out") return;
    this.restartInFlight = true;
    const epoch = this.epoch;
    try {
      if (this.restartOfferSdp === null) this.restartOfferSdp = await session.restartOffer();
      if (epoch !== this.epoch || this.state.callId !== callId || this.restartOfferSdp === null) return;
      this.deps.signal.send({ type: "call.restart_offer", call_id: callId, sdp: this.restartOfferSdp });
    } catch {
      if (epoch === this.epoch) this.restartOfferSdp = null;
    } finally {
      if (epoch === this.epoch) this.restartInFlight = false;
    }
  }

  private retryRecovery(): void {
    if (this.state.phase !== "reconnecting") return;
    this.flushLocalIce();
    if (this.state.direction === "out") void this.sendRestartOffer();
    else this.requestCallerRestart();
    this.scheduleRecoveryRetry();
  }

  private scheduleRecoveryRetry(): void {
    if (this.recoveryRetryTimer !== null || this.state.phase !== "reconnecting") return;
    const delay = this.deps.recoveryRetryMs ?? DEFAULT_CALL_RECOVERY_RETRY_MS;
    this.recoveryRetryTimer = this.setTimer(() => {
      this.recoveryRetryTimer = null;
      this.retryRecovery();
    }, delay);
  }

  private clearRecovery(): void {
    if (this.recoveryDeadlineTimer !== null) {
      this.clearTimer(this.recoveryDeadlineTimer);
      this.recoveryDeadlineTimer = null;
    }
    if (this.recoveryRetryTimer !== null) {
      this.clearTimer(this.recoveryRetryTimer);
      this.recoveryRetryTimer = null;
    }
    this.restartInFlight = false;
    this.restartOfferSdp = null;
  }

  private flushLocalIce(): void {
    const callId = this.state.callId;
    if (!callId || this.pendingLocalIce.length === 0) return;
    const queued = this.pendingLocalIce;
    this.pendingLocalIce = [];
    for (let i = 0; i < queued.length; i += 1) {
      const candidate = queued[i];
      if (!this.deps.signal.send({ type: "call.ice", call_id: callId, candidate })) {
        this.pendingLocalIce = queued.slice(i);
        return;
      }
    }
  }

  private async flushIce(): Promise<void> {
    const session = this.session;
    if (!session || this.pendingIce.length === 0) return;
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const candidate of queued) {
      try {
        await session.addIce(candidate);
      } catch {
        /* see onIce: one bad candidate is not a failed call */
      }
    }
  }

  // End the call locally AND tell the peer — used when our side breaks (ICE failure), where staying
  // silent would leave the other phone showing a live call with no audio.
  private hangUpWith(reason: CallEndReason): void {
    if (this.state.callId) {
      this.deps.signal.send({ type: "call.hangup", call_id: this.state.callId });
    }
    this.finish(reason);
  }

  private finish(reason: CallEndReason): void {
    this.epoch += 1;
    this.clearRecovery();
    this.closeSession();
    this.pendingIce = [];
    this.pendingLocalIce = [];
    this.pendingOffer = null;
    const ended: CallState = { ...this.state, phase: "ended", reason, awaitingMedia: false };
    this.set(ended);
    this.deps.onFinished?.(ended);
    this.clearLinger();
    // V87: a terminal screen that offers a way out waits for the person. Only the states with
    // nothing left to decide step aside on their own.
    if (endHoldsScreen(ended)) return;
    const linger = this.deps.endLingerMs ?? DEFAULT_LINGER_MS;
    this.lingerTimer = this.setTimer(() => {
      this.lingerTimer = null;
      if (this.state.phase === "ended") this.set({ ...IDLE_STATE });
    }, linger);
  }

  private applyVideoTargets(): void {
    if (!this.videoTargets) return;
    this.session?.attachVideo?.(this.videoTargets.local, this.videoTargets.remote);
  }

  private closeSession(): void {
    try {
      this.session?.close();
    } catch {
      /* closing twice must never throw into the UI */
    }
    this.session = null;
    this.videoTargets = null;
  }

  // A frame belongs to the current call when the ids match. A frame for an unknown call id is stale
  // (a previous call of ours, or a race with another device) and is ignored.
  private matches(frame: Record<string, unknown>): boolean {
    if (!this.busy) return false;
    const id = str(frame.call_id);
    return !!id && id === this.state.callId;
  }

  private set(next: CallState): void {
    this.state = next;
    this.deps.onState(next);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private clearLinger(): void {
    if (this.lingerTimer === null) return;
    this.clearTimer(this.lingerTimer);
    this.lingerTimer = null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---- wording --------------------------------------------------------------------------------

// The one line under the peer's name. Every phase says something true and specific: the old designs
// showed "Звонок" for all of dialing, ringing, connecting and a dead call alike.
export function callStatusKey(state: CallState): string {
  switch (state.phase) {
    case "dialing":
      return state.awaitingMedia ? "call.stateMic" : "call.stateDialing";
    case "ringing":
      return "call.stateRinging";
    case "incoming":
      return state.video ? "call.stateIncomingVideo" : "call.stateIncoming";
    case "connecting":
      return state.awaitingMedia ? "call.stateMic" : "call.stateConnecting";
    case "active":
      return state.videoCanResume
        ? "call.stateVideoCanResume"
        : state.videoAutoPaused
          ? "call.stateAudioOnly"
          : "call.stateActive";
    case "reconnecting":
      return "call.stateReconnecting";
    case "ended":
      return endReasonKey(state);
    default:
      return "call.stateIdle";
  }
}

export function endReasonKey(state: CallState): string {
  switch (state.reason) {
    case "hangup_local":
    case "hangup_remote":
      return state.connectedAt ? "call.endFinished" : "call.endCancelled";
    case "declined_local":
      return "call.endDeclinedByMe";
    case "declined_remote":
      return "call.endDeclined";
    case "busy":
      return "call.endBusy";
    case "answered_elsewhere":
      return "call.endAnsweredElsewhere";
    case "timeout":
      return "call.endNoAnswer";
    case "unavailable":
      return "call.endUnavailable";
    case "not_allowed":
      return "call.endNotAllowed";
    case "already_in_call":
      return "call.endAlreadyInCall";
    case "media_denied":
      return "call.endMicDenied";
    case "media_blocked":
      return "call.endMicBlocked";
    case "offline":
      return "call.endOffline";
    case "failed":
      return "call.endFailed";
    default:
      return "call.endUnknown";
  }
}

// V87. A terminal call screen used to end every story the same way: one line of wording and a
// «Закрыть» button that returned to the list after 2.6 s. That is right for a *social* outcome —
// busy, no answer, declined — because the log behind the screen already carries a one-tap redial for
// exactly that person. It is wrong for a *technical* failure: "Нет доступа к микрофону" told the
// person what broke, never what to do about it, and tapping redial in the log simply failed again
// with the same six words. Measured on the stand (var/ux-audit/tools/m_callscreen_v87.mjs): phase
// `ended`, reason `media_denied`, one control on screen — `Закрыть`.
//
// So the terminal screen now splits by whether the person can still act:
//   * recoverable technical failure → an explanation of the fix, a "call again" control, and NO
//     self-dismiss (a button that vanishes while it is being reached for is worse than no button);
//   * everything else → unchanged: the reason lingers briefly and the screen steps out of the way.
export interface CallRecovery {
  /** Placing the same call again is a sensible, non-pushy next step for this reason. */
  retry: boolean;
  /** Locale key for one extra line telling the person how to fix it; null when nothing to add. */
  hintKey: string | null;
}

export function endRecovery(state: CallState): CallRecovery {
  switch (state.reason) {
    case "media_denied":
      // The browser/OS refused the microphone. Nothing on the server side is wrong and no amount of
      // redialling helps until the permission is granted, so the fix has to be spelled out.
      return { retry: true, hintKey: "call.hintMicDenied" };
    case "media_blocked":
      // V111: the shell cannot capture at all and no setting the person can reach changes that, so
      // both halves of the recoverable card would be false — the instruction and the retry alike.
      // The explanation still holds the screen: vanishing after 2.6 s would leave the failure unexplained.
      return { retry: false, hintKey: "call.hintMicBlocked" };
    case "offline":
      return { retry: true, hintKey: "call.hintOffline" };
    case "failed":
      return { retry: true, hintKey: "call.hintFailed" };
    case "already_in_call":
      // Retrying is guaranteed to fail while the other call is up: name the blocker instead.
      return { retry: false, hintKey: "call.hintAlreadyInCall" };
    default:
      // Social outcomes (busy, answered elsewhere, no answer, declined, unavailable, hang-up) end here: the call log the
      // screen returns to carries the redial, and a second screen offering the same thing is noise.
      return { retry: false, hintKey: null };
  }
}

/** Does this terminal state hold the screen until the person decides? Mirrors `endRecovery`. */
export function endHoldsScreen(state: CallState): boolean {
  const recovery = endRecovery(state);
  return recovery.retry || recovery.hintKey !== null;
}

// mm:ss (h:mm:ss past an hour) for the live timer. Shared with the log's duration formatting rules.
export function formatCallTimer(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
