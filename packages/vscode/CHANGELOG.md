# Changelog

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
