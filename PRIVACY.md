# Privacy policy for GreenChat for Windows

Effective date: 2026-08-04

GreenChat for Windows is a network client. It communicates with GreenChat services when the user signs in or uses messaging, calling, file-transfer, update, bot, mini-app or financial-interface features.

## Data transmitted

Depending on the features used, the client may transmit:

- account identifiers, profile information and authentication material;
- message, reaction, group, channel and contact operations requested by the user;
- call signaling, media-routing information and encrypted media streams;
- files and media selected by the user;
- device and application version identifiers required for session security, compatibility and updates;
- crash or diagnostic information only when the user explicitly submits it or enables a documented diagnostic function;
- information entered into an optional third-party integration, only when the user enables and operates that integration.

The application does not intentionally collect unrelated browsing history, documents, passwords from other applications or advertising identifiers.

## Network destinations

The default production build connects to GreenChat endpoints under `greenchat.globalsystem.cc` and to infrastructure required for user-requested real-time communication and update delivery. Optional integrations may contact their own documented service endpoints after the user enables them.

A custom or development build may be configured to use another server origin. The selected operator is responsible for that service's privacy practices.

## Local storage

The client stores application settings, cached interface data and session state on the local computer. Refresh credentials are stored through the operating-system credential facility where supported. Cached data can remain until the account is removed, the cache is cleared or the application is uninstalled.

## Microphone, camera, notifications and files

GreenChat requests microphone, camera, notification and file access only for the corresponding user-facing function. Denying a permission disables or limits that function. The installer provides normal Windows uninstallation.

## System changes

The installer creates the files, shortcuts, protocol handlers and update registration required for GreenChat. It does not disable antivirus, firewall, SmartScreen, Windows Update or other operating-system security controls.

## Source code and verification

The Windows client source and build workflow are public in this repository. Release signing provenance and the applicable policy are documented in [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md).

## Contact

Privacy and security reports may be opened through the repository's issue tracker unless they contain sensitive vulnerability details. Sensitive security reports must follow [`SECURITY.md`](SECURITY.md).
