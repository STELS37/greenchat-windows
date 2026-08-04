// clients/ui/test/call_recovery_v87.test.ts — V87: a call that failed must leave a way out.
//
// Evidence that produced this layer (var/ux-audit/tools/m_callscreen_v87.mjs, 2026-07-30, stand
// 127.0.0.1:8992, 390x844): placing a call in an environment without a microphone left the screen in
// phase `ended`, reason `media_denied`, showing exactly one control — «Закрыть» — and nothing at all
// about how to make the call work. The screen also cleared itself 2.6 s later, so even an action
// added there would have vanished while being reached for.
//
// This guard fixes the rule, not the pixels: a *technical* failure holds the screen and carries both
// an instruction and a retry; a *social* outcome (busy, no answer, declined) keeps the old, correct
// behaviour, because the call log underneath already redials that person in one tap.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CallController,
  IDLE_STATE,
  endHoldsScreen,
  endRecovery,
  type CallEndReason,
  type CallMediaSession,
  type CallState,
} from "../src/screens/call_model.ts";

const ended = (reason: CallEndReason): CallState => ({ ...IDLE_STATE, phase: "ended", reason });

test("V87: a technical failure states the fix and offers the call again", () => {
  for (const reason of ["media_denied", "offline", "failed"] as const) {
    const r = endRecovery(ended(reason));
    assert.equal(r.retry, true, `${reason}: the person must be able to try again from the screen`);
    assert.ok(r.hintKey, `${reason}: a fact without a next step is the dead end V87 removes`);
    assert.equal(endHoldsScreen(ended(reason)), true, `${reason}: an offered action must not self-destruct`);
  }
  // The one failure retrying cannot fix: it names the blocker instead of promising a useless retry.
  const busyDevice = endRecovery(ended("already_in_call"));
  assert.equal(busyDevice.retry, false, "retrying while another call is up fails by definition");
  assert.ok(busyDevice.hintKey, "the blocker has to be named");
});

test("V87: a social outcome adds nothing — the log behind the screen already redials", () => {
  for (const reason of ["busy", "timeout", "declined_remote", "declined_local", "unavailable", "not_allowed", "hangup_local", "hangup_remote"] as const) {
    const r = endRecovery(ended(reason));
    assert.equal(r.retry, false, `${reason}: a second redial control here is noise`);
    assert.equal(r.hintKey, null, `${reason}: nothing to instruct — the reason is the whole story`);
    assert.equal(endHoldsScreen(ended(reason)), false, `${reason}: this screen must step out of the way`);
  }
});

// The rule above is only worth anything if the live machine obeys it, so drive the real controller:
// a denied microphone must leave the screen standing after every pending timer has fired.
test("V87: the machine keeps a mic-denied screen on until the person closes it", async () => {
  const timers: Array<{ fn: () => void; id: number }> = [];
  let next = 1;
  const states: CallState[] = [];
  const controller = new CallController({
    signal: { send: () => true, subscribe: () => () => {} },
    media: {
      async open(): Promise<CallMediaSession> {
        throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
      },
    },
    async iceServers() { return []; },
    async resolvePeer(id) { return { id, name: "Пётр" }; },
    onState(s) { states.push(s); },
    now: () => 1_000_000,
    setTimer: (fn) => { const id = next++; timers.push({ fn, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  });

  await controller.place({ id: 78, name: "Пётр" }, false);
  assert.equal(controller.current.phase, "ended");
  assert.equal(controller.current.reason, "media_denied");
  const due = timers.splice(0, timers.length);
  for (const t of due) t.fn();
  assert.equal(controller.current.phase, "ended", "the explanation must survive the linger timer");
  assert.equal(controller.current.peer?.id, 78, "retry needs the peer, so the peer must still be there");

  controller.dismiss();
  assert.equal(controller.current.phase, "idle", "«Закрыть» still works — the screen is not a trap");
});
