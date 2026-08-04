# Code signing policy

## Purpose

Code signing identifies the exact public source revision used to build a GreenChat Desktop release and protects Windows users against modified installers. A valid signature is not a substitute for source review, reproducible build evidence or malware analysis.

## Signing provider

**Free code signing provided by SignPath.io, certificate by SignPath Foundation.**

The Authenticode certificate used by the open-source release lane is owned and controlled by SignPath Foundation. GreenChat maintainers do not receive or export its private key.

## Source and build requirements

A signing request is permitted only when all of the following are true:

1. the source revision is a committed SHA on the protected default branch of this public repository;
2. the complete Windows client source and build workflow are publicly available at that SHA;
3. every build job leading to the signing request runs on a GitHub-hosted runner;
4. dependency installation uses committed lock files and pinned toolchain versions;
5. the unsigned artifact is uploaded by the same workflow run that submits the signing request;
6. automated tests, source-boundary checks and secret scans have passed;
7. the signing request is manually approved by an authorized project approver;
8. the signed files are verified with Windows Authenticode tooling before release publication;
9. release metadata records the source SHA, workflow run, file size and SHA-256 for every published artifact.

Self-hosted runners are not allowed in the SignPath signing chain. Privately supplied binaries are not accepted as signing inputs.

## Roles

- **Authors** prepare code changes but cannot approve their own signing request.
- **Reviewers** review pull requests and verify that changes remain inside the public Windows-client boundary.
- **Approvers** manually approve or reject SignPath signing requests after reviewing the source SHA, CI results and artifact provenance.

All maintainers, reviewers and approvers must use multi-factor authentication for their GitHub and SignPath accounts. Approval rights are limited to the minimum number of maintainers required to release the project.

## Artifact policy

The signing configuration permits only expected Windows PE and MSI files produced by the GreenChat build. The release lane signs:

- the native GreenChat application executable before bundling;
- the NSIS setup executable after bundling;
- the MSI installer after bundling.

Unknown file types, scripts, archives containing unexpected executable paths, and files produced outside the declared workflow are rejected.

## Release approval

Every public signed release requires manual SignPath approval. Automatic approval is not used. The approver must verify that:

- the request belongs to this repository and the expected workflow run;
- the commit is on the protected default branch;
- all mandatory GitHub checks succeeded;
- the artifact names and architectures match the release declaration;
- no unrelated executable was included;
- the release notes accurately describe security-relevant changes.

## Compromise or incident response

Signing is suspended immediately when repository, maintainer or dependency compromise is suspected. Maintainers will disable the release workflow, revoke affected tokens, notify SignPath, preserve workflow evidence and publish a security advisory when disclosure is safe. No replacement release is signed until the incident is contained and the source boundary is re-audited.

## Policy changes

Changes to this document, signing workflows, artifact configuration or approver roles require pull-request review. Such changes are treated as security-sensitive and must not be combined with unrelated product changes.
