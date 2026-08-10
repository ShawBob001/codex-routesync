import { execFile } from "node:child_process";

export interface HistoryMigrationResult {
  rollout_updates: number;
  thread_updates: number;
  backup_dir: string | null;
}

export interface HistoryInventoryResult {
  source_providers: string[];
}

export interface HistoryRepairSummary {
  rollout_updates: number;
  thread_updates: number;
  backup_dirs: string[];
  sources: string[];
  completed_sources: string[];
  failed_source: string | null;
}

export interface HistoryRepairDependencies {
  enabled: boolean;
  sourceProviders: readonly string[];
  targetProvider?: string;
  runMigration: (sourceProvider: string, targetProvider: string) => Promise<HistoryMigrationResult>;
  markReloadRecommended: (summary: HistoryRepairSummary) => void | PromiseLike<void>;
  showErrorMessage: (message: string) => PromiseLike<unknown>;
}

function isUpdateCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function parseHistoryMigrationResult(output: string): HistoryMigrationResult {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object") {
    throw new Error("History migration returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  if (
    !isUpdateCount(result.rollout_updates)
    || !isUpdateCount(result.thread_updates)
    || (result.backup_dir !== null && typeof result.backup_dir !== "string")
  ) {
    throw new Error("History migration returned an invalid result.");
  }
  return {
    rollout_updates: result.rollout_updates,
    thread_updates: result.thread_updates,
    backup_dir: result.backup_dir,
  };
}

export function parseHistoryInventoryResult(output: string): HistoryInventoryResult {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object") {
    throw new Error("History inventory returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.source_providers)
    || !result.source_providers.every(
      (provider) => typeof provider === "string" && provider.trim().length > 0,
    )
  ) {
    throw new Error("History inventory returned an invalid result.");
  }
  return { source_providers: [...result.source_providers] };
}

export function runHistoryInventoryProcess(
  pythonExecutable: string,
  scriptPath: string,
  codexHome: string,
): Promise<HistoryInventoryResult> {
  return new Promise((resolve, reject) => {
    execFile(
      pythonExecutable,
      [scriptPath, "--codex-home", codexHome, "--list-sources", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`History inventory failed: ${detail}`));
          return;
        }
        try {
          resolve(parseHistoryInventoryResult(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export function runHistoryMigrationProcess(
  pythonExecutable: string,
  scriptPath: string,
  codexHome: string,
  sourceProvider: string,
  targetProvider = "openai",
): Promise<HistoryMigrationResult> {
  return new Promise((resolve, reject) => {
    execFile(
      pythonExecutable,
      [
        scriptPath,
        "--codex-home",
        codexHome,
        "--source",
        sourceProvider,
        "--target",
        targetProvider,
        "--json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`History repair failed for provider "${sourceProvider}": ${detail}`));
          return;
        }
        try {
          resolve(parseHistoryMigrationResult(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export function selectHistoryMigrationSources(
  values: readonly string[],
  targetProvider = "openai",
): string[] {
  const target = targetProvider.trim();
  const normalized = new Set<string>();
  for (const value of values) {
    const provider = value.trim();
    if (provider && provider !== target) {
      normalized.add(provider);
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Runs only from the explicit maintenance command. Extension activation must
 * never call this function because rollout files may be receiving live writes.
 */
export async function repairSharedHistory(
  dependencies: HistoryRepairDependencies,
): Promise<HistoryRepairSummary | null> {
  if (!dependencies.enabled) {
    return null;
  }

  const targetProvider = dependencies.targetProvider?.trim() || "openai";
  const sources = selectHistoryMigrationSources(dependencies.sourceProviders, targetProvider);
  const summary: HistoryRepairSummary = {
    rollout_updates: 0,
    thread_updates: 0,
    backup_dirs: [],
    sources,
    completed_sources: [],
    failed_source: null,
  };

  for (const sourceProvider of sources) {
    try {
      const result = await dependencies.runMigration(sourceProvider, targetProvider);
      summary.rollout_updates += result.rollout_updates;
      summary.thread_updates += result.thread_updates;
      if (result.backup_dir) {
        summary.backup_dirs.push(result.backup_dir);
      }
      summary.completed_sources.push(sourceProvider);
    } catch (error) {
      summary.failed_source = sourceProvider;
      const hasCompletedUpdates = summary.rollout_updates > 0 || summary.thread_updates > 0;
      if (hasCompletedUpdates) {
        await dependencies.markReloadRecommended(summary);
      }
      const message = error instanceof Error ? error.message : String(error);
      const retainedUpdates = hasCompletedUpdates
        ? ` Completed updates were kept (${summary.rollout_updates} rollout record(s), ${summary.thread_updates} thread record(s)); reload is recommended.`
        : "";
      await dependencies.showErrorMessage(
        `Could not finish repairing local Codex history for provider "${sourceProvider}". `
        + `Completed ${summary.completed_sources.length} of ${sources.length} source migration(s).`
        + `${retainedUpdates} ${message}`,
      );
      return summary.completed_sources.length > 0 ? summary : null;
    }
  }

  if (summary.rollout_updates > 0 || summary.thread_updates > 0) {
    await dependencies.markReloadRecommended(summary);
  }
  return summary;
}
