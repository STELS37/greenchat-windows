// clients/web/src/tg_import.worker.ts — parse a Telegram export off the main thread (T-417).
// A real export's result.json is megabytes of JSON; JSON.parse + normalisation on the UI thread would
// jank the whole app. This dedicated worker does both and posts back the normalised TgParsed (or an
// error string). Media upload + batch sending stay on the main thread (they need the ApiClient/session).
// build.mjs bundles this entry into its own hashed /assets chunk and injects that URL into the app
// (esbuild `define` → __GC_WORKER_URL__); the shell constructs `new Worker(url, {type:"module"})` and
// falls back to a main-thread parse if a worker cannot be constructed.
import { parseTelegramExport } from "../../core/src/index.ts";

export interface TgWorkerRequest {
  text: string;
}
export type TgWorkerResponse =
  | { ok: true; parsed: ReturnType<typeof parseTelegramExport> }
  | { ok: false; error: string };

// Both the DOM and WebWorker libs are on, so `self` has a merged type; narrow to just what we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<TgWorkerRequest>) => void) | null;
  postMessage(message: TgWorkerResponse): void;
};

ctx.onmessage = (e: MessageEvent<TgWorkerRequest>): void => {
  try {
    const parsed = parseTelegramExport(JSON.parse(e.data.text));
    ctx.postMessage({ ok: true, parsed });
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
