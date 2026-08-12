# Changelog

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
