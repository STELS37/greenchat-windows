// clients/core/src/pow_gate.ts — T-121 wiring: the POW_REQUIRED retry gate around an auth request.
//
// Server contract (server/src/core/pow.ts): when GC_POW=1, POST /v1/auth/register and
// POST /v1/auth/qr/start demand a solved challenge. The client learns of the demand from a
// 400 POW_REQUIRED, fetches GET /v1/auth/pow → {salt,bits,expires_at}, solves it (pow_solver.ts)
// and retries the ORIGINAL request once carrying {pow_salt, pow_nonce}. A salt is single-use
// (spent for 10 min) and a challenge is solvable for 5 min, so a stale/reused/wrong solution
// comes back as 400 POW_INVALID.
//
// This gate is transport- and UI-agnostic: it takes the request and the challenge fetch as plain
// async closures, and the solver as an injectable `runner` (a web shell passes a Web Worker runner;
// the default is the in-process solvePowChallenge, so Node unit tests and non-worker shells work
// with zero DOM dependencies). Retry discipline (proposal client-pow-open-registration.md):
//   • no PoW demanded → exactly ONE request, ZERO challenge fetches (the flag-off path is unchanged);
//   • POW_REQUIRED → exactly ONE challenge fetch, solve, retry the original request exactly ONCE;
//   • POW_INVALID on that retry (or the challenge expiring mid-solve) → ONE more fresh challenge,
//     then the error surfaces as-is — never an unbounded loop;
//   • the AbortSignal is threaded through every step; an abort surfaces as PowAbortedError and NO
//     further request is made.
import {
  PowAbortedError,
  solvePowChallenge,
  type PowChallenge,
  type PowSolution,
} from "./pow_solver.ts";

export type { PowChallenge, PowSolution } from "./pow_solver.ts";

// The wire fields the retried request must carry (server assertPow reads exactly these two).
export interface PowWire {
  pow_salt: string;
  pow_nonce: string;
}

export interface PowRunnerOptions {
  signal?: AbortSignal;
  onProgress?: (attempts: number) => void;
}

// A pluggable solver executor: the web shell supplies a Web Worker implementation (pow_runner.ts);
// the default runs solvePowChallenge in-process. MUST reject with the pow_solver error classes
// (matched by `.name`, so a worker boundary that re-creates them is fine).
export type PowRunner = (challenge: PowChallenge, opts: PowRunnerOptions) => Promise<PowSolution>;

export interface PowGateOptions {
  // GET /v1/auth/pow → {salt,bits,expires_at}. Called ONLY after a POW_REQUIRED verdict.
  fetchChallenge: () => Promise<PowChallenge>;
  // Solver executor; default = direct in-process solvePowChallenge.
  runner?: PowRunner;
  // Cooperative cancellation (screen unmount): abort ⇒ PowAbortedError, no further requests.
  signal?: AbortSignal;
  // Attempt counter for a progress UI; forwarded to the runner.
  onProgress?: (attempts: number) => void;
}

// Total challenges fetched per gated call is bounded: 1 for the normal POW_REQUIRED round + 1 more
// after a POW_INVALID/expiry, then the failure surfaces. The guarded request runs at most 3 times
// (bare + one retry per challenge).
const MAX_CHALLENGES = 2;

// The server's PoW verdicts arrive as ApiError-shaped objects carrying a stable `.code`
// (clients/core/src/errors.ts). Matched structurally — not instanceof — so ui-layer fakes and
// any ApiLike transport satisfy the contract.
function powCodeOf(err: unknown): "POW_REQUIRED" | "POW_INVALID" | null {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "POW_REQUIRED" || code === "POW_INVALID" ? code : null;
}

// Solver-side errors are matched by `.name` (stable across the worker boundary, where the runner
// re-creates the class rather than structured-cloning it).
function errName(err: unknown): string | null {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

// Execute `exec` (one call = one HTTP round-trip of the ORIGINAL auth request; `pow` present ⇒ the
// body must carry {pow_salt, pow_nonce}) behind the PoW retry gate. Resolves with the request's
// result; rejects with the original error when it is not a PoW demand, with PowAbortedError on
// cancellation, or with the final POW_INVALID/solver error once the bounded retries are spent.
export async function executeWithPow<T>(
  exec: (pow?: PowWire) => Promise<T>,
  opts: PowGateOptions,
): Promise<T> {
  const runner: PowRunner = opts.runner ?? ((challenge, ro) => solvePowChallenge(challenge, ro));
  const runnerOpts: PowRunnerOptions = {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  };

  // Run one step under the abort contract: an abort observed before/during the step surfaces as
  // PowAbortedError (never a half-classified transport error), and no later step runs.
  const guarded = async <R>(step: () => Promise<R>): Promise<R> => {
    if (opts.signal?.aborted) throw new PowAbortedError();
    try {
      return await step();
    } catch (err) {
      if (opts.signal?.aborted) throw new PowAbortedError();
      throw err;
    }
  };

  // 1. The bare request. When PoW is off (features.pow=false) this is the ONLY round-trip and the
  //    challenge endpoint is never touched — the flag-off path stays byte-identical.
  try {
    return await guarded(() => exec());
  } catch (err) {
    if (powCodeOf(err) !== "POW_REQUIRED") throw err;
  }

  // 2. Bounded challenge rounds. `continue` is only reachable while round < MAX_CHALLENGES, so the
  //    loop runs at most MAX_CHALLENGES times — there is no unbounded retry cycle.
  for (let round = 1; ; round++) {
    const challenge = await guarded(() => opts.fetchChallenge());

    let solution: PowSolution;
    try {
      solution = await guarded(() => runner(challenge, runnerOpts));
    } catch (err) {
      // The challenge expired mid-solve (slow device, tab in background): worth ONE fresh
      // challenge. Every other solver failure (aborted/exhausted/malformed) surfaces as-is.
      if (errName(err) === "PowExpiredError" && round < MAX_CHALLENGES) continue;
      throw err;
    }

    try {
      return await guarded(() => exec({ pow_salt: solution.pow_salt, pow_nonce: solution.pow_nonce }));
    } catch (err) {
      // POW_INVALID (expired/spent salt — e.g. the request raced the TTL) or an anomalous repeat
      // POW_REQUIRED: ONE fresh challenge, then give up and surface the server's verdict.
      if (powCodeOf(err) !== null && round < MAX_CHALLENGES) continue;
      throw err;
    }
  }
}
