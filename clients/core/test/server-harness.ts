// clients/core test harness (T-402): boots the REAL compiled Green Chat server as a child process
// against a throwaway data dir on a free port, then tears it down (SIGTERM -> graceful path). This
// is the "live local server" the plan requires the core SDK to be tested against. Not a *.test.ts
// file, so the node --test glob does not run it directly.
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// clients/core/test -> repo/server/dist/index.js
const SERVER_ENTRY = path.resolve(HERE, "../../../server/dist/index.js");

export interface LiveServer {
  base: string; // http://127.0.0.1:<port>
  port: number;
  dataDir: string;
  logPath: string;
  teardown: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(base: string, proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy in time");
}

export async function startLiveServer(env: Record<string, string> = {}): Promise<LiveServer> {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `compiled server not found at ${SERVER_ENTRY} — run \`npm --prefix ../server run build\` first`,
    );
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-core-"));
  const logPath = path.join(dataDir, "server.log");
  const logFd = fs.openSync(logPath, "a");

  let port = 0;
  let base = "";
  let proc!: ChildProcess;
  const MAX_BOOT = 6;
  for (let attempt = 1; attempt <= MAX_BOOT; attempt++) {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER_ENTRY], {
      env: {
        ...process.env,
        GC_PORT: String(port),
        GC_HOST: "127.0.0.1",
        GC_DATA_DIR: dataDir,
        GC_RATELIMIT_DISABLE: "1",
        ...env,
      },
      stdio: ["ignore", logFd, logFd],
    });
    try {
      await waitHealthy(base, proc);
      break;
    } catch (err) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (attempt === MAX_BOOT) {
        fs.closeSync(logFd);
        throw err;
      }
    }
  }

  async function teardown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const done = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      proc.kill("SIGTERM");
    });
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { base, port, dataDir, logPath, teardown };
}

// A blank in-memory token store for constructing an ApiClient before login.
export function emptyTokens(): { access: string | null; refresh: string | null; accessExpiresAt: number | null } {
  return { access: null, refresh: null, accessExpiresAt: null };
}

// Deterministic wait helper for event-driven assertions.
export function waitFor(pred: () => boolean, timeoutMs = 4000, stepMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}
