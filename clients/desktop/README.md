# clients/desktop — Tauri 2 shell (Windows / macOS / Linux)

Thin Rust host around the **shared web bundle** (`clients/web/dist`). All app logic runs in the WebView
against the same UI the browser/PWA uses; the shell only adds native seams. Implemented in T-411.

## What the shell adds (no frontend fork)

The web bundle is used byte-for-byte (`tauri.conf.json` → `build.frontendDist: "../../web/dist"`). Native
behaviour is bridged by `src-tauri/src/bridge.js`, injected as an init script with two launch-time
placeholders substituted by Rust (the persisted session read from the keyring, and the backend origin):

- **Tray + unread badge** — persistent tray icon; left-click / "Показать" shows the window, "Выход" quits.
  The unread total is mirrored to the tray tooltip (and the macOS dock badge).
- **Close-to-tray** — closing the window hides it instead of quitting (§7.2). Real quit is the tray menu.
- **Native notifications with explicit consent** — notifications are OFF until the person enables the
  local desktop toggle and the operating system grants permission. The server's
  `/v1/badge.total_unread` excludes muted and archived chats, so only a rise in the mute-aware badge while
  the window is unfocused can notify. Visible copy is deliberately generic (no sender, chat title or
  message text). The incoming `message.new` event supplies an in-memory chat id; activating the banner
  focuses Green Chat and opens that exact chat. The target is cleared after every badge update so an old
  message can never redirect a later notification.
- **Deep links** `greenchat://…` and `gcpay://…` → SPA hash routes (see `src/deeplink.rs`, unit-tested).
  Single-instance forwards a second launch (incl. a Linux deep-link open) to the running window.
- **Refresh token in the OS secret store** — the bridge shadows `localStorage['gc.session']` (and only
  that key) to the `keyring` crate (Secret Service / Keychain / DPAPI). The token is seeded into memory at
  boot and never written to the WebView's on-disk localStorage (§7.2 "refresh НЕ в localStorage").
- **window-state** persists window geometry. **Autostart** is an explicit local Settings toggle backed by the operating-system login item; it is never enabled merely by signing in and is never stored on the server.
- **Server origin** — the bundle is same-origin (`baseUrl:""`); under `tauri://` there is no server on the
  origin, so the bridge rewrites own-origin `/v1/*` fetches and `ws(s)` sockets to `$GC_SERVER` when set.

## Linux production build

The Linux client is a standalone installed Tauri application. It carries the shared GreenChat UI but
owns a native process, tray, deep links, notifications, Secret Service/keyring session storage and a
recognisable device identity (`desktop/<version>`, `GreenChat Desktop Linux <arch> <version>`).

Use the rustup `stable` toolchain pinned by `src-tauri/rust-toolchain.toml`; do not use an old system
`rustc`. The governed factory builds the web payload in an isolated staging directory, embeds the
pinned official TDLib runtime and produces three package formats:

- `GreenChat-<version>-linux-x86_64.AppImage` — portable package;
- `GreenChat-<version>-linux-amd64.deb` — Debian/Ubuntu;
- `GreenChat-<version>-linux-x86_64.rpm` — Fedora/RHEL/openSUSE.

Every installer receives its own detached updater signature. The build verifies package metadata,
architecture, `.desktop` launcher, embedded `libtdjson.so`, SHA-256 and minisign signature, removes
source maps and normalises duplicate DEB dependencies before re-signing.

```sh
npm --prefix clients ci
npm --prefix clients run test:linux-release
npm --prefix clients run build:linux -- --out var/release-artifacts/linux
```

A normal release build refuses a dirty Git tree. `--allow-dirty` exists only for local proof runs and
is recorded in `linux-release.json`. `GC_SERVER` may override the canonical backend origin for a
self-hosted build.

The canonical `.github/workflows/desktop-artifacts.yml` matrix builds Linux together with macOS and
Windows from the exact current `master` SHA. Linux artifacts are private until the release catalog and
transactional deploy pipeline admit their immutable filenames, hashes and signatures.

Updater requests include `bundle_type=appimage|deb|rpm`; the server returns the matching installer, so
a DEB/RPM installation can never receive AppImage bytes. Older Linux clients retain the generic
AppImage fallback. See `docs/CLIENTS.md` §7.2.

## Layout

- `src-tauri/tauri.conf.json` — window, tray, deep-link schemes, bundle targets, CSP.
- `src-tauri/src/lib.rs` — app builder: plugins, tray, close-to-tray, keyring + badge/notify commands.
- `src-tauri/src/bridge.js` — the injected shim that rewires the shared bundle to the native seams.
- `src-tauri/src/deeplink.rs` — pure `greenchat://`/`gcpay://` → hash mapping (unit-tested).
- `src-tauri/capabilities/default.json` — Tauri 2 permission ACL for the window + plugins.
- `src-tauri/icons/` — app + tray icons, rasterized from `clients/web/dist/icon.svg`.


## macOS production build

The macOS client is a standalone universal Tauri application, not a browser shortcut. The exact same
verified web payload is embedded in a signed native `.app`, then shipped in a notarized `.dmg`; the
Tauri updater receives a separately minisign-signed update archive. macOS-specific configuration is
isolated in `src-tauri/tauri.macos.conf.json`, with privacy strings in `Info.plist`, hardened-runtime
entitlements in `Entitlements.plist`, and a native multi-resolution `icons/icon.icns`.

`desktop-artifacts.yml` builds one `universal-apple-darwin` binary containing both `arm64` and `x86_64`.
The workflow rejects an artifact unless `codesign`, Gatekeeper (`spctl`), notarization stapling,
`hdiutil verify`, both architecture slices, the updater signature and exact latest-master identity all
pass. The generated `release.json` and `SHA256SUMS` bind every downloadable byte to the source SHA.

Release and one-time Apple credential setup are documented in `docs/MACOS_RELEASE.md`.
