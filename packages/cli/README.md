# Codex SwitchBridge CLI

**Switch between Codex account mode and Responses-compatible API-provider mode from the terminal without splitting new local conversation history.**

The npm package is `codex-switchbridge-cli`. It installs the `codex-switchbridge` command.

## Install

Install a tarball from [GitHub Releases](https://github.com/baoshichao001-dev/codex-switchbridge/releases):

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

After the package is published to npm:

```bash
npm install --global codex-switchbridge-cli
```

## Switch between modes

```bash
# Save a Codex login
codex-switchbridge add work

# Switch to that account
codex-switchbridge use work

# Create or switch to an API provider
# Responses-compatible providers share local history by default
codex-switchbridge mode team-api

# Use provider-specific history instead
codex-switchbridge mode team-api --separate-history
```

Before each switch, the CLI saves the outgoing credentials back to the matching saved entry. It then updates `auth.json`, `config.toml`, and the shared-history route under one lock.

Use `codex-switchbridge use <name>` to return to a specific account. `mode account` restores the only saved account when there is exactly one. If several accounts exist, the CLI asks you to choose one instead of guessing.

## Shared local conversation history

Responses-compatible API providers use the same local Codex history bucket as account mode unless `--separate-history` is passed. New threads remain available after you change modes.

Shared history requires:

```toml
wire_api = "responses"
base_url = "https://your-provider.example/v1"
```

This behavior applies to local threads under the same `CODEX_HOME`. It does not synchronize ChatGPT web history, Codex Cloud tasks, connectors, quotas, or history between devices.

Older provider-tagged threads need the VS Code extension's explicit **Repair Shared Conversation History** command. The CLI never rewrites conversation files during normal switching.

## Commands

```text
codex-switchbridge add <name>
codex-switchbridge list
codex-switchbridge use <name>
codex-switchbridge mode [name] [--separate-history]
codex-switchbridge quota [name]
codex-switchbridge current
codex-switchbridge refresh [name]
codex-switchbridge export [file]
codex-switchbridge import <file>
```

Use `--auth-dir <path>` or `CODEX_SWITCHBRIDGE_AUTH_DIR` to select a separate saved-entry directory. Unlock encrypted entries with `--password` or `CODEX_SWITCHBRIDGE_PASSWORD`.

## Project

- [Documentation](https://github.com/baoshichao001-dev/codex-switchbridge#readme)
- [Releases](https://github.com/baoshichao001-dev/codex-switchbridge/releases)
- [Issues](https://github.com/baoshichao001-dev/codex-switchbridge/issues)

## Provenance and license

Codex SwitchBridge is an independent open-source project derived from [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch), with substantial modifications by `baoshichao001-dev`.

Released under the MIT License.
