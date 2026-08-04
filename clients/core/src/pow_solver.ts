// Client-side proof-of-work solver for the optional GC_POW registration gate.
//
// The server challenge contract is GET /v1/auth/pow -> {salt,bits,expires_at} and the
// solution is sha256(`${salt}:${nonce}`) with at least `bits` leading zero bits. This
// module is transport/UI agnostic so web/mobile/desktop shells can run it inside a
// worker and attach {pow_salt,pow_nonce} only when the server asks for POW_REQUIRED.

export interface PowChallenge {
  salt: string;
  bits: number;
  expires_at: number;
}

export interface PowSolution {
  pow_salt: string;
  pow_nonce: string;
  attempts: number;
}

export type PowHash = (input: Uint8Array) => Promise<Uint8Array>;

export interface SolvePowOptions {
  signal?: AbortSignal;
  nowSec?: () => number;
  hash?: PowHash;
  batchSize?: number;
  maxAttempts?: number;
  yieldEveryBatches?: number;
  onProgress?: (attempts: number) => void;
}

export class PowChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowChallengeError";
  }
}

export class PowExpiredError extends Error {
  constructor() {
    super("proof-of-work challenge expired");
    this.name = "PowExpiredError";
  }
}

export class PowAbortedError extends Error {
  constructor() {
    super("proof-of-work solving aborted");
    this.name = "PowAbortedError";
  }
}

export class PowExhaustedError extends Error {
  constructor(attempts: number) {
    super(`proof-of-work solution not found in ${attempts} attempts`);
    this.name = "PowExhaustedError";
  }
}

const encoder = new TextEncoder();

export function leadingZeroBits(bytes: Uint8Array): number {
  let total = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    total += Math.clz32(byte) - 24;
    break;
  }
  return total;
}

function validateChallenge(challenge: PowChallenge, nowSec: () => number): void {
  if (!/^[0-9a-f]{16}$/.test(challenge.salt)) {
    throw new PowChallengeError("proof-of-work salt must be 16 lowercase hex characters");
  }
  if (!Number.isInteger(challenge.bits) || challenge.bits < 1 || challenge.bits > 30) {
    throw new PowChallengeError("proof-of-work difficulty must be an integer in 1..30 bits");
  }
  if (!Number.isInteger(challenge.expires_at) || challenge.expires_at <= nowSec()) {
    throw new PowExpiredError();
  }
}

async function defaultHash(input: Uint8Array): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer: TS's BufferSource overload deliberately rejects a
  // Uint8Array backed by a possible SharedArrayBuffer.
  const data = new ArrayBuffer(input.byteLength);
  new Uint8Array(data).set(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PowAbortedError();
}

function taskYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function solvePowChallenge(
  challenge: PowChallenge,
  options: SolvePowOptions = {},
): Promise<PowSolution> {
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const hash = options.hash ?? defaultHash;
  const batchSize = options.batchSize ?? 128;
  const maxAttempts = options.maxAttempts ?? 20_000_000;
  const yieldEveryBatches = options.yieldEveryBatches ?? 8;

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024) {
    throw new PowChallengeError("batchSize must be an integer in 1..1024");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new PowChallengeError("maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(yieldEveryBatches) || yieldEveryBatches < 1) {
    throw new PowChallengeError("yieldEveryBatches must be a positive integer");
  }

  validateChallenge(challenge, nowSec);
  abortIfNeeded(options.signal);

  let attempts = 0;
  let batchNo = 0;
  while (attempts < maxAttempts) {
    abortIfNeeded(options.signal);
    if (challenge.expires_at <= nowSec()) throw new PowExpiredError();

    const count = Math.min(batchSize, maxAttempts - attempts);
    const nonces = Array.from({ length: count }, (_, index) => (attempts + index).toString(36));
    const digests = await Promise.all(
      nonces.map((nonce) => hash(encoder.encode(`${challenge.salt}:${nonce}`))),
    );

    for (let index = 0; index < digests.length; index += 1) {
      const completed = attempts + index + 1;
      if (leadingZeroBits(digests[index]!) >= challenge.bits) {
        options.onProgress?.(completed);
        return {
          pow_salt: challenge.salt,
          pow_nonce: nonces[index]!,
          attempts: completed,
        };
      }
    }

    attempts += count;
    batchNo += 1;
    options.onProgress?.(attempts);
    if (batchNo % yieldEveryBatches === 0) await taskYield();
  }

  throw new PowExhaustedError(attempts);
}
