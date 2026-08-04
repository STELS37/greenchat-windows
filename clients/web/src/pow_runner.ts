// clients/web/src/pow_runner.ts — the web shell's PowRunner: run the T-121 solver in a dedicated
// Web Worker (pow.worker.ts) so a bits=20 solve never occupies the UI thread (proposal acceptance
// №2: in production the solver runs ONLY in the Worker). build.mjs bundles the worker as its own
// hashed chunk and injects its URL via esbuild `define` (__GC_POW_WORKER_URL__ — same pattern as
// T-417's tg_import worker). Fallback ladder, in order:
//   • no injected URL (tsc/dev, a build without the chunk) → main-thread solvePowChallenge;
//   • `new Worker(url)` throws (CSP, exotic browser) → main-thread solvePowChallenge.
// The main-thread path is a FALLBACK ONLY: the solver yields to the event loop every few batches
// (yieldEveryBatches), so even there the UI stays responsive, just less smooth than off-thread.
// Cancellation: an abort terminates the worker (a terminated solve costs nothing server-side —
// the challenge simply goes unused) and rejects with a PowAbortedError-shaped error, matching the
// pow_gate contract that matches solver errors by `.name`.
import {
  solvePowChallenge,
  PowAbortedError,
  type PowRunner,
  type PowSolution,
} from "../../core/src/index.ts";
import type { PowWorkerRequest, PowWorkerResponse } from "./pow.worker.ts";

// Injected by build.mjs (`define`), absent under plain tsc — hence the typeof probe.
declare const __GC_POW_WORKER_URL__: string;

function powWorkerUrl(): string | null {
  return typeof __GC_POW_WORKER_URL__ === "string" && __GC_POW_WORKER_URL__.length > 0
    ? __GC_POW_WORKER_URL__
    : null;
}

// Re-create a typed error from the worker's {name, message} wire shape (classes don't survive
// structured clone). pow_gate and callers match by `.name`, so a named Error is equivalent.
function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

// The Worker-backed runner for one solve. Exported as the value main.ts hands to Session.
export const webPowRunner: PowRunner = (challenge, opts) => {
  const url = powWorkerUrl();
  if (url === null) return solveOnMainThread(challenge, opts);

  let worker: Worker;
  try {
    worker = new Worker(url, { type: "module" });
  } catch {
    return solveOnMainThread(challenge, opts);
  }

  return new Promise<PowSolution>((resolve, reject) => {
    let done = false;
    const onAbort = (): void => finish(() => reject(new PowAbortedError()));
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      opts.signal?.removeEventListener("abort", onAbort);
      try { worker.terminate(); } catch { /* already gone */ }
      settle();
    };
    if (opts.signal?.aborted) {
      finish(() => reject(new PowAbortedError()));
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (ev: MessageEvent<PowWorkerResponse>): void => {
      const msg = ev.data;
      if (msg.kind === "progress") {
        if (!done) opts.onProgress?.(msg.attempts);
        return;
      }
      if (msg.kind === "result") {
        finish(() => resolve({ pow_salt: msg.pow_salt, pow_nonce: msg.pow_nonce, attempts: msg.attempts }));
        return;
      }
      finish(() => reject(namedError(msg.name, msg.message)));
    };
    worker.onerror = (ev: ErrorEvent): void => {
      finish(() => reject(new Error(ev.message || "pow worker error")));
    };

    const req: PowWorkerRequest = { challenge };
    worker.postMessage(req);
  });
};

// Fallback: solve inline. The solver's cooperative yield (default: every 8 batches of 128 hashes)
// keeps the event loop breathing; a gentler batch size trims per-slice jank further on slow devices.
function solveOnMainThread(
  challenge: Parameters<PowRunner>[0],
  opts: Parameters<PowRunner>[1],
): Promise<PowSolution> {
  return solvePowChallenge(challenge, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    batchSize: 64,
    yieldEveryBatches: 2,
  });
}
