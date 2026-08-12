# Codex SwitchBridge

**Seamlessly switch between saved Codex accounts and Responses-compatible API providers, keep local conversation history available in both modes, and see local token usage by selection.**

Codex SwitchBridge updates credentials and provider routing as one guarded switch. Account mode and compatible API-provider mode use the same local history bucket, so changing how Codex authenticates does not split new conversations into separate timelines.

The VS Code extension opens a graphical Dashboard in the editor area for the active mode, shared-history state, account quota reset clocks, total local token usage, and the amount attributed to each saved account or API provider. The Dashboard can follow VS Code's display language or switch immediately between English and Simplified Chinese.

Codex SwitchBridge runs on Windows, macOS, and Linux. Use it from VS Code or from the command line.

[![GitHub release](https://img.shields.io/github/v/release/baoshichao001-dev/codex-switchbridge)](https://github.com/baoshichao001-dev/codex-switchbridge/releases)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/baoshichao001-dev.codex-switchbridge?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Two modes, one local conversation history

```text
Codex account mode  <->  Codex SwitchBridge  <->  Responses API-provider mode
                               |
                    shared history under CODEX_HOME
```

| Capability | What SwitchBridge does |
| --- | --- |
| Account and API switching | Applies the selected account credentials or API-provider profile together with the matching Codex configuration |
| Shared conversation history | Keeps new local threads visible in both modes by using one Codex history bucket |
| Local token usage | Indexes Codex rollout counters locally and breaks tracked usage down by saved account or API provider |
| State preservation | Saves the outgoing account or provider credentials before applying the next mode |
| Safe transitions | Serializes concurrent switches, writes authentication atomically, and keeps rollback backups |
| Reload handling | Shows a non-blocking reload action by default when the Codex extension needs to read the new authentication state |

> Shared conversation history is local to one `CODEX_HOME`. It does not copy or merge ChatGPT web history, Codex Cloud tasks, connectors, quotas, or conversation history between devices.

## Quick start

### VS Code extension

Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=baoshichao001-dev.codex-switchbridge). You can also open Extensions in VS Code and search for `Codex SwitchBridge` or `@id:baoshichao001-dev.codex-switchbridge`.

For offline installation, download the latest `.vsix` from [GitHub Releases](https://github.com/baoshichao001-dev/codex-switchbridge/releases), then run **Extensions: Install from VSIX...**. To use the terminal instead, run the command below. Replace VERSION with the version in the downloaded filename.

```bash
code --install-extension codex-switchbridge-VERSION.vsix
```

Open the **Codex SwitchBridge** Activity Bar view, then select **Open Dashboard**. The Dashboard opens in the central editor area so quota, reset-time, account, provider, and token-usage information has room to breathe. The Accounts and API Providers views continue to handle one-click switching.

### CLI

Install the CLI tarball from a GitHub release:

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

After publication to npm, install the same package from the registry:

```bash
npm install --global codex-switchbridge-cli
```

## Switch between accounts and API providers

In VS Code, use **Switch Account** or **Switch API Provider**. SwitchBridge saves the current selection, updates `auth.json` and `config.toml`, then refreshes its account and provider views.

From the CLI:

```bash
# Switch to a saved Codex account
codex-switchbridge use work

# Switch to a saved Responses-compatible API provider
# Shared local history is enabled by default
codex-switchbridge mode team-api

# Keep provider-specific history when compatibility requires it
codex-switchbridge mode team-api --separate-history
```

Returning to a named account uses `codex-switchbridge use <name>`. If `mode account` can identify exactly one saved account, it restores that account. With multiple saved accounts, the CLI asks you to choose one with `use <name>` instead of guessing.

An API-provider profile stores the authentication payload for `auth.json` and the provider configuration for `config.toml`. Shared history requires `wire_api = "responses"` and a valid provider `base_url`.

## Editor dashboard, quota reset time, and local token usage

The VS Code Dashboard reads account quota metadata and cumulative `token_count` events from local Codex rollout files under the current `CODEX_HOME`. It shows:

- each available quota reset as a live seconds-level countdown;
- the same reset as local time with seconds and time-zone offset;
- the exact upstream UTC timestamp, including milliseconds when present;
- recorded total, input, output, cached input, and reasoning output tokens;
- attributed and unattributed totals;
- per-account and per-API-provider usage and session counts;
- index coverage, session count, tracking start, and last refresh time.

Reset clocks use the timestamp returned by the quota service. Missing, invalid, or already-due timestamps are shown explicitly; SwitchBridge does not invent a replacement reset time. The countdown is recalculated from the wall clock and updates without refreshing the entire Dashboard.

Use the language selector in the Dashboard header to choose **Auto**, **English**, or **简体中文**. Auto follows the VS Code display language, while either explicit choice is saved as a window setting and takes effect without reloading VS Code.

Input and output make up the recorded total. Cached input is already part of input, and reasoning output is already part of output, so those two values are not added again.

Per-selection attribution starts when SwitchBridge begins local tracking. The index assigns each subsequent token increment to the account or API provider active when Codex recorded it, including when one conversation continues across a mode switch. Older shared `openai` sessions cannot be assigned to a specific saved entry safely and remain under **Earlier or unattributed**. Older provider-tagged sessions are attributed only when their provider ID maps to exactly one saved profile.

These figures are local activity counters, not billing or cost data. SwitchBridge does not upload rollout content, and its local index stores counters, timestamps, file fingerprints, and opaque IDs rather than conversation text, paths, account labels, provider names, or credentials. Use **Refresh Local Token Usage** to reindex immediately; otherwise the extension refreshes it during normal background maintenance.

## How conversation history stays available

Codex normally groups local threads by model provider. A custom provider ID can make threads appear to vanish when you return to account mode even though the files still exist.

SwitchBridge avoids that split for new threads:

1. Account mode uses Codex's built-in `openai` provider.
2. A Responses-compatible API provider keeps that same history identity while SwitchBridge applies its API key and base URL.
3. Switching back restores the account credentials and original OpenAI route.

Both modes therefore read the same local conversation history under the same `CODEX_HOME`. SwitchBridge synchronizes the route used to index history; it does not copy conversation text after every switch.

Shared history is enabled by default in the VS Code extension and for compatible CLI provider switches. In VS Code, control it with `codex-switchbridge.shareHistoryAcrossProviders`.

### Repair older provider-tagged threads

Threads created before shared routing may still use a provider-specific ID. To bring those threads into the shared local history:

1. Stop active Codex output.
2. Run **Codex SwitchBridge: Repair Shared Conversation History**.
3. Use the **Reload recommended** status-bar action when the repair finishes.

The repair command creates backups, changes only provider identity fields, validates the JSONL and SQLite records, and stops if a rollout changes during inspection. Extension activation never rewrites history. Python 3 is required only for this maintenance command.

See [Conversation history across modes](./docs/shared-history.md) for the exact scope and safety checks.

## Features

- One-click switching between local or synced Codex accounts and API providers in VS Code
- One-command account and API-provider switching from the CLI
- Shared local conversation history for Responses-compatible provider routes
- Wide editor Dashboard with graphical quota, precise reset clocks, and total/per-selection local token usage
- Runtime English/Simplified Chinese Dashboard switching, plus localized VS Code commands and settings
- Account quota display, token refresh, and rotating background maintenance
- Local or VS Code Settings Sync storage for saved accounts and providers
- Optional encryption for saved authentication data
- Import and export for saved accounts
- Backup-first repair for older provider-tagged local threads
- Cross-window switch locking and rollback snapshots

## CLI commands

| Command | Description |
| --- | --- |
| `codex-switchbridge add <name>` | Run `codex login` and save the result as a named account |
| `codex-switchbridge list` | List saved accounts and API providers |
| `codex-switchbridge use <name>` | Switch to a saved account and restore account mode |
| `codex-switchbridge mode [name]` | Show the current mode or switch to an API provider with shared history by default |
| `codex-switchbridge mode <name> --separate-history` | Switch to an API provider with provider-specific local history |
| `codex-switchbridge remove <name>` | Remove a saved account |
| `codex-switchbridge quota [name]` | Show account quota usage |
| `codex-switchbridge current` | Show the current account or API-provider mode |
| `codex-switchbridge refresh [name]` | Refresh an account access token |
| `codex-switchbridge export [file]` | Export saved accounts to JSON |
| `codex-switchbridge import <file>` | Import saved accounts from JSON |

Use `--auth-dir <path>` or `CODEX_SWITCHBRIDGE_AUTH_DIR` to place saved entries outside the default Codex directory. Use `--password` or `CODEX_SWITCHBRIDGE_PASSWORD` to unlock encrypted entries.

## VS Code settings

| Setting | Default | Description |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | Follow VS Code or use English/Simplified Chinese in the Dashboard |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | Keep new local conversation history available across account mode and compatible API-provider modes |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | Show a reload action, never notify, or reload automatically after a switch |
| `codex-switchbridge.quotaRefreshInterval` | `30` | Check one saved account per interval for token maintenance and quota refresh |
| `codex-switchbridge.tokenAutoUpdate` | `true` | Refresh saved account tokens during background maintenance when they are expired or near expiry |
| `codex-switchbridge.showStatusBar` | `true` | Show current selection, quota, token usage, and reload recommendations in the status bar |
| `codex-switchbridge.authDirectory` | `""` | Store local saved entries in this directory; empty uses the default Codex directory |

## Data and switch safety

Local accounts use `auth_{name}.json`. Local API providers use `provider_{name}.json`. VS Code can also keep encrypted entries in synced extension storage.

Before a switch overwrites the active `auth.json`, SwitchBridge writes the latest outgoing credentials back to the matching saved account or provider. The switch then updates authentication, provider routing, and shared-history route state under one cross-process lock. Authentication files use atomic replacement, and failed transitions restore their snapshots.

Quota lookup and local token indexing are read-only. They do not rotate tokens, rewrite saved authentication, or modify conversation files. Token maintenance is a separate operation.

Some Codex tools cache authentication when they start. SwitchBridge cannot force another extension process to discard that cache, so a VS Code window reload may still be required after a successful file switch. The default behavior keeps this recommendation in the status bar instead of showing repeated popups.

Do not run **Codex Account Switch** and Codex SwitchBridge at the same time. Both extensions write the same local Codex files.

## Development

```bash
npm install
npm run build
npm run verify
```

Dashboard visual tests also need Playwright Chromium and its Linux system dependencies:

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

Minimal Linux images without `/etc/fonts/fonts.conf` must expose a valid Fontconfig configuration through `FONTCONFIG_FILE` and `FONTCONFIG_PATH`; otherwise Chromium cannot measure or render text.

Project layout:

```text
packages/
  core/     Shared auth, provider routing, history routing, quota, and storage logic
  cli/      Command-line interface
  vscode/   VS Code extension
scripts/    History maintenance and release helpers
docs/       Architecture, behavior, and deployment notes
```

Release procedures are documented in [Deployment](./docs/deployment.md).

## Provenance and license

Codex SwitchBridge is an independent open-source project derived from [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch), with substantial modifications by `baoshichao001-dev`.

Released under the [MIT License](./LICENSE). The upstream copyright notice and license text are preserved.
