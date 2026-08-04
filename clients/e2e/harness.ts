import { basename, dirname, resolve } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

const OWNED_PREFIX = "green-chat-e2e-";

/** Remove only this Playwright run's throwaway state; never sweep sibling runs. */
export function cleanupE2eDir(dataDir: string | undefined, tempRoot = tmpdir()): boolean {
  if (!dataDir) return false;
  const root = resolve(tempRoot);
  const target = resolve(dataDir);
  if (dirname(target) !== root || !basename(target).startsWith(OWNED_PREFIX)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

// Playwright kills the managed webServer. We own only the exact GC_E2E_DATA_DIR exported by this run.
// Deleting every similarly named temp directory is forbidden: independent CI/lane runs may be live.
export default async function globalTeardown(): Promise<void> {
  cleanupE2eDir(process.env.GC_E2E_DATA_DIR);
  // T-461: the run also owns a throwaway web bundle directory (never clients/web/dist).
  cleanupE2eDir(process.env.GC_E2E_WEB_DIST);
}
