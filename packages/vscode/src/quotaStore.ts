import * as vscode from "vscode";
import {
  isReloginRequiredRefreshError,
  QuotaInfo,
  QuotaUnavailableCode,
  RELOGIN_REQUIRED_MESSAGE,
} from "@codex-switchbridge/core";
import {
  querySavedAccountQuota,
  SavedAccountInfo,
  SavedAccountQuotaQueryContext,
  SavedEntriesSnapshot,
} from "./savedEntries";
import {
  CachedQuotaSnapshot,
  getCachedQuotaSnapshot,
  QuotaQueryResultWithFallbackMetadata,
} from "./quotaCache";
import { logInfo, logWarn, startPerformanceLog } from "./log";

const DEFAULT_CONCURRENCY = 4;
const SLOW_ACCOUNT_THRESHOLD_MS = 3000;
const LOG_PREFIX = "[codex-switchbridge:vscode:quotaStore]";

export type QuotaProvenance =
  | "network"
  | "hydrated-cache"
  | "cache-reuse"
  | "cache-fallback"
  | null;

export interface AccountQuotaState {
  accountId: string;
  info: QuotaInfo | null;
  loading: boolean;
  errorMessage: string | null;
  errorStatusCode: number | null;
  fallbackReasonCode: QuotaUnavailableCode | null;
  refreshAttemptedAt: number | null;
  queriedAt: number | null;
  provenance: QuotaProvenance;
  cacheReason: string | null;
  reloginRequired: boolean;
  reloginMessage: string | null;
}

export interface QuotaStoreSnapshot {
  revision: number;
  byAccountId: ReadonlyMap<string, Readonly<AccountQuotaState>>;
}

export interface AccountQuotaRefreshOptions {
  snapshot: SavedEntriesSnapshot;
  queryContext?: SavedAccountQuotaQueryContext;
  reason?: string;
  refreshId?: string;
  concurrency?: number;
}

interface QuotaStoreDependencies {
  now: () => number;
  getCachedQuota: (account: SavedAccountInfo) => CachedQuotaSnapshot | null;
  queryQuota: (
    account: SavedAccountInfo,
    context: SavedAccountQuotaQueryContext | undefined,
    options: { reason?: string },
  ) => Promise<QuotaQueryResultWithFallbackMetadata>;
}

export class QuotaStore implements vscode.Disposable {
  private readonly states = new Map<string, AccountQuotaState>();
  private readonly generations = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<QuotaStoreSnapshot>();
  private readonly dependencies: QuotaStoreDependencies;
  private revision = 0;
  private publishQueued = false;
  private disposed = false;

  readonly onDidChange = this.emitter.event;

  constructor(dependencies: Partial<QuotaStoreDependencies> = {}) {
    this.dependencies = {
      now: Date.now,
      getCachedQuota: getCachedQuotaSnapshot,
      queryQuota: (account, context, options) => (
        querySavedAccountQuota(account, context, options) as Promise<QuotaQueryResultWithFallbackMetadata>
      ),
      ...dependencies,
    };
  }

  getSnapshot(): QuotaStoreSnapshot {
    return {
      revision: this.revision,
      byAccountId: new Map(
        [...this.states].map(([accountId, state]) => [accountId, cloneState(state)]),
      ),
    };
  }

  get(accountId: string): Readonly<AccountQuotaState> | undefined {
    const state = this.states.get(accountId);
    return state ? cloneState(state) : undefined;
  }

  reconcileAccounts(accounts: readonly SavedAccountInfo[]): void {
    this.assertActive();
    const readyAccounts = accounts.filter((account) => account.storageState === "ready");
    const readyIds = new Set(readyAccounts.map((account) => account.id));
    let changed = false;

    for (const accountId of this.states.keys()) {
      if (!readyIds.has(accountId)) {
        this.states.delete(accountId);
        this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
        changed = true;
      }
    }

    for (const account of readyAccounts) {
      let cached: CachedQuotaSnapshot | null;
      try {
        cached = this.dependencies.getCachedQuota(account);
      } catch {
        logWarn(LOG_PREFIX, "hydrate-cache-failed", { source: account.source });
        continue;
      }
      if (!cached) continue;
      const previous = this.states.get(account.id);
      if (previous?.loading) continue;
      if (previous?.info && (previous.queriedAt ?? 0) >= cached.queriedAtMs) continue;

      this.states.set(account.id, {
        accountId: account.id,
        info: cloneQuotaInfo(cached.info),
        loading: false,
        errorMessage: null,
        errorStatusCode: null,
        fallbackReasonCode: null,
        refreshAttemptedAt: previous?.refreshAttemptedAt ?? null,
        queriedAt: cached.queriedAtMs,
        provenance: "hydrated-cache",
        cacheReason: null,
        reloginRequired: false,
        reloginMessage: null,
      });
      changed = true;
    }

    if (changed) this.publish();
  }

  async refreshQuota(
    targetIds: Iterable<string> | undefined,
    options: AccountQuotaRefreshOptions,
  ): Promise<void> {
    this.assertActive();
    const normalizedTargetIds = targetIds ? [...targetIds] : undefined;
    const perf = startPerformanceLog(LOG_PREFIX, "quotaStore.refreshQuota", {
      targetCount: normalizedTargetIds?.length ?? null,
      reason: options.reason ?? null,
      refreshId: options.refreshId ?? null,
    });
    this.reconcileAccounts(options.snapshot.accounts);
    const targetSet = normalizedTargetIds ? new Set(normalizedTargetIds) : null;
    const accounts = options.snapshot.accounts.filter((account) => (
      account.storageState === "ready" && (!targetSet || targetSet.has(account.id))
    ));
    if (accounts.length === 0) {
      perf.finish({ effectiveCount: 0 });
      return;
    }

    logInfo(LOG_PREFIX, "refresh-start", {
      targetCount: targetSet?.size ?? null,
      reason: options.reason ?? null,
      refreshId: options.refreshId ?? null,
      effectiveCount: accounts.length,
    });

    const generations = new Map<string, number>();
    const attemptedAt = this.dependencies.now();
    for (const account of accounts) {
      const generation = (this.generations.get(account.id) ?? 0) + 1;
      this.generations.set(account.id, generation);
      generations.set(account.id, generation);
      const previous = this.states.get(account.id);
      this.states.set(account.id, {
        accountId: account.id,
        info: previous?.info ? cloneQuotaInfo(previous.info) : null,
        loading: true,
        errorMessage: null,
        errorStatusCode: null,
        fallbackReasonCode: null,
        refreshAttemptedAt: attemptedAt,
        queriedAt: previous?.queriedAt ?? null,
        provenance: previous?.provenance ?? null,
        cacheReason: previous?.cacheReason ?? null,
        reloginRequired: false,
        reloginMessage: null,
      });
    }
    this.publish();

    const accountDurations: number[] = [];
    const slowestAccounts: Array<{ source: string; durationMs: number }> = [];
    let okCount = 0;
    let errorCount = 0;
    let inflightReuseCount = 0;
    let cacheReuseCount = 0;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    await runWithConcurrency(accounts, concurrency, async (account) => {
      const generation = generations.get(account.id)!;
      const startedAt = this.dependencies.now();
      const accountPerf = startPerformanceLog(
        LOG_PREFIX,
        "quotaStore.refreshQuota.account",
        {
          source: account.source,
          refreshId: options.refreshId ?? null,
        },
        { mode: "adaptive", slowThresholdMs: SLOW_ACCOUNT_THRESHOLD_MS },
      );
      let resultKind = "error";
      let resultSource = "direct";
      try {
        const result = await this.dependencies.queryQuota(account, options.queryContext, {
          reason: options.reason,
        });
        const durationMs = Math.max(0, this.dependencies.now() - startedAt);
        accountDurations.push(durationMs);
        slowestAccounts.push({ source: account.source, durationMs });
        if (result.kind === "ok") okCount += 1;
        else errorCount += 1;
        if ((result as { source?: string }).source === "reused" || (result as { reusedInflight?: boolean }).reusedInflight) {
          inflightReuseCount += 1;
        }
        if (result.usedCachedQuota === true) cacheReuseCount += 1;
        resultKind = result.kind;
        resultSource = (result as { source?: string }).source ?? "direct";
        logQuotaResult(result);
        if (!this.isCurrent(account.id, generation)) {
          accountPerf.finish({ resultKind, source: resultSource, durationMs, stale: true });
          return;
        }
        await this.applyResult(account, result, attemptedAt, generation);
        accountPerf.finish({ resultKind, source: resultSource, durationMs });
      } catch (error) {
        const durationMs = Math.max(0, this.dependencies.now() - startedAt);
        accountDurations.push(durationMs);
        slowestAccounts.push({ source: account.source, durationMs });
        errorCount += 1;
        accountPerf.fail(error instanceof Error ? error.constructor.name : typeof error, { durationMs });
        if (!this.isCurrent(account.id, generation)) return;
        this.applyError(account.id, error, attemptedAt);
        logWarn(LOG_PREFIX, "refresh-result-error", {
          source: account.source,
          refreshId: options.refreshId ?? null,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        });
      }
    });

    const sortedDurations = [...accountDurations].sort((left, right) => left - right);
    slowestAccounts.sort((left, right) => right.durationMs - left.durationMs);
    slowestAccounts.length = Math.min(slowestAccounts.length, 5);
    logInfo(LOG_PREFIX, "refresh-finish", {
      targetCount: targetSet?.size ?? null,
      reason: options.reason ?? null,
      refreshId: options.refreshId ?? null,
    });
    perf.finish({
      requestedCount: targetSet?.size ?? accounts.length,
      effectiveCount: accounts.length,
      concurrency,
      okCount,
      errorCount,
      inflightReuseCount,
      cacheReuseCount,
      p50Ms: percentile(sortedDurations, 0.5),
      p95Ms: percentile(sortedDurations, 0.95),
      maxMs: sortedDurations[sortedDurations.length - 1] ?? 0,
      slowestAccountsTopN: slowestAccounts,
    });
  }

  markReloginRequired(
    accountIds: Iterable<string>,
    message = RELOGIN_REQUIRED_MESSAGE,
  ): void {
    this.assertActive();
    let changed = false;
    for (const accountId of accountIds) {
      if (typeof accountId !== "string" || accountId.length === 0) continue;
      const previous = this.states.get(accountId) ?? emptyState(accountId);
      this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
      this.states.set(accountId, {
        ...cloneState(previous),
        loading: false,
        reloginRequired: true,
        reloginMessage: message,
      });
      changed = true;
    }
    if (changed) this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.publishQueued = false;
    this.states.clear();
    this.generations.clear();
    this.emitter.dispose();
  }

  private async applyResult(
    account: SavedAccountInfo,
    result: QuotaQueryResultWithFallbackMetadata,
    attemptedAt: number,
    generation: number,
  ): Promise<void> {
    const previous = this.states.get(account.id) ?? emptyState(account.id);
    if (result.kind !== "ok") {
      const reloginRequired = isReloginRequiredRefreshError(result.message);
      this.states.set(account.id, {
        ...cloneState(previous),
        loading: false,
        errorMessage: result.message,
        errorStatusCode: null,
        fallbackReasonCode: null,
        refreshAttemptedAt: attemptedAt,
        reloginRequired,
        reloginMessage: reloginRequired ? RELOGIN_REQUIRED_MESSAGE : previous.reloginMessage,
      });
      this.queuePublish();
      return;
    }

    const usedCache = result.usedCachedQuota === true;
    const fallbackReasonCode = safeQuotaUnavailableCode(result.fallbackReasonCode);
    const fallbackStatusCode = safeHttpStatusCode(result.fallbackStatusCode);
    const isFallback = usedCache && (
      result.fallbackRefreshFailed === true
      || result.fallbackErrorMessage != null
      || fallbackReasonCode !== null
      || fallbackStatusCode !== null
      || result.fallbackReloginRequired === true
    );
    let cached: CachedQuotaSnapshot | null = null;
    if (usedCache) {
      try {
        cached = this.dependencies.getCachedQuota(account);
      } catch {
        cached = null;
      }
    }
    if (!this.isCurrent(account.id, generation)) return;
    const reloginRequired = result.info.unavailableReason?.code === "relogin_required"
      || result.fallbackReloginRequired === true;
    this.states.set(account.id, {
      accountId: account.id,
      info: cloneQuotaInfo(result.info),
      loading: false,
      errorMessage: isFallback ? "Refresh failed" : null,
      errorStatusCode: fallbackStatusCode,
      fallbackReasonCode,
      refreshAttemptedAt: attemptedAt,
      queriedAt: usedCache && cached ? cached.queriedAtMs : this.dependencies.now(),
      provenance: usedCache ? (isFallback ? "cache-fallback" : "cache-reuse") : "network",
      cacheReason: isFallback ? formatCacheReason(result) : null,
      reloginRequired,
      reloginMessage: reloginRequired ? RELOGIN_REQUIRED_MESSAGE : null,
    });
    this.queuePublish();
  }

  private applyError(accountId: string, error: unknown, attemptedAt: number): void {
    const previous = this.states.get(accountId) ?? emptyState(accountId);
    const reloginRequired = isReloginRequiredRefreshError(error);
    this.states.set(accountId, {
      ...cloneState(previous),
      loading: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStatusCode: null,
      fallbackReasonCode: null,
      refreshAttemptedAt: attemptedAt,
      reloginRequired,
      reloginMessage: reloginRequired ? RELOGIN_REQUIRED_MESSAGE : previous.reloginMessage,
    });
    this.queuePublish();
  }

  private isCurrent(accountId: string, generation: number): boolean {
    return this.generations.get(accountId) === generation;
  }

  private publish(): void {
    this.publishQueued = false;
    this.revision += 1;
    this.emitter.fire(this.getSnapshot());
  }

  private queuePublish(): void {
    if (this.disposed || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      if (!this.publishQueued) return;
      this.publishQueued = false;
      if (!this.disposed) this.publish();
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("QuotaStore is disposed");
  }
}

function logQuotaResult(result: QuotaQueryResultWithFallbackMetadata): void {
  if (result.kind !== "ok") {
    logInfo(LOG_PREFIX, "quota-result", {
      resultKind: result.kind,
      unavailableReason: null,
      statusCode: null,
    });
    return;
  }

  const fallbackReasonCode = result.usedCachedQuota === true
    ? safeQuotaUnavailableCode(result.fallbackReasonCode)
    : null;
  const fallbackStatusCode = result.usedCachedQuota === true
    ? safeHttpStatusCode(result.fallbackStatusCode)
    : null;
  logInfo(LOG_PREFIX, "quota-result", {
    resultKind: result.kind,
    unavailableReason: fallbackReasonCode
      ?? safeQuotaUnavailableCode(result.info.unavailableReason?.code),
    statusCode: fallbackStatusCode
      ?? safeHttpStatusCode(result.info.unavailableReason?.statusCode),
  });
}

function emptyState(accountId: string): AccountQuotaState {
  return {
    accountId,
    info: null,
    loading: false,
    errorMessage: null,
    errorStatusCode: null,
    fallbackReasonCode: null,
    refreshAttemptedAt: null,
    queriedAt: null,
    provenance: null,
    cacheReason: null,
    reloginRequired: false,
    reloginMessage: null,
  };
}

function cloneQuotaInfo(info: QuotaInfo): QuotaInfo {
  return structuredClone(info);
}

function cloneState(state: AccountQuotaState): AccountQuotaState {
  return structuredClone(state);
}

function formatCacheReason(result: QuotaQueryResultWithFallbackMetadata): string | null {
  const statusCode = safeHttpStatusCode(result.fallbackStatusCode);
  return statusCode === null ? "Refresh failed" : `HTTP ${statusCode}`;
}

const QUOTA_UNAVAILABLE_CODES = new Set<QuotaUnavailableCode>([
  "workspace_deactivated",
  "missing_auth_tokens",
  "invalid_auth_token",
  "relogin_required",
  "quota_token_rejected",
  "request_failed",
]);

function safeQuotaUnavailableCode(value: unknown): QuotaUnavailableCode | null {
  return typeof value === "string" && QUOTA_UNAVAILABLE_CODES.has(value as QuotaUnavailableCode)
    ? value as QuotaUnavailableCode
    : null;
}

function safeHttpStatusCode(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : DEFAULT_CONCURRENCY;
  const limit = Math.max(1, Math.min(DEFAULT_CONCURRENCY, requested));
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}
