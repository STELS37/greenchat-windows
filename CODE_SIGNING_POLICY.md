# Code signing policy

## Status

GreenChat for Windows is applying for the SignPath Foundation open-source code-signing program. The integration is committed but remains disabled until SignPath approves the project and provides the organization, project, policy and artifact-configuration identifiers.

Once approved, releases will carry this notice:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

No self-signed certificate is presented to end users as a trusted public signature. Unsigned validation artifacts are clearly named and are never published as signed releases.

## Verifiable build origin

Every signing request must satisfy all of the following:

1. Source is a public commit of `STELS37/greenchat-windows`.
2. All jobs leading to the signing request run on GitHub-hosted runners.
3. The bare GreenChat application is uploaded as a GitHub Actions artifact and signed before any installer is created.
4. Tauri bundles NSIS and MSI around that exact signed application; its SHA-256 is recorded in the bundle manifest.
5. The unsigned installers are uploaded as a second GitHub Actions artifact and signed in a separate request.
6. The SignPath GitHub connector verifies repository, workflow, branch and commit origin for both requests.
7. Each signing request requires manual approval in SignPath.
8. The returned application, NSIS EXE and MSI are verified with `Get-AuthenticodeSignature` and must include trusted timestamps.
9. The portable ZIP must contain the exact signed application hash used for installer bundling.
10. Checksums and release metadata are generated only after both signing stages pass.

## Team roles

The project currently has one maintainer, so the roles are initially held by the same GitHub account:

- Committer and reviewer: [STELS37](https://github.com/STELS37)
- Signing-request approver: [STELS37](https://github.com/STELS37)

Additional maintainers must be documented here before receiving repository or SignPath access. All maintainers must enable multi-factor authentication for GitHub and SignPath.

## Change control

- Changes from untrusted contributors are accepted only through pull requests and review.
- Workflow, dependency-lock, build, installer, updater, cryptography and signing-policy changes receive heightened review.
- Signing is permitted only from the protected default branch or an explicitly approved release tag.
- A signing request is denied if source identity, artifact provenance, metadata restrictions, malware scanning or signature verification fails.

## Artifact scope

The project signs only GreenChat binaries built from source in this repository:

- GreenChat NSIS installer (`.exe`);
- GreenChat MSI installer (`.msi`);
- GreenChat desktop executable, signed before it is embedded into installers and the portable package.

Third-party binaries are not signed with the GreenChat project policy unless SignPath explicitly approves that scope. Existing upstream signatures are preserved or verified where supported.

## Two-stage artifact configurations

The SignPath project uses two artifact configurations:

- `signpath/app-artifact-configuration.xml` for the bare GreenChat application;
- `signpath/installer-artifact-configuration.xml` for NSIS and MSI containers.

This separation prevents a superficially signed installer from containing an unsigned application executable.

## Privacy policy

See [`PRIVACY.md`](PRIVACY.md). GreenChat communicates with networked systems only to provide functions requested by the user, including account access, messaging, calls, file transfer, updates and optional integrations. The client does not silently install unrelated software or change system security settings.
