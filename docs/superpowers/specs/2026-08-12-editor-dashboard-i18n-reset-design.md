# Codex SwitchBridge Editor Dashboard, Reset Clock, and Bilingual UI Design

Status: Approved by the user's standing instruction to continue with the recommended design without further confirmation

Date: 2026-08-12

## Goal

Move the operational dashboard out of the narrow Activity Bar sidebar and into a graphical editor-area panel. Make quota reset timing useful at a glance, and let users switch the dashboard between Simplified Chinese and English without reloading the window.

The change must preserve the existing account/API-provider switching, shared-history, token attribution, quota refresh, auto-switch, transactional re-login, and secret-handling behavior shipped in 0.4.1.

## Chosen Product Shape

The Activity Bar becomes a lightweight launcher and management surface:

```text
Codex SwitchBridge Activity Bar
  ├─ Dashboard
  │    └─ Open Dashboard
  ├─ Accounts
  └─ API Providers
```

`Open Dashboard` opens one singleton `WebviewPanel` in the active editor column. Clicking the launcher again reveals the same panel instead of creating another copy. Accounts and API Providers remain native tree views with their existing context commands.

The editor panel is an operational console, not a marketing page. At wide widths it uses a two-column grid with a prominent current-route and quota surface, a compact automation/control surface, account comparison cards, and token-usage graphics. At narrow split-editor widths it collapses back to one column without losing actions or status text.

## Editor Panel Architecture

### Dashboard launcher

A new `DashboardLauncherProvider` supplies one native TreeItem for the existing `codexSwitchBridgeOverview` view ID. The item invokes `codex-switchbridge.openDashboard`. Keeping the view ID avoids unnecessary migration of user view placement while removing the expensive Webview from the sidebar.

### Dashboard panel manager

The current `DashboardViewProvider` becomes a panel manager while retaining its mature responsibilities:

- secret-free model delivery;
- strict action parsing and fixed host-side handlers;
- state revision ordering and burst coalescing;
- delivery retry;
- current target-ID validation;
- visible-panel quota refresh scheduling;
- nonce-based CSP and local-only assets.

`show()` creates a `WebviewPanel` only when none exists; otherwise it calls `reveal()`. Closing the panel releases panel-specific listeners but keeps the single extension-level source subscription. Reopening creates a fresh Webview context and always sends the latest model after `dashboard.ready`.

The panel is not auto-opened on extension activation and is not serialized across window reloads. This avoids surprise editors and stale persisted models. Only non-sensitive browser UI state, such as expanded token details, remains in `webview.setState()`.

## Information Layout

### Header

The header contains the SwitchBridge identity, a short current-mode subtitle, Refresh, Switch Route, and a language control with `Auto`, `中文`, and `English`. The language control is keyboard accessible and visually compact.

### Current route and quota

Account mode shows a larger quota ring, account identity, plan, locally recorded tokens, freshness, and shared-history state. API-provider mode shows a distinct provider signal and never invents account quota.

For every quota window with a reset timestamp, the UI shows:

1. a live countdown (`2h 14m 08s` / `2小时14分08秒`);
2. the full local absolute time including seconds and UTC offset;
3. the exact upstream UTC ISO timestamp, including milliseconds when supplied;
4. the window label and remaining percentage;
5. freshness so a cached timestamp cannot be mistaken for a newly queried value.

The upstream Usage API currently supplies Unix seconds in `reset_at`. The core already multiplies by 1000 and preserves the resulting `Date`. The UI must not claim sub-second accuracy when the upstream value has only second precision. It recomputes the countdown from `Date.now()` on a one-second aligned timer and immediately on visibility/focus changes, so background timer throttling does not accumulate drift.

If a timestamp is absent or invalid, the UI says reset time is unavailable rather than inferring one from the window length. If it has passed, the UI says the reset is due and waits for the existing refresh scheduler or a user refresh; the Webview does not start an independent quota request.

### Automation and accounts

Auto-switch remains truthful: it triggers only at zero remaining five-hour quota. The best cached candidate is advisory and the command still revalidates before switching.

Other accounts appear as responsive comparison cards with percentage, progress bar, reset countdown, absolute reset time, local token usage, freshness, and direct re-login/unlock actions where applicable. Unknown quota stays unknown rather than being rendered as zero.

### Local token usage

The token section keeps the total, indexed sessions, segmented contribution bar, and expandable input/output/cached/reasoning/attributed metrics. Wide layout gives the legend enough horizontal space; compact names still truncate with accessible titles.

## Language Architecture

### Runtime dashboard language

Add a `codex-switchbridge.language` window setting with:

- `auto`: use `vscode.env.language`; any `zh-*` locale maps to Simplified Chinese, otherwise English;
- `zh-cn`: force Simplified Chinese;
- `en`: force English.

The preference is stored through VS Code configuration so it persists and can sync. A shared, typed catalog contains no `vscode` dependency and is bundled into the browser renderer. Host state includes both the preference and effective locale. A strict `dashboard.locale.set` message updates only the allowlisted setting.

On a locale update the Webview changes `html.lang`, title, ARIA labels, date/number formatters, and visible copy in place. It does not replace the HTML shell or reload the VS Code window.

### VS Code-owned static surfaces

`package.nls.json` and `package.nls.zh-cn.json` localize contributed view names, command titles, welcome content, and setting descriptions. These strings follow the VS Code display language because VS Code resolves static contributions before extension runtime; a per-extension toggle cannot rewrite them live.

The editor dashboard and launcher are the switchable bilingual surface in this release. Existing account/provider management commands retain their established runtime behavior; translating every transient core/OS error is deliberately excluded because those details must remain exact and because it would turn this focused dashboard change into a risky core-message migration.

## Protocol and Security

The host message adds a locale envelope:

```ts
interface DashboardHostMessage<Model> {
  type: "dashboard.state";
  revision: number;
  locale: {
    preference: "auto" | "en" | "zh-cn";
    effective: "en" | "zh-cn";
  };
  state: Model;
}
```

The client protocol adds exactly one message:

```ts
{
  type: "dashboard.locale.set";
  requestId: string;
  preference: "auto" | "en" | "zh-cn";
}
```

The parser rejects extra keys, invalid preferences, oversized request IDs, arrays, null-prototype objects, and custom prototypes. No auth data, API keys, base URLs, raw provider configuration, error stacks, or credential fields cross the Webview boundary.

The CSP remains local-only with a fresh nonce, `connect-src 'none'`, and no command URIs. User-controlled names are inserted only through DOM text APIs.

## Error and Lifecycle Behavior

- Repeated launcher clicks reveal one panel.
- Closing and reopening produces a new panel that receives current state.
- Hidden panels stop model delivery; becoming visible delivers only the latest revision.
- Repeated `dashboard.ready` after a Webview context reset is accepted and receives state.
- Model or action failures are logged and contained without destroying the panel.
- A missing quota timestamp, cached data, revoked account, locked storage, and API-provider mode each have explicit bilingual states.
- The existing stable reload strip remains a single non-repeating action.

## Accessibility and Visual Rules

- Use editor theme variables with sidebar fallbacks and support dark, light, and high contrast.
- Use semantic buttons, selects, details, headings, progress bars, and status regions.
- Never use color as the only status signal.
- Keep visible focus outlines and logical keyboard order.
- Honor reduced motion.
- Test at 240, 360, and 480 px for split/narrow panels and 720, 960, and 1200 px for editor layouts.
- Long English and Chinese labels must wrap or truncate without horizontal overflow.

## Testing Strategy

1. Protocol unit tests cover the locale message allowlist and invalid input.
2. Locale unit tests cover `auto`, `zh-*`, English fallback, catalog parity, interpolation, and persisted setting updates.
3. Panel-host tests cover lazy singleton creation, reveal, close/reopen, repeated ready, visibility, coalescing, CSP, action routing, and disposal.
4. Manifest tests cover the native launcher, open command, NLS key parity, and unchanged management trees.
5. Dashboard-model tests retain secret-boundary and exact reset ISO assertions.
6. Browser tests cover both languages, exact reset countdown/absolute/UTC text, timer updates, wide/narrow layouts, themes, high contrast, keyboard access, and no overflow.
7. Full repository tests, audit, VSIX validation, and an installed-extension smoke check run before completion.

## Release Scope

This is a feature-level release and will use version `0.5.0`. The verified VSIX will be installed into the current remote VS Code environment. Publishing to GitHub or Marketplace is a separate external action and is not implied by this local implementation request.
