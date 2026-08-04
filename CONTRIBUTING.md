# Contributing

GreenChat for Windows accepts focused, reviewable changes to the open-source client.

## Development rules

1. Create an issue or clearly describe the defect or feature in the pull request.
2. Keep changes limited to the Windows client and shared client code in this repository.
3. Add or update tests for behavior changes.
4. Do not commit secrets, production credentials, private keys, personal data or generated release artifacts.
5. Preserve the AGPL-3.0-or-later license and third-party notices.
6. Explain changes to build, dependency, installer, updater, cryptography or signing files in additional detail.

## Local checks

```bash
npm --prefix clients ci
npm --prefix clients run check
npm --prefix clients test
node scripts/build-windows-desktop.mjs --self-check
node --test scripts/build-windows-desktop.test.mjs
```

A native Windows build is performed by GitHub Actions.

## License of contributions

By submitting a contribution, you agree that it is licensed under GNU AGPL-3.0-or-later and that you have the right to provide it under that license.

## Review and signing roles

Repository and code-signing roles are documented in [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md). External contributions require review before merge. Signing-policy changes require maintainer review and must not weaken origin verification or manual release approval.
