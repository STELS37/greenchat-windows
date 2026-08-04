import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function synchsafe(bytes: Buffer, offset: number): number {
  return ((bytes[offset]! & 0x7f) << 21)
    | ((bytes[offset + 1]! & 0x7f) << 14)
    | ((bytes[offset + 2]! & 0x7f) << 7)
    | (bytes[offset + 3]! & 0x7f);
}

function inspectFirstMp3Frame(bytes: Buffer): { sampleRate: number; bitrateKbps: number; channels: number } {
  let offset = 0;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" && bytes.length >= 10) {
    offset = 10 + synchsafe(bytes, 6);
  }
  for (; offset + 4 <= bytes.length; offset += 1) {
    const header = bytes.readUInt32BE(offset) >>> 0;
    if (((header & 0xffe00000) >>> 0) !== 0xffe00000) continue;
    const version = (header >>> 19) & 0x3;
    const layer = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    if (version !== 0x3 || layer !== 0x1 || bitrateIndex === 0 || bitrateIndex === 0xf || sampleRateIndex === 0x3) {
      continue;
    }
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const sampleRates = [44_100, 48_000, 32_000];
    const channelMode = (header >>> 6) & 0x3;
    return {
      sampleRate: sampleRates[sampleRateIndex]!,
      bitrateKbps: bitrates[bitrateIndex]!,
      channels: channelMode === 0x3 ? 1 : 2,
    };
  }
  throw new Error("no MPEG-1 Layer III audio frame found");
}

test("V210: call tones are full-band stereo assets instead of 8 kHz telephone audio", () => {
  for (const file of ["call-incoming.mp3", "call-outgoing.mp3"]) {
    const bytes = readFileSync(new URL(`../../web/public/assets/${file}`, import.meta.url));
    const info = inspectFirstMp3Frame(bytes);
    assert.equal(info.sampleRate, 48_000, `${file} must retain full-band phone-speaker detail`);
    assert.equal(info.channels, 2, `${file} must not collapse to the old mono asset`);
    assert.ok(info.bitrateKbps >= 128, `${file} must not return to the old 8 kbit/s encoding`);
    assert.ok(bytes.length >= 60_000, `${file} must contain the mastered signal, not a low-rate stub`);
  }
});
