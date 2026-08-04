# Source provenance

## Public baseline

The public GreenChat Desktop source baseline was exported from the private GreenChat engineering repository at this exact commit:

```text
1fc59313cdb73ba7f973af7af02d864b5f23864f
```

Commit timestamp and subject:

```text
2026-08-04T16:43:10+03:00 fix(chat): show recent people in participant picker
```

Only files required to build and audit the Windows desktop client were exported. Server, deployment, mobile and financial-backend source trees were not part of the Windows artifact and were excluded.

## Exported source boundary

The baseline contains these original source paths:

- `clients/core/**`
- `clients/ui/**`
- `clients/web/**`
- `clients/desktop/**`
- `clients/third_party/tdlib/**`
- required top-level `clients/*` build files
- `config/client-release.json`
- `docs/legal/**`
- the Windows build and release scripts under `scripts/`
- the original Windows GitHub Actions workflow
- `LICENSE`

Public repository policy and documentation files were added during publication; they are not inputs to the legacy beta binary.

## Released artifact proof

The unsigned `1.0.0-beta.6` Windows x64 release was built from the commit above with a clean source tree. Its release manifest and checksums are preserved in `release-baseline/` and attached to the corresponding GitHub release.

Future signed releases are built directly from this public repository. Their manifests record the public source SHA and GitHub workflow run, eliminating the one-time export boundary used for the legacy beta.
