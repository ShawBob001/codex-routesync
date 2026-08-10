# Shared local history

Codex SwitchBridge keeps account sessions and Responses-compatible provider
sessions in one local Codex history bucket by routing saved providers through
Codex's built-in `openai` provider. The setting
`codex-switchbridge.shareHistoryAcrossProviders` is enabled by default.

This affects new local threads under the same `CODEX_HOME`. It does not merge
ChatGPT web history, Codex Cloud tasks, quotas, connectors, or other cloud data.

## Repairing older threads

Threads created before shared routing was enabled may still carry a custom
provider ID. To migrate those records:

1. Stop any active Codex response.
2. Run **Codex SwitchBridge: Repair Local Shared History**.
3. When the status bar shows **Reload recommended**, click it or run
   **Codex SwitchBridge: Reload Window**.

Python 3 is required only for this explicit maintenance command. Extension
activation never launches the migration and never rewrites conversation files.

The repair process:

- inventories provider IDs directly from rollout JSONL and SQLite, including
  IDs whose saved provider profile was renamed or deleted;
- updates only `session_meta.payload.model_provider` in rollout JSONL;
- updates matching `threads.model_provider` rows in `state_5.sqlite`;
- creates a backup under `CODEX_HOME/switchbridge-history-migration-backups`;
- checks rollout fingerprints before replacement and aborts if a file changed;
- validates JSONL and SQLite provider values by thread ID before completion.

The maintenance lock coordinates repair processes, but Codex itself does not
use that lock. Always run repair when no response is being generated.
