# Auth Switch Unauthorized Fix Design

## Problem

Switching from an API provider to a saved Codex account can leave Codex routed through the provider and return `401 Unauthorized`. A legacy route-state file from the pre-SwitchBridge project name is not recognized by current releases, active-account re-login can accept an unchanged or missing auth file, and the Codex process may continue caching the old credential until VS Code reloads. A second installed account manager can also write the same global `auth.json` concurrently.

## Design

### Legacy route migration

The core live-switch layer will recognize `account-switch-shared-history.json` as the single legacy route-state filename. It will validate it with the same schema used for the current file, migrate it atomically to `switchbridge-shared-history.json`, and remove the legacy file only after the current file is written. If both files exist, the current file remains authoritative. A successful route write or clear removes the stale legacy file so it cannot be migrated later and revive an obsolete provider route. Live-switch backups will snapshot both filenames so rollback restores the exact pre-switch state.

Account activation will then consume the migrated route state and restore its recorded original `openai_base_url`. This avoids deleting a user-defined account base URL when no SwitchBridge route state exists.

### Reliable re-login

Re-login will use the existing transient login directory rather than the live `CODEX_HOME`. Clicking `Done` is only a request to inspect the transient result; the operation succeeds only when that directory contains a valid account OAuth payload. The returned identity must match the saved account being updated. The saved entry is overwritten with the new auth while preserving the previously active selection when re-login targets an inactive account.

When the re-login target is the active account, the validated auth becomes the live auth through the same transactional account activation primitive. Re-login deliberately does not rewrite the current-selection marker: that asynchronous write could overwrite a selection made while login was open. A cloud marker whose sync metadata is now stale is reconciled by the existing saved-entry guard before the next account operation. The existing reload policy is then applied so Codex cannot silently keep using its cached revoked token. Cancelling or failing transient login leaves the live auth, route, saved entry, and selection unchanged.

### Conflict warning

On activation, SwitchBridge will check for known extensions that also manage global Codex authentication. If one is installed and active, it will show one actionable warning explaining that simultaneous use can overwrite `auth.json`. The warning is diagnostic and does not uninstall or disable another extension automatically.

## Error handling

- Invalid legacy route JSON is reported through the existing invalid-state error path and is not deleted.
- Missing, provider-mode, or identity-mismatched transient login output is rejected without touching saved credentials.
- Cloud sync conflicts continue through the existing conflict warning path.
- A conflict-extension lookup failure does not block SwitchBridge activation.

## Testing

- Core regression tests reproduce the legacy filename plus stale provider `openai_base_url`, verify account activation clears the route, verify migration is atomic, and verify rollback restores both state files.
- VS Code command tests verify active-account re-login uses a transient `CODEX_HOME`, rejects missing auth, writes the new auth, and applies `always` and `statusBar` reload policies only when the active runtime changes.
- Activation tests verify the competing extension warning appears only when the known extension is active.
- The full monorepo test suite, migration tests, build, and VSIX packaging must pass before installation.

## Version and installation

The VS Code extension patch version will become `0.4.1`. The verified VSIX will be installed with force enabled. The current machine's legacy route will be repaired by the installed core switching logic when the target account is activated; the competing extension will be uninstalled only because the user asked to repair the running setup and the extension cannot be disabled persistently through the available remote CLI.
