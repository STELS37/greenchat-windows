// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical UI placement for third-party account connections.
 *
 * TikTok is a social identity/content connection and must never be surfaced in
 * Gamer Mode. Epic Games remains a gaming connection.
 *
 * Keep placement in one module so future surfaces cannot accidentally re-add
 * TikTok to the gaming profile by iterating an undifferentiated provider list.
 */
export const CONNECTION_PROVIDERS = ["tiktok", "epic"] as const;
export type ConnectionProvider = typeof CONNECTION_PROVIDERS[number];

export const SOCIAL_FEED_PROVIDERS = ["tiktok"] as const satisfies readonly ConnectionProvider[];
export const GAMING_PROVIDERS = ["epic"] as const satisfies readonly ConnectionProvider[];

export type ConnectionSurface = "social_feed" | "gaming";

const PROVIDER_SURFACE: Readonly<Record<ConnectionProvider, ConnectionSurface>> = Object.freeze({
  tiktok: "social_feed",
  epic: "gaming",
});

export function providerSurface(provider: ConnectionProvider): ConnectionSurface {
  return PROVIDER_SURFACE[provider];
}

export function providersForSurface(surface: ConnectionSurface): readonly ConnectionProvider[] {
  return surface === "social_feed" ? SOCIAL_FEED_PROVIDERS : GAMING_PROVIDERS;
}

export function isProviderAllowedOnSurface(
  provider: ConnectionProvider,
  surface: ConnectionSurface,
): boolean {
  return providerSurface(provider) === surface;
}
