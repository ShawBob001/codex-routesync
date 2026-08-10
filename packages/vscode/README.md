# Codex SwitchBridge

Manage multiple Codex accounts inside VS Code.

Codex SwitchBridge gives you a dedicated Activity Bar view for saved accounts, quick account switching, quota visibility, token refresh, and account import/export without leaving the editor.

Codex SwitchBridge is an independent open-source project derived from
[jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch),
with substantial modifications by `baoshichao001-dev`.

## Features

- Add a new account from `codex login`
- Add a provider profile from the Providers view
- Switch the active account with one click
- Switch the active provider with one click
- Refresh expired tokens for saved accounts and auto-rotate near-expiry access tokens during background quota refresh
- Inspect current quota usage in the account list and status bar
- Refresh saved account quotas in the background one account at a time on a configurable interval
- Reuse recent quota results from a shared local cache across VS Code windows
- Optionally share local Codex history between saved accounts and Responses-compatible relay providers
- Unlock locked saved storage after entering the local storage password
- Import and export account backups as JSON
- Show a non-blocking **Reload recommended** status-bar action after account or provider changes
- Repair older provider-tagged local history only when you explicitly run the maintenance command

## View

Open the **Codex SwitchBridge** view from the Activity Bar to:

- See all saved accounts
- See saved providers
- Identify the currently active account
- Inspect account email, plan, and quota usage
- Run inline actions such as switch and refresh

## Commands

Available commands:

- `Codex SwitchBridge: Add Account`
- `Codex SwitchBridge: Add Provider`
- `Codex SwitchBridge: Switch Account`
- `Codex SwitchBridge: Switch Provider`
- `Codex SwitchBridge: Refresh Token`
- `Codex SwitchBridge: Refresh Quota`
- `Codex SwitchBridge: Import Accounts`
- `Codex SwitchBridge: Export Accounts`
- `Codex SwitchBridge: Repair Local Shared History`

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codex-switchbridge.quotaRefreshInterval` | `30` | Automatic background quota refresh interval, in seconds; minimum `5`; each interval refreshes one saved account quota in rotation |
| `codex-switchbridge.showStatusBar` | `true` | Show the current account quota in the status bar |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | Show a non-blocking reload recommendation, never notify, or reload automatically after switching |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | Route saved relay profiles through the built-in `openai` provider so new local history remains visible across account and provider switches |
| `codex-switchbridge.authDirectory` | `""` | Directory used to save and load `auth_{name}.json`; empty uses the default Codex config directory |

### Shared local history across providers

Enable `codex-switchbridge.shareHistoryAcrossProviders` to route saved
Responses-compatible relay profiles through Codex's built-in `openai`
provider. Saved ChatGPT accounts and relay profiles then use one local history
bucket under the same `CODEX_HOME`. This shares local threads and local memory;
it does not merge ChatGPT web history, Codex Cloud tasks, connectors, quotas,
or other account-scoped cloud data.

For older provider-tagged threads, stop active Codex output and run
**Codex SwitchBridge: Repair Local Shared History**. Activation never rewrites
history. The explicit repair creates backups and aborts if a rollout changes
during validation. Python 3 is required only for this command.

Disable or uninstall **Codex Account Switch** before enabling Codex
SwitchBridge because both extensions write the same local Codex files.

## Requirements

- Codex CLI installed and available in your shell
- A successful `codex login` flow for each account you want to save

## Repository

Source code and issue tracker:

- Repository: https://github.com/baoshichao001-dev/codex-switchbridge
- Issues: https://github.com/baoshichao001-dev/codex-switchbridge/issues
