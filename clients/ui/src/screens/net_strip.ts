// Quiet, Telegram-style connection status for the authenticated shell.
//
// The transport has two independent delivery paths: WebSocket and durable long-poll. A WebSocket
// reconnect is therefore not automatically a user-visible outage, and mobile radios routinely emit
// sub-second online/offline transitions while switching cell/Wi-Fi or waking the WebView. The shell
// only says anything when the aggregate delivery path has remained unavailable continuously for the
// grace period below. Recovery hides the status immediately; routine reconnects never produce a
// success banner.

import { el } from "../dom.ts";
import type { I18n } from "../i18n.ts";

export type NetLevel = "online" | "reconnecting" | "offline";
export type NetPhase = "hidden" | "connecting";

// Long enough to absorb ordinary mobile hand-offs and WebView wake-up races, short enough to explain
// a real outage before the user starts troubleshooting. The delay applies to BOTH navigator offline
// and aggregate transport failure; neither signal may flash a global warning by itself.
export const CONNECTION_NOTICE_DELAY_MS = 5_000;

export interface NetSample {
  online: boolean;
  ws: string;
  delivery?: string;
}

// navigator.onLine=false is a useful degraded signal, but not an instruction to interrupt the UI at
// once. Timing belongs to netPhase(). A working long-poll fallback means messaging remains connected
// even if the realtime socket is being rebuilt.
export function netLevel(sample: NetSample): NetLevel {
  if (!sample.online) return "offline";
  if (sample.ws === "open" || sample.delivery === "fallback") return "online";
  return "reconnecting";
}

export interface PhaseInput {
  level: NetLevel;
  // Continuous time in the aggregate degraded family. A transition offline → reconnecting does not
  // reset this clock because delivery has not recovered in between.
  heldMs: number;
}

export function netPhase(input: PhaseInput): NetPhase {
  if (input.level === "online") return "hidden";
  return input.heldMs >= CONNECTION_NOTICE_DELAY_MS ? "connecting" : "hidden";
}

export function netPhaseText(phase: NetPhase, i18n: I18n): string | null {
  return phase === "connecting" ? i18n.t("net.reconnecting") : null;
}

export interface NetStripDeps {
  i18n: I18n;
  sample(): NetSample;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  intervalMs?: number;
}

export interface NetStrip {
  root: HTMLElement;
  refresh(): void;
  phase(): NetPhase;
  destroy(): void;
}

export function createNetStrip(deps: NetStripDeps): NetStrip {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const label = el("span", { class: "gc-net-strip-label" });
  const root = el("div", {
    class: "gc-net-strip",
    "data-phase": "hidden",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": true,
  }, [label]);
  root.hidden = true;

  let level: NetLevel = "online";
  let degradedSince: number | null = null;
  let phase: NetPhase = "hidden";

  const render = (): void => {
    const at = now();
    const nextLevel = netLevel(deps.sample());
    const wasDegraded = level !== "online";
    const isDegraded = nextLevel !== "online";

    if (!wasDegraded && isDegraded) degradedSince = at;
    if (wasDegraded && !isDegraded) degradedSince = null;
    level = nextLevel;

    const heldMs = isDegraded && degradedSince !== null ? at - degradedSince : 0;
    const nextPhase = netPhase({ level, heldMs });
    if (nextPhase === phase) return;

    phase = nextPhase;
    const text = netPhaseText(phase, deps.i18n);
    root.setAttribute("data-phase", phase);
    if (text === null) {
      root.hidden = true;
      label.textContent = "";
      return;
    }
    label.textContent = text;
    root.hidden = false;
  };

  render();
  const handle = schedule(render, deps.intervalMs ?? 1_000);

  return {
    root,
    refresh: render,
    phase: () => phase,
    destroy() { cancel(handle); },
  };
}
