import test from "node:test";
import assert from "node:assert/strict";

import {
  CALL_ENCODING_PROFILES,
  CallNetworkRecoveryPolicy,
  CallPacketLossWindow,
  CallQualityHysteresis,
  CallStatsPollGate,
  classifyCallQuality,
  tuneCallSdp,
} from "../../web/src/call_quality.ts";

test("V167: media policy degrades before speech becomes unusable", () => {
  assert.equal(classifyCallQuality({ packetLossRatio: 0.01, roundTripTimeMs: 80, availableOutgoingBitrate: 2_000_000 }), "high");
  assert.equal(classifyCallQuality({ packetLossRatio: 0.04, roundTripTimeMs: 120, availableOutgoingBitrate: 500_000 }), "medium");
  assert.equal(classifyCallQuality({ packetLossRatio: 0.09, roundTripTimeMs: 200, availableOutgoingBitrate: 350_000 }), "low");
  assert.equal(classifyCallQuality({ packetLossRatio: 0.16, roundTripTimeMs: 100 }), "critical");
  assert.ok(CALL_ENCODING_PROFILES.critical.audioBitrate >= 12_000, "critical still preserves intelligible speech");
  assert.ok(CALL_ENCODING_PROFILES.critical.videoBitrate < CALL_ENCODING_PROFILES.low.videoBitrate);
});

test("V168: jitter degrades video before bursty speech becomes unintelligible", () => {
  const clean = { packetLossRatio: 0, roundTripTimeMs: 70, availableOutgoingBitrate: 2_000_000 };
  assert.equal(classifyCallQuality({ ...clean, jitterMs: 20 }), "high");
  assert.equal(classifyCallQuality({ ...clean, jitterMs: 70 }), "medium");
  assert.equal(classifyCallQuality({ ...clean, jitterMs: 140 }), "low");
  assert.equal(classifyCallQuality({ ...clean, jitterMs: 300 }), "critical");
});

test("V168: a slow stats round cannot overlap and apply stale quality out of order", () => {
  const gate = new CallStatsPollGate();
  assert.equal(gate.begin(), true);
  assert.equal(gate.begin(), false, "the next interval is skipped while getStats/setParameters is pending");
  gate.end();
  assert.equal(gate.begin(), true, "polling resumes after the previous round settles");
});

test("V168: bitrate estimate changes alone never trigger an ICE restart storm", () => {
  const policy = new CallNetworkRecoveryPolicy();
  assert.equal(policy.onOnline(true), false, "online without a preceding outage is only a quality change");
  assert.equal(policy.onOffline(false), false, "there is no live media route to recover before first connect");
  assert.equal(policy.onOffline(true), true, "the first real outage enters recovery");
  assert.equal(policy.onOffline(true), false, "duplicate offline events do not duplicate restart offers");
  assert.equal(policy.onOnline(true), true, "the returning route gets one proactive ICE restart");
  assert.equal(policy.onOnline(true), false, "the offline marker is consumed exactly once");
  assert.equal(policy.onOffline(true), true);
  policy.onConnected();
  assert.equal(policy.onOnline(true), false, "a confirmed WebRTC connection clears stale browser events");
});

test("V167: accumulated loss is converted to interval loss and can recover", () => {
  const window = new CallPacketLossWindow();
  assert.equal(window.update({ packetsLost: 20, packetsSent: 100 }), 0.2);
  assert.equal(window.update({ packetsLost: 20, packetsSent: 200 }), 0, "old loss must not poison the next clean interval");
  assert.equal(window.update({ packetsLost: 25, packetsSent: 300 }), 0.05);
  assert.equal(window.update({ packetsLost: 1, packetsSent: 10 }), 0.1, "counter rollback starts a new SSRC/ICE window");
  assert.equal(window.update({ packetsLost: 99, packetsSent: 99, fractionLost: 0.03 }), 0.03, "native interval fraction wins");
});

test("V167: quality worsens immediately and recovers slowly without bitrate oscillation", () => {
  const policy = new CallQualityHysteresis();
  const bad = { packetLossRatio: 0.2, roundTripTimeMs: 900 };
  const good = { packetLossRatio: 0, roundTripTimeMs: 50, availableOutgoingBitrate: 2_000_000 };
  assert.equal(policy.update(bad), "critical");
  assert.equal(policy.update(good), "critical");
  assert.equal(policy.update(good), "critical");
  assert.equal(policy.update(good), "low", "recovery moves only one rung after three clean intervals");
});

test("V167: Opus SDP always carries FEC, DTX, mono and a bounded speech bitrate", () => {
  const input = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=0;stereo=1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=rtpmap:96 VP8/90000",
    "",
  ].join("\r\n");
  const tuned = tuneCallSdp(input, 24_000);
  const opus = tuned.split("\r\n").find((line) => line.startsWith("a=fmtp:111")) ?? "";
  assert.match(opus, /useinbandfec=1/);
  assert.match(opus, /usedtx=1/);
  assert.match(opus, /stereo=0/);
  assert.match(opus, /sprop-stereo=0/);
  assert.match(opus, /maxaveragebitrate=24000/);
  assert.equal((opus.match(/useinbandfec=/g) ?? []).length, 1, "transform replaces rather than duplicates parameters");
  assert.equal(tuneCallSdp(tuned, 24_000), tuned, "transform is idempotent");
});
