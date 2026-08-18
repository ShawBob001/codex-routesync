# Transient Login Auth Wait Design

## Problem

RouteSync starts `codex login` in a terminal with a temporary `CODEX_HOME` and asks the user to click **Done** after authentication. Device authentication can report success in the browser before the Codex CLI has written `auth.json`. RouteSync currently reads the file immediately after **Done**, so this timing window produces a false `auth.json was not found after login` failure and then deletes the temporary directory.

## Scope

After the user clicks **Done**, RouteSync will wait up to 30 seconds for the temporary `auth.json` to become readable. It will check every 250 milliseconds and continue immediately when a valid auth file can be read.

Cancellation remains immediate. The terminal and temporary directory retain their existing cleanup behavior. Persisting temporary credentials or changing the login command is outside this change.

## Design

Extract the bounded wait into a small asynchronous helper with injected timing parameters suitable for tests. The helper will:

1. Attempt to read the expected auth file immediately.
2. If it is unavailable, wait for the polling interval and retry.
3. Return the parsed auth as soon as it is available.
4. Return `null` when the 30-second deadline expires.

`runTransientCodexLogin` will call this helper only after **Done**. A timeout will flow through the existing missing-auth result, but the user-facing error will explain that the CLI did not finish writing `auth.json` within 30 seconds and instruct the user to wait for the terminal success message before retrying.

## Error Handling And Security

- A missing or temporarily unreadable file is retried until the deadline.
- Malformed or incompatible auth content is treated as unavailable and retried, allowing an in-progress atomic write to complete.
- The temporary directory is always removed by the existing `finally` block.
- No tokens, auth contents, or temporary paths are added to logs.
- The wait is bounded, so a stalled login cannot leave the command pending indefinitely.

## Tests

Add focused regression coverage for:

- auth already available when **Done** is clicked;
- auth appearing after one or more polling intervals;
- no auth appearing before the deadline;
- cancellation avoiding the wait and preserving existing cleanup behavior.

The VS Code package tests, build, VSIX packaging, and installation smoke check must pass before updating the installed extension.

## Acceptance Criteria

- Clicking **Done** slightly before the CLI writes `auth.json` still imports the account.
- A successful delayed read does not wait for the full timeout.
- A 30-second timeout produces an actionable error instead of the current generic missing-file message.
- Cancel behavior and temporary credential cleanup are unchanged.
