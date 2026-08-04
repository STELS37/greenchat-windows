// clients/ui/src/screens/import_model.ts — the Telegram-import state machine (T-417, «переезд»).
// DOM-free and core-free (like every screen model): it drives an import through injected ports and
// exposes an observable state the screen renders. The heavy lifting — parsing result.json and streaming
// ≤ 500-message batches with media-upload dedup — lives in clients/core (parseTelegramExport /
// runTelegramImport, both unit-tested there); this model owns only the idle→parsing→running→done/error
// progression and the localisation-ready progress numbers. The web shell wires `parse` to a Web Worker
// and `drive` to the core driver over an ApiClient + FileUploader; a test passes fakes.

// What the screen reads bytes from — a chosen folder or an opened .zip, both built by the shell.
export interface ImportSource {
  // The export manifest (result.json) as text.
  readManifest(): Promise<string>;
  // A referenced media file's bytes + name + mime, or null when it is absent from a partial export.
  readMedia(path: string): Promise<{ bytes: Uint8Array; name: string; mime: string } | null>;
}

// The shell's parse step returns an opaque handle (the core `TgParsed`) plus the counts the UI shows.
// The model never inspects `parsed` — it only threads it back into `drive`.
export interface ImportParseResult {
  parsed: unknown;
  title: string;
  messageCount: number;
  mediaCount: number;
}

// Progress from the driver: uploading media, or sending message batches (with the running summary).
export interface ImportDriveProgress {
  phase: "media" | "sending";
  done: number;
  total: number;
  summary: string | null;
}

// The driver's terminal result, mapped from the server's response.
export interface ImportSummary {
  chatId: number;
  messageCount: number;
  fileCount: number;
  summary: string; // «N сообщений, M файлов»
}

export interface ImportPorts {
  // Parse the export text (a Web Worker in the app; a direct call in tests).
  parse(text: string): Promise<ImportParseResult>;
  // Upload media then POST the conversation in batches, reporting progress. Returns the final summary.
  drive(
    parsed: unknown,
    source: ImportSource,
    importId: string,
    onProgress: (p: ImportDriveProgress) => void,
    signal: AbortSignal,
  ): Promise<ImportSummary>;
  // A fresh, server-legal import_id (matches /^[A-Za-z0-9_-]{1,128}$/) tying this import's batches.
  newImportId(): string;
}

export type ImportState =
  | { status: "idle" }
  | { status: "parsing" }
  | {
      status: "running";
      phase: "media" | "sending";
      done: number;
      total: number;
      title: string;
      messageCount: number;
      mediaCount: number;
      summary: string | null;
    }
  | { status: "done"; chatId: number; summary: string }
  | { status: "error"; message: string };

export interface ImportModel {
  getState(): ImportState;
  subscribe(listener: (s: ImportState) => void): () => void;
  // Run one import from a chosen source. Ignored while another is in flight. Never rejects — failures
  // land in the "error" state so the screen can show them.
  run(source: ImportSource): Promise<void>;
  // Return to idle after a done/error run, so the user can import another export.
  reset(): void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "import failed";
}

export function createImportModel(ports: ImportPorts): ImportModel {
  let state: ImportState = { status: "idle" };
  const listeners = new Set<(s: ImportState) => void>();
  let generation = 0;
  let active: AbortController | null = null;

  const set = (next: ImportState): void => {
    state = next;
    for (const l of [...listeners]) l(state);
  };

  const isCurrent = (mine: number, controller: AbortController): boolean =>
    generation === mine && active === controller && !controller.signal.aborted;

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async run(source) {
      if (state.status === "parsing" || state.status === "running") return; // single-flight per generation
      const mine = ++generation;
      const controller = new AbortController();
      active?.abort();
      active = controller;
      set({ status: "parsing" });
      try {
        const text = await source.readManifest();
        if (!isCurrent(mine, controller)) return;
        const info = await ports.parse(text);
        if (!isCurrent(mine, controller)) return;
        set({
          status: "running",
          phase: "media",
          done: 0,
          total: info.mediaCount,
          title: info.title,
          messageCount: info.messageCount,
          mediaCount: info.mediaCount,
          summary: null,
        });
        const importId = ports.newImportId();
        const result = await ports.drive(info.parsed, source, importId, (p) => {
          if (!isCurrent(mine, controller) || state.status !== "running") return;
          set({
            status: "running",
            phase: p.phase,
            done: p.done,
            total: p.total,
            title: info.title,
            messageCount: info.messageCount,
            mediaCount: info.mediaCount,
            summary: p.summary,
          });
        }, controller.signal);
        if (!isCurrent(mine, controller)) return;
        set({ status: "done", chatId: result.chatId, summary: result.summary });
      } catch (err) {
        if (!isCurrent(mine, controller)) return;
        set({ status: "error", message: errorMessage(err) });
      } finally {
        if (active === controller) active = null;
      }
    },
    reset() {
      generation += 1;
      active?.abort();
      active = null;
      set({ status: "idle" });
    },
  };
}
