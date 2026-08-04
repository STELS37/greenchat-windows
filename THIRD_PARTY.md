# Third-party components

GreenChat for Windows is distributed under AGPL-3.0-or-later and uses open-source dependencies recorded in committed lockfiles.
Original GreenChat artwork and audio are covered separately in [`ASSET_LICENSES.md`](ASSET_LICENSES.md); they are not third-party dependencies.

## JavaScript and TypeScript

The complete dependency graph and exact versions are recorded in:

- `clients/package-lock.json`

Notable direct dependencies include LiveKit Client, libsodium wrappers, jsQR, TypeScript, esbuild and Playwright. Their licenses are provided by their respective packages and upstream repositories.

## Rust and Tauri

The complete Rust dependency graph and checksums are recorded in:

- `clients/desktop/src-tauri/Cargo.lock`

The desktop host uses Tauri 2 and open-source Rust crates from crates.io.

## TDLib

The optional Telegram connector uses the official TDLib source at the exact commit recorded in:

- `clients/third_party/tdlib/PINNED.env`

TDLib is licensed under the Boost Software License 1.0. Its license and OpenSSL notices are copied into Windows packages by the build process. Generated TDLib binaries are not committed.

## WebView2 and Windows system components

The Tauri Windows client uses Microsoft Edge WebView2 and Windows system libraries supplied by or installed for the operating system. These are treated as system/runtime components and are not signed as GreenChat-owned binaries.

## Signing boundary

The GreenChat SignPath policy signs only GreenChat-owned executable and installer files built from this repository. Third-party binaries are preserved, excluded from the GreenChat signing scope or verified according to the final SignPath artifact configuration.
