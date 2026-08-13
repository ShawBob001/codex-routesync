# Sidebar Dashboard v0.4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview tree with a graphical, quota-first VS Code sidebar dashboard while keeping switching, shared history, token attribution, and native account/API Provider management behavior unchanged.

**Architecture:** Extract live account quota presentation state into one `QuotaStore` owned by the extension and refreshed only by `RefreshCoordinator`. Build a pure secret-free dashboard DTO, then deliver it through a restrictive `WebviewViewProvider` to a browser renderer that uses VS Code theme variables and a fixed allowlist of existing commands.

**Tech Stack:** TypeScript 5.9, VS Code Extension API 1.85, esbuild 0.25, Node.js test runner, HTML/CSS/SVG, Playwright visual tests, npm workspaces, `@vscode/vsce`.

---

## File Map

Create or change only the following feature-owned files:

- `packages/vscode/src/quotaStore.ts`: live immutable quota snapshots, cache hydration, refresh lifecycle, and relogin state.
- `packages/vscode/src/accountTree.ts`: native quota presentation that consumes `QuotaStore` instead of owning network state.
- `packages/vscode/src/refreshCoordinator.ts`: sole scheduler, now targeting `QuotaStore` and notifying dashboard model changes.
- `packages/vscode/src/dashboardModel.ts`: pure transformation from saved entries/quota/usage/config/reload state to a secret-free DTO.
- `packages/vscode/src/dashboardProtocol.ts`: Webview message types and strict parser.
- `packages/vscode/src/dashboardViewProvider.ts`: secure HTML shell, state delivery, update coalescing, and action routing.
- `packages/vscode/webview/dashboard.ts`: DOM-only browser renderer and interaction handling.
- `packages/vscode/webview/dashboard.css`: responsive VS Code-themed dashboard styling.
- `packages/vscode/webview/tsconfig.json`: browser typecheck boundary with DOM libraries.
- `packages/vscode/src/statusBar.ts`: observable reload-recommendation state.
- `packages/vscode/src/extension.ts`: singleton composition and Webview registration.
- `packages/vscode/src/commands.ts`: dashboard refresh command and existing command routing integration.
- `packages/vscode/scripts/build.mjs`: Node bundle entries and browser asset build.
- `packages/vscode/package.json`: Webview contribution, command/menu, visual-test script, Playwright development dependency, and version 0.4.0.
- `packages/vscode/.vscodeignore`: exclude raw Webview sources and visual fixtures from VSIX.
- `packages/vscode/test/quotaStore.test.js`: store lifecycle and concurrency contract.
- `packages/vscode/test/dashboardModel.test.js`: DTO semantics, serializability, and secret-boundary contract.
- `packages/vscode/test/dashboardProtocol.test.js`: message parsing and fixed-action contract.
- `packages/vscode/test/dashboardViewProvider.test.js`: CSP, delivery, coalescing, and command routing.
- `packages/vscode/test/addAccount.test.js`: activation mock and existing Overview integration assertions.
- `packages/vscode/test/packageManifest.test.js`: view contribution and release metadata contract.
- `packages/vscode/test/visual/dashboard.spec.mjs`: browser layout, theme, focus, and screenshot checks.
- `packages/vscode/CHANGELOG.md`, `package.json`, `package-lock.json`: local 0.4.0 release metadata.

Delete `packages/vscode/src/usageTree.ts` only after all Overview behavior has moved into the dashboard model and existing integration tests assert posted dashboard state.

### Task 1: Extract The Shared Quota Store

**Files:**
- Create: `packages/vscode/src/quotaStore.ts`
- Create: `packages/vscode/test/quotaStore.test.js`
- Modify: `packages/vscode/scripts/build.mjs`

- [ ] **Step 1: Add a failing cache and lifecycle contract**

Add `quotaStore` as a separate CommonJS test entry in `scripts/build.mjs`, then create tests that mock `vscode`, `savedEntries`, and `quotaCache`. The first tests must assert this public state shape:

```ts
export type QuotaProvenance =
  | "network"
  | "hydrated-cache"
  | "cache-reuse"
  | "cache-fallback"
  | null;

export interface AccountQuotaState {
  accountId: string;
  info: QuotaInfo | null;
  loading: boolean;
  errorMessage: string | null;
  errorStatusCode: number | null;
  refreshAttemptedAt: number | null;
  queriedAt: number | null;
  provenance: QuotaProvenance;
  cacheReason: string | null;
  reloginRequired: boolean;
  reloginMessage: string | null;
}
```

Use an account with cached quota queried at `1_700_000_000_000`. Assert `reconcileAccounts()` hydrates it with `provenance === "hydrated-cache"`, preserves that exact `queriedAt`, and returns a cloned `Map` through `getSnapshot()`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build:vscode
PATH=/tmp/csb-node.cfY4xx/bin:$PATH node --test packages/vscode/test/quotaStore.test.js
```

Expected: FAIL because `dist/quotaStore.js` or `QuotaStore` does not exist.

- [ ] **Step 3: Implement immutable reconciliation and subscriptions**

Implement this API:

```ts
export interface QuotaStoreSnapshot {
  revision: number;
  byAccountId: ReadonlyMap<string, Readonly<AccountQuotaState>>;
}

export class QuotaStore implements vscode.Disposable {
  readonly onDidChange: vscode.Event<QuotaStoreSnapshot>;
  getSnapshot(): QuotaStoreSnapshot;
  get(accountId: string): Readonly<AccountQuotaState> | undefined;
  reconcileAccounts(accounts: readonly SavedAccountInfo[]): void;
  refreshQuota(
    targetIds: Iterable<string> | undefined,
    options: AccountQuotaRefreshOptions,
  ): Promise<void>;
  markReloginRequired(accountIds: Iterable<string>, message?: string): void;
  dispose(): void;
}
```

Internally clone each state and the `Map` before returning snapshots. `reconcileAccounts()` removes missing account IDs, ignores non-ready accounts for cache hydration, does not overwrite a newer live `queriedAt`, and emits only when state changes.

- [ ] **Step 4: Add failing refresh and race tests**

Cover these transitions with controlled promises:

```text
old valid info -> loading with old info -> network success
old valid info -> loading with old info -> cache fallback plus safe error metadata
no old info -> loading -> failed with no fake quota
unavailable quota info -> unavailable state
markReloginRequired -> relogin state while retaining prior info
same account refresh generation 1 completes after generation 2 -> generation 1 ignored
different accounts refresh concurrently -> both complete and neither remains loading
```

Assert `refreshAttemptedAt` is the attempt time and `queriedAt` is the actual data timestamp. Cached fallback must keep its cache timestamp rather than using completion time.

- [ ] **Step 5: Implement quota refresh behavior**

Move the query loop, bounded concurrency, cache fallback normalization, relogin detection, percentile performance logging, and slow-query reporting out of `AccountTreeProvider`. Track a generation per account ID so overlapping target sets do not invalidate unrelated accounts. Emit loading state once and coalesce completed-account updates through one event per microtask.

- [ ] **Step 6: Run the focused suite and commit**

Run the build and `quotaStore.test.js`; expect all tests to pass. Then commit only the store, its tests, and build entry:

```bash
git add packages/vscode/src/quotaStore.ts packages/vscode/test/quotaStore.test.js \
  packages/vscode/scripts/build.mjs
git commit -m "Extract shared quota state store"
```

### Task 2: Migrate Existing Quota Consumers Without Behavioral Change

**Files:**
- Modify: `packages/vscode/src/accountTree.ts`
- Modify: `packages/vscode/src/refreshCoordinator.ts`
- Modify: `packages/vscode/src/commands.ts`
- Modify: `packages/vscode/src/extension.ts`
- Modify: `packages/vscode/test/addAccount.test.js`
- Modify: `packages/vscode/test/logging.test.js`

- [ ] **Step 1: Add failing composition and shared-query assertions**

Update the activation harness to locate one `QuotaStore` subscription and assert:

```text
activation constructs one store
account tree displays hydrated and live quota from the store
account tree and status bar reuse one shared current-account query
provider mode schedules zero account quota requests unless a full dashboard refresh is explicit
relogin updates both the store snapshot and native account tree
```

Retain the existing timer rotation, group refresh, cached-fallback, and stale-response regression tests.

- [ ] **Step 2: Run the affected integration tests and verify RED**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build:vscode
PATH=/tmp/csb-node.cfY4xx/bin:$PATH node --test \
  --test-name-pattern="quota|relogin|timer|cached|shared query" \
  packages/vscode/test/addAccount.test.js packages/vscode/test/logging.test.js
```

Expected: new store-composition assertions fail.

- [ ] **Step 3: Make `AccountTreeProvider` a store consumer**

Change its constructor to:

```ts
constructor(
  private readonly quotaStore: QuotaStore,
  private readonly usageService?: UsageService,
) {
  this.quotaSubscription = quotaStore.onDidChange(() => {
    this.syncRootItems();
    this._onDidChangeTreeData.fire(undefined);
  });
}
```

Tree rendering continues to use the existing labels, icons, tooltips, and detail rows. Replace reads of the private `quotaState` map with `quotaStore.get(account.id)`. Remove network, cache, and refresh-generation ownership from the tree.

- [ ] **Step 4: Route all refreshes through the singleton**

Construct `QuotaStore` once in `extension.ts`, register it for disposal, and inject it into the account tree and `RefreshCoordinator`. In the coordinator, preserve one `SavedEntriesSnapshot` and one `SavedAccountQuotaQueryContext` per refresh pass, including the pre-created forced current-account promise used by auto-switch evaluation.

Replace direct command calls as follows:

```text
accountTree.refreshQuota(...) -> quotaStore.refreshQuota(...)
accountTree.markReloginRequired(...) -> quotaStore.markReloginRequired(...)
```

Keep `RefreshCoordinator` as the only scheduler and target selector. Update performance-log assertions from `accountTree.refreshQuota` to `quotaStore.refreshQuota` without weakening duration/stage checks.

- [ ] **Step 5: Run VS Code integration tests and commit**

Run all VS Code tests; expect the existing behavioral suite plus new store assertions to pass. Commit:

```bash
git add packages/vscode/src/accountTree.ts packages/vscode/src/refreshCoordinator.ts \
  packages/vscode/src/commands.ts packages/vscode/src/extension.ts \
  packages/vscode/test/addAccount.test.js packages/vscode/test/logging.test.js
git commit -m "Share quota state across extension views"
```

### Task 3: Build The Secret-Free Dashboard Model

**Files:**
- Create: `packages/vscode/src/dashboardModel.ts`
- Create: `packages/vscode/test/dashboardModel.test.js`
- Modify: `packages/vscode/scripts/build.mjs`
- Modify: `packages/vscode/src/statusBar.ts`

- [ ] **Step 1: Add failing account, Provider, and secret-boundary tests**

Build `dashboardModel.ts` as a test entry. Create fixtures containing sentinel secrets in account auth, Provider auth/config/profile, base URLs, storage errors, and usage errors. Assert the result is JSON serializable and recursively contains none of these keys or sentinel values:

```js
const forbiddenKeys = [
  "auth", "config", "profile", "tokens", "apiKey", "OPENAI_API_KEY",
  "base_url", "storageMessage", "lastError",
];
```

Cover account route, Provider route with no quota field, unknown route, duplicate local/cloud names, secondary five-hour window selection, cached and stale values, failed-without-cache, relogin, locked/pending/invalid accounts, and deterministic other-account sorting.

- [ ] **Step 2: Add failing usage, candidate, and reload tests**

Assert:

```text
ruleLabel is exactly "Switch at 0%"
candidate excludes current, non-ready, relogin, unavailable, no-5h, and exhausted accounts
candidate ordering matches rankAutoSwitchCandidates, including earliest reset tie-break
Provider mode sets appliesToCurrentRoute false
all token totals and small segments remain represented
zero-token percentages are finite zero values
partial/indexing states use fixed safe messages
reload recommendation becomes one stable DTO field
```

- [ ] **Step 3: Run focused tests and verify RED**

Run the build and `dashboardModel.test.js`; expect failure because the builder is missing.

- [ ] **Step 4: Implement the pure builder**

Export:

```ts
export interface BuildDashboardModelInput {
  saved: SavedEntriesSnapshot;
  providers: readonly SavedProviderInfo[];
  quota: QuotaStoreSnapshot;
  usage: UsageSnapshot;
  autoSwitchEnabled: boolean;
  sharedHistoryEnabled: boolean;
  reload: ReloadRecommendationSnapshot;
  nowMs: number;
}

export function buildDashboardModel(
  input: Readonly<BuildDashboardModelInput>,
): DashboardModel;
```

The DTO contains only primitives, arrays, ISO strings, and `null`. Project account/provider values field by field. Allow `wireApi` only when it equals the known values `responses` or `chat`; never forward `base_url`. Reuse `getFiveHourQuotaWindow`, `getRemainingQuotaPercent`, `rankAutoSwitchCandidates`, `stableSubjectId`, and `formatCompactTokens`.

- [ ] **Step 5: Make reload recommendation observable**

Add this state to `StatusBarManager`:

```ts
export interface ReloadRecommendationSnapshot {
  recommended: boolean;
  reason: string | null;
}

readonly onDidChangeReloadRecommendation: vscode.Event<ReloadRecommendationSnapshot>;
getReloadRecommendation(): ReloadRecommendationSnapshot;
```

Store the reason explicitly, emit only on semantic changes, and route configuration-driven clearing through `clearReloadRecommendation()` rather than direct private-field assignment.

- [ ] **Step 6: Run focused and status-bar tests, then commit**

Run `dashboardModel.test.js` plus reload-related `addAccount.test.js` cases. Commit:

```bash
git add packages/vscode/src/dashboardModel.ts packages/vscode/src/statusBar.ts \
  packages/vscode/test/dashboardModel.test.js packages/vscode/scripts/build.mjs \
  packages/vscode/test/addAccount.test.js
git commit -m "Add secret-free dashboard state model"
```

### Task 4: Add A Strict Webview Protocol And Host Provider

**Files:**
- Create: `packages/vscode/src/dashboardProtocol.ts`
- Create: `packages/vscode/src/dashboardViewProvider.ts`
- Create: `packages/vscode/test/dashboardProtocol.test.js`
- Create: `packages/vscode/test/dashboardViewProvider.test.js`
- Modify: `packages/vscode/scripts/build.mjs`

- [ ] **Step 1: Add failing protocol parser tests**

Use this exact client action union:

```ts
export type DashboardAction =
  | "refreshDashboard"
  | "switchMode"
  | "setAutoSwitch"
  | "configureAutoSwitch"
  | "addAccount"
  | "addProvider"
  | "reloginAccount"
  | "unlockStorage"
  | "reloadWindow";
```

Test valid `dashboard.ready` and `dashboard.action` messages. Reject missing/extra discriminants, arbitrary command IDs, non-string request IDs, non-boolean toggle values, unknown actions, oversized target IDs, and prototype-bearing objects.

- [ ] **Step 2: Implement the parser and verify GREEN**

Export `parseDashboardClientMessage(value: unknown): DashboardClientMessage | null`. Check own properties, exact allowed keys per action, string length limits, and required payload combinations. Do not throw for untrusted input.

- [ ] **Step 3: Add failing host provider tests**

Mock a `WebviewView` and assert:

```text
resolve sets enableScripts true and localResourceRoots to dist/webview only
HTML contains a fresh nonce CSP with default/connect/object/base/form restrictions
HTML contains no inline model JSON, command URI, unsafe-inline, or remote origin
dashboard.ready receives the latest state exactly once
bursty source changes coalesce to the newest revision
disposing or hiding a view does not leak listeners
fixed actions route to fixed extension commands
targeted account actions reject IDs absent from the current DTO
```

- [ ] **Step 4: Implement the provider**

The provider subscribes to `QuotaStore`, `UsageService`, reload state, and relevant workspace configuration. It rebuilds state from one saved snapshot plus `listSavedProviders()`, then posts:

```ts
export interface DashboardHostMessage {
  type: "dashboard.state";
  revision: number;
  state: DashboardModel;
}
```

Use a host-side `Record<DashboardAction, handler>` rather than accepting a command name. Targeted relogin/unlock handlers resolve account IDs against a fresh saved snapshot before calling existing commands. Model changes coalesce through `queueMicrotask` and only post while a resolved view exists.

- [ ] **Step 5: Generate a restrictive HTML shell**

Generate a cryptographic nonce and this policy:

```text
default-src 'none';
img-src <webview-source> data:;
style-src <webview-source>;
script-src 'nonce-<nonce>';
font-src <webview-source>;
connect-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

The shell contains only a skip link, `<main id="app">`, and local CSS/script references. It enables no command URIs and embeds no user-controlled labels.

- [ ] **Step 6: Run protocol/provider tests and commit**

Run both focused suites and commit the four new files plus build entries.

### Task 5: Implement The Graphical Sidebar Renderer

**Files:**
- Create: `packages/vscode/webview/dashboard.ts`
- Create: `packages/vscode/webview/dashboard.css`
- Create: `packages/vscode/webview/tsconfig.json`
- Modify: `packages/vscode/scripts/build.mjs`
- Modify: `packages/vscode/.vscodeignore`
- Modify: `packages/vscode/package.json`
- Modify: `packages/vscode/test/packageManifest.test.js`

- [ ] **Step 1: Add failing manifest and browser-build tests**

Update the manifest test to require:

```js
assert.equal(overview.type, "webview");
assert.equal(overview.showCollapseAll, undefined);
assert.equal(accounts.type, undefined);
assert.equal(providers.type, undefined);
```

Require the Overview title menu to use `codex-switchbridge.refreshDashboard` and keep `switchMode`. Add a build assertion that `dist/webview/dashboard.js` and `dashboard.css` exist and that raw `webview/**` sources are excluded by `.vscodeignore`.

- [ ] **Step 2: Run manifest/build tests and verify RED**

Expected: Overview is still a tree and browser assets are absent.

- [ ] **Step 3: Add the browser build boundary**

Use `webview/tsconfig.json` with `ES2020`, `DOM`, strict mode, and no emit. Extend `build.mjs` with a second esbuild call:

```js
await build({
  entryPoints: [path.join(packageDir, "webview", "dashboard.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: path.join(distDir, "webview", "dashboard.js"),
  minify: !watch,
});
copyFileSync(
  path.join(packageDir, "webview", "dashboard.css"),
  path.join(distDir, "webview", "dashboard.css"),
);
```

Update `typecheck` to run both extension and Webview TypeScript checks.

- [ ] **Step 4: Implement DOM-only rendering**

Build the approved Switch Path hierarchy using `document.createElement`, `textContent`, named helper functions, and native buttons/checkboxes. Never use `innerHTML`. Required regions are:

```text
current route
quota ring or Provider no-quota state
shared-history badge
auto-switch toggle, 0% rule, advisory candidate, settings
other-account quota bars
collapsible local-token segmented bar and metrics
switch/refresh commands
conditional reload strip
```

Persist only `{ tokenDetailsExpanded: boolean }` through the VS Code Webview state API. Ignore stale host revisions. Every click posts one typed action with a generated request ID, and toggle UI waits for the host’s next state instead of optimistically changing truth.

- [ ] **Step 5: Implement responsive theme-native styling**

Use VS Code variables for all foregrounds, surfaces, borders, focus rings, buttons, warnings, errors, and chart colors. Keep radii at 6 px or below. Fix the quota ring at 108 px, progress bars at 7 px, and control heights at 28–32 px. Add breakpoints for widths below 300 px, truncation tooltips, `:focus-visible`, high-contrast borders, and `prefers-reduced-motion`.

Do not use gradients, decorative blobs, remote assets, viewport-scaled fonts, nested cards, or hidden overflow that clips focus rings.

- [ ] **Step 6: Verify build contracts and commit**

Run both TypeScript checks, build, and manifest tests. Commit browser sources, build changes, ignore rules, and manifest contribution changes.

### Task 6: Register The Dashboard And Preserve Existing Workflows

**Files:**
- Modify: `packages/vscode/src/extension.ts`
- Modify: `packages/vscode/src/refreshCoordinator.ts`
- Modify: `packages/vscode/src/commands.ts`
- Modify: `packages/vscode/test/addAccount.test.js`
- Delete: `packages/vscode/src/usageTree.ts`

- [ ] **Step 1: Extend the VS Code integration mock**

Add `registerWebviewViewProvider`, `WebviewView`, `webview.postMessage`, `onDidReceiveMessage`, `onDidChangeVisibility`, `asWebviewUri`, `cspSource`, and disposal tracking to the existing mock. Store resolved providers under the view ID and provide helpers to deliver `dashboard.ready` and inspect the latest posted state.

- [ ] **Step 2: Convert Overview integration tests and verify RED**

Replace direct `getChildren()` assertions at the five existing Overview call sites with DTO assertions:

```text
active route changes after account/Provider switch
total and unattributed usage appear in state
refreshUsage posts a newer usage state
per-selection token attribution appears in segments
reload recommendation appears once without added notifications
```

Expected: tests fail until activation registers and resolves the Webview provider.

- [ ] **Step 3: Register and compose the dashboard**

Construct `DashboardViewProvider` after `QuotaStore`, `UsageService`, `StatusBarManager`, and `RefreshCoordinator`. Register it using:

```ts
vscode.window.registerWebviewViewProvider(
  "codexSwitchBridgeOverview",
  dashboardView,
  { webviewOptions: { retainContextWhenHidden: true } },
);
```

Remove `OverviewTreeProvider` from the coordinator and replace `overviewTree.refresh()` with a dashboard state invalidation callback. Delete `usageTree.ts` after all imports and tests are migrated.

- [ ] **Step 4: Add the unified refresh command**

Register `codex-switchbridge.refreshDashboard` so it:

```ts
await refreshCoordinator.refreshViews("manual");
refreshCoordinator.scheduleQuotaRefresh({ reason: "manual", fullRefresh: true });
refreshCoordinator.scheduleUsageRefresh("manual");
await refreshCoordinator.flushScheduledRefresh();
```

The Webview Retry and title action both invoke this command. Existing `refreshUsage`, `refreshQuota`, and account-tree refresh commands retain their current narrower semantics.

- [ ] **Step 5: Run the complete VS Code suite and commit**

Run `npm test -w packages/vscode`; expect all existing and new tests to pass. Commit integration changes and deletion of `usageTree.ts`.

### Task 7: Run Automated Visual And Accessibility QA

**Files:**
- Create: `packages/vscode/test/visual/dashboard.spec.mjs`
- Modify: `packages/vscode/package.json`
- Modify: `package-lock.json`
- Modify: `packages/vscode/.vscodeignore`

- [ ] **Step 1: Add Playwright as a development-only dependency**

Install the stable `@playwright/test` package in the VS Code workspace and add:

```json
"test:visual": "playwright test test/visual/dashboard.spec.mjs --reporter=line"
```

Install Chromium for the current environment. Raw test files, screenshots, traces, and Playwright output remain excluded from the VSIX.

- [ ] **Step 2: Add fixture-driven browser tests**

Load the built CSS and IIFE renderer into a page with a stubbed `acquireVsCodeApi`. Exercise these states:

```text
account ready with primary and secondary quota
account refreshing with retained cached value
failed without cache
relogin required
storage locked
Provider mode with no quota ring
unknown and empty state
partial and indexing token usage
reload-required strip
```

Run each meaningful layout at 240, 360, and 480 px sidebar widths. Cover dark, light, and high-contrast variable sets.

- [ ] **Step 3: Assert layout and keyboard behavior**

For every fixture, assert:

```js
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
```

Check quota-ring bounds, action-row wrapping, no intersection between adjacent major regions, full keyboard traversal of interactive controls, visible focus indication, descriptive accessible names, and reduced-motion behavior. Capture deterministic screenshots under `test-results/dashboard/` for manual inspection.

- [ ] **Step 4: Run visual tests and inspect screenshots**

Run `npm run test:visual -w packages/vscode`. Open representative 240 px dark, 360 px light, Provider, error, and reload screenshots. Fix any clipping, overlap, low-contrast text, unstable dimensions, or misleading labels, then rerun until green.

- [ ] **Step 5: Commit visual coverage and final polish**

Commit the Playwright dependency metadata, tests, ignore rules, and any CSS/renderer corrections.

### Task 8: Version, Verify, Package, And Install Locally

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/vscode/package.json`
- Modify: `packages/vscode/CHANGELOG.md`
- Generate (ignored): `packages/vscode/codex-switchbridge-0.4.0.vsix`

- [ ] **Step 1: Add failing 0.4.0 release assertions**

Update the identity test to expect extension `0.4.0`, then run it and verify failure while manifests remain `0.3.1`.

- [ ] **Step 2: Bump scoped release metadata**

Set the root private package and VS Code workspace to `0.4.0`. Update only their matching entries in `package-lock.json`; leave Core and CLI versions unchanged. Add:

```markdown
## 0.4.0 - 2026-08-12

- Replaced the Overview tree with a graphical quota-first sidebar dashboard.
- Added direct auto-switch controls, comparable account quota bars, token-use visualization, and stable reload guidance.
- Unified live quota presentation state across the dashboard and native account view without duplicate requests.
```

- [ ] **Step 3: Run complete verification**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run verify
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run test:visual -w packages/vscode
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm audit --workspaces --include-workspace-root --audit-level=moderate
git diff --check 32217d0
```

Expected: all Core, CLI, VS Code, migration, protocol, visual, accessibility, and security-boundary tests pass; audit reports no moderate-or-higher vulnerability; diff check is empty.

- [ ] **Step 4: Package and inspect the VSIX**

Run:

```bash
PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run package:vscode
unzip -t packages/vscode/codex-switchbridge-0.4.0.vsix
unzip -l packages/vscode/codex-switchbridge-0.4.0.vsix | \
  rg 'dist/webview/dashboard\.(js|css)|extension/package.json'
```

Expected: archive integrity passes; both browser assets are present; raw `src`, `webview`, tests, temporary mockups, credentials, and environment files are absent.

- [ ] **Step 5: Install and smoke-check locally**

Install the exact VSIX with `code --install-extension ... --force`, confirm the manifest publisher's `codex-switchbridge@0.4.0`, reload the Extension Host, and manually verify account mode, Provider mode, toggle, switch menu, token expansion, and one-shot reload strip.

- [ ] **Step 6: Request code review and commit the release metadata**

Run the requesting-code-review workflow against the complete diff, address any correctness or security findings, rerun affected tests, and commit release metadata. Do not publish to GitHub or the Visual Studio Marketplace in this plan; publishing remains an explicit deployment action after the local 0.4.0 artifact is verified.
