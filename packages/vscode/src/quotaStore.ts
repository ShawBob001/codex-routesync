import * as vscode from "vscode";
import {
  isReloginRequiredRefreshError,
  QuotaInfo,
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

const DEFAULT_CONCURRENCY = 4;

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

type MaybePromise<T> = T | Promise<T>;

interface QuotaStoreDependencies {
  now: () => number;
  getCachedQuota: (account: SavedAccountInfo) => MaybePromise<CachedQuotaSnapshot | null>;
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

  async reconcileAccounts(accounts: readonly SavedAccountInfo[]): Promise<void> {
    this.assertActive();
    const readyAccounts = accounts.filter((account) => account.storageState === "ready");
    const readyIds = new Set(readyAccounts.map((account) => account.id));
    let changed = false;

    for (const accountId of this.states.keys()) {
      if (!readyIds.has(accountId)) {
        this.states.delete(accountId);
        this.generations.delete(accountId);
        changed = true;
      }
    }

    for (const account of readyAccounts) {
      const cached = await this.dependencies.getCachedQuota(account);
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
    await this.reconcileAccounts(options.snapshot.accounts);
    const targetSet = targetIds ? new Set(targetIds) : null;
    const accounts = options.snapshot.accounts.filter((account) => (
      account.storageState === "ready" && (!targetSet || targetSet.has(account.id))
    ));
    if (accounts.length === 0) return;

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
        refreshAttemptedAt: attemptedAt,
        queriedAt: previous?.queriedAt ?? null,
        provenance: previous?.provenance ?? null,
        cacheReason: previous?.cacheReason ?? null,
        reloginRequired: false,
        reloginMessage: null,
      });
    }
    this.publish();

    await runWithConcurrency(accounts, options.concurrency ?? DEFAULT_CONCURRENCY, async (account) => {
      const generation = generations.get(account.id)!;
      try {
        const result = await this.dependencies.queryQuota(account, options.queryContext, {
          reason: options.reason,
        });
        if (!this.isCurrent(account.id, generation)) return;
        await this.applyResult(account, result, attemptedAt, generation);
      } catch (error) {
        if (!this.isCurrent(account.id, generation)) return;
        this.applyError(account.id, error, attemptedAt);
      }
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
        refreshAttemptedAt: attemptedAt,
        reloginRequired,
        reloginMessage: reloginRequired ? RELOGIN_REQUIRED_MESSAGE : previous.reloginMessage,
      });
      this.publish();
      return;
    }

    const usedCache = result.usedCachedQuota === true;
    const fallbackError = result.fallbackErrorMessage ?? null;
    const isFallback = usedCache && (
      fallbackError !== null
      || typeof result.fallbackStatusCode === "number"
      || result.fallbackReloginRequired === true
    );
    const cached = usedCache ? await this.dependencies.getCachedQuota(account) : null;
    if (!this.isCurrent(account.id, generation)) return;
    const reloginRequired = result.info.unavailableReason?.code === "relogin_required"
      || result.fallbackReloginRequired === true;
    this.states.set(account.id, {
      accountId: account.id,
      info: cloneQuotaInfo(result.info),
      loading: false,
      errorMessage: fallbackError,
      errorStatusCode: result.fallbackStatusCode ?? null,
      refreshAttemptedAt: attemptedAt,
      queriedAt: usedCache && cached ? cached.queriedAtMs : this.dependencies.now(),
      provenance: usedCache ? (isFallback ? "cache-fallback" : "cache-reuse") : "network",
      cacheReason: isFallback ? formatCacheReason(result) : null,
      reloginRequired,
      reloginMessage: reloginRequired ? RELOGIN_REQUIRED_MESSAGE : null,
    });
    this.publish();
  }

  private applyError(accountId: string, error: unknown, attemptedAt: number): void {
    const previous = this.states.get(accountId) ?? emptyState(accountId);
    const reloginRequired = isReloginRequiredRefreshError(error);
    this.states.set(accountId, {
      ...cloneState(previous),
      loading: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStatusCode: null,
      refreshAttemptedAt: attemptedAt,
      reloginRequired,
      reloginMessage: reloginRequired ? RELOGIN_REQUIRED_MESSAGE : previous.reloginMessage,
    });
    this.publish();
  }

  private isCurrent(accountId: string, generation: number): boolean {
    return this.generations.get(accountId) === generation;
  }

  private publish(): void {
    this.revision += 1;
    this.emitter.fire(this.getSnapshot());
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("QuotaStore is disposed");
  }
}

function emptyState(accountId: string): AccountQuotaState {
  return {
    accountId,
    info: null,
    loading: false,
    errorMessage: null,
    errorStatusCode: null,
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
  if (typeof result.fallbackStatusCode === "number") {
    return result.fallbackErrorMessage
      ? `HTTP ${result.fallbackStatusCode}: ${result.fallbackErrorMessage}`
      : `HTTP ${result.fallbackStatusCode}`;
  }
  return result.fallbackErrorMessage ?? null;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
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
