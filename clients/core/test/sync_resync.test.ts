// T-402 — deterministic resync + header coverage via a tiny node:http stub (0 deps). A real
// retention purge (which is what makes the live server answer resync:true) is unreachable over HTTP
// on a fresh server, so we drive the SyncEngine long-poll path against a stub that answers
// {events:[], next_since, resync:true} once. A fake WebSocket that never opens keeps the engine in
// long-poll mode (the plan's "offline -> long-poll" branch).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { ApiClient } from "../src/api.ts";
import { SyncEngine } from "../src/sync.ts";
import { waitFor } from "./server-harness.ts";

// A WebSocket that never fires any event -> WsClient stays in "connecting" and the engine long-polls.
class SilentWebSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 0; // CONNECTING, forever
  constructor(_url: string) {
    /* deliberately inert */
  }
  send(_data: string): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}

interface StubState {
  server: http.Server;
  base: string;
  updateCalls: number;
  lastClientHeader: string | null;
}

function startStub(): Promise<StubState> {
  const state: StubState = { server: null as unknown as http.Server, base: "", updateCalls: 0, lastClientHeader: null };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/v1/updates")) {
      state.updateCalls++;
      state.lastClientHeader = (req.headers["x-gc-client"] as string) ?? null;
      res.setHeader("content-type", "application/json");
      if (state.updateCalls === 1) {
        // First poll: cursor is behind the retention window -> full resync, jump to head 42.
        res.end(JSON.stringify({ ok: true, result: { events: [], next_since: 42, resync: true } }));
      } else {
        // Subsequent polls behave like a real long-poll: hold briefly, then an empty batch.
        setTimeout(() => {
          res.end(JSON.stringify({ ok: true, result: { events: [], next_since: 42 } }));
        }, 200);
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "no" } }));
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      state.base = `http://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

test("SyncEngine: resync:true jumps the cursor to the server head and fires onResync", async () => {
  const stub = await startStub();
  let engine: SyncEngine | null = null;
  try {
    const api = new ApiClient({
      baseUrl: stub.base,
      clientId: "node/0.1.0",
      tokens: { access: "dummy", refresh: null, accessExpiresAt: null },
    });
    let resyncs = 0;
    engine = new SyncEngine({
      api,
      baseUrl: stub.base,
      onEvent: () => {
        /* no durable events in this scenario */
      },
      onResync: () => {
        resyncs++;
      },
      wsImpl: SilentWebSocket as unknown as typeof WebSocket,
      longPollTimeoutSec: 1,
    });
    engine.start();

    await waitFor(() => resyncs >= 1 && engine!.getCursor() === 42);
    assert.equal(engine.getCursor(), 42, "cursor jumped to the server head");
    assert.ok(resyncs >= 1, "onResync fired");
    assert.equal(stub.lastClientHeader, "node/0.1.0", "X-GC-Client header sent on every request");
  } finally {
    if (engine) engine.stop();
    await new Promise<void>((r) => stub.server.close(() => r()));
  }
});
