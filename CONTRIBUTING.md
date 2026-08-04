# Contributing

GreenChat Desktop accepts focused changes to the public Windows client. Do not submit server credentials, production infrastructure, private APIs, user data or unrelated GreenChat products to this repository.

## Development process

1. Create a branch from the current default branch.
2. Keep each pull request limited to one auditable change.
3. Add or update tests for behavioral changes.
4. Run the client checks listed in `README.md`.
5. Explain security, privacy and update implications in the pull request.
6. Obtain review from a maintainer other than the author.

Direct pushes to the protected default branch are not the normal contribution path. Release and signing workflow changes require security-sensitive review.

## Public-source boundary

Permitted source areas include the shared client core, UI, web bundle, Tauri desktop shell, pinned open-source desktop dependencies and the Windows build/release workflow. The following are outside this repository:

- GreenChat server and deployment infrastructure;
- production secrets and credentials;
- Android and iOS applications;
- payment, exchange, P2P and banking provider backends;
- private operational evidence and support data.

## Commit and pull-request requirements

- use descriptive commit messages;
- do not commit generated installers, dependency directories or local build caches;
- keep lock-file changes intentional and reviewable;
- do not disable signature, provenance, secret-scan or source-boundary checks;
- do not approve your own release signing request;
- enable multi-factor authentication on accounts with repository or signing access.

## License

By contributing, you agree that your contribution is licensed under AGPL-3.0-or-later, the license used by this repository.
