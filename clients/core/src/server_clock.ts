// T-125: server-corrected client clock. The offset is measured against the midpoint of the config
// request, which removes most round-trip latency bias. Consumers inject nowSec() into relative labels,
// mute/edit/TTL timers and diagnostics instead of trusting the device wall clock directly.
export class ServerClock {
  private offset = 0;
  private readonly localNowMs: () => number;

  constructor(localNowMs: () => number = () => Date.now()) {
    this.localNowMs = localNowMs;
  }

  update(serverTimeSec: number, requestStartedMs: number, responseReceivedMs: number): void {
    if (!Number.isFinite(serverTimeSec) || !Number.isFinite(requestStartedMs) || !Number.isFinite(responseReceivedMs)) return;
    if (responseReceivedMs < requestStartedMs) return;
    const midpointSec = (requestStartedMs + responseReceivedMs) / 2000;
    this.offset = serverTimeSec - midpointSec;
  }

  offsetSec(): number {
    return this.offset;
  }

  nowSec(): number {
    return this.localNowMs() / 1000 + this.offset;
  }
}
