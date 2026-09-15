# GreenChat for Windows 1.0.0-beta.8

This update adds usable Epic launcher and TikTok public-post features. It does not complete account linking for those providers.

- More → Social feed opens a dedicated TikTok screen. Paste a full public video/photo URL to load the official TikTok player. Nothing is loaded from TikTok before selecting Watch. Tracking parameters are removed, frames are restricted to the official player, and leaving the screen stops playback.
- If the embedded player is unavailable, the original post can be opened in the system browser. Actual playback depends on TikTok availability and the post's visibility; it was not verified in the development browser because the official player was unavailable there.
- Gamer Mode → Epic Games on this computer reads installed games from Epic Games Launcher after the user selects Find installed games. Play hands the selected installed game's identifier to the official launcher. No launcher credentials, arbitrary executable paths or account tokens are read.
- The installed game list is local and is not proof of a linked Epic account. TikTok Login Kit/Display API and Epic account linking still require registered provider applications and server integration.
- Steam/FACEIT remain in Gamer Mode. TikTok appears only in Social feed.

The unsigned prerelease is intended for manual installation. SignPath remains disabled; these artifacts must not be distributed through the signed automatic updater.
