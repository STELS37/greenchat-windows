import assert from "node:assert/strict";
import test from "node:test";
import {
  PowAbortedError,
  PowChallengeError,
  PowExhaustedError,
  PowExpiredError,
  leadingZeroBits,
  solvePowChallenge,
} from "../src/pow_solver.ts";

const challenge = (overrides: Partial<{ salt: string; bits: number; expires_at: number }> = {}) => ({
  salt: "0123456789abcdef",
  bits: 8,
  expires_at: Math.floor(Date.now() / 1000) + 60,
  ...overrides,
});

test("leadingZeroBits counts complete and partial zero bytes", () => {
  assert.equal(leadingZeroBits(Uint8Array.from([0, 0, 0x10])), 19);
  assert.equal(leadingZeroBits(Uint8Array.from([0x80])), 0);
  assert.equal(leadingZeroBits(Uint8Array.from([0x01])), 7);
  assert.equal(leadingZeroBits(Uint8Array.from([])), 0);
});

test("solvePowChallenge returns a reusable wire payload that satisfies the challenge", async () => {
  const result = await solvePowChallenge(challenge(), {
    batchSize: 64,
    maxAttempts: 100_000,
  });
  assert.equal(result.pow_salt, "0123456789abcdef");
  assert.ok(result.pow_nonce.length > 0);
  assert.ok(result.attempts >= 1);

  const bytes = new TextEncoder().encode(`${result.pow_salt}:${result.pow_nonce}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  assert.ok(leadingZeroBits(digest) >= 8);
});

test("solvePowChallenge reports deterministic progress and batch attempts", async () => {
  const progress: number[] = [];
  let calls = 0;
  const result = await solvePowChallenge(challenge({ bits: 1 }), {
    batchSize: 4,
    maxAttempts: 12,
    hash: async () => {
      calls += 1;
      return Uint8Array.from([calls === 7 ? 0x00 : 0xff]);
    },
    onProgress: (attempts) => progress.push(attempts),
  });
  assert.equal(result.attempts, 7);
  assert.equal(result.pow_nonce, "6");
  assert.deepEqual(progress, [4, 7]);
});

test("solvePowChallenge rejects malformed or expired challenges", async () => {
  await assert.rejects(
    solvePowChallenge(challenge({ salt: "BAD" })),
    PowChallengeError,
  );
  await assert.rejects(
    solvePowChallenge(challenge({ bits: 31 })),
    PowChallengeError,
  );
  await assert.rejects(
    solvePowChallenge(challenge({ expires_at: 10 }), { nowSec: () => 10 }),
    PowExpiredError,
  );
});

test("solvePowChallenge is abortable before and during work", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    solvePowChallenge(challenge(), { signal: before.signal }),
    PowAbortedError,
  );

  const during = new AbortController();
  let calls = 0;
  await assert.rejects(
    solvePowChallenge(challenge({ bits: 20 }), {
      signal: during.signal,
      batchSize: 2,
      maxAttempts: 10,
      hash: async () => {
        calls += 1;
        if (calls === 2) during.abort();
        return Uint8Array.from([0xff]);
      },
    }),
    PowAbortedError,
  );
});

test("solvePowChallenge expires between batches and has a bounded attempt ceiling", async () => {
  let clock = 100;
  await assert.rejects(
    solvePowChallenge({ salt: "0123456789abcdef", bits: 20, expires_at: 102 }, {
      nowSec: () => clock++,
      batchSize: 1,
      maxAttempts: 10,
      hash: async () => Uint8Array.from([0xff]),
    }),
    PowExpiredError,
  );

  await assert.rejects(
    solvePowChallenge(challenge({ bits: 20 }), {
      batchSize: 2,
      maxAttempts: 4,
      hash: async () => Uint8Array.from([0xff]),
    }),
    (error: unknown) => error instanceof PowExhaustedError && /4 attempts/.test(error.message),
  );
});
