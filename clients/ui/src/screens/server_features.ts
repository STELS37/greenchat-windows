// clients/ui/src/screens/server_features.ts — optional server contours advertised by public /v1/config.
//
// Why this exists: several contours are *fail-closed* on the server (pay/cards/routes.ts registers no
// route at all unless GC_CARDS=1 AND GC_PAYMENTS=1). Before this module the UI had no way to know that
// and simply offered the entry point, so on every default deployment the "Cards" tab was a dead link:
// one 404 in the console and an "unavailable" panel, every single time it was tapped. A navigation item
// whose only possible outcome is an error state is a defect, not a graceful degradation.
//
// The probe is memoised per ApiLike instance because /v1/config is public, cacheable (the server sends
// cache-control: max-age=60) and read by several screens. A failed probe resolves to "everything
// optional is off" — the conservative direction: a hidden tab is recoverable by a refresh, a dead tab
// is not recoverable at all.
import type { ApiLike } from "./api.ts";

export interface ServerFeatures {
  /** Card contour reachable: /v1/cards exists on this server. */
  cards: boolean;
  /** Money contour reachable at all: wallet, exchange and everything built on the ledger. */
  payments: boolean;
  /**
   * Did the server actually answer? V85: this used to be missing, and "the probe failed" was folded
   * into "the contours are off". Hiding a tab on that basis is right (conservative), but a SCREEN
   * that says «Финансовый контур ещё не активирован» when the phone simply has no network is telling
   * the user the wrong thing about the wrong system. Measured 2026-07-30 at 390x844 with every /v1/*
   * call aborted: /wallet still rendered the contour-off state (tone=empty, green glyph) instead of
   * the offline state. Consumers that need the difference read this flag; consumers that only decide
   * whether to advertise a destination keep ignoring it.
   */
  known: boolean;
  /**
   * B-P0-4 (owner directive 2026-07-30): demo money contour. `kind='demo'` assets are usable and
   * POST /v1/wallet/faucet works, so a user can obtain a balance and actually exercise send /
   * exchange / history. It matters because "payments on" is not the same as "payments usable": on the
   * production deployment GUSD is the only enabled asset, every rail (chains, on-ramp, cards) is off
   * and GUSD cannot be issued to users, so a fresh account sees a wallet that can only ever show 0.
   * The flag is advertised by /v1/config as `demo_finance` and only ever gates a clearly labelled
   * test-money entry point — never a real rail.
   */
  demoFinance: boolean;
}

/** The contours a destination can depend on. `known` is diagnostic, never a requirement. */
export type ServerContour = "cards" | "payments";

const OFF: ServerFeatures = { cards: false, payments: false, known: false, demoFinance: false };

interface ConfigBody {
  features?: { cards?: unknown; payments?: unknown; demo_finance?: unknown };
}

/** Pure: turn any /v1/config body (old servers included) into a feature record. */
export function readServerFeatures(body: unknown): ServerFeatures {
  const features = (body as ConfigBody | null | undefined)?.features;
  // Strict `=== true`: a server that predates the flag omits it, and "unknown" must read as off so the
  // client never advertises a contour it cannot reach.
  return {
    cards: features?.cards === true,
    payments: features?.payments === true,
    known: true,
    demoFinance: features?.demo_finance === true,
  };
}

const cache = new WeakMap<ApiLike, Promise<ServerFeatures>>();

/** Memoised per api instance. Never rejects — a failed probe reads as "optional contours off". */
export function serverFeatures(api: ApiLike): Promise<ServerFeatures> {
  const hit = cache.get(api);
  if (hit) return hit;
  const probe = api.get<unknown>("/v1/config").then(readServerFeatures, () => {
    // V85: a FAILED probe must not be remembered. It used to be cached for the lifetime of the api
    // instance, so once the phone lost the network at the wrong moment every finance screen was
    // permanently convinced the contours were off — and the retry button on those screens could not
    // possibly change the answer, because it never asked again. An answer is cached; a silence is not.
    cache.delete(api);
    return OFF;
  });
  cache.set(api, probe);
  return probe;
}

/** A navigation destination that only exists when some optional server contour does. */
export interface OptionalDestination {
  /** Which contour this destination needs; absent = always available (chats, settings…). */
  requires?: ServerContour;
}

// Why filtering, not disabling: GC_PAYMENTS defaults to 0, so on a stock deployment "Кошелёк" and
// "Биржа" occupied two of the five slots in the main navigation bar and answered every tap with a
// 403 plus an "unavailable" card (measured: var/ux-audit/v40/report.json, light/wallet + light/exchange).
// Two fifths of the primary navigation of a MESSENGER were reserved for contours the server refuses to
// serve. The routes stay reachable by URL for an operator flipping the flag — only the advertisement
// goes away.
export function visibleDestinations<T extends OptionalDestination>(items: T[], features: ServerFeatures): T[] {
  return items.filter((item) => !item.requires || features[item.requires]);
}

/** Test seam: drop the memoised probe for one api instance. */
export function forgetServerFeatures(api: ApiLike): void {
  cache.delete(api);
}
