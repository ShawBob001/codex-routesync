# Codex SwitchBridge Sidebar Dashboard Design

Status: Approved for implementation

Date: 2026-08-12

## Goal

Replace the text-heavy Overview tree with a graphical VS Code sidebar dashboard that makes remaining account quota and automatic-switch readiness understandable at a glance. Preserve the existing native Accounts and API Providers trees for detailed management.

The dashboard must improve presentation without changing the established switching, history-sharing, token-attribution, credential-storage, or auto-switch semantics.

## Success Criteria

1. Opening the SwitchBridge Activity Bar shows the active account or API Provider immediately.
2. In account mode, the preferred five-hour quota window is the strongest visual signal. Its remaining percentage and reset time are readable without expanding a tree item.
3. The automatic-switch toggle, zero-quota rule, and currently best cached candidate are visible and directly actionable.
4. Other saved accounts are comparable through compact remaining-quota bars.
5. Shared-history and local token-usage status remain visible but do not compete with quota.
6. Account/API Provider management keeps its existing native tree commands and context menus.
7. The dashboard performs no independent quota network queries, exposes no secrets, and does not introduce repeated reload notifications.

## Chosen Visual Direction

Use the approved **Switch Path** layout in the existing Activity Bar container:

- a compact current-route surface contains a fixed-size quota ring, active selection identity, auto-switch toggle, candidate, reset time, and shared-history badge;
- other accounts appear below as horizontal quota bars;
- local token usage appears as a lower-priority segmented bar with expandable details;
- primary commands sit near the data they affect;
- reload-required state appears as one stable action strip at the bottom instead of a repeating notification.

The design is an operational dashboard, not a marketing surface. It uses restrained VS Code theme colors, square-to-subtle 6 px radii, compact typography, and no gradients, decorative imagery, nested cards, or viewport-scaled text.

## View Architecture

The `codexSwitchBridgeOverview` contribution becomes a `WebviewView`. The Accounts and API Providers contributions remain native tree views.

The implementation is divided into focused units:

### `QuotaStore`

Own the live per-account quota presentation state that currently resides inside `AccountTreeProvider`. It exposes immutable snapshots and a change event while retaining:

- cache hydration;
- loading, error, cached-fallback, and relogin-required states;
- stale-result suppression through refresh generations;
- account pruning;
- update timestamps and data provenance.

`RefreshCoordinator` remains the only scheduler and the only unit that initiates quota refreshes. It passes the existing shared query context to `QuotaStore`, so the account tree, status bar, auto-switch evaluation, and dashboard never create duplicate requests.

### `DashboardModel`

Build a pure, serializable, secret-free dashboard DTO from:

- the saved entries snapshot and current selection;
- the `QuotaStore` snapshot;
- the `UsageService` snapshot;
- shared-history configuration;
- auto-switch configuration;
- reload-recommended state.

It derives display labels, preferred five-hour quota windows, quota severity, sorted accounts, compact token segments, and the best cached auto-switch candidate. The candidate is explicitly advisory: the existing auto-switch command still re-fetches and ranks eligible accounts before changing runtime auth.

### `DashboardViewProvider`

Own Webview lifecycle, HTML/CSS/JavaScript, rendering, and message transport only. It subscribes to model changes and coalesces bursts before posting the newest DTO. It dispatches a fixed allowlist of UI actions to existing extension commands; arbitrary command identifiers from Webview messages are rejected.

The view posts its current state as soon as it resolves. When visible state lacks fresh quota data, it asks `RefreshCoordinator` to schedule a single coalesced full refresh; it never queries quota itself. Normal timer refresh remains managed by the coordinator.

## Information And Interaction Design

### Account Mode

The current route shows:

- account name and plan;
- preferred five-hour remaining quota as a circular progress indicator;
- reset time;
- secondary quota window as compact text when present;
- source only when it disambiguates duplicate local/cloud names;
- shared-history status;
- automatic-switch state and the best currently cached candidate.

The auto-switch rule is represented truthfully as `Switch at 0%`, because current behavior activates only when the five-hour quota is exhausted. The toggle calls the existing enable or disable command. Settings opens the existing configuration flow. “Switch now” opens the existing account/API mode picker rather than bypassing command validation.

Other accounts are sorted by actionable state, then remaining five-hour quota descending. Each row shows its name, remaining percentage, reset time where useful, and a quota bar. Loading, exhausted, cached, unavailable, locked, invalid, and relogin-required states use distinct labels and icons instead of mapping unknown data to zero.

### API Provider Mode

The current route shows Provider identity, wire API when available and safe, tracked local token usage, shared-history status, and switch controls. It states that API Provider mode has no account-quota data and does not render a fake percentage ring.

The auto-switch area remains visible but reads `Enabled for account mode` when enabled. Other account quota bars remain available so the user can see the account route they could switch back to.

No API key, auth value, raw Provider configuration, base URL containing credentials, or account token enters the dashboard DTO.

### Token Usage

The collapsed summary contains total recorded local tokens and a segmented contribution bar for attributed selections. Expanding it reveals input, output, cached input, reasoning output, attributed, unattributed, and indexed-session values already produced by `UsageService`.

The UI continues to label these as local recorded tokens, not billing cost. Long selection names truncate with a tooltip, and small segments remain represented in the accessible text list even when visually too narrow to label.

### Reload Recommendation

When a switch requires Codex to reload its runtime state, the dashboard shows one persistent bottom strip with a Reload button. The status is cleared by the existing reload lifecycle. The dashboard must not create an additional popup notification or reset the notification deduplication state.

## State Flow

```text
commands / configuration / timers
              |
              v
      RefreshCoordinator
       |       |       |
       v       v       v
 saved entries  QuotaStore  UsageService
       \          |          /
        \         |         /
          DashboardModel
                |
                v
      DashboardViewProvider
                |
                v
       secret-free Webview DTO
```

Selection changes rebuild the model immediately, then the coordinator refreshes the affected quota and usage state through its existing coalesced queue. Loading preserves the last valid quota value and adds a refreshing marker, preventing full-page flashes.

The model distinguishes:

- refresh attempt time;
- actual quota query time;
- cache hydration or cached fallback;
- stale data;
- unavailable data.

Dates cross the Webview boundary only as ISO strings or preformatted labels. Maps, auth payloads, Provider configs, and error stacks never cross it.

## Error And Empty States

- **No saved entries:** show compact Add Account and Add API Provider actions.
- **Unknown active auth:** identify that runtime auth was not matched and offer Switch Mode.
- **Refreshing:** retain prior values, animate only a small refresh indicator, and honor reduced-motion preferences.
- **Failed with cache:** show cached values plus a stale warning and Retry action.
- **Failed without cache:** show the concrete safe error label and Retry action; never show `0%`.
- **Relogin required:** replace the quota action with Re-login for that account.
- **Storage locked/pending/invalid:** show the relevant state and route action through the existing management command where one exists.
- **Token indexing:** show stable skeleton values or `Indexing`, then update without resizing fixed-format controls.
- **Partial token coverage:** show the existing partial-coverage warning without exposing file paths or errors to the Webview.

## Theme, Layout, And Accessibility

- Use VS Code CSS variables for foreground, muted text, surfaces, borders, focus outlines, buttons, warnings, errors, and chart colors.
- Support dark, light, and high-contrast themes without assuming a dark background.
- The quota ring uses an accessible text value and SVG/CSS progress semantics; color is never the only status cue.
- All interactive elements are native `button` or `input` controls with labels, keyboard focus, and tooltips for icon-only actions.
- At narrow widths, the current-route content stacks vertically and command buttons wrap without clipping.
- Quota rings, progress bars, toggles, and buttons have stable dimensions so loading and label changes do not shift surrounding content.
- Motion is limited to refreshing feedback and is disabled under `prefers-reduced-motion`.

## Webview Security

- Generate a per-render nonce and enforce a restrictive Content Security Policy.
- Load no remote fonts, scripts, images, analytics, or network resources.
- Disable command URIs inside the Webview.
- Validate every incoming message by discriminated action name and primitive payload shape.
- Maintain a fixed host-side action-to-command map.
- Escape all user-controlled labels before initial HTML insertion and render subsequent model data through DOM text APIs, never `innerHTML`.
- Persist only non-sensitive UI state such as whether token details are expanded.

## Testing Strategy

### Unit Tests

- `QuotaStore`: cache hydration, loading transitions, cached fallback, stale completion suppression, pruning, unavailable states, and relogin state.
- `DashboardModel`: account and Provider modes, five-hour-window selection, truthful zero-quota rule, candidate ranking, duplicate names, sorting, token segments, no-cache errors, and secret-field absence.
- Webview protocol: action allowlist, malformed message rejection, command routing, and update coalescing.

### Manifest And Rendering Contract Tests

- Overview contribution uses `type: webview` while Accounts and API Providers remain tree views.
- CSP contains a nonce and excludes remote origins and unsafe inline execution.
- HTML contains accessible controls and no secret DTO fields.
- Narrow, standard, light, dark, high-contrast, loading, error, Provider, and reload-required fixture states render without overflow or overlap.

### Regression And Packaging

- Existing account switching, Provider switching, history reconciliation, auto-switch, token usage, status bar, storage, and manifest suites continue to pass.
- TypeScript build, bundled extension build, repository verification, package audit, and VSIX archive validation pass.
- The packaged VSIX contains required dashboard assets and contains no tests, source maps not already intended for shipping, temporary mockups, credentials, or environment files.

## Scope

This iteration changes the Overview presentation and introduces the shared quota presentation store needed to keep all consumers consistent. It does not redesign the native Accounts or API Providers trees, change the zero-quota auto-switch algorithm, add billing estimates, add remote telemetry, or change conversation-history identity.

Release publication and remote-machine synchronization are separate deployment steps after the implementation is verified and the user requests or authorizes that release scope.
