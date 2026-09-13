// SPDX-License-Identifier: AGPL-3.0-or-later
// REST contracts for the existing GreenChat gaming service. No provider credentials in the client.
import type { ApiLike } from "./api.ts";
import type { GamerModeProfile } from "./gamer_mode_screen.ts";

export interface GamingSettings {
  enabled: boolean;
  show_current_game: boolean;
  show_accounts: boolean;
  show_faceit_rank: boolean;
}
export interface GamingState {
  settings: GamingSettings;
  profile: {
    steam: { connected: boolean; name?: string; profile_url?: string; avatar_url?: string;
      steam_level?: number; friends_count?: number } | null;
    faceit: { connected: boolean; profile_url?: string; cs2?: { skill_level?: number; elo?: number } | null } | null;
    current_game: { name: string; detail?: string; art_url?: string } | null;
  };
  providers: {
    steam: { link_available: boolean };
    faceit: { link_available: boolean; requires_steam: boolean };
  };
  sync_errors?: string[];
}

export function validateGamingState(value: GamingState): GamingState {
  if (!value || !value.settings || !value.profile || !value.providers ||
      !value.providers.steam || !value.providers.faceit ||
      ["enabled", "show_current_game", "show_accounts", "show_faceit_rank"].some(
        key => typeof value.settings[key as keyof GamingSettings] !== "boolean")) {
    throw new Error("Invalid gaming response");
  }
  return value;
}

export function gamingProfile(state: GamingState, self: { name: string; username: string }, api: ApiLike): GamerModeProfile {
  const { steam, faceit, current_game: game } = state.profile;
  const media = (url?: string): string | null => url ? (api.resolveUrl?.(url) ?? url) : null;
  return {
    ...self,
    avatarUrl: media(steam?.avatar_url),
    steam: { linked: steam?.connected === true, level: steam?.steam_level ?? null, friends: steam?.friends_count ?? null },
    faceit: { linked: faceit?.connected === true, level: faceit?.cs2?.skill_level ?? null, elo: faceit?.cs2?.elo ?? null },
    epic: { linked: false },
    nowPlaying: game ? { title: game.name, subtitle: game.detail ?? "", imageUrl: media(game.art_url) } : null,
  };
}

/** Validate official navigation destinations, including server-returned OAuth URLs. */
export function gamingExternalUrl(raw: string, provider: "steam" | "faceit" | "epic", auth = false): string {
  const url = new URL(raw);
  const hosts = { steam: "steamcommunity.com", faceit: "www.faceit.com", epic: "store.epicgames.com" };
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      (url.hostname !== hosts[provider] && !(provider === "faceit" && url.hostname === "faceit.com")) ||
      (auth && (provider !== "steam" || url.pathname !== "/openid/login"))) {
    throw new Error("Invalid gaming destination");
  }
  return url.href;
}
