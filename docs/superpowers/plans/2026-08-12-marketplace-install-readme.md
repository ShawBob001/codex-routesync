# Marketplace Install README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub repository clearly advertise direct installation from the Visual Studio Marketplace and the VS Code Extensions view.

**Architecture:** Keep installation instructions in the two existing README files and use one canonical Marketplace item URL and extension ID. Treat GitHub Releases as the offline fallback, and update the repository homepage only after the documentation PR is merged.

**Tech Stack:** Markdown, shell/Node static checks, Visual Studio Marketplace public metadata, GitHub CLI.

---

### Task 1: Add Marketplace Installation To Both READMEs

**Files:**
- Modify: `README.md`
- Modify: `packages/vscode/README.md`

- [ ] **Step 1: Run the static contract before editing**

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH node - <<'NODE'
const fs = require("node:fs");
const assert = require("node:assert/strict");
const files = ["README.md", "packages/vscode/README.md"];
const marketplace = "https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge";
const extensionId = "@id:baoshichao001-dev.codex-switchbridge";
const safeVsix = "codex-switchbridge-VERSION.vsix";
const unsafeVsix = "codex-switchbridge-<version>.vsix";
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(marketplace), `${file}: Marketplace URL missing`);
  assert.ok(text.includes(extensionId), `${file}: extension ID missing`);
  assert.doesNotMatch(text, /codex-switchbridge-0\.3\.0\.vsix/);
  assert.ok(text.includes(safeVsix), `${file}: shell-safe VSIX placeholder missing`);
  assert.ok(!text.includes(unsafeVsix), `${file}: unsafe shell-redirection placeholder found`);
  assert.match(text, /Replace VERSION with the version in the downloaded filename\./);
}
const root = fs.readFileSync("README.md", "utf8");
assert.match(root, /visual studio marketplace/i);
assert.match(root, /visual-studio-marketplace\/v\/baoshichao001-dev\.codex-switchbridge/i);
NODE
```

Expected: FAIL because both README files lack the Marketplace URL and extension ID, and still name the 0.3.0 VSIX.

- [ ] **Step 2: Update the root README first viewport**

Add this badge beside the existing release and license badges:

```markdown
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/baoshichao001-dev.codex-switchbridge?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge)
```

Replace the VS Code quick-start body with concise instructions in this order:

```markdown
[Install Codex SwitchBridge from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge), or open **Extensions** in VS Code and search for `Codex SwitchBridge` or `@id:baoshichao001-dev.codex-switchbridge`.

For offline installation, download the latest `.vsix` from [GitHub Releases](https://github.com/baoshichao001-dev/codex-switchbridge/releases), then run **Extensions: Install from VSIX...** or:

Replace VERSION with the version in the downloaded filename.

```bash
code --install-extension codex-switchbridge-VERSION.vsix
```
```

- [ ] **Step 3: Update the extension README install section**

Use the same Marketplace link, VS Code search terms, offline fallback, and version-neutral shell command from Step 2. Keep the existing warning about disabling conflicting switch extensions immediately after installation instructions.

- [ ] **Step 4: Humanize and consistency-check the text**

Read both edited sections aloud as technical instructions. Remove promotional filler, repeated phrasing, em/en dashes, and claims not supported by the Marketplace page. Keep the product name, URL, extension ID, and commands exact.

- [ ] **Step 5: Run the static contract after editing**

Run the Node script from Step 1 again.

Expected: exit 0 with no output. Both README files contain the shell-safe `codex-switchbridge-VERSION.vsix` placeholder and reject `codex-switchbridge-<version>.vsix`.

- [ ] **Step 6: Verify the VSIX example does not invoke shell redirection**

```bash
bash -c 'code(){ :; }; code --install-extension codex-switchbridge-VERSION.vsix'
```

Expected: exit 0. Do not substitute `bash -n`; shell syntax validation accepts redirections and would not catch the unsafe placeholder.

- [ ] **Step 7: Verify Markdown destinations respond**

```bash
curl -fsSL -A 'Mozilla/5.0' -o /dev/null -w '%{http_code}\n' \
  'https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge'
curl -fsSL -A 'Mozilla/5.0' -o /dev/null -w '%{http_code}\n' \
  'https://github.com/baoshichao001-dev/codex-switchbridge/releases'
```

Expected: both commands exit 0 and print `200`. The Marketplace route returns 404 to HEAD requests, so this check uses GET.

- [ ] **Step 8: Commit documentation**

```bash
git add README.md packages/vscode/README.md
git commit -m "Document VS Code Marketplace installation"
```

### Task 2: Verify Public Marketplace Metadata

**Files:** None.

- [ ] **Step 1: Query the published extension**

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npx --yes @vscode/vsce@3.9.2 \
  show baoshichao001-dev.codex-switchbridge --json
```

Expected: extension name `codex-switchbridge`, version `0.3.1`, and VSIX SHA-256 `7639ace6f827f57a7e773762f78c252c692de1ad63c96af855bf3b3b31015971`.

- [ ] **Step 2: Confirm the documentation diff is isolated**

```bash
git diff --check origin/main..HEAD
git diff --name-only origin/main..HEAD
```

Expected: the spec, plan, `README.md`, and `packages/vscode/README.md` only; no package, source, release, or binary changes.

### Task 3: Publish And Update GitHub Repository Metadata

**Files:** None.

- [ ] **Step 1: Push and merge the documentation PR**

Push `agent/marketplace-install-readme`, create a PR against `main`, include the static check and Marketplace metadata evidence, mark it ready, and squash-merge it.

- [ ] **Step 2: Update the repository homepage**

```bash
gh repo edit baoshichao001-dev/codex-switchbridge \
  --homepage 'https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge'
```

- [ ] **Step 3: Verify the merged repository state**

```bash
gh repo view baoshichao001-dev/codex-switchbridge \
  --json defaultBranchRef,description,homepageUrl,url
```

Expected: `main` is the default branch, the existing product description is unchanged, and `homepageUrl` is the Marketplace item URL.
