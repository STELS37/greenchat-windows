# GreenChat for Windows

GreenChat for Windows is the open-source desktop client of GreenChat. It is built with Tauri 2, Rust and TypeScript and connects to the GreenChat service selected by the user or configured for the build.

This repository intentionally contains **client code only**. GreenChat server, payment, exchange, card, operations and infrastructure code are not part of this repository and are not required to audit or build the Windows client.

## Current status

- License: [GNU AGPL-3.0-or-later](LICENSE)
- Supported Windows architectures: x64 and ARM64
- Installer formats: NSIS EXE and MSI
- Source import: see [`UPSTREAM_COMMIT`](UPSTREAM_COMMIT) and [`EXPORT_PROVENANCE.txt`](EXPORT_PROVENANCE.txt)
- Authenticode: SignPath Foundation onboarding is being prepared; until approval, CI artifacts are explicitly marked unsigned

The current public download page is: <https://greenchat.globalsystem.cc>

## Build from source

Prerequisites on a native Windows runner:

- Git
- Node.js 22
- Rust stable with the MSVC target
- Visual Studio Build Tools 2022 with C++ and Windows SDK
- CMake
- Tauri CLI 2

```powershell
npm --prefix clients ci
npm --prefix clients run check
node scripts/build-windows-desktop.mjs --self-check
node scripts/build-windows-desktop.mjs --arch x64 --allow-unsigned --out $env:RUNNER_TEMP\greenchat-windows
```

The canonical GitHub-hosted build is defined in [`.github/workflows/windows-artifacts.yml`](.github/workflows/windows-artifacts.yml). A release submitted to SignPath is always built from a public commit by GitHub-hosted runners.

## Repository scope

Included:

- shared protocol and crypto client code in `clients/core`;
- desktop UI and localization in `clients/ui`;
- web runtime bundled into the desktop application in `clients/web`;
- Tauri/Rust host in `clients/desktop`;
- pinned TDLib build instructions in `clients/third_party/tdlib`;
- Windows build and verification scripts.

Excluded:

- server-side code and databases;
- financial providers and production credentials;
- deployment infrastructure and operational state;
- Android and iOS clients.

## Security and privacy

Read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability and [`PRIVACY.md`](PRIVACY.md) for network and local-storage behavior.

## Code signing policy

See [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md).

After SignPath Foundation accepts the project, the release workflow will use the exact required statement:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

Until acceptance, the workflow cannot claim a trusted publisher and refuses to label unsigned outputs as signed.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). All contributors must agree that their contributions are licensed under AGPL-3.0-or-later.
