# GreenChat Desktop for Windows

GreenChat Desktop is the open-source Windows client for GreenChat. It is a Tauri 2 application that embeds the same TypeScript user interface used by the GreenChat web client and adds native Windows integration such as secure credential storage, desktop notifications, tray behavior, deep links and application updates.

This repository contains the complete source and build definition for the Windows artifacts distributed as GreenChat Desktop. It intentionally does **not** contain the GreenChat server, deployment infrastructure, mobile applications or financial-service backends; those components are not linked into or shipped with the Windows binaries.

## Current release

The first public source baseline corresponds to the already distributed unsigned beta:

- version: `1.0.0-beta.6`;
- original source commit: `1fc59313cdb73ba7f973af7af02d864b5f23864f`;
- platform: Windows x86_64;
- release state: unsigned legacy beta, retained for provenance;
- release manifest: `release-baseline/windows-x64-release.json`.

The release assets and their SHA-256 checksums are published in the matching GitHub release. They are intentionally identified as unsigned and are not represented as SignPath-signed artifacts.

## Repository layout

- `clients/core` — protocol, storage, cryptography and shared client logic;
- `clients/ui` — framework-independent TypeScript UI;
- `clients/web` — web entry point and assets embedded by Tauri;
- `clients/desktop` — Tauri/Rust native desktop shell;
- `clients/third_party/tdlib` — pinned TDLib source identity and license material;
- `scripts` — deterministic Windows build, verification and release tooling;
- `config/client-release.json` — canonical public client version;
- `docs/legal` — privacy policy and terms shown by the client.

## Local checks

```bash
npm --prefix clients ci
npm --prefix clients run check
npm --prefix clients test
npm --prefix clients run build:web
npm --prefix clients run check:desktop
node scripts/build-windows-desktop.mjs --self-check
```

A complete installer build requires a native Windows runner with MSVC, Rust, CMake, vcpkg, gperf, PHP and Tauri CLI 2.11.4. The GitHub Actions workflows install and verify the required toolchain from a clean checkout.

## Windows trust model

GreenChat uses two independent signatures:

1. **Authenticode**, applied to the Windows application and installers through SignPath;
2. **Tauri updater signature**, used only when the separately governed updater key is enabled.

Unsigned validation artifacts are isolated from release artifacts and can never be published as signed builds. See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

> Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Security and privacy

Security issues must be reported privately as described in [SECURITY.md](SECURITY.md). Privacy terms are documented in [PRIVACY.md](PRIVACY.md) and in the client-facing source at [`docs/legal/privacy.md`](docs/legal/privacy.md).

## License

GreenChat Desktop is licensed under the GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
