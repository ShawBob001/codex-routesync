# Changelog

## 0.8.2 - 2026-08-19

- Waits up to 30 seconds for Codex to finish writing the transient `auth.json` after account login, preventing false failures when device authentication completes before the file appears.
- Keeps cancellation and temporary credential cleanup unchanged, and reports an actionable timeout message when Codex does not produce readable authentication data.

## 0.8.1 - 2026-08-13

- Renamed the project and VS Code extension to **Codex RouteSync**, with the new `ShawBob001.codex-routesync` Marketplace identity and `ShawBob001/codex-routesync` GitHub repository.
- Renamed VS Code contribution IDs and the offline package to `codex-routesync-0.8.1.vsix` while preserving existing `codex-switchbridge.*` settings and local token-usage state.
- Added activation guards for both previous extension identities so two installations cannot write the same Codex authentication and provider files concurrently.
- Updated English, Simplified Chinese, Japanese, Korean, Spanish, French, and German documentation, release instructions, and community links for the RouteSync identity.

## 0.8.0 - 2026-08-13

- Moved the VS Code distribution to the new `ShawBob001.codex-switchbridge-vscode` Marketplace identity and renamed the offline package to `codex-switchbridge-vscode-0.8.0.vsix`.
- Added an activation guard that asks users to disable or uninstall the previous Marketplace installation and reload VS Code before the replacement can manage Codex files.
- Preserved local accounts, API providers, configuration, backups, shared history under `CODEX_HOME`, and existing `codex-switchbridge.*` settings across the move.
- Documented the required migration of synced or cloud entries to Local storage. Extension-scoped `globalState`, `SecretStorage`, and previously stored per-route usage attribution do not transfer automatically between Marketplace identities.

## 0.7.0 - 2026-08-13

- Placed saved Codex accounts and API providers in one flat route list, removing the remaining account/provider directory split from the sidebar.
- Added an account reset action that can consume one earned rate-limit reset through the official Codex App Server protocol, with account revalidation, confirmation, idempotency, and an immediate quota refresh.
- Added an accessible Token details doughnut chart that compares mutually exclusive usage attributed to each account, API provider, and earlier or unattributed activity.
- Added full English, Simplified Chinese, Japanese, Korean, Spanish, French, and German README editions with a language navigation bar on every edition.
- Added regression coverage that verifies every non-zero usage-history bucket renders exactly one bar fill.

## 0.6.1 - 2026-08-13

- Fixed account quota and OAuth token-refresh requests behind explicit, VS Code, and extension-host proxies, including remote extension hosts that override Node's HTTPS transport.
- Rejected malformed OAuth refresh responses without overwriting saved credentials and removed sensitive response bodies, proxy credentials, and account emails from diagnostics.
- Unified Accounts and API Providers into one bilingual routes tree to reduce sidebar fragmentation.
- Opened or focused the graphical Dashboard automatically whenever the SwitchBridge Activity Bar view becomes visible, while retaining the explicit Open Dashboard action.
- Added up-to-date English and Simplified Chinese usage screenshots to the project documentation.

## 0.6.0 - 2026-08-13

- Added an official-inspired orange usage chart with daily, weekly, and monthly grouping, account/API-provider filters, date ranges, and selected-range totals, averages, peaks, and estimates.
- Preserved zero-usage dates and marked older or undated local observations explicitly instead of presenting them as authoritative billing data.
- Added a machine-only, non-synced `codex-switchbridge.proxy` with fallback to VS Code and extension-host proxy settings so remote quota requests work even when the extension host does not inherit the interactive shell environment.
- Normalized legacy quota cache data during activation and added actionable, redacted network diagnostics when remaining quota cannot be reached.
- Isolated quota caches by authentication scope and serialized cross-window cache maintenance so one VS Code window cannot remove or overwrite another window's valid entry.
- Kept the last cached quota visible after a refresh failure while showing a fixed bilingual warning instead of hiding the failed refresh or exposing raw network details.
- Kept quota reset timestamps, earned reset counts, local token history controls, and error states fully available in English and Simplified Chinese.

## 0.5.1 - 2026-08-13

- Fixed account quota requests on remote hosts that require `HTTP_PROXY` or `HTTPS_PROXY`, while respecting `NO_PROXY` exclusions.
- Displayed whichever account quota windows the service actually returns, including accounts with only a 7-day window instead of a 5-hour window.
- Added available rate-limit reset counts and kept remaining quota percentages separate from locally recorded token consumption.
- Isolated automated-test quota caches from the live runtime cache and added conservative cleanup for previously polluted cache entries.

## 0.5.0 - 2026-08-12

- Moved the graphical Dashboard from the narrow sidebar into a reusable editor panel while keeping native account and API-provider management views.
- Added responsive wide-screen cards for the current route, automatic switching, saved accounts, quota, and local token usage.
- Added live quota reset countdowns with local time-zone details and exact upstream UTC timestamps, including explicit unavailable and due states.
- Added immediate English and Simplified Chinese Dashboard switching, automatic VS Code language following, and localized commands, views, welcome text, and settings.

## 0.4.1 - 2026-08-12

- Migrated legacy provider route state so switching back to a Codex account reliably removes stale API routing.
- Made account re-login use an isolated Codex home and reject missing or identity-mismatched login results without changing the live session.
- Applied refreshed credentials immediately for the active account and reused the configured reload policy to clear cached revoked tokens.
- Warned when another active extension can concurrently overwrite Codex auth or configuration files.

## 0.4.0 - 2026-08-12

- Replaced the Overview tree with a graphical quota-first sidebar dashboard.
- Added direct auto-switch controls, comparable account quota bars, token-use visualization, and stable reload guidance.
- Unified live quota presentation state across the dashboard and native account view without duplicate requests.

## 0.3.1 - 2026-08-12

- Replaced the generic lightning icon with the S-Bridge identity across the Marketplace and VS Code Activity Bar.
- Added a self-contained editable color master and small-size brand asset validation.

## 0.3.0 - 2026-08-11

- Added an Overview with active mode, shared-history state, total local token usage, and per-account/API attribution.
- Refreshed the Accounts, API Providers, details, icons, descriptions, tooltips, and status bar for faster scanning.
- Kept token increments correctly attributed when a conversation continues across a selection switch.
- Persisted provider selection before automatic window reloads and kept remapped usage stable across renames, storage moves, deletion, and recreation.
- Isolated usage indexes by `CODEX_HOME` and compressed the complete local index without discarding event timestamps.
- Avoided reload recommendations when a source-only selection change left runtime credentials unchanged.
- Rejected account and provider storage moves when the destination already contains a same-name entry.
- Hardened saved-entry paths, provider secret display, atomic credential writes, cross-window switching, and synced-source reconciliation.

## 0.2.0 - 2026-08-10

- Introduced Codex SwitchBridge with guarded account/API-provider switching and shared local conversation history.
