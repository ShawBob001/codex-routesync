# Codex RouteSync Brand Migration Design

## Goal

Rename the public project and the unpublished replacement VS Code extension to **Codex RouteSync**, using the GitHub repository `ShawBob001/codex-routesync` and Marketplace identity `ShawBob001.codex-routesync`.

## Identity Boundaries

- Public product name: `Codex RouteSync`.
- GitHub repository: `ShawBob001/codex-routesync`.
- VS Code extension package and command namespace: `codex-routesync`.
- VSIX filename: `codex-routesync-0.8.1.vsix`.
- Existing `codex-switchbridge.*` VS Code settings remain unchanged so user preferences continue to load.
- Existing `codex-switchbridge` CLI commands and published package names remain unchanged to avoid a breaking CLI migration.

## Migration Safety

The new extension must refuse activation while either earlier extension identity is installed:

- the original Marketplace identity used before version 0.8.0;
- `ShawBob001.codex-switchbridge-vscode`, the unpublished replacement identity produced in version 0.8.0.

The warning directs the user to move synced or cloud entries to Local storage, disable or uninstall the old extension, reload VS Code, and then open Codex RouteSync. Local `CODEX_HOME` data and the compatible settings namespace remain available.

## Documentation And Release

All current public documentation, badges, repository metadata, screenshots' alt text, Marketplace links, install commands, and contribution templates use the RouteSync brand. Historical design documents and changelog entries may describe former names when required to explain migration history.

Version `0.8.1` is the first Codex RouteSync build. The release includes the VSIX and checksum file and is published from the renamed GitHub repository after local verification and CI success.

## Verification

- Manifest tests assert the new publisher/name/version/display name and runtime namespace.
- Migration tests assert both previous extension identities block activation before any stateful initialization.
- README tests assert direct RouteSync Marketplace/GitHub links and the RouteSync VSIX command.
- Full tests, build, packaging, archive integrity, isolated installation, and GitHub CI must pass.
