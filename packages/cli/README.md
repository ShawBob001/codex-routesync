# Codex SwitchBridge CLI

Command-line account and provider switching for Codex. The npm package is
`codex-switchbridge-cli`; it installs the `codex-switchbridge` executable.

## Install

From npm after the package is published:

```bash
npm install --global codex-switchbridge-cli
codex-switchbridge --version
```

Or install the tarball downloaded from a GitHub release:

```bash
npm install --global ./codex-switchbridge-cli-0.1.0.tgz
```

## Commands

```text
codex-switchbridge add <name>
codex-switchbridge list
codex-switchbridge use <name>
codex-switchbridge mode [name]
codex-switchbridge quota [name]
codex-switchbridge current
codex-switchbridge refresh [name]
codex-switchbridge export [file]
codex-switchbridge import <file>
```

Use `--auth-dir <path>` or `CODEX_SWITCHBRIDGE_AUTH_DIR` to select a separate
saved-account directory. Encrypted entries can be unlocked with `--password`
or `CODEX_SWITCHBRIDGE_PASSWORD`.

Project documentation and releases are available at
<https://github.com/baoshichao001-dev/codex-switchbridge>.

## Provenance

Codex SwitchBridge is an independent open-source project derived from
[jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch),
with substantial modifications by `baoshichao001-dev`.

## License

MIT
