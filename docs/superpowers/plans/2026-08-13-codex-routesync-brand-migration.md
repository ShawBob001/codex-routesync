# Codex RouteSync Brand Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the public project, VS Code extension, GitHub repository, and release package to Codex RouteSync without breaking existing settings or CLI commands.

**Architecture:** Treat public branding and the VS Code runtime contribution namespace as the new identity. Retain the existing settings namespace and CLI package/command names as compatibility interfaces, while guarding activation against both previous extension identities.

**Tech Stack:** TypeScript, VS Code extension manifest/NLS, Node test runner, npm workspaces, VSCE, GitHub CLI.

---

### Task 1: Brand Contract Tests

**Files:**
- Modify: `packages/vscode/test/packageManifest.test.js`
- Modify: `packages/vscode/test/readmeLanguages.test.js`
- Modify: `packages/vscode/test/addAccount.test.js`

- [ ] Change manifest expectations to `ShawBob001.codex-routesync`, display name `Codex RouteSync`, version `0.8.1`, and the `codex-routesync.*` runtime namespace.
- [ ] Change documentation expectations to the `codex-routesync` repository, Marketplace URL, and VSIX filename.
- [ ] Add an activation test for the version 0.8.0 identity `ShawBob001.codex-switchbridge-vscode` while retaining coverage for the original identity.
- [ ] Run the focused tests and confirm they fail on the old brand values.

### Task 2: Extension And Workspace Identity

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/vscode/package.json`
- Modify: `packages/vscode/package.nls.json`
- Modify: `packages/vscode/package.nls.zh-cn.json`
- Modify: `packages/vscode/src/**/*.ts`
- Modify: `packages/vscode/test/**/*.js`

- [ ] Set root and VS Code versions to `0.8.1` and use the RouteSync package/repository identity.
- [ ] Replace VS Code command, activity container, view, context, and webview namespaces with RouteSync identifiers.
- [ ] Replace user-visible SwitchBridge brand strings with Codex RouteSync.
- [ ] Keep every `codex-switchbridge.*` configuration property and current CLI package/command intact.
- [ ] Implement activation blocking for both earlier Marketplace identities.
- [ ] Run focused tests and confirm they pass.

### Task 3: Public Documentation

**Files:**
- Modify: `README*.md`
- Modify: `packages/vscode/README.md`
- Modify: `.github/**/*.md`
- Modify: `docs/*.md`
- Modify: `packages/vscode/CHANGELOG.md`

- [ ] Update headings, descriptions, badges, repository links, Marketplace links, and VSIX install examples.
- [ ] Add the `0.8.1` brand migration changelog entry and retain accurate historical release notes.
- [ ] Update migration language to cover both previous extension identities without exposing the private legacy publisher alias in public documentation.
- [ ] Run README and manifest contract tests.

### Task 4: Package Verification

**Files:**
- Create: `packages/vscode/codex-routesync-0.8.1.vsix`

- [ ] Run `npm run verify` and require zero failures.
- [ ] Run `npm run build` and require exit code zero.
- [ ] Package with VSCE and inspect the embedded manifest.
- [ ] Run `unzip -t` and install into an isolated VS Code-compatible user/extensions directory.
- [ ] Record the SHA-256 digest.

### Task 5: GitHub Rename And Release

**Files:**
- Modify remote repository metadata and the local `origin` URL.

- [ ] Commit and push the verified migration.
- [ ] Rename `ShawBob001/codex-switchbridge` to `ShawBob001/codex-routesync`.
- [ ] Update the repository description and homepage to the RouteSync Marketplace URL.
- [ ] Confirm GitHub Actions succeeds on the pushed commit.
- [ ] Create tag and GitHub Release `v0.8.1` with the VSIX and SHA-256 checksum.
- [ ] Confirm the public repository, release assets, and direct Marketplace target use the new identity.
