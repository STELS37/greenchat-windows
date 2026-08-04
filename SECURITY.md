# Security policy

## Supported versions

Only the latest public GreenChat Desktop release and the current default branch receive security fixes. Legacy unsigned beta artifacts remain available solely for provenance and should not be treated as trusted production releases.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

1. open the repository's **Security** tab;
2. choose **Report a vulnerability**;
3. include affected versions, reproduction steps, impact, logs and a minimal proof of concept;
4. remove personal data, access tokens and unrelated secrets from attachments.

Reports are acknowledged and handled through the private security advisory. Coordinated disclosure is preferred. Please do not publish exploit details before a fixed release and advisory are available.

## Sensitive areas

Reports concerning any of the following receive priority:

- authentication and session persistence;
- local credential storage and DPAPI/keyring integration;
- update verification or code signing;
- remote content execution inside the desktop WebView;
- deep links and single-instance forwarding;
- cryptographic key handling;
- file and media processing;
- call and realtime signaling boundaries;
- dependency or build-pipeline compromise.

## Signing incidents

A suspected compromise of GitHub Actions, SignPath credentials, release artifacts or a maintainer account immediately suspends signed releases under the process in [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
