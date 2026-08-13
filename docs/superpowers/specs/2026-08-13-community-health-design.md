# Community Health Design

## Goal

Make Codex SwitchBridge safer and easier to contribute to, and have GitHub
recognize the repository's community files.

## Scope

Keep repository-level policies and templates under `.github/`. Public forms
handle ordinary bugs, features, and questions. Sensitive reports go through
GitHub Private Vulnerability Reporting. Add continuous integration and dependency
update configuration as evidence of sustainable maintenance.

Add a factual maintenance statement that describes the student maintainer's
long-term commitment, the local-history interoperability problem, the mature core
workflow, future maintenance priorities, and the proposed use of OpenAI support.
It must not claim adoption numbers or OpenAI endorsement.

## Verification

Parse every YAML file, scan for unresolved placeholders, run `npm run verify`,
push the files to the default branch, and query GitHub's Community Profile and
security APIs. Success requires a 100% measured Community Profile score, all
expected file URLs, an enabled security policy, and enabled private reporting.
