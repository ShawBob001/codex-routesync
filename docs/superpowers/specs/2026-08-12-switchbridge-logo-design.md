# Codex SwitchBridge Logo Design

Status: Approved direction, pending implementation

Date: 2026-08-12

## Goal

Replace the generic lightning icon with a distinct SwitchBridge mark that remains recognizable in the Visual Studio Marketplace and at VS Code Activity Bar sizes. The change is visual only and must not alter switching, history, token-usage, or storage behavior.

## Chosen Direction

The approved mark is **S-Bridge**. Two interlocked routes form an abstract `S`:

- the cyan route represents Codex account authentication;
- the white route represents API-provider authentication;
- the shared cobalt node represents one local conversation-history timeline;
- the opposing route ends communicate reversible switching.

The mark retains the current blue identity without retaining the old standalone lightning bolt.

## Geometry And Color

The color mark uses a near-black rounded-square field with flat geometric paths. It contains no text, gradient, glow, texture, or fine decorative lines.

| Role | Color |
| --- | --- |
| Background | `#111827` |
| Brand blue and shared node | `#2F66E8` |
| Account route | `#58D4E8` |
| API route | `#FFFFFF` |

The route widths, central opening, and outer padding must remain legible at 24 px. The Activity Bar variant uses the same silhouette in `currentColor`, with no colored background.

## Deliverables

- `packages/vscode/resources/icon-color.svg`: editable color master.
- `packages/vscode/resources/icon.png`: square Marketplace icon, rendered at 256 x 256 pixels.
- `packages/vscode/resources/icon.svg`: monochrome Activity Bar mark using `currentColor`.
- `packages/vscode/CHANGELOG.md`: a 0.3.1 entry describing the brand update.
- VS Code package and root release metadata updated to 0.3.1. Core and CLI packages remain at 0.3.0 because their shipped behavior does not change.

The existing filenames used by the extension manifest remain stable, so no command, view, or extension identifier changes are required.

## Validation

Implementation is complete only when all of the following hold:

1. The color mark is visually clear at 256, 128, 48, and 24 px on light and dark surfaces.
2. The monochrome mark is readable at 16 and 24 px in both light and dark VS Code themes.
3. `icon.png` is exactly 256 x 256 pixels and the SVG files parse without external fonts or linked assets.
4. The extension manifest tests, typecheck, bundle, and full repository verification pass.
5. The generated VSIX contains the intended icon files, installs locally as version 0.3.1, and has a recorded SHA-256 digest.

## Release

Publish a GitHub `v0.3.1` release containing the verified VSIX and checksum file. Marketplace credentials are not stored in this environment, so the exact VSIX will be supplied for manual upload through the existing publisher dashboard. After upload, verify that the public Marketplace record reports version 0.3.1 and the same VSIX digest.

No npm CLI release is part of this logo-only update.
