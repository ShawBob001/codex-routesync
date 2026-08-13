# VS Code Proxy-Safe HTTP Transport Design

## Problem

SwitchBridge 0.6.0 correctly resolves `codex-switchbridge.proxy`, but quota queries still show unavailable inside a remote VS Code extension host. The same account and proxy succeed from the core package outside VS Code.

The extension-host probe established the boundary failure: VS Code replaces Node's `https.request` and, with its default `http.proxySupport: override`, discards the explicit `HttpsProxyAgent`. The request then connects directly to `chatgpt.com:443` and fails with `ETIMEDOUT`/`ENETUNREACH`. Calling the original HTTPS implementation in that same process succeeds through the configured proxy. Token refresh has a second gap: its request path does not accept the SwitchBridge proxy at all.

## Considered approaches

1. **Ask users to set `http.proxy` or disable `http.proxySupport`.** Smallest change, but it leaks an implementation detail into global editor settings and leaves SwitchBridge's own proxy option misleading. Rejected.
2. **Use VS Code's patched HTTP layer and mirror the extension setting into `http.proxy`.** This mutates a global setting owned by the user and can affect every extension. Rejected.
3. **Use a shared, proxy-safe core transport for quota and refresh.** Explicit proxy requests bypass the VS Code patch while direct/environment-driven requests preserve their existing behavior. Recommended and approved under the user's standing instruction to use the recommended design without further confirmation.

## Architecture

Create a focused core HTTPS transport module. It owns proxy URL resolution, `NO_PROXY` matching, proxy-agent construction, request timeout handling, and the choice between Node's patched and original request implementations.

- With an explicit proxy URL, construct `HttpsProxyAgent` and invoke the original HTTPS request when VS Code exposes it as `https.__vscodeOriginal`. Outside VS Code, use normal `https.request`.
- With `proxyUrl: null`, force a direct request.
- With `proxyUrl: undefined`, retain environment proxy and `NO_PROXY` behavior.
- Keep errors generic at public UI boundaries and never log proxy URLs, credentials, authorization headers, tokens, or response bodies.

Both quota GET and OAuth refresh POST use this transport. `refreshAccessToken`, `refreshAndSave`, and saved-account refresh operations receive the same `proxyUrl?: string | null` semantics already used by quota queries. The VS Code command layer creates one query context per operation and passes its resolved proxy into refresh calls.

## Error handling and privacy

The transport returns status/body to the existing parsers, but diagnostic output records only safe metadata: operation, status code, duration, error constructor/code, and whether an explicit proxy was selected. Email addresses are removed from performance log fields.

Authentication errors continue to map to relogin/token-rejected states. Network errors continue to map to `request_failed`, now with a regression-proof request path.

## Tests

- A core regression test simulates VS Code's patched `https.request` discarding an explicit agent and verifies that explicit proxy requests select `__vscodeOriginal`.
- GET and POST transport tests verify proxy propagation, direct mode, environment mode, timeout, and credential-safe logging.
- Refresh tests verify `proxyUrl` reaches the OAuth request without exposing it in logs.
- A VS Code activation/command test verifies changing the extension proxy affects subsequent quota and refresh operations.
- A real local smoke test queries both saved accounts through `127.0.0.1:3128` from the VS Code Node runtime.

## Success criteria

- Both saved accounts no longer report `request_failed` when the configured proxy is reachable.
- The Refresh Token command uses the SwitchBridge proxy and no longer produces the network-related `Failed: personal, secondary` result.
- No global `http.proxy` or `http.proxySupport` change is required.
- All existing core, extension, privacy, packaging, and visual tests remain green.
