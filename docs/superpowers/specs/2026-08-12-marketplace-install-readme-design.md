# Marketplace Install Entry Design

Status: Approved

Date: 2026-08-12

## Goal

Make it obvious from the GitHub repository that Codex SwitchBridge can be installed directly from the Visual Studio Marketplace and from the VS Code Extensions view.

## README Structure

The root README will add a Visual Studio Marketplace version badge beside the existing GitHub release and license badges. The badge and a short **Install from Visual Studio Marketplace** link will point to:

`https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge`

The VS Code quick-start section in both `README.md` and `packages/vscode/README.md` will use this order:

1. Install from the Marketplace link.
2. In VS Code, open Extensions and search for `Codex SwitchBridge` or `@id:baoshichao001-dev.codex-switchbridge`.
3. Use the latest VSIX from GitHub Releases only for offline or manual installation.

The instructions will not hard-code a VSIX version in prose or commands. The shell example will use `codex-switchbridge-VERSION.vsix`, and the text will tell readers to replace `VERSION` with the version in the downloaded filename. The placeholder must not use angle brackets because an unquoted `<` is shell redirection.

## Repository Metadata

The GitHub repository homepage field will point to the public Marketplace item page. The repository description remains unchanged because it already describes the product rather than an installation channel.

## Scope And Verification

This is a documentation and repository-metadata change only. It does not change extension code, package versions, release artifacts, or Marketplace content.

Verification requires:

- both README files contain the exact Marketplace item URL and extension ID;
- the root README contains the Marketplace badge and direct install link;
- neither README names the stale `codex-switchbridge-0.3.0.vsix` artifact;
- both README files use the shell-safe `codex-switchbridge-VERSION.vsix` placeholder and explain how to replace `VERSION`;
- neither README contains the unsafe `codex-switchbridge-<version>.vsix` form;
- Markdown links use public HTTPS targets;
- the Marketplace public API reports version 0.3.1 and VSIX SHA-256 `7639ace6f827f57a7e773762f78c252c692de1ad63c96af855bf3b3b31015971` at the time of the change;
- GitHub reports its homepage field as the Marketplace item URL after merge.
