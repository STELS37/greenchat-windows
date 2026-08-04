// V124 — a message that failed while the phone was offline must not need a manual tap once the
// network is back.
//
// Measured first, on the installed signed artifact (var/ux-audit/v124-offline/report.json,
// versionCode 1000013): with the link cut the bubble walked queued → sending → failed in ~6 s and
// offered «Повторить» — honest. Then the link returned, the strip said «Соединение восстановлено»,
// and 20 s later the bubble was still ⚠: nothing re-drove the queue. `flush()` existed for exactly
// this ("right after the socket reconnects") and had zero call sites.
//
// retryFailed() is the narrow wire for it. These tests pin the three properties that make it safe to
// call from the `online` event: it re-sends what failed, it does NOT cut short an undo window, and it
// stays silent while the app lock has the Outbox paused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api.ts";
import { MemoryStore } from "../src/store.ts";
import { Outbox, type OutboxChange } from "../src/outbox.ts";

// A link that can be cut and restored, counting every attempt that reached "the wire".
function linkApi(state: { offline: boolean; calls: number }): ApiClient {
  return new ApiClient({
    baseUrl: "http://retryfailed.test",
    clientId: "node/0.1.0",
    tokens: { access: "a", refresh: "r", accessExpiresAt: null },
    maxRetries: 0,
    fetchImpl: (async () => {
      state.calls += 1;
      if (state.offline) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ ok: true, result: { id: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("V124: retryFailed() re-sends a message that failed offline, with no user tap", async () => {
  const link = { offline: true, calls: 0 };
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api: linkApi(link), store: new MemoryStore(), undoMs: 0, onChange: (c) => changes.push(c) });

  await ob.enqueueMessage(41, { client_msg_id: "cm-1", text: "written on the metro" });
  await waitFor(() => changes.some((c) => c.item.status === "failed"));
  assert.equal((await ob.list()).length, 1, "the failed message is still in the queue, not dropped");

  link.offline = false;
  const restarted = await ob.retryFailed();
  assert.equal(restarted, 1, "one failed item was re-driven");
  await waitFor(() => changes.some((c) => c.removed === true && c.item.status === "sent"));
  assert.deepEqual(await ob.list(), [], "queue is empty once the re-send lands");
});

test("V124: retryFailed() does not cut an undo window short — flush() is what does that", async () => {
  const link = { offline: false, calls: 0 };
  const ob = new Outbox({ api: linkApi(link), store: new MemoryStore(), undoMs: 60_000 });

  await ob.enqueueMessage(41, { client_msg_id: "cm-2", text: "still regrettable" });
  const restarted = await ob.retryFailed();
  assert.equal(restarted, 0, "a queued item is not a failed item");
  assert.equal(link.calls, 0, "the user's 5 s to change their mind survived the reconnect");

  await ob.flush();
  await waitFor(() => link.calls > 0);
});

test("V124: retryFailed() stays silent while the app lock has the Outbox paused", async () => {
  const link = { offline: true, calls: 0 };
  const changes: OutboxChange[] = [];
  const ob = new Outbox({ api: linkApi(link), store: new MemoryStore(), undoMs: 0, onChange: (c) => changes.push(c) });

  await ob.enqueueMessage(41, { client_msg_id: "cm-3", text: "queued before the lock" });
  await waitFor(() => changes.some((c) => c.item.status === "failed"));
  const before = link.calls;

  ob.pause();
  link.offline = false;
  assert.equal(await ob.retryFailed(), 0, "a paused Outbox re-drives nothing");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(link.calls, before, "and nothing reached the wire behind the lock");
});
