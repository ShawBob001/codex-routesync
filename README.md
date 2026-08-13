[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex RouteSync

**Seamlessly switch between saved Codex accounts and Responses-compatible API providers, keep local conversation history available in both modes, and see local token usage by selection.**

Codex RouteSync updates credentials and provider routing as one guarded switch. Account mode and compatible API-provider mode use the same local history bucket, so changing how Codex authenticates does not split new conversations into separate timelines.

The VS Code extension opens a graphical Dashboard in the editor area for the active mode, shared-history state, account quota reset clocks, and total local token usage. Saved accounts and API providers appear together in one flat route list. Token details include a source doughnut chart, while the orange history chart groups local observations by day, week, or month. The Dashboard can follow VS Code's display language or switch immediately between English and Simplified Chinese.

## Usage preview

Opening the **Codex RouteSync** Activity Bar shows saved accounts and API providers as peers in one flat **Accounts & API Routes** list, then automatically opens or focuses the Dashboard. Use the route list for account/API management and the wide Dashboard for quota, reset time, automatic switching, and local token history.

![Codex RouteSync Dashboard in English dark mode](./assets/screenshots/dashboard-en-dark.png)

The same Dashboard can switch immediately to Simplified Chinese:

![Codex RouteSync Dashboard in Simplified Chinese light mode](./assets/screenshots/dashboard-zh-light.png)

Codex RouteSync runs on Windows, macOS, and Linux. Use it from VS Code or from the command line.

[![GitHub release](https://img.shields.io/github/v/release/ShawBob001/codex-routesync)](https://github.com/ShawBob001/codex-routesync/releases)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Two modes, one local conversation history

```text
Codex account mode  <->  Codex RouteSync  <->  Responses API-provider mode
                               |
                    shared history under CODEX_HOME
```

| Capability | What RouteSync does |
| --- | --- |
| Account and API switching | Applies the selected account credentials or API-provider profile together with the matching Codex configuration |
| Shared conversation history | Keeps new local threads visible in both modes by using one Codex history bucket |
| Local token usage | Indexes Codex rollout counters locally, charts daily/weekly/monthly activity, and breaks tracked usage down by saved account or API provider |
| State preservation | Saves the outgoing account or provider credentials before applying the next mode |
| Safe transitions | Serializes concurrent switches, writes authentication atomically, and keeps rollback backups |
| Reload handling | Shows a non-blocking reload action by default when the Codex extension needs to read the new authentication state |

> Shared conversation history is local to one `CODEX_HOME`. It does not copy or merge ChatGPT web history, Codex Cloud tasks, connectors, quotas, or conversation history between devices.

## Quick start

### VS Code extension

Install the extension from its [Visual Studio Marketplace page](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync), or open Extensions in VS Code and search for `Codex RouteSync`.

For offline installation, download the latest `.vsix` from [GitHub Releases](https://github.com/ShawBob001/codex-routesync/releases), then run **Extensions: Install from VSIX...**. To use the terminal instead, run the command below. Replace VERSION with the version in the downloaded filename.

```bash
code --install-extension codex-routesync-VERSION.vsix
```

#### Move from the previous Marketplace listing

If you installed Codex SwitchBridge from an earlier Marketplace listing, complete these steps before enabling Codex RouteSync:

1. Open the previous installation and move every synced or cloud account and API provider to **Local**.
2. Disable or uninstall the previous installation, then run **Developer: Reload Window**.
3. Install Codex RouteSync from the link above and re-enter your storage password.

Accounts, API providers, configuration files, backups, and shared history under the configured `CODEX_HOME` remain available. Existing `codex-switchbridge.*` settings also remain in effect. The listings have different extension identities, so the previous installation's `globalState`, `SecretStorage`, and stored per-route usage attribution do not migrate automatically.

Open the **Codex RouteSync** Activity Bar view. Its flat **Accounts & API Routes** list puts saved accounts and API providers in the same sidebar directory, and the Dashboard automatically opens or returns to the foreground in the central editor area. The title-bar **Open Dashboard** action remains available as a fallback.

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

In VS Code, use **Switch Account** or **Switch API Provider**. RouteSync saves the current selection, updates `auth.json` and `config.toml`, then refreshes its account and provider views.

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

- the remaining percentage for every quota window returned by the account service, including 5-hour, 7-day, and named limits;
- each available quota reset as a live seconds-level countdown;
- the same reset as local time with seconds and time-zone offset;
- the exact upstream UTC timestamp, including milliseconds when present;
- the available earned rate-limit reset count when the account service provides it;
- a confirmed **Use one reset** action for the current account when an earned reset applies;
- recorded total, input, output, cached input, and reasoning output tokens;
- attributed and unattributed totals;
- per-account and per-API-provider usage and session counts;
- a source doughnut chart that compares mutually exclusive account, API-provider, and unattributed totals;
- an orange daily, weekly, or monthly usage chart with source and date filters;
- selected-range total, average, peak, and estimated usage;
- index coverage, session count, tracking start, and last refresh time.

Reset clocks prefer the absolute timestamp returned by the quota service. If only its relative reset countdown is available, RouteSync derives the corresponding timestamp at query time. Missing, invalid, or already-due reset metadata is shown explicitly. The countdown is recalculated from the wall clock and updates without refreshing the entire Dashboard. Account quota requests and OAuth token refresh use `codex-switchbridge.proxy` first, followed by VS Code's `http.proxy` and the extension host's `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` environment. Environment resolution continues to honor `NO_PROXY`. The dedicated setting is machine-scoped and excluded from Settings Sync. VS Code stores its value in local settings, so prefer an unauthenticated local proxy or protect the machine settings file if the URL contains credentials.

Use the language selector in the Dashboard header to choose **Auto**, **English**, or **简体中文**. Auto follows the VS Code display language, while either explicit choice is saved as a window setting and takes effect without reloading VS Code.

The reset action uses the official Codex App Server method, verifies that the same saved account is still active, asks for confirmation, consumes at most one earned reset with an idempotency key, and refreshes quota afterward. If the installed Codex version does not support reset consumption, RouteSync opens the official Usage page instead.

Input and output make up the recorded total. Cached input is already part of input, and reasoning output is already part of output, so those two values are not added again. The doughnut chart uses only mutually exclusive attributed source totals, so it does not count cached input or reasoning output twice.

Per-selection attribution starts when RouteSync begins local tracking. The index assigns each subsequent token increment to the account or API provider active when Codex recorded it, including when one conversation continues across a mode switch. Older shared `openai` sessions cannot be assigned to a specific saved entry safely and remain under **Earlier or unattributed**. Older provider-tagged sessions are attributed only when their provider ID maps to exactly one saved profile.

The account service provides a remaining percentage, not an absolute remaining-token allowance. The history chart contains device-local activity counters rather than billing, cost, or remote balance data. Older indexed activity that cannot be placed exactly is marked as estimated, and activity without a reliable date stays outside the chart. API-provider profiles expose only local counters unless that provider offers a compatible quota API. RouteSync does not upload rollout content, and its local index stores counters, timestamps, file fingerprints, and opaque IDs rather than conversation text, paths, account labels, provider names, or credentials. Use **Refresh Local Token Usage** to reindex immediately; otherwise the extension refreshes it during normal background maintenance.

## How conversation history stays available

Codex normally groups local threads by model provider. A custom provider ID can make threads appear to vanish when you return to account mode even though the files still exist.

RouteSync avoids that split for new threads:

1. Account mode uses Codex's built-in `openai` provider.
2. A Responses-compatible API provider keeps that same history identity while RouteSync applies its API key and base URL.
3. Switching back restores the account credentials and original OpenAI route.

Both modes therefore read the same local conversation history under the same `CODEX_HOME`. RouteSync synchronizes the route used to index history; it does not copy conversation text after every switch.

Shared history is enabled by default in the VS Code extension and for compatible CLI provider switches. In VS Code, control it with `codex-switchbridge.shareHistoryAcrossProviders`.

### Repair older provider-tagged threads

Threads created before shared routing may still use a provider-specific ID. To bring those threads into the shared local history:

1. Stop active Codex output.
2. Run **Codex RouteSync: Repair Shared Conversation History**.
3. Use the **Reload recommended** status-bar action when the repair finishes.

The repair command creates backups, changes only provider identity fields, validates the JSONL and SQLite records, and stops if a rollout changes during inspection. Extension activation never rewrites history. Python 3 is required only for this maintenance command.

See [Conversation history across modes](./docs/shared-history.md) for the exact scope and safety checks.

## Features

- One-click switching between local or synced Codex accounts and API providers in VS Code
- One flat sidebar route list for saved accounts and API providers
- One-command account and API-provider switching from the CLI
- Shared local conversation history for Responses-compatible provider routes
- Wide editor Dashboard with graphical quota, precise reset clocks, earned reset redemption, a source doughnut chart, and filterable daily/weekly/monthly local token history
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
| `codex-switchbridge.proxy` | `""` | Machine-only HTTP(S) proxy for account quota requests and OAuth token refresh; excluded from Settings Sync; empty uses VS Code and extension-host proxy settings |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | Keep new local conversation history available across account mode and compatible API-provider modes |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | Show a reload action, never notify, or reload automatically after a switch |
| `codex-switchbridge.quotaRefreshInterval` | `30` | Check one saved account per interval for token maintenance and quota refresh |
| `codex-switchbridge.tokenAutoUpdate` | `true` | Refresh saved account tokens during background maintenance when they are expired or near expiry |
| `codex-switchbridge.showStatusBar` | `true` | Show current selection, quota, token usage, and reload recommendations in the status bar |
| `codex-switchbridge.authDirectory` | `""` | Store local saved entries in this directory; empty uses the default Codex directory |

## Data and switch safety

Local accounts use `auth_{name}.json`. Local API providers use `provider_{name}.json`. VS Code can also keep encrypted entries in synced extension storage.

Before a switch overwrites the active `auth.json`, RouteSync writes the latest outgoing credentials back to the matching saved account or provider. The switch then updates authentication, provider routing, and shared-history route state under one cross-process lock. Authentication files use atomic replacement, and failed transitions restore their snapshots.

Quota lookup and local token indexing are read-only. They do not rotate tokens, rewrite saved authentication, or modify conversation files. Token maintenance is a separate operation.

Some Codex tools cache authentication when they start. RouteSync cannot force another extension process to discard that cache, so a VS Code window reload may still be required after a successful file switch. The default behavior keeps this recommendation in the status bar instead of showing repeated popups.

Do not run **Codex Account Switch** and Codex RouteSync at the same time. Both extensions write the same local Codex files.

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

## Maintenance and contributing

Codex RouteSync is maintained as a long-term open-source project. The project
accepts focused bug reports, feature proposals, documentation improvements, and
tested pull requests. Read the
[contribution guide](./.github/CONTRIBUTING.md), [security policy](./.github/SECURITY.md),
and [open-source maintenance statement](./docs/OPEN_SOURCE_MAINTENANCE.md) before
participating.

## Provenance and license

Codex RouteSync is an independent open-source project derived from [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch), with substantial modifications by `ShawBob001`.

Released under the [MIT License](./LICENSE). The upstream copyright notice and license text are preserved.
