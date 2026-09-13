# GreenChat for Windows 1.0.0-beta.7

Gamer Mode is now reachable from More and Profile, with the animated design introduced in PR #17.

- Steam uses official OpenID sign-in in the system browser. FACEIT links through the verified Steam identity.
- Current game, Steam level/friends and FACEIT level/ELO come from the GreenChat gaming API.
- Enabling the mode and changing account/game/rank visibility saves to the server. Failed writes require a refresh and never claim success.
- Light/dark themes, responsive cards, live particles and reduced-motion support. Turning the mode off pauses the background.
- Epic Games stays in Gamer Mode. Its store can be opened, but account linking is unavailable until the server implements it. TikTok is not shown in Gamer Mode.
- Missing achievements, playtime and library totals are shown as unavailable instead of invented data.

Windows packaging now keeps generated TDLib resources separate from tracked source. The two-stage build retains clean-source, architecture and Microsoft Defender checks.

The repository currently has SignPath disabled. An unsigned candidate has no trusted Authenticode signature and must never be described as a signed release or installed through the signed auto-updater.
