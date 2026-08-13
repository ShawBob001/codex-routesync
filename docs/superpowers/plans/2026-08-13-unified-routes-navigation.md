# Unified Routes Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three fragmented SwitchBridge sidebar views with one bilingual accounts-and-API routes tree that automatically opens or focuses the central dashboard.

**Architecture:** Compose the existing account and provider tree data sources behind a small `RoutesTreeProvider` with two presentation-only root groups. Contribute one view in the manifest and use its visibility event as the supported signal to show the existing idempotent dashboard panel.

**Tech Stack:** TypeScript, VS Code TreeView API, manifest NLS, Node test runner, Playwright visual tests

---

### Task 1: Define the single-view manifest contract

**Files:**
- Modify: `packages/vscode/test/packageManifest.test.js`
- Modify: `packages/vscode/package.json`
- Modify: `packages/vscode/package.nls.json`
- Modify: `packages/vscode/package.nls.zh-cn.json`

- [ ] **Step 1: Rewrite the manifest test to RED**

Assert the contributed view IDs are exactly:

```js
assert.deepEqual(
  manifest.contributes.views["codex-switchbridge"].map((view) => view.id),
  ["codexSwitchBridgeRoutes"],
);
```

Assert no serialized `view/title`, `view/item/context`, or `viewsWelcome` entry contains `codexSwitchBridgeOverview`, `codexSwitchBridgeAccounts`, or `codexSwitchBridgeProviders`. Assert English and Chinese NLS contain `view.routes.name`.

- [ ] **Step 2: Run the test and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH node --test --test-name-pattern='native views|view menus|routes' packages/vscode/test/packageManifest.test.js`

Expected: FAIL with three existing view IDs.

- [ ] **Step 3: Implement the minimal manifest change**

Contribute:

```json
{
  "id": "codexSwitchBridgeRoutes",
  "name": "%view.routes.name%",
  "icon": "resources/icon.svg",
  "showCollapseAll": true
}
```

Set `view.routes.name` to `Accounts & API Routes` and `账号与 API 路由`. Retarget all title/context menu predicates to `view == codexSwitchBridgeRoutes`; keep Open Dashboard, Refresh, Add Account, and Add API Provider in navigation groups and move less frequent actions to overflow groups.

- [ ] **Step 4: Run the manifest test and verify GREEN**

Run the focused command from Step 2. Expected: PASS.

### Task 2: Build the composite routes tree with TDD

**Files:**
- Create: `packages/vscode/src/routesTree.ts`
- Create: `packages/vscode/test/routesTree.test.js`
- Modify: `packages/vscode/scripts/build.mjs`

- [ ] **Step 1: Write failing provider tests**

Bundle `routesTree.ts` with a minimal `vscode` mock and assert:

```js
const roots = routes.getChildren();
assert.deepEqual(roots.map((item) => item.kind), ["accounts", "providers"]);
assert.deepEqual(routes.getChildren(roots[0]), accountRoots);
assert.deepEqual(routes.getChildren(roots[1]), providerRoots);
assert.equal(routes.getParent(accountRoots[0]), roots[0]);
assert.equal(routes.getParent(providerRoots[0]), roots[1]);
```

Also assert a child refresh from either delegate fires one unified root refresh and that Chinese labels are `账号` and `API 提供商`.

- [ ] **Step 2: Run and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH node --test packages/vscode/test/routesTree.test.js`

Expected: FAIL because `routesTree.ts` does not exist.

- [ ] **Step 3: Implement `RoutesTreeProvider`**

Create:

```ts
export type RoutesTreeNode = RoutesGroupItem | AccountTreeNode | ProviderTreeNode;
export type RoutesGroupKind = "accounts" | "providers";

export class RoutesGroupItem extends vscode.TreeItem {
  constructor(
    public readonly kind: RoutesGroupKind,
    label: string,
    description: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `routesGroup:${kind}`;
    this.contextValue = `routesGroup.${kind}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}
```

Delegate children/tree items/parents to the existing providers, cache the two route groups, subscribe to both delegate change events, and expose `refreshLocale()` to rebuild group labels.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 3: Register one TreeView and auto-show the dashboard

**Files:**
- Modify: `packages/vscode/test/addAccount.test.js`
- Modify: `packages/vscode/src/extension.ts`
- Delete: `packages/vscode/src/dashboardLauncher.ts`

- [ ] **Step 1: Extend the TreeView mock and write RED activation tests**

Make mock TreeViews expose `visible`, `onDidChangeVisibility`, and `setVisible(visible)`. Replace the existing “three native trees” test with assertions that:

```js
assert.deepEqual([...mocked.treeViews.keys()], ["codexSwitchBridgeRoutes"]);
assert.equal(mocked.webviewPanels.length, 0);
routesView.setVisible(true);
assert.equal(mocked.webviewPanels.length, 1);
routesView.setVisible(false);
routesView.setVisible(true);
assert.equal(mocked.webviewPanels.length, 1);
```

Add a separate initial-`visible: true` case that opens one panel during activation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/vscode && node --test --test-name-pattern='unified route|visible.*dashboard|activation registers' packages/vscode/test/addAccount.test.js`

Expected: FAIL because activation still creates three trees and has no visibility listener.

- [ ] **Step 3: Register and wire the unified view**

Instantiate `RoutesTreeProvider`, create only `codexSwitchBridgeRoutes`, and wire:

```ts
const showDashboardWhenVisible = ({ visible }: { visible: boolean }) => {
  if (visible) dashboardView.show();
};
const visibilitySubscription = routesTreeView.onDidChangeVisibility(showDashboardWhenVisible);
if (routesTreeView.visible) dashboardView.show();
```

Pass the unified TreeView to `registerCommands`, dispose the composite and visibility subscription, and remove `DashboardLauncher`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused activation command. Expected: PASS.

### Task 4: Preserve account/provider commands through the unified tree

**Files:**
- Modify: `packages/vscode/test/addAccount.test.js`
- Modify: `packages/vscode/src/commands.ts`

- [ ] **Step 1: Add branch navigation helpers to tests**

Add explicit helpers:

```js
function getRoutesTree(mocked) {
  return mocked.treeViews.get("codexSwitchBridgeRoutes").treeDataProvider;
}
function getRouteGroup(mocked, kind) {
  return getRoutesTree(mocked).getChildren().find((item) => item.kind === kind);
}
function getAccountRoots(mocked) {
  return getRoutesTree(mocked).getChildren(getRouteGroup(mocked, "accounts"));
}
function getProviderRoots(mocked) {
  return getRoutesTree(mocked).getChildren(getRouteGroup(mocked, "providers"));
}
```

Mechanically replace direct reads of the two legacy TreeViews with these helpers; do not add fake legacy IDs to the mock.

- [ ] **Step 2: Update command typing and reveal tests**

Change the `registerCommands` TreeView parameter to `vscode.TreeView<RoutesTreeNode>`. Verify Expand All Accounts and reveal operations still traverse `getParent()` through the accounts root group.

- [ ] **Step 3: Run the complete activation/command test file**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/vscode && node --test packages/vscode/test/addAccount.test.js`

Expected: PASS with no reference to legacy view IDs.

### Task 5: Refresh runtime labels when language changes

**Files:**
- Modify: `packages/vscode/test/routesTree.test.js`
- Modify: `packages/vscode/src/routesTree.ts`
- Modify: `packages/vscode/src/extension.ts`

- [ ] **Step 1: Add a failing locale refresh test**

Change the locale provider from `en` to `zh-cn`, call `refreshLocale()`, and assert new root labels plus one tree refresh event.

- [ ] **Step 2: Run and verify RED**

Run the routes tree test. Expected: FAIL until locale refresh is implemented.

- [ ] **Step 3: Wire locale changes**

Use the same effective locale resolver as the dashboard. On `codex-switchbridge.language` configuration changes, call `routesTree.refreshLocale()` in addition to invalidating the dashboard.

- [ ] **Step 4: Verify routes and activation tests**

Run both focused test files. Expected: PASS.

### Task 6: Package a local 0.6.1 validation build

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/vscode/package.json`
- Modify: `packages/vscode/CHANGELOG.md` or the repository's existing changelog path

- [ ] **Step 1: Bump the patch version without tagging**

Set the monorepo and VS Code extension versions to `0.6.1`, update the lockfile mechanically, and document the proxy-safe quota/refresh fix plus unified navigation.

- [ ] **Step 2: Run full verification**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run verify`

Expected: exit 0 with no failed tests.

- [ ] **Step 3: Run visual verification**

Run:

```bash
LD_LIBRARY_PATH=/tmp/csb-playwright-libs/lib \
FONTCONFIG_FILE=$PWD/.superpowers/brainstorm/fonts.conf \
FONTCONFIG_PATH=/tmp/csb-playwright-libs/etc/fonts \
PATH=/tmp/csb-node.cfY4xx/bin:$PATH \
npm run test:visual -w packages/vscode
```

Expected: all visual cases PASS and dependency audit reports zero violations.

- [ ] **Step 4: Package and inspect the VSIX**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run package:vscode`

Expected: `packages/vscode/codex-switchbridge-0.6.1.vsix` is created. Inspect its manifest to confirm only `codexSwitchBridgeRoutes` is contributed and `dist/extension.js` contains the proxy-safe transport.

- [ ] **Step 5: Install locally for user validation**

Install the VSIX with the current VS Code Server CLI using `--force`. Do not publish or push in this task. Report that one Reload Window is required to activate the newly installed bundle.
