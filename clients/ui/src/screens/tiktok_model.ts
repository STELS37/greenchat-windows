// SPDX-License-Identifier: AGPL-3.0-or-later
export interface TikTokPost { id: string; url: string; playerUrl: string }

// Only canonical public posts; never execute pasted HTML or load arbitrary frames.
export function tiktokPost(raw: string): TikTokPost {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["www.tiktok.com", "tiktok.com"].includes(url.hostname)) throw new Error("Invalid TikTok link");
  const match = /^\/@([A-Za-z0-9._]{1,64})\/(?:video|photo)\/(\d{15,22})\/?$/.exec(url.pathname);
  if (!match) throw new Error("Use the full public post link");
  const id = match[2]!;
  return { id, url: `https://www.tiktok.com${url.pathname.replace(/\/$/, "")}`,
    playerUrl: `https://www.tiktok.com/player/v1/${id}?autoplay=0&controls=1&description=1&music_info=1` };
}
