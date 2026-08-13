# Contributing to Codex RouteSync

Thanks for taking the time to improve Codex RouteSync. Small, focused changes
are easier to review and release. For a large behavior change, open a feature
request first so its compatibility and data-migration impact can be discussed.

## Choose the right channel

- Use the bug form for reproducible failures.
- Use the feature form for a new workflow or behavior.
- Use the question form when the documentation does not answer a usage question.
- Use [private vulnerability reporting](https://github.com/ShawBob001/codex-routesync/security/advisories/new)
  for anything that could expose credentials, conversations, or local files.

Do not put secrets or private conversation content in issues, pull requests,
screenshots, fixtures, or logs. See the [security policy](./SECURITY.md) before
reporting authentication, proxy, sync, storage, or history-repair problems.

## Development setup

You need Node.js 20 or later and npm. Python 3 is required only for the shared-
history migration tests and repair script.

```bash
git clone https://github.com/ShawBob001/codex-routesync.git
cd codex-switchbridge
npm ci
npm run build
npm run verify
```

The repository is an npm workspace:

```text
packages/core/     Authentication, quota, provider, and history-routing logic
packages/cli/      Command-line interface
packages/vscode/   VS Code extension, dashboard, localization, and integration
scripts/           Migration and release helpers
docs/              Architecture, behavior, and maintenance notes
```

Keep changes in the narrowest package that owns the behavior. Shared switching
or storage rules belong in `core`; editor-only behavior belongs in `vscode`.

## Tests

Add a regression test for every bug fix and focused tests for new behavior. Run
the closest package test while iterating, then run the complete check before
opening a pull request:

```bash
npm run test -w packages/core
npm run test -w packages/cli
npm run test -w packages/vscode
npm run verify
```

Dashboard layout changes also require Playwright Chromium and the visual suite:

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

Use fake credentials and a temporary `CODEX_HOME` in tests. Never copy a real
Codex session, provider profile, proxy URL, token, or rollout into the repository.

## User-facing changes

- Update the relevant README or `docs/` page when behavior changes.
- Update `packages/vscode/CHANGELOG.md` when users need to know about the change.
- Keep English and Simplified Chinese strings in sync. Commands and settings may
  require changes to `package.nls.json` and `package.nls.zh-cn.json`.
- Include English/Chinese and light/dark screenshots for visible dashboard work.
- Explain migrations and rollback behavior when stored data or history routing
  changes.

Do not bump package versions, generate `.vsix` or `.tgz` files, publish a release,
or update release checksums unless a maintainer explicitly asks for release work.

## Pull requests

Create a topic branch, keep commits scoped, and complete the pull request
template. Link the issue your change addresses and list the exact commands you
ran. A maintainer may ask for changes when a patch broadens scope, lacks tests,
or cannot preserve authentication and history data safely.

All participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
