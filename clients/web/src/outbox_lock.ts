import type { OutboxExclusive } from "../../core/src/outbox.ts";

/**
 * Browser-wide per-item lease for the durable outbox.
 *
 * Web Locks is scoped to the origin and automatically releases a lock when a tab closes or crashes.
 * Holding the lock through the network request means a second tab waits, then re-reads the row after
 * the first tab either deleted it or left an ambiguous `sending` item for safe idempotent replay.
 */
export function browserOutboxExclusive(): OutboxExclusive {
  const manager = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!manager) return async (_key, task) => task();

  return async (key, task) => {
    await manager.request(key, { mode: "exclusive" }, async () => {
      await task();
    });
  };
}
