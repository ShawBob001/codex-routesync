# Unified Routes Navigation Design

## Problem

The SwitchBridge activity-bar container currently contributes three separate views: a one-row Dashboard launcher, Accounts, and API Providers. They read as unrelated panels even though they all operate on the same active route. Opening the container also leaves users one extra click away from the central dashboard.

## Considered approaches

1. **Embed the complete dashboard in the sidebar.** It opens automatically, but recreates the cramped layout the editor-area dashboard was introduced to solve. Rejected.
2. **Keep three views and auto-expand/collapse them.** Low implementation cost, but preserves the visual fragmentation and duplicate title actions. Rejected.
3. **Contribute one unified routes tree and auto-focus the editor dashboard when it becomes visible.** This gives one coherent navigation surface while preserving the spacious dashboard. Recommended and approved under the user's standing instruction to use the recommended design without further confirmation.

## Information architecture

The activity-bar container contributes one view, `codexSwitchBridgeRoutes`, titled “Accounts & API Routes” / “账号与 API 路由”. Its tree is:

```text
Accounts & API Routes
├── Accounts
│   ├── Local Accounts
│   └── Cloud Accounts
└── API Providers
    └── provider entries
```

The two top-level groups are presentation-only nodes. They delegate children, tree items, and parent relationships to the existing account and provider tree providers. Existing account/provider commands and context values remain unchanged.

## Dashboard opening behavior

The unified `TreeView` listens to `onDidChangeVisibility`:

- When the view first becomes visible, create or focus the central dashboard.
- If the view is already visible during activation, open it immediately.
- Re-showing the view focuses the existing panel rather than creating a duplicate.

VS Code does not expose a direct activity-bar click event. Visibility is the supported reliable signal for first reveal and for switching back from another container. A compact Open Dashboard title action remains as a fallback if the container stays visible while the editor panel is manually closed.

## Commands and menus

All view title and item-context menu predicates target `codexSwitchBridgeRoutes`; the three legacy view IDs are removed from the manifest and activation code. The visible title bar stays compact:

- Open Dashboard
- Refresh
- Add Account
- Add API Provider

Less frequent actions remain available in the overflow menu. Existing command IDs do not change, preserving keybindings and command-palette behavior.

## Localization

Manifest localization adds the unified view name in English and Simplified Chinese. Runtime top-level group labels follow the current SwitchBridge language preference and refresh when it changes.

## Tests

- Manifest tests assert that only `codexSwitchBridgeRoutes` is contributed and no menu references legacy view IDs.
- Unit tests cover top-level groups, child delegation, parent chains, and refresh propagation from both underlying providers.
- Activation tests cover hidden-to-visible, initially visible, repeated reveal, and focus-without-duplicate behavior.
- Existing account/provider command tests are migrated to helpers that navigate the unified tree instead of retaining fake legacy aliases.
- Packaging and visual checks verify that the editor dashboard remains unchanged and automatically appears after revealing the container.

## Success criteria

- The sidebar shows one coherent route view, not three independent sections.
- Accounts and API providers remain fully manageable through the unified tree.
- Revealing SwitchBridge automatically opens or focuses the central dashboard.
- English and Chinese labels are complete, with no stale legacy view IDs in the packaged extension.
