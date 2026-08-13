# ShawBob001 Marketplace Listing Design

## Goal

Publish Codex SwitchBridge under the verified `ShawBob001` Marketplace
publisher without deleting the legacy listing, exposing a private identity in
public documentation, or risking concurrent writers against one Codex profile.

## Extension Identity

The new Marketplace identity is `ShawBob001.codex-switchbridge-vscode` with the
display name **Codex SwitchBridge for VS Code** and version `0.8.0`. The distinct
manifest name and display name satisfy Marketplace uniqueness requirements while
keeping the Codex SwitchBridge project brand.

Existing user-facing configuration keys remain under `codex-switchbridge.*` so
VS Code settings continue to apply after migration. Internal command and view
identifiers may change where necessary to prevent contribution collisions with
the legacy extension.

## Coexistence Safety

The legacy and replacement extensions must not manage the same `CODEX_HOME` at
the same time. On activation, the replacement detects the legacy extension,
shows a migration warning, offers to open the Extensions view, and stops before
registering route-management commands or file watchers. The user must disable or
uninstall the legacy extension and reload VS Code before the replacement starts.

The legacy Marketplace item is retained. It can be unpublished separately after
the replacement has been verified, but it is not deleted as part of this release.

## State Continuity

Local accounts, API providers, configuration files, backups, and shared Codex
history live under the configured `CODEX_HOME` and are therefore available to
the replacement extension automatically. Standard VS Code settings also remain
available because their configuration keys do not change.

Marketplace extension storage is scoped by extension identity. Synced or cloud
records in the old extension's `globalState`, stored secrets, and extension-local
usage attribution cannot be read directly by the replacement. Before migration,
users should move synced accounts and providers to Local in the legacy extension.
They must re-enter any storage password in the replacement. Overall local usage
can be rebuilt from rollout files, but previously stored per-route attribution
may not be preserved.

## Distribution

The release produces `codex-switchbridge-vscode-0.8.0.vsix`, publishes the same
artifact as a GitHub release asset, and uses the direct Marketplace URL for the
new identity after the user uploads the VSIX to `ShawBob001`. No Marketplace PAT
is stored in this repository or requested through chat.

## Verification

Tests must lock the new manifest identity, version, migration guard, preserved
configuration namespace, package contents, documentation links, and absence of
secrets. The release is complete only after the full repository verification,
VSIX archive validation, GitHub release verification, and a live Marketplace
metadata check for `ShawBob001.codex-switchbridge-vscode`.
