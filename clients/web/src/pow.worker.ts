// clients/web/src/pow.worker.ts — solve the T-121 registration proof-of-work off the main thread.
// At production difficulty (bits=20) a solve is ~1M sha256 attempts; even with the solver's
// cooperative yields that would occupy the UI thread for seconds, so the proposal (acceptance №2)
// requires the solver to run ONLY in a Worker in production. This worker takes one challenge per
// message, streams attempt-counter progress back, and posts a final result/error. Cancellation is
// worker termination from the shell (pow_runner.ts) — no in-band cancel message is needed.
// build.mjs bundles this entry into its own hashed /assets chunk and injects the URL into the app
// (esbuild `define` → __GC_POW_WORKER_URL__), exactly like tg_import.worker.ts (T-417). Unlike that
// worker we import pow_solver.ts DIRECTLY (not the whole core index): the solver is self-contained,
// which keeps this lazy chunk ~1 KB instead of dragging the full SDK closure in.
import { solvePowChallenge, type PowChallenge } from "../../core/src/pow_solver.ts";

export interface PowWorkerRequest {
  challenge: PowChallenge;
}
export type PowWorkerResponse =
  | { kind: "progress"; attempts: number }
  | { kind: "result"; pow_salt: string; pow_nonce: string; attempts: number }
  // `name` is the pow_solver error class name (PowExpiredError/…): Error instances do not
  // structured-clone with their class, so the runner re-creates a named error from these fields.
  | { kind: "error"; name: string; message: string };

// Both the DOM and WebWorker libs are on, so `self` has a merged type; narrow to just what we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PowWorkerRequest>) => void) | null;
  postMessage(message: PowWorkerResponse): void;
};

ctx.onmessage = (e: MessageEvent<PowWorkerRequest>): void => {
  void (async () => {
    try {
      const solution = await solvePowChallenge(e.data.challenge, {
        // Report every yielded batch so the shell can render a live progress counter. The solver
        // already yields cooperatively; inside a dedicated worker that just keeps message delivery
        // (i.e. nothing — termination kills us regardless) responsive without slowing the search.
        onProgress: (attempts) => ctx.postMessage({ kind: "progress", attempts }),
      });
      ctx.postMessage({ kind: "result", ...solution });
    } catch (err) {
      const name = err instanceof Error && err.name ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      ctx.postMessage({ kind: "error", name, message });
    }
  })();
};
