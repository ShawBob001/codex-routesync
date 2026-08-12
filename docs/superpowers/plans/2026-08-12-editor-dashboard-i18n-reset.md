# Editor Dashboard, Precise Reset Clock, and Bilingual UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Codex SwitchBridge 0.5.0 with a singleton editor-area dashboard, accurate live Usage-limit reset timing, and an immediately switchable English/Simplified-Chinese dashboard.

**Architecture:** Replace the sidebar Webview with a one-item native launcher and refactor the existing secure host into a lazy singleton `WebviewPanel` manager. Preserve the current secret-free model and refresh sources, add a typed locale envelope and catalog, and render a responsive editor grid whose reset clocks derive only from upstream timestamps.

**Tech Stack:** TypeScript 5.9, VS Code Extension API, esbuild, Node.js test runner, browser DOM/CSS/SVG, Playwright, package NLS, npm workspaces, `@vscode/vsce`.

---

## File Map

- Create `packages/vscode/src/dashboardLauncher.ts`: one native dashboard-launch TreeItem.
- Create `packages/vscode/src/dashboardI18n.ts`: typed English/Chinese catalog and locale helpers shared by host and browser.
- Create `packages/vscode/test/dashboardI18n.test.js`: catalog and locale resolution tests.
- Modify `packages/vscode/src/dashboardProtocol.ts`: strict locale-change message.
- Modify `packages/vscode/src/dashboardViewProvider.ts`: singleton editor panel lifecycle and locale envelope.
- Modify `packages/vscode/src/extension.ts`: compose launcher/panel and locale state.
- Modify `packages/vscode/src/commands.ts`: register the open-dashboard command callback.
- Modify `packages/vscode/webview/dashboard.ts`: wide semantic layout, bilingual rendering, precise clocks.
- Modify `packages/vscode/webview/dashboard.css`: editor-theme, responsive grid, graphical cards.
- Modify `packages/vscode/package.json`: 0.5.0, launcher, command, language setting, NLS keys.
- Create `packages/vscode/package.nls.json` and `packages/vscode/package.nls.zh-cn.json`: static contribution translations.
- Modify `packages/vscode/test/dashboardProtocol.test.js`, `dashboardViewProvider.test.js`, `packageManifest.test.js`, `addAccount.test.js`, and `test/visual/dashboard.spec.mjs`.
- Modify root `package.json`, `package-lock.json`, `packages/vscode/CHANGELOG.md`, `README.md`, and `packages/vscode/README.md` for 0.5.0.

### Task 1: Define bilingual and reset-time contracts

- [ ] Add failing catalog tests asserting identical English/Chinese keys, `zh-CN` and `zh-Hans` resolution, unknown-locale English fallback, safe interpolation, and stable `Intl` locale identifiers.
- [ ] Build and run the focused test; verify RED because `dashboardI18n` does not exist.
- [ ] Implement `LanguagePreference`, `SupportedLocale`, `resolveDashboardLocale()`, `translate()`, and complete dashboard dictionaries.
- [ ] Add failing protocol tests for a valid `dashboard.locale.set` and rejection of invalid preferences, extra fields, prototype-bearing objects, and oversized IDs.
- [ ] Implement the exact parser branch and verify focused tests GREEN.

### Task 2: Replace the sidebar Webview with a singleton editor panel

- [ ] Add failing manifest tests requiring a native `codexSwitchBridgeOverview`, `openDashboard`, launcher title menu, and unchanged Account/API Provider tree views.
- [ ] Add failing host tests for lazy creation, singleton reveal, close/reopen, hidden delivery, repeated ready after context reset, disposal, and existing CSP/action guarantees.
- [ ] Add `DashboardLauncherProvider` and refactor `DashboardViewProvider` into a panel manager with `show()`.
- [ ] Update activation composition and command registration without auto-opening the panel or changing auth/re-login paths.
- [ ] Run host, manifest, activation, and logging tests until GREEN.

### Task 3: Render the wide editor dashboard and precise reset clocks

- [ ] Extend Playwright fixtures with deterministic `now`, English/Chinese locale envelopes, local timezone, primary/secondary resets, and 720/960/1200 px layouts.
- [ ] Add failing browser assertions for two-column layout, one-panel overflow safety, full local time to seconds, UTC ISO, live countdown, passed/invalid reset states, `html.lang`, translated controls, keyboard traversal, and theme coverage.
- [ ] Refactor the renderer into a page header, route hero, automation card, account card grid, usage card, actions, and reload strip using DOM APIs only.
- [ ] Add an aligned one-second clock that recomputes from wall time and refreshes immediately on visibility/focus; never infer missing timestamps or initiate quota network work.
- [ ] Add responsive/editor-theme CSS and keep 240–480 px split-editor fallbacks.
- [ ] Run browser/typecheck tests until GREEN and inspect generated screenshots.

### Task 4: Add static NLS and release metadata

- [ ] Add failing manifest tests that every `%key%` exists in both NLS catalogs and that both catalogs have identical keys.
- [ ] Replace contributed static strings with NLS placeholders and add complete English/Simplified-Chinese NLS files.
- [ ] Add the `auto/en/zh-cn` window setting and use the host handler to persist changes with `ConfigurationTarget.Global`.
- [ ] Update documentation, changelog, root/workspace versions, and lockfile to 0.5.0.
- [ ] Run manifest, locale, and package metadata tests until GREEN.

### Task 5: Verify, review, package, and install

- [ ] Run the full repository `npm run verify` and confirm zero failures.
- [ ] Run all Playwright dashboard visual tests in supported themes and widths; inspect representative English/Chinese screenshots.
- [ ] Run `npm audit --workspaces --include-workspace-root` and record the result.
- [ ] Request an independent code review, fix every Critical/Important issue, and rerun affected plus full tests.
- [ ] Package `codex-switchbridge-0.5.0.vsix`, validate the ZIP, inspect its contents for required NLS/Webview assets and excluded secrets/tests, and calculate SHA-256.
- [ ] Install the VSIX into the current remote VS Code server, verify `baoshichao001-dev.codex-switchbridge@0.5.0` is the only SwitchBridge/conflicting switch extension, and provide the exact reload/open instructions.
