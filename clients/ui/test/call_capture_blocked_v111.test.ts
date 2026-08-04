// clients/ui/test/call_capture_blocked_v111.test.ts — V111: the call screen must not promise a fix
// the installed build cannot deliver.
//
// Evidence from the signed direct APK (versionCode 1000013, redroid Android 15, 393x801 CSS px,
// probes var/ux-audit/tools/m_calls_v111.mjs + /tmp/m_perm_v111.mjs, screenshot /tmp/dev_state_v111.png,
// 2026-07-31):
//   * `dumpsys package app.greenchat` requested permissions: INTERNET, ACCESS_NETWORK_STATE,
//     POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, WAKE_LOCK, c2dm RECEIVE, USE_BIOMETRIC,
//     USE_FINGERPRINT, DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION — no RECORD_AUDIO, no CAMERA.
//   * `navigator.mediaDevices.getUserMedia({audio:true})` rejects in 318 ms with NotAllowedError
//     "Permission denied" — no OS prompt is ever shown, because the permission is not in the manifest.
//   * Tapping «Позвонить» therefore always lands on the terminal screen with
//     «Нет доступа к микрофону» + «Разрешите доступ к микрофону в настройках приложения или браузера —
//     после этого звонок пойдёт.» + a green «Позвонить снова» button.
// Both of those are false on this artifact: Android app settings carry no «Микрофон» switch to grant,
// so the instruction leads nowhere and the retry can only fail again, forever. This is the same class
// of defect V85/P0-4 removed from finance: an action that cannot work must not pretend it can.
//
// Why the rule is bound to the shell and not to the Permissions API: on the device
// `navigator.permissions.query({name:"microphone"})` answers "prompt" — it claims the app may still
// ask — while the capture is refused instantly. The API cannot be trusted here, so the shell reports
// the fact it can actually prove, and the release contract below keeps that report honest.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CallController,
  IDLE_STATE,
  endHoldsScreen,
  endRecovery,
  type CallMediaSession,
  type CallState,
} from "../src/screens/call_model.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const deniedMedia = (captureBlocked?: boolean): {
  open: () => Promise<CallMediaSession>;
  captureBlocked?: () => boolean;
} => ({
  async open(): Promise<CallMediaSession> {
    throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  },
  ...(captureBlocked === undefined ? {} : { captureBlocked: () => captureBlocked }),
});

const placeAndEnd = async (captureBlocked?: boolean): Promise<CallState> => {
  const states: CallState[] = [];
  const controller = new CallController({
    signal: { send: () => true, subscribe: () => () => {} },
    media: deniedMedia(captureBlocked),
    iceServers: async () => [],
    resolvePeer: async () => null,
    onState: (s) => { states.push(s); },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  await controller.place({ id: 7, name: "Артём Волков" }, false);
  const ended = states.filter((s) => s.phase === "ended");
  assert.ok(ended.length > 0, "a refused microphone must end the call visibly");
  return ended[ended.length - 1];
};

test("V111: a shell that can never capture ends the call with a reason of its own", async () => {
  const blocked = await placeAndEnd(true);
  assert.equal(
    blocked.reason,
    "media_blocked",
    "a permanently uncapturable shell must not reuse the recoverable 'permission was denied' ending",
  );
  // The recoverable ending stays exactly as V87 left it for browsers, where granting really does work.
  const denied = await placeAndEnd(false);
  assert.equal(denied.reason, "media_denied", "a browser denial is still recoverable");
  const legacy = await placeAndEnd(undefined);
  assert.equal(legacy.reason, "media_denied", "a shell that reports nothing keeps the old behaviour");
});

test("V111: the permanent ending offers no impossible retry and no impossible instruction", () => {
  const state: CallState = { ...IDLE_STATE, phase: "ended", reason: "media_blocked" };
  const recovery = endRecovery(state);
  assert.equal(recovery.retry, false, "a retry that can only fail again is a false promise");
  assert.equal(recovery.hintKey, "call.hintMicBlocked", "the real reason has to be spelled out");
  assert.equal(endHoldsScreen(state), true, "the explanation must stay until the person closes it");

  const hint = ru["call.hintMicBlocked"];
  assert.ok(typeof hint === "string" && hint.length > 40, "ru hint must exist and explain");
  assert.ok(
    !/после этого звонок пойдёт/i.test(hint),
    "the build cannot keep that promise — measured NotAllowedError with no grantable permission",
  );
  assert.ok(
    /микрофон/i.test(hint) && /настройк/i.test(hint),
    "the hint must name the microphone and the settings the person will (not) find it in",
  );
  for (const key of ["call.endMicBlocked", "call.hintMicBlocked"] as const) {
    assert.ok(ru[key], `ru is missing ${key}`);
    assert.ok(en[key], `en is missing ${key}`);
  }
});

test("V149: every Android edition declares grantable microphone and camera permissions", () => {
  // Calls are a canonical GreenChat surface. Shipping their buttons while the artifact permanently
  // forbids capture is not graceful degradation; it is a broken release. The manifest and verifier
  // therefore require both runtime permissions on every channel.
  const manifest = read("../../mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/, "audio calls require RECORD_AUDIO");
  assert.match(manifest, /android\.permission\.CAMERA/, "video calls require CAMERA");

  const verifier = read("../../mobile/verify-messenger-artifacts.mjs");
  const banned = verifier.match(/universallyForbiddenPermissions\s*=\s*\/([^/]+)\//);
  assert.ok(banned, "the release verifier must still ban telephony spying permissions");
  assert.doesNotMatch(banned[1], /RECORD_AUDIO|CAMERA/, "call media permissions are no longer forbidden");
  assert.match(verifier, /requiredMessengerPermissions[\s\S]*RECORD_AUDIO[\s\S]*CAMERA/);

  // Native Android must behave like the browser: ask the OS and treat a denial as recoverable. A
  // hardcoded nativeCaptureBlocked() would make the new manifest useless and keep every call failing.
  const adapter = read("../../web/src/call_media.ts");
  assert.doesNotMatch(adapter, /nativeCaptureBlocked|captureBlocked:\s*nativeCaptureBlocked/);
  assert.match(adapter, /mediaDevices\.getUserMedia/);
});
