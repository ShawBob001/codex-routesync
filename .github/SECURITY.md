# Security Policy

Codex SwitchBridge handles authentication files, API-provider settings, proxy
configuration, and local conversation metadata. Please report security problems
privately so users have time to update before technical details are published.

## Supported versions

| Version | Security updates |
| --- | --- |
| 0.7.x | Supported |
| 0.6.x and earlier | Not supported |

Security fixes are released for the latest stable minor version. Upgrade to the
latest Marketplace or GitHub release before reporting a problem that may already
have been fixed.

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/ShawBob001/codex-switchbridge/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include the following when it is safe to do so:

- the affected SwitchBridge version and installation source;
- the VS Code or CLI surface, operating system, and Codex version;
- a minimal reproduction using fake credentials and a temporary `CODEX_HOME`;
- the expected impact and any conditions needed to reproduce it;
- redacted logs, screenshots, or proof-of-concept code.

Never submit real `auth.json`, `auth_*.json`, or `provider_*.json` files. Remove
API keys, access/refresh/ID tokens, cookies, account names, email addresses,
proxy credentials, SecretStorage values, conversation text, rollout files, and
private filesystem paths from every report.

The maintainer will make a best-effort acknowledgement within 7 days, confirm
the initial assessment within 14 days, and coordinate remediation and disclosure
with the reporter. The target is to resolve confirmed vulnerabilities within 90
days, but severity, platform dependencies, and release coordination may affect
that timeline. Please wait for a fixed release before publishing details.

## Security scope

Reports are especially useful when they concern:

- credential or secret exposure through logs, errors, webviews, exports, or sync;
- unsafe OAuth refresh or API-provider switching behavior;
- path traversal, symbolic-link handling, file permissions, or atomic writes;
- corruption or unintended disclosure during history repair, backup, or rollback;
- proxy credential leakage or bypass of configured proxy exclusions;
- extension-command, webview-message, or cross-window trust boundaries.

Ordinary authorization failures, quota-display problems, compatibility issues,
and feature bugs that do not expose data belong in the public bug-report form.
