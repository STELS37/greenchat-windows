// clients/ui/src/screens/support_status.ts — T-514 (MS-4 §3.1.3 / §14): the service-status model behind
// the "Состояние сервиса" card in Settings → Help. Pure/DOM-free and, crucially, NO new server endpoint:
// the web shell probes the PUBLIC GET /health (parseHealth here unwraps the server's {ok,result} envelope;
// it is fetched raw + injected as health() rather than through the ApiClient, so a signed-out / connecting
// client can still probe), reads the live realtime link from SyncEngine.getWsState(), navigator.onLine, and
// the offline support-queue length. This module maps those four inputs to a traffic-light level + localized
// lines; the DOM card + refresh loop live in support_help.ts.
import type { I18n } from "../i18n.ts";

// The subset of GET /health (server: index.ts) we read. Only `status` drives the light; uptime is shown
// when present. `status: "up"` is the healthy marker the server emits.
export interface HealthInfo {
  status: string;
  uptime_sec?: number | undefined;
}

// Parse the PUBLIC GET /health body into HealthInfo. The server router wraps EVERY handler return in the
// {ok,result} envelope, so /health answers {ok:true,result:{status,uptime_sec,…}} — unwrap `result`. Also
// accept a BARE {status,…} object, so a self-hoster/reverse-proxy that serves /health unwrapped keeps
// working. Anything without a string `status` (an error envelope, an HTML error page, garbage, null) → null,
// which the card reads as "server unreachable" (down). Kept pure so the unwrap is unit-tested, not just
// exercised live: a permanently-"down" card was exactly the regression this guards against.
export function parseHealth(raw: unknown): HealthInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as { result?: unknown };
  const body = (env.result && typeof env.result === "object" ? env.result : raw) as {
    status?: unknown;
    uptime_sec?: unknown;
  };
  if (typeof body.status !== "string") return null;
  return {
    status: body.status,
    ...(typeof body.uptime_sec === "number" ? { uptime_sec: body.uptime_sec } : {}),
  };
}

// The four live inputs sampled at render time. `ws` is the raw SyncEngine.getWsState() string — kept as a
// plain string (not the core WsState type) so the UI layer stays free of any clients/core import.
export interface StatusProbe {
  online: boolean;
  health: HealthInfo | null; // null when the probe threw / timed out (offline or server down)
  ws: string;
  queued: number; // offline support-ticket queue length (S-003)
}

// The port the web shell injects (all sampled fresh on every refresh). health() resolves null on failure.
// deliveryState is optional because the detailed Help card still reports raw WebSocket health, while
// the global strip uses the aggregate WS/long-poll verdict when the shell can provide it.
export interface SupportStatusPort {
  health(): Promise<HealthInfo | null>;
  wsState(): string;
  deliveryState?(): string;
  online(): boolean;
  queued(): number;
}

export type ServiceLevel = "ok" | "degraded" | "down";

export interface StatusView {
  level: ServiceLevel;
  server: string;
  connection: string;
  queued: string | null; // "В очереди: N" when queued > 0, else null (nothing to show)
  uptime: string | null; // localized uptime when /health reported it, else null
}

// The realtime link is "live" only when the socket is actually open. Everything else (idle before the
// engine starts, connecting/reconnecting, closed) is a not-yet/degraded realtime state — the app still
// works over long-poll, so it is "degraded", never "down", as long as /health answers.
function wsIsOpen(ws: string): boolean {
  return ws === "open";
}

// Collapse the four inputs to one traffic light:
//   down     — the client is offline, or /health did not answer "up" (server unreachable/unhealthy).
//   degraded — server is up but the realtime socket is not open (long-poll fallback / reconnecting).
//   ok       — server up AND realtime socket open.
export function serviceLevel(p: StatusProbe): ServiceLevel {
  if (!p.online) return "down";
  if (!p.health || p.health.status !== "up") return "down";
  return wsIsOpen(p.ws) ? "ok" : "degraded";
}

// Compact, localized uptime ("3д 4ч" / "3d 4h"): the two largest non-zero units, minutes shown when
// nothing bigger exists. Unit suffixes come from i18n (status.unit.d/h/m) so ru/en read naturally.
export function formatUptime(sec: number, i18n: I18n): string {
  const total = Math.max(0, Math.floor(sec));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}${i18n.t("status.unit.d")}`);
  if (h > 0) parts.push(`${h}${i18n.t("status.unit.h")}`);
  if (m > 0 || parts.length === 0) parts.push(`${m}${i18n.t("status.unit.m")}`);
  return parts.slice(0, 2).join(" ");
}

// Map a WsState string to its localized connection line. Offline short-circuits to the offline label so
// the card never claims "reconnecting" while the device itself has no network.
function connectionLabel(p: StatusProbe, i18n: I18n): string {
  if (!p.online) return i18n.t("status.ws.offline");
  if (wsIsOpen(p.ws)) return i18n.t("status.ws.open");
  if (p.ws === "closed") return i18n.t("status.ws.closed");
  return i18n.t("status.ws.connecting"); // idle | connecting | reconnecting | any unknown
}

// The full localized view a status card renders. Server/connection are always present; queued/uptime are
// null when there is nothing to show, so the card can drop those rows entirely.
export function describeStatus(p: StatusProbe, i18n: I18n): StatusView {
  const level = serviceLevel(p);
  const serverUp = !!p.health && p.health.status === "up" && p.online;
  const uptimeSec = p.health?.uptime_sec;
  return {
    level,
    server: serverUp ? i18n.t("status.server.up") : i18n.t("status.server.down"),
    connection: connectionLabel(p, i18n),
    queued: p.queued > 0 ? i18n.t("status.queued", { n: p.queued }) : null,
    uptime: serverUp && typeof uptimeSec === "number" && uptimeSec >= 0 ? formatUptime(uptimeSec, i18n) : null,
  };
}

// The localized headline for a level (the light's caption). Exported so the DOM card and tests agree.
export function levelLabel(level: ServiceLevel, i18n: I18n): string {
  return i18n.t(`status.level.${level}`);
}
