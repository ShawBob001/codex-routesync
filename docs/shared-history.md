# Conversation history across account and API-provider modes

Codex RouteSync keeps new account sessions and Responses-compatible API-provider sessions in one local Codex history bucket. The VS Code setting `codex-switchbridge.shareHistoryAcrossProviders` is enabled by default. The CLI uses the same shared route by default for compatible providers; pass `--separate-history` when a provider must keep its own history identity.

## How the shared route works

Account mode uses Codex's built-in `openai` provider identity. For a compatible API provider, RouteSync keeps that identity and applies the provider's `base_url` through `openai_base_url`. Authentication still comes from the selected provider profile.

Because both modes write new threads with the same provider identity, the Codex history view reads one local timeline instead of splitting it by provider name.

Shared routing requires:

```toml
wire_api = "responses"
base_url = "https://your-provider.example/v1"
```

The route applies only under the same `CODEX_HOME`. It does not copy or merge ChatGPT web history, Codex Cloud tasks, connectors, quotas, or history between devices.

## Repair older threads

Threads created before shared routing was enabled may still carry a custom provider ID. To migrate those records:

1. Stop active Codex output.
2. Run **Codex RouteSync: Repair Shared Conversation History**.
3. Use the **Reload recommended** status-bar action when the repair finishes.

Python 3 is required only for this explicit maintenance command. Extension activation never launches the migration and never rewrites conversation files.

The repair process:

- inventories provider IDs directly from rollout JSONL and SQLite, including IDs whose saved profile was renamed or deleted;
- updates only `session_meta.payload.model_provider` in rollout JSONL;
- updates matching `threads.model_provider` rows in `state_5.sqlite`;
- creates a backup under `CODEX_HOME/switchbridge-history-migration-backups`;
- checks rollout fingerprints before replacement and stops if a file changed;
- validates JSONL and SQLite provider values by thread ID before completion.

The maintenance lock coordinates repair processes, but Codex itself does not use that lock. Run repair only when no response is being generated.

## Reload behavior

RouteSync updates files on disk immediately. A running Codex extension may still cache authentication or history state in memory. The default `statusBar` reload policy shows one non-blocking action when a reload is useful. It does not display repeated notification popups.
