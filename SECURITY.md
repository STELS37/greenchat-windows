# Security policy

## Supported versions

Security fixes are applied to the latest public Windows client source and the latest released Windows build.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Use GitHub's **Report a vulnerability** function in the Security tab of this repository. Include:

- affected version and commit;
- reproduction steps;
- impact and realistic attack prerequisites;
- logs or proof with credentials, personal data and access tokens removed;
- a suggested fix when available.

Reports concerning the GreenChat service rather than this Windows client should clearly state that the server is affected so they can be routed without exposing details publicly.

## Release security controls

- dependencies are locked;
- builds run from exact public commits on GitHub-hosted runners;
- signing requests are tied to uploaded GitHub Actions artifacts;
- release signing requires manual approval;
- Authenticode signatures and timestamps are verified before publication;
- unsigned validation artifacts are never represented as signed releases;
- private keys and tokens are never committed to this repository.

## Scope limits

The repository does not authorize testing against other users, production accounts, payment systems or infrastructure without explicit permission. Use isolated test accounts and avoid service disruption or access to data that does not belong to you.
