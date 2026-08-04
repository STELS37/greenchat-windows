// clients/ui/src/router.ts — hash router (T-404, CLIENTS §9 deep links).
// Web equivalents of the cross-platform deep links: /#/chat/<id>, /#/chat/<id>/message/<mid>,
// /#/user/<username>, /#/join/<invite>, /#/settings, and /#/ (home). Path parsing and pattern
// matching are pure (unit-tested). The HashRouter binds to a HashEnv adapter (default: window),
// so it is testable in node with a fake env.

export interface RouteDef {
  name: string;
  pattern: string; // e.g. "/chat/:id/message/:mid"
}

export interface Route {
  name: string;
  params: Record<string, string>;
  path: string; // normalised, e.g. "/chat/42"
}



export const WEB_ROUTES: RouteDef[] = [
  { name: "authQr", pattern: "/auth/qr/:token" },
  { name: "contacts", pattern: "/contacts" },
  { name: "home", pattern: "/" },
  { name: "settings", pattern: "/settings" },
  { name: "bots", pattern: "/bots" },
  { name: "miniapps", pattern: "/miniapps" },
  { name: "miniappChatStart", pattern: "/miniapp/:id/chat/:chat/:start" },
  { name: "miniappChat", pattern: "/miniapp/:id/chat/:chat" },
  { name: "miniapp", pattern: "/miniapp/:id" },
  { name: "calls", pattern: "/calls" },
  { name: "wallet", pattern: "/wallet" },
  { name: "exchange", pattern: "/exchange" },
  { name: "cards", pattern: "/cards" },
  { name: "connect", pattern: "/connect" },
  { name: "import", pattern: "/import" },
  { name: "join", pattern: "/join/:invite" },
  { name: "user", pattern: "/user/:username" },
  { name: "message", pattern: "/chat/:id/message/:mid" },
  { name: "chat", pattern: "/chat/:id" },
  { name: "pay", pattern: "/pay/invoice/:code" },
];

/**
 * Paths a person or a link can reasonably produce that are not route patterns themselves.
 *
 * Measured on the signed direct APK 1000012 (redroid 15, CDP against the device WebView,
 * 2026-07-31): the bottom bar's fifth item is labelled "More"/«Ещё» and navigates to `#/settings`,
 * but `#/more` matched no pattern at all — the shell fell through to its home branch and drew the
 * chat list while the address bar still read `#/more`. The same happened for `#/definitely-not-a-
 * route`: chats were drawn under a URL that promised something else, so a reload, a share or a
 * back-press restored a screen the user never chose.
 *
 * An alias is the honest fix for the one case where the label and the route genuinely disagree;
 * everything else is a real not-found and is normalised to home by the shell.
 */
export const ROUTE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "/more": "/settings",
});

/** Canonical path for an alias, or null when `path` is not an alias. Pure; used by the shell. */
export function aliasTarget(path: string): string | null {
  return ROUTE_ALIASES[path] ?? null;
}

/**
 * The address the shell must move to, or null when the current route is a real one and the address
 * is already honest. Pure so the rule can be asserted without a DOM or a live shell.
 *
 * An alias resolves to its canonical screen; every other unmatched address is normalised to home,
 * because drawing home under a foreign address is exactly the defect this replaces.
 */
export function correctedPath(route: Pick<Route, "name" | "path">): string | null {
  if (route.name !== "notFound") return null;
  return aliasTarget(route.path) ?? "/";
}

// Normalise a location.hash into a clean path. "#/chat/42?x=1" → "/chat/42"; "" or "#" → "/".
export function parsePath(hash: string): string {
  let h = hash;
  if (h.startsWith("#")) h = h.slice(1);
  const qi = h.indexOf("?");
  if (qi >= 0) h = h.slice(0, qi);
  if (h.length === 0) return "/";
  if (!h.startsWith("/")) h = "/" + h;
  if (h.length > 1 && h.endsWith("/")) h = h.replace(/\/+$/, "");
  return h.length === 0 ? "/" : h;
}

function matchOne(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split("/").filter((s) => s.length > 0);
  const sp = path.split("/").filter((s) => s.length > 0);
  if (pp.length !== sp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    const val = sp[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

// Match a path against a route table (first match wins — order routes specific→generic).
export function matchRoutes(defs: RouteDef[], path: string): Route | null {
  for (const def of defs) {
    const params = matchOne(def.pattern, path);
    if (params) return { name: def.name, params, path };
  }
  return null;
}

// Map a native deep link to its web hash form. greenchat://chat/42 → "#/chat/42";
// gcpay://invoice/CODE → "#/pay/invoice/CODE". Returns null for unknown schemes.
export function deepLinkToHash(url: string): string | null {
  const m = /^([a-z]+):\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\/+$/, "");
  if (scheme === "greenchat") return "#/" + rest;
  if (scheme === "gcpay") return "#/pay/" + rest;
  return null;
}

// Adapter over the browser hash location — injectable so the router is testable in node.
export interface HashEnv {
  getHash(): string;
  setHash(hash: string): void;
  listen(cb: () => void): () => void;
}

export function browserHashEnv(): HashEnv {
  return {
    getHash: () => (typeof location !== "undefined" ? location.hash : ""),
    setHash: (hash: string) => { if (typeof location !== "undefined") location.hash = hash; },
    listen: (cb: () => void) => {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
  };
}

export class HashRouter {
  private readonly routes: RouteDef[];
  private readonly env: HashEnv;
  private readonly listeners = new Set<(route: Route) => void>();
  private unlisten: (() => void) | null = null;
  private route: Route;
  private emitted = 0;

  constructor(routes: RouteDef[] = WEB_ROUTES, env: HashEnv = browserHashEnv()) {
    this.routes = routes;
    this.env = env;
    this.route = this.resolve();
  }

  private resolve(): Route {
    const path = parsePath(this.env.getHash());
    return matchRoutes(this.routes, path) ?? { name: "notFound", params: {}, path };
  }

  current(): Route { return this.route; }

  // Every delivery of a route to subscribers goes through here, and each one bumps `emitted`. That
  // counter is what lets navigate() tell "the environment already announced this move" apart from
  // "the environment stayed silent", without assuming which of the two a given HashEnv does.
  private emit(): void {
    this.emitted += 1;
    this.route = this.resolve();
    for (const l of [...this.listeners]) l(this.route);
  }

  start(): void {
    if (this.unlisten) return;
    this.unlisten = this.env.listen(() => { this.emit(); });
    this.route = this.resolve();
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  navigate(path: string): void {
    const clean = path.startsWith("#") ? path : "#" + (path.startsWith("/") ? path : "/" + path);
    const before = this.env.getHash();
    const emitted = this.emitted;
    this.env.setHash(clean);
    // Assigning `location.hash` the value it already holds fires NO `hashchange`, so navigating to
    // the destination you are already on used to be a dead press. Measured on the 390x844 route
    // probe (2026-07-30): from «Ещё» -> «Профиль», tapping the «Ещё» tab again did nothing at all —
    // route() never ran, so swap() never reached the screen's reset() hook that pops a section back
    // to the index. Every mainstream messenger treats a re-tap of the active tab as "go to the root
    // of this tab", and the whole mechanism was already built (HashRouter -> app.route -> swap ->
    // Mounted.reset); only this event was missing. Same-destination navigation is therefore
    // delivered synchronously here, exactly once, carrying the payload a hashchange would carry.
    // The guard requires BOTH that the hash did not move and that setHash() delivered nothing of its
    // own, so a real change (or a HashEnv that notifies eagerly) can never be dispatched twice.
    if (this.unlisten && this.emitted === emitted && this.env.getHash() === before) this.emit();
  }

  subscribe(listener: (route: Route) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
