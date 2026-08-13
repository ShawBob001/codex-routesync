# Open Source Maintenance

## Project purpose

Codex SwitchBridge addresses a practical compatibility gap in local Codex use.
Conversations created through official Codex account authentication and through
Responses-compatible third-party API routes can otherwise appear in separate
local histories when the model-provider identity changes. SwitchBridge applies
credentials and routing as one guarded transition while retaining a shared local
history identity for compatible routes.

The project does not copy ChatGPT web history, Codex Cloud tasks, or conversations
between devices. It manages local Codex state and preserves the upstream MIT
attribution described in the repository license.

## Current state

The core workflow is implemented and publicly released as a VS Code extension
and CLI. It currently covers:

- guarded switching between saved Codex accounts and compatible API providers;
- shared local conversation-history routing and backup-first repair tools;
- credential preservation, rollback, storage encryption, and proxy-aware refresh;
- account quota reset clocks and device-local token-usage analysis;
- an editor dashboard with English and Simplified Chinese interfaces;
- automated unit, integration, migration, manifest, and visual regression tests.

This is a mature foundation for the problem it addresses, not a claim that every
Codex version, provider, or platform edge case is finished. Compatibility and
security work will continue as Codex changes and users report concrete needs.

## Maintainer commitment

Codex SwitchBridge is intended to remain an actively maintained, long-term
open-source project. Maintenance includes issue triage, review of focused
contributions, compatibility testing, security response, documentation, and
release management.

Project decisions are made in public issues and pull requests whenever possible.
Changes are evaluated against three priorities: preserving credentials and local
history safely, remaining compatible with supported Codex workflows, and keeping
common switching tasks understandable in VS Code and the CLI. Adoption numbers
are reported from public sources when relevant; local token counters are never
presented as project usage or user adoption.

## Near-term maintenance priorities

1. Track Codex authentication, App Server, history, and configuration changes.
2. Expand cross-platform and remote-extension-host compatibility coverage.
3. Harden credential, proxy, sync, backup, and history-repair boundaries.
4. Turn real bug reports into regression tests and improve contributor onboarding.
5. Extend documentation and localization based on demonstrated user demand.

The roadmap follows confirmed maintenance needs rather than a fixed feature
count. Requests that weaken credential safety, depend on undocumented remote
data, or misrepresent local usage as billing data will not be accepted.

## Participate

Start with the [contribution guide](../.github/CONTRIBUTING.md). Use the structured
issue forms for bugs, requests, and questions. Report sensitive problems through
the private route in the [security policy](../.github/SECURITY.md).
