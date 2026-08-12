# Auth Switch Unauthorized Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account switching and re-login reliably leave API-provider mode, install fresh OAuth credentials, and warn about competing auth managers.

**Architecture:** The core owns compatibility migration and transactional route cleanup. The VS Code command layer performs login in an isolated Codex home, validates the returned identity, activates the updated account through existing switching APIs, and applies the established reload policy. Extension activation reports known writers of the same auth file without coupling core logic to VS Code.

**Tech Stack:** TypeScript, Node.js test runner, esbuild, VS Code Extension API, npm workspaces, VSIX/vsce.

---

### Task 1: Migrate legacy shared-history route state

**Files:**
- Modify: `packages/core/src/liveSwitch.ts`
- Test: `packages/core/test/shared-history.test.js`

- [ ] Add a failing test that writes `account-switch-shared-history.json`, a provider `openai_base_url`, and provider auth, then calls `activateAccountAuth()` and expects the recorded original URL to be restored and both route files to be absent.
- [ ] Add failing coverage for current-file precedence and rollback snapshots of both filenames.
- [ ] Run `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run test -w packages/core -- --test-name-pattern='legacy shared route'` and confirm the missing migration fails.
- [ ] Add a shared parser, atomically migrate a valid legacy file when no current file exists, and include both route files in transaction snapshots.
- [ ] Re-run the focused core tests and then `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run test -w packages/core`.
- [ ] Commit the core fix and tests.

### Task 2: Make account re-login transactional and reload-aware

**Files:**
- Modify: `packages/vscode/src/commands.ts`
- Modify: `packages/vscode/src/savedEntries.ts` only if an existing save/activation boundary cannot express the transaction
- Test: `packages/vscode/test/addAccount.test.js`

- [ ] Add a failing active-account test that verifies the login terminal receives a transient `CODEX_HOME`, the validated new OAuth auth replaces both saved and live auth, and `reloadWindowAfterSwitch=always` executes Reload Window.
- [ ] Add a failing test that clicks `Done` without a transient auth result and verifies live and saved auth remain unchanged with an error message.
- [ ] Add a failing inactive-account test that verifies fresh auth is saved but the prior active runtime remains selected and no reload is requested.
- [ ] Run focused VS Code tests and confirm failures come from the current live-home login and missing reload.
- [ ] Replace `runCodexLogin` use in re-login with `runTransientCodexLogin`, validate account OAuth and identity, save with `selectAfterSave: false`, then activate only when the target was active and apply the existing reload policy.
- [ ] Re-run focused tests and the complete VS Code test suite.
- [ ] Commit the re-login fix and tests.

### Task 3: Detect competing auth managers

**Files:**
- Modify: `packages/vscode/src/extension.ts`
- Test: `packages/vscode/test/addAccount.test.js`

- [ ] Extend the VS Code mock with `extensions.getExtension` and add a failing activation test for active `wannanbigpig.codex-accounts-manager`.
- [ ] Add a companion test proving an installed but inactive extension does not warn.
- [ ] Run the focused activation tests and confirm the active-conflict case fails.
- [ ] Add a small activation helper that logs and shows one warning naming the conflicting extension and explaining `auth.json` contention.
- [ ] Re-run focused and complete VS Code tests.
- [ ] Commit the conflict detection and tests.

### Task 4: Version, verify, package, and repair runtime

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/vscode/package.json`

- [ ] Bump the root and VS Code extension patch version from `0.4.0` to `0.4.1` using npm's workspace-aware version tooling without tagging.
- [ ] Run `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run verify` and require zero failures.
- [ ] Run `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build` and package the VSIX.
- [ ] Review the complete diff for secrets, unrelated changes, and release metadata consistency.
- [ ] Merge the verified branch into local `main`, install the `0.4.1` VSIX with `--force`, and remove the known competing auth-manager extension.
- [ ] Back up the live Codex auth/config/route files, migrate the legacy route state, activate the user's most recently selected account, and verify only structural fields and hashes: OAuth tokens present, API key absent, provider route absent.
- [ ] Tell the user to execute Reload Window, because the currently running extension host cannot be safely reloaded from this non-interactive terminal without disrupting the active conversation.
