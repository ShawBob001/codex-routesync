# ShawBob001 Marketplace Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Codex SwitchBridge 0.8.0 as the new `ShawBob001.codex-switchbridge-vscode` Marketplace listing with a guarded migration from the legacy extension.

**Architecture:** Preserve local `CODEX_HOME` data and existing configuration keys, give Marketplace and UI contributions a distinct extension identity, and stop activation when the legacy extension is installed. Package one immutable VSIX for both GitHub and Marketplace distribution.

**Tech Stack:** TypeScript, VS Code Extension API, Node test runner, npm workspaces, `@vscode/vsce`, GitHub CLI.

---

### Task 1: Lock identity and migration behavior with tests

- [ ] Update manifest assertions for publisher, extension name, display name, and version.
- [ ] Add activation tests proving the legacy extension blocks initialization and gives the user a migration action.
- [ ] Assert the `codex-switchbridge.*` configuration namespace remains stable.

### Task 2: Implement the replacement identity and activation guard

- [ ] Set the 0.8.0 package identity and localized display name.
- [ ] Add the legacy-extension guard before route commands, watchers, and views register.
- [ ] Make command and view contributions collision-free while preserving configuration compatibility.

### Task 3: Document migration and distribution

- [ ] Add concise legacy-to-replacement migration steps to the Marketplace README and primary repository READMEs.
- [ ] Update VSIX filenames, direct Marketplace links, changelog, deployment notes, and release metadata.
- [ ] Keep private identity details and credentials out of public files.

### Task 4: Verify and package

- [ ] Run focused tests, type checks, the full repository verification, and visual checks.
- [ ] Build `codex-switchbridge-vscode-0.8.0.vsix`, validate the ZIP and manifest, scan it for secrets, and calculate SHA-256.
- [ ] Smoke-test a clean installation and the legacy-extension guard where the available VS Code environment permits.

### Task 5: Publish and verify

- [ ] Commit and push the release changes to GitHub.
- [ ] Create GitHub release `v0.8.0` with the verified VSIX and checksum asset.
- [ ] Upload the same VSIX to the `ShawBob001` Marketplace publisher, then verify the public listing and installation metadata.
