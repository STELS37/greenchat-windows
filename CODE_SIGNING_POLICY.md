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
3. The unsigned input is uploaded as a GitHub Actions artifact before submission.
4. The SignPath GitHub connector verifies repository, workflow, branch and commit origin.
5. The signing request requires manual approval in SignPath.
6. Returned EXE and MSI files are verified with `Get-AuthenticodeSignature` and must include a trusted timestamp.
7. Checksums and release metadata are generated only after signing.

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
- GreenChat desktop executable included in the portable package.

Third-party binaries are not signed with the GreenChat project policy unless SignPath explicitly approves that scope. Existing upstream signatures are preserved or verified where supported.

## Privacy policy

See [`PRIVACY.md`](PRIVACY.md). GreenChat communicates with networked systems only to provide functions requested by the user, including account access, messaging, calls, file transfer, updates and optional integrations. The client does not silently install unrelated software or change system security settings.
