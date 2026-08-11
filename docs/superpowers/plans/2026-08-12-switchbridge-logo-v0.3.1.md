# SwitchBridge Logo v0.3.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the VS Code extension icon with the approved S-Bridge identity, ship extension version 0.3.1, validate the packaged extension locally, publish it to GitHub, and install the exact VSIX on b200 when that SSH target is reachable.

**Architecture:** Keep the brand source deterministic and vector-native. A color SVG is the editable master for the Marketplace PNG, while a separate `currentColor` SVG carries the same geometry in the VS Code Activity Bar. Tests validate identity, asset safety, and PNG dimensions without adding runtime dependencies.

**Tech Stack:** SVG, PNG, Node.js built-in test runner, npm workspaces, `@vscode/vsce`, VS Code remote CLI, GitHub CLI, SSH/SCP.

---

### Task 1: Add Failing Brand-Asset Tests

**Files:**
- Modify: `packages/vscode/test/packageManifest.test.js`

- [ ] **Step 1: Update the identity assertion to 0.3.1**

Change the test title and expected version:

```js
test("extension identity is Codex SwitchBridge 0.3.1", () => {
  assert.equal(manifest.name, "codex-switchbridge");
  assert.equal(manifest.displayName, "Codex SwitchBridge");
  assert.equal(manifest.publisher, "baoshichao001-dev");
  assert.equal(manifest.version, "0.3.1");
```

- [ ] **Step 2: Add an asset contract test**

```js
test("S-Bridge brand assets are self-contained and Marketplace-ready", () => {
  const resources = path.join(__dirname, "..", "resources");
  const colorSvg = fs.readFileSync(
    path.join(resources, "icon-color.svg"),
    "utf-8",
  );
  const activitySvg = fs.readFileSync(
    path.join(resources, "icon.svg"),
    "utf-8",
  );
  const png = fs.readFileSync(path.join(resources, "icon.png"));

  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);

  for (const svg of [colorSvg, activitySvg]) {
    assert.doesNotMatch(svg, /<(?:text|image)\b/i);
    assert.doesNotMatch(svg, /\b(?:href|xlink:href)=/i);
    assert.doesNotMatch(svg, /url\(/i);
  }

  assert.match(colorSvg, /#111827/i);
  assert.match(colorSvg, /#2f66e8/i);
  assert.match(colorSvg, /#58d4e8/i);
  assert.match(activitySvg, /currentColor/);
  assert.doesNotMatch(activitySvg, /#[0-9a-f]{3,8}/i);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH node --test \
  --test-name-pattern="extension identity|S-Bridge brand" \
  packages/vscode/test/packageManifest.test.js
```

Expected: FAIL because the manifest is still 0.3.0 and `icon-color.svg` does not exist.

### Task 2: Create The S-Bridge Assets

**Files:**
- Create: `packages/vscode/resources/icon-color.svg`
- Modify: `packages/vscode/resources/icon.svg`
- Modify: `packages/vscode/resources/icon.png`

- [ ] **Step 1: Create the editable color master**

Create this self-contained 256 px SVG:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#111827"/>
  <path d="M29 36h47c15 0 26 11 26 25S91 85 76 85H55c-7 0-12 5-12 12v4H28v-5c0-16 11-27 27-27h21c7 0 11-3 11-9s-4-9-11-9H52v10z" fill="#58D4E8"/>
  <path d="M99 92H52c-15 0-26-11-26-25s11-24 26-24h21c7 0 12-5 12-12v-4h15v5c0 16-11 27-27 27H52c-7 0-11 3-11 9s4 9 11 9h24V67z" fill="#FFFFFF"/>
  <path d="m29 36 23 15H29zM99 92 76 77h23z" fill="#2F66E8"/>
  <circle cx="64" cy="64" r="7" fill="#2F66E8"/>
</svg>
```

- [ ] **Step 2: Replace the Activity Bar source**

Use one-color geometry that follows the same opposing routes:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 7h10c3 0 5 2 5 5s-2 5-5 5H9c-2 0-3 1-3 3"/>
  <path d="M20 17H10c-3 0-5-2-5-5s2-5 5-5h5c2 0 3-1 3-3"/>
  <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>
</svg>
```

- [ ] **Step 3: Render the Marketplace PNG from the master**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npx --yes sharp-cli@5.2.0 \
  -i packages/vscode/resources/icon-color.svg \
  -o packages/vscode/resources \
  -f png
mv -f packages/vscode/resources/icon-color.png \
  packages/vscode/resources/icon.png
```

The final command intentionally replaces the approved Marketplace icon. Confirm the file is 256 x 256 through the Node test rather than relying on filename or visual inspection.

### Task 3: Bump Extension Release Metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/vscode/package.json`
- Modify: `packages/vscode/CHANGELOG.md`

- [ ] **Step 1: Set release versions**

Set the root private package and VS Code workspace to `0.3.1`. In `package-lock.json`, update only the top-level version, `packages[""]`, and `packages["packages/vscode"]`. Leave Core and CLI at `0.3.0`.

- [ ] **Step 2: Add the changelog entry**

Insert above 0.3.0:

```markdown
## 0.3.1 - 2026-08-12

- Replaced the generic lightning icon with the S-Bridge identity across the Marketplace and VS Code Activity Bar.
- Added a self-contained editable color master and small-size brand asset validation.
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run the same focused Node command from Task 1.

Expected: 2 matching tests pass and no tests fail.

- [ ] **Step 4: Visually inspect the final PNG**

Open `packages/vscode/resources/icon.png` with the local image viewer. Verify the dark rounded field, cyan and white interlocked routes, blue route ends, and blue shared node are present with clear padding.

- [ ] **Step 5: Commit the implementation**

```bash
git add package.json package-lock.json packages/vscode/package.json \
  packages/vscode/CHANGELOG.md packages/vscode/resources \
  packages/vscode/test/packageManifest.test.js
git commit -m "Release v0.3.1 with S-Bridge logo"
```

### Task 4: Verify, Package, And Install Locally

**Files:**
- Create: `codex-switchbridge-v0.3.1-SHA256SUMS`
- Generate (ignored): `packages/vscode/codex-switchbridge-0.3.1.vsix`

- [ ] **Step 1: Run complete verification**

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run verify
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm audit --audit-level=moderate
git diff --check v0.3.0
```

Expected: all Core, CLI, VS Code, and migration tests pass; audit reports zero vulnerabilities; diff check is empty.

- [ ] **Step 2: Package and inspect the VSIX**

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run package:vscode
unzip -t packages/vscode/codex-switchbridge-0.3.1.vsix
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npx --yes @vscode/vsce@3.9.2 ls --tree --no-dependencies
```

Expected: archive integrity passes and the package contains `icon.png`, `icon.svg`, and `icon-color.svg`, with no source, test, credential, or environment files.

- [ ] **Step 3: Record the exact SHA-256**

Calculate the VSIX digest and create `codex-switchbridge-v0.3.1-SHA256SUMS` with the release filename and digest. Stage and commit that checksum file.

- [ ] **Step 4: Install the exact VSIX on the current VS Code server**

```bash
code --install-extension \
  /mnt/pfs/pynr16/Shichao_Bao/codex-switchbridge/packages/vscode/codex-switchbridge-0.3.1.vsix \
  --force
code --list-extensions --show-versions
```

Expected: installation succeeds and the list contains `baoshichao001-dev.codex-switchbridge@0.3.1`.

### Task 5: Publish GitHub Release

**Files:** None beyond committed release assets.

- [ ] **Step 1: Push a release branch and open a PR**

Push `agent/logo-v0.3.1`, create a PR against `main`, include verification evidence, mark it ready, and squash-merge it.

- [ ] **Step 2: Tag the merged commit**

Create and push annotated tag `v0.3.1` only after `main` contains the tested tree.

- [ ] **Step 3: Create and verify the GitHub release**

Upload `codex-switchbridge-0.3.1.vsix` and `codex-switchbridge-v0.3.1-SHA256SUMS`. Verify both assets, release URL, tag, and digest through `gh release view`.

### Task 6: Synchronize The Exact VSIX To b200

**Files:** Remote temporary VSIX only.

- [ ] **Step 1: Re-check target resolution before any remote write**

```bash
ssh -G b200
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 b200 true
```

Expected before proceeding: `HostName` resolves to a real address and the connection exits 0. Current 2026-08-12 evidence fails with `Could not resolve hostname b200`; if still failing, request the reachable SSH hostname or IP and do not claim synchronization.

- [ ] **Step 2: Create a private remote staging directory**

Run `umask 077; mktemp -d /tmp/codex-switchbridge.XXXXXX` through SSH and validate that the returned path starts with `/tmp/codex-switchbridge.` before using it.

- [ ] **Step 3: Upload and install the exact verified VSIX**

Use `scp` to upload `packages/vscode/codex-switchbridge-0.3.1.vsix` into the validated directory. Run the remote VS Code CLI with `--install-extension <exact-path> --force`, then confirm `baoshichao001-dev.codex-switchbridge@0.3.1` through `--list-extensions --show-versions`.

- [ ] **Step 4: Clean remote staging after successful installation**

Delete only the validated versioned VSIX and its validated random staging directory. Report the removal and that the package remains recoverable from the GitHub release.

### Task 7: Marketplace Handoff And Public Verification

**Files:** None.

- [ ] **Step 1: Supply the exact GitHub VSIX for manual Marketplace update**

Marketplace credentials are intentionally absent. Give the user the GitHub release download link and direct them to upload the VSIX as a new version under the existing `baoshichao001-dev.codex-switchbridge` entry.

- [ ] **Step 2: Verify public propagation after upload**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npx --yes @vscode/vsce@3.9.2 \
  show baoshichao001-dev.codex-switchbridge --json
```

Expected: public metadata reports 0.3.1 and `Microsoft.VisualStudio.Services.VsixSha256` matches the GitHub release asset.
