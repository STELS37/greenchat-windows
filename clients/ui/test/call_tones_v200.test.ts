import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  callToneForState,
  createBrowserCallTones,
  type CallToneAudio,
  type CallToneEnvironment,
} from "../../web/src/call_tones.ts";

type FakeAudio = CallToneAudio & {
  src: string;
  plays: number;
  pauses: number;
  loads: number;
  rejectNextPlay: boolean;
};

function fakeEnvironment() {
  const audios: FakeAudio[] = [];
  const gestures = new Set<() => void>();
  const environment: CallToneEnvironment = {
    createAudio(src) {
      const audio: FakeAudio = {
        src,
        loop: false,
        preload: "none",
        currentTime: 19,
        volume: 0,
        plays: 0,
        pauses: 0,
        loads: 0,
        rejectNextPlay: false,
        play() {
          this.plays += 1;
          if (this.rejectNextPlay) {
            this.rejectNextPlay = false;
            return Promise.reject(new Error("autoplay blocked"));
          }
          return Promise.resolve();
        },
        pause() { this.pauses += 1; },
        load() { this.loads += 1; },
      };
      audios.push(audio);
      return audio;
    },
    onUserGesture(listener) {
      gestures.add(listener);
      return () => { gestures.delete(listener); };
    },
  };
  return {
    environment,
    audios,
    gestures,
    gesture() { for (const listener of [...gestures]) listener(); },
  };
}

const state = (
  phase: "idle" | "dialing" | "ringing" | "incoming" | "connecting" | "active" | "reconnecting" | "ended",
  direction: "in" | "out",
  awaitingMedia = false,
) => ({ phase, direction, awaitingMedia });

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("tone mapping follows the call lifecycle and stops before media connection", () => {
  assert.equal(callToneForState(state("idle", "out")), null);
  assert.equal(callToneForState(state("dialing", "out")), "outgoing");
  assert.equal(callToneForState(state("ringing", "out")), "outgoing");
  assert.equal(callToneForState(state("connecting", "out")), null, "remote answer stops ringback");
  assert.equal(callToneForState(state("active", "out")), null);
  assert.equal(callToneForState(state("incoming", "in")), "incoming");
  assert.equal(
    callToneForState(state("incoming", "in", true)),
    null,
    "accept marks awaitingMedia synchronously, so the ringtone stops before permission prompts",
  );
  assert.equal(callToneForState(state("ended", "in")), null);
});

test("incoming and outgoing tones loop without overlapping or restarting on equivalent phases", async () => {
  const fake = fakeEnvironment();
  const tones = createBrowserCallTones({
    incomingUrl: "/incoming.mp3",
    outgoingUrl: "/outgoing.mp3",
    environment: fake.environment,
  });
  const [incoming, outgoing] = fake.audios;

  assert.equal(incoming.loop, true);
  assert.equal(outgoing.loop, true);
  assert.equal(incoming.preload, "auto");
  assert.equal(outgoing.preload, "auto");
  assert.equal(incoming.volume, 1);
  assert.equal(outgoing.volume, 1);

  tones.update(state("dialing", "out"));
  await flush();
  assert.equal(tones.current(), "outgoing");
  assert.equal(outgoing.plays, 1);
  assert.equal(outgoing.currentTime, 0);

  tones.update(state("ringing", "out"));
  await flush();
  assert.equal(outgoing.plays, 1, "dialing → ringing keeps the same continuous loop");

  tones.update(state("connecting", "out"));
  assert.equal(tones.current(), null);
  assert.equal(outgoing.currentTime, 0);
  assert.ok(outgoing.pauses >= 2);

  tones.update(state("incoming", "in"));
  await flush();
  assert.equal(tones.current(), "incoming");
  assert.equal(incoming.plays, 1);
  assert.equal(outgoing.currentTime, 0);

  tones.update(state("incoming", "in", true));
  assert.equal(tones.current(), null);
  assert.equal(incoming.currentTime, 0);
});

test("autoplay rejection retries once on a real gesture only while the call is still ringing", async () => {
  const fake = fakeEnvironment();
  const tones = createBrowserCallTones({
    incomingUrl: "/incoming.mp3",
    outgoingUrl: "/outgoing.mp3",
    environment: fake.environment,
  });
  const incoming = fake.audios[0];
  incoming.rejectNextPlay = true;

  tones.update(state("incoming", "in"));
  await flush();
  assert.equal(incoming.plays, 1);
  assert.equal(fake.gestures.size, 1);

  fake.gesture();
  await flush();
  assert.equal(incoming.plays, 2);
  assert.equal(fake.gestures.size, 0);

  incoming.rejectNextPlay = true;
  tones.stop();
  tones.update(state("incoming", "in"));
  await flush();
  assert.equal(fake.gestures.size, 1);
  tones.update(state("ended", "in"));
  fake.gesture();
  await flush();
  assert.equal(fake.gestures.size, 0);
  assert.equal(incoming.plays, 3, "an ended call cannot be resurrected by a later gesture");
});

test("destroy is idempotent and permanently silences both players", async () => {
  const fake = fakeEnvironment();
  const tones = createBrowserCallTones({
    incomingUrl: "/incoming.mp3",
    outgoingUrl: "/outgoing.mp3",
    environment: fake.environment,
  });
  tones.update(state("dialing", "out"));
  await flush();
  tones.destroy();
  tones.destroy();
  tones.update(state("incoming", "in"));
  await flush();

  assert.equal(tones.current(), null);
  assert.equal(fake.audios[0].plays, 0);
  assert.equal(fake.audios[1].plays, 1);
  assert.equal(fake.gestures.size, 0);
  assert.equal(fake.audios[0].currentTime, 0);
  assert.equal(fake.audios[1].currentTime, 0);
});

test("the web shell wires versioned assets into every CallController state transition", () => {
  const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /import \{ createBrowserCallTones \} from "\.\/call_tones\.ts";/u);
  assert.match(main, /const callTones = createBrowserCallTones\(\{/u);
  assert.match(main, /call-incoming\.mp3\?v=\$\{encodeURIComponent\(BUILD_ID\)\}/u);
  assert.match(main, /call-outgoing\.mp3\?v=\$\{encodeURIComponent\(BUILD_ID\)\}/u);
  assert.match(main, /onState: \(state\) => \{\s*callTones\.update\(state\);\s*callOverlay\.render\(state\);\s*\}/u);

  for (const file of ["call-incoming.mp3", "call-outgoing.mp3"]) {
    const path = fileURLToPath(new URL(`../../web/public/assets/${file}`, import.meta.url));
    assert.ok(statSync(path).size > 4_000, `${file} must contain an optimized supplied ringtone, not a stub`);
  }
});
