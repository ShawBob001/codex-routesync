import { getModeDisplayName, QuotaInfo, WindowInfo } from "@codex-switchbridge/core";
import {
  getFiveHourQuotaWindow,
  getRemainingQuotaPercent,
  rankAutoSwitchCandidates,
} from "./autoSwitch";
import type { AccountQuotaState, QuotaStoreSnapshot } from "./quotaStore";
import type {
  SavedAccountInfo,
  SavedEntriesSnapshot,
  SavedProviderInfo,
  StorageSource,
} from "./savedEntries";
import {
  formatCompactTokens,
  stableSubjectId,
  TokenTotals,
  UsageSnapshot,
} from "./tokenUsage";
import type { ReloadRecommendationSnapshot } from "./statusBar";

export type DashboardQuotaStatus =
  | "available"
  | "exhausted"
  | "loading"
  | "no-data"
  | "unavailable"
  | "relogin-required"
  | "storage-locked"
  | "storage-pending"
  | "storage-invalid";

export type DashboardQuotaFreshness = "fresh" | "cached" | "stale" | null;

export interface DashboardQuotaWindow {
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
}

export interface DashboardQuota {
  status: DashboardQuotaStatus;
  refreshing: boolean;
  freshness: DashboardQuotaFreshness;
  fiveHour: DashboardQuotaWindow | null;
  secondary: DashboardQuotaWindow | null;
  message: string | null;
  queriedAt: string | null;
  refreshAttemptedAt: string | null;
}

export interface DashboardCandidate {
  accountId: string;
  name: string;
  disambiguator: "Local" | "Cloud" | null;
  remainingPercent: number;
  resetsAt: string | null;
  freshness: DashboardQuotaFreshness;
  advisory: true;
}

export interface DashboardAccount {
  accountId: string;
  name: string;
  disambiguator: "Local" | "Cloud" | null;
  plan: string | null;
  localTokens: number | null;
  quota: DashboardQuota;
}

export interface DashboardUsageSegment {
  id: string;
  kind: "account" | "provider";
  label: string;
  sessionCount: number;
  totalTokens: number;
  percent: number;
  compactTokens: string;
}

export interface DashboardUsage {
  status: UsageSnapshot["status"];
  coverage: UsageSnapshot["coverage"];
  message: string | null;
  total: TokenTotals;
  compactTotal: string;
  attributedTokens: number;
  attributedPercent: number;
  unattributedTokens: number;
  sessionCount: number;
  trackingStartedAt: string | null;
  updatedAt: string | null;
  segments: DashboardUsageSegment[];
}

export type DashboardRoute =
  | {
      kind: "account";
      accountId: string | null;
      name: string;
      source: StorageSource | null;
      disambiguator: "Local" | "Cloud" | null;
      plan: string | null;
      localTokens: number | null;
      quota: DashboardQuota;
    }
  | {
      kind: "provider";
      providerId: string | null;
      name: string;
      source: StorageSource | null;
      disambiguator: "Local" | "Cloud" | null;
      wireApi: "responses" | "chat" | null;
      storageState: "ready" | "locked" | "pending" | "invalid" | "unmatched";
      localTokens: number | null;
    }
  | {
      kind: "unknown";
      label: string;
      plan: string | null;
    };

export interface DashboardModel {
  version: 1;
  generatedAt: string;
  savedEntryCounts: { accounts: number; providers: number };
  route: DashboardRoute;
  autoSwitch: {
    enabled: boolean;
    appliesToCurrentRoute: boolean;
    ruleLabel: "Switch at 0%";
    candidate: DashboardCandidate | null;
  };
  sharedHistory: { enabled: boolean; label: string };
  otherAccounts: DashboardAccount[];
  usage: DashboardUsage;
  reload: { recommended: boolean; message: string | null };
}

export interface BuildDashboardModelInput {
  saved: SavedEntriesSnapshot;
  providers: readonly SavedProviderInfo[];
  quota: QuotaStoreSnapshot;
  usage: UsageSnapshot;
  autoSwitchEnabled: boolean;
  sharedHistoryEnabled: boolean;
  reload: ReloadRecommendationSnapshot;
  nowMs: number;
}

export function buildDashboardModel(
  input: Readonly<BuildDashboardModelInput>,
): DashboardModel {
  const accounts = input.saved.accounts;
  const duplicateAccountNames = duplicateNames(accounts);
  const duplicateProviderNames = duplicateNames(input.providers);
  const route = buildRoute(input, duplicateAccountNames, duplicateProviderNames);
  const currentAccountId = route.kind === "account" ? route.accountId : null;
  const candidates = rankAutoSwitchCandidates(
    accounts
      .filter((account) => isCandidateAccount(account, currentAccountId, input.quota))
      .map((account) => ({
        candidate: account,
        info: input.quota.byAccountId.get(account.id)!.info!,
      })),
  ).sort((left, right) => {
    if (right.remainingPercent !== left.remainingPercent) {
      return right.remainingPercent - left.remainingPercent;
    }
    const resetDelta = windowResetTime(left.window) - windowResetTime(right.window);
    if (resetDelta !== 0) return resetDelta;
    return left.candidate.id.localeCompare(right.candidate.id);
  });
  const bestCandidate = candidates[0] ?? null;
  const otherAccounts = accounts
    .filter((account) => account.id !== currentAccountId)
    .map((account) => buildDashboardAccount(
      account,
      input.quota.byAccountId.get(account.id),
      input.usage,
      duplicateAccountNames,
    ))
    .sort(compareDashboardAccounts);

  return {
    version: 1,
    generatedAt: toIso(input.nowMs) ?? new Date(0).toISOString(),
    savedEntryCounts: {
      accounts: accounts.length,
      providers: input.providers.length,
    },
    route,
    autoSwitch: {
      enabled: input.autoSwitchEnabled,
      appliesToCurrentRoute: route.kind === "account",
      ruleLabel: "Switch at 0%",
      candidate: bestCandidate
        ? {
            accountId: bestCandidate.candidate.id,
            name: bestCandidate.candidate.name,
            disambiguator: disambiguator(bestCandidate.candidate, duplicateAccountNames),
            remainingPercent: bestCandidate.remainingPercent,
            resetsAt: toIso(bestCandidate.window.resetsAt?.getTime() ?? null),
            freshness: freshness(input.quota.byAccountId.get(bestCandidate.candidate.id)),
            advisory: true,
          }
        : null,
    },
    sharedHistory: {
      enabled: input.sharedHistoryEnabled,
      label: input.sharedHistoryEnabled ? "Shared history" : "Route-specific history",
    },
    otherAccounts,
    usage: buildUsage(input.usage),
    reload: {
      recommended: input.reload.recommended,
      message: input.reload.recommended ? input.reload.reason : null,
    },
  };
}

function buildRoute(
  input: Readonly<BuildDashboardModelInput>,
  duplicateAccountNames: ReadonlySet<string>,
  duplicateProviderNames: ReadonlySet<string>,
): DashboardRoute {
  const selection = input.saved.selection;
  if (selection.kind === "account") {
    const account = input.saved.bySourceAndName.get(`${selection.source}:${selection.name}`) ?? null;
    return {
      kind: "account",
      accountId: account?.id ?? null,
      name: account?.name ?? selection.name,
      source: account?.source ?? selection.source,
      disambiguator: account ? disambiguator(account, duplicateAccountNames) : null,
      plan: account?.meta?.plan ?? selection.meta?.plan ?? null,
      localTokens: account ? subjectTokens(input.usage, "account", account.source, account.name) : null,
      quota: account
        ? buildQuota(account, input.quota.byAccountId.get(account.id))
        : emptyQuota("unavailable", "Saved account is unavailable."),
    };
  }

  if (selection.kind === "provider") {
    const provider = input.providers.find(
      (entry) => entry.source === selection.source && entry.name === selection.name,
    ) ?? null;
    return {
      kind: "provider",
      providerId: provider?.id ?? null,
      name: getModeDisplayName(provider?.name ?? selection.name),
      source: provider?.source ?? selection.source,
      disambiguator: provider ? disambiguator(provider, duplicateProviderNames) : null,
      wireApi: provider ? safeWireApi(provider) : null,
      storageState: provider ? providerStorageState(provider) : "unmatched",
      localTokens: provider
        ? subjectTokens(input.usage, "provider", provider.source, provider.name)
        : null,
    };
  }

  return {
    kind: "unknown",
    label: "No active saved route",
    plan: selection.meta?.plan ?? null,
  };
}

function buildDashboardAccount(
  account: SavedAccountInfo,
  state: Readonly<AccountQuotaState> | undefined,
  usage: UsageSnapshot,
  duplicateAccountNames: ReadonlySet<string>,
): DashboardAccount {
  return {
    accountId: account.id,
    name: account.name,
    disambiguator: disambiguator(account, duplicateAccountNames),
    plan: account.meta?.plan ?? null,
    localTokens: subjectTokens(usage, "account", account.source, account.name),
    quota: buildQuota(account, state),
  };
}

function buildQuota(
  account: SavedAccountInfo,
  state: Readonly<AccountQuotaState> | undefined,
): DashboardQuota {
  if (account.storageState === "locked") {
    return emptyQuota("storage-locked", "Unlock storage to view quota.");
  }
  if (account.storageState === "pending") {
    return emptyQuota("storage-pending", "Waiting for synced storage.");
  }
  if (account.storageState === "invalid") {
    return emptyQuota("storage-invalid", "Saved account data is invalid.");
  }
  if (state?.reloginRequired) {
    return quotaFromState(state, "relogin-required", "Sign in again to refresh quota.");
  }
  if (!state) {
    return emptyQuota("no-data", "Quota has not been loaded yet.");
  }
  if (!state.info) {
    return quotaFromState(
      state,
      state.loading ? "loading" : state.errorMessage ? "unavailable" : "no-data",
      state.loading ? "Refreshing quota..." : state.errorMessage ? "Quota is unavailable." : "Quota has not been loaded yet.",
    );
  }
  if (state.info.unavailableReason) {
    const status = state.info.unavailableReason.code === "relogin_required"
      ? "relogin-required"
      : "unavailable";
    return quotaFromState(
      state,
      status,
      status === "relogin-required" ? "Sign in again to refresh quota." : "Quota is unavailable.",
    );
  }
  if (state.errorMessage && state.provenance !== "cache-fallback") {
    return quotaFromState(
      state,
      "unavailable",
      "Quota refresh failed. Showing the last known value.",
    );
  }
  const window = getFiveHourQuotaWindow(state.info);
  if (!window || !Number.isFinite(window.usedPercent)) {
    return quotaFromState(state, "unavailable", "A five-hour quota window is unavailable.");
  }
  const remaining = getRemainingQuotaPercent(window);
  return quotaFromState(
    state,
    remaining <= 0 ? "exhausted" : "available",
    remaining <= 0 ? "Five-hour quota is exhausted." : null,
  );
}

function quotaFromState(
  state: Readonly<AccountQuotaState>,
  status: DashboardQuotaStatus,
  message: string | null,
): DashboardQuota {
  const info = state.info;
  const fiveHourSource = info ? getFiveHourQuotaWindow(info) : null;
  const otherWindow = info && fiveHourSource
    ? (info.primaryWindow === fiveHourSource ? info.secondaryWindow : info.primaryWindow)
    : null;
  return {
    status,
    refreshing: state.loading,
    freshness: freshness(state),
    fiveHour: fiveHourSource && Number.isFinite(fiveHourSource.usedPercent)
      ? projectWindow(fiveHourSource)
      : null,
    secondary: otherWindow && Number.isFinite(otherWindow.usedPercent)
      ? projectWindow(otherWindow)
      : null,
    message,
    queriedAt: toIso(state.queriedAt),
    refreshAttemptedAt: toIso(state.refreshAttemptedAt),
  };
}

function emptyQuota(status: DashboardQuotaStatus, message: string): DashboardQuota {
  return {
    status,
    refreshing: false,
    freshness: null,
    fiveHour: null,
    secondary: null,
    message,
    queriedAt: null,
    refreshAttemptedAt: null,
  };
}

function projectWindow(window: WindowInfo): DashboardQuotaWindow {
  return {
    label: windowLabel(window),
    remainingPercent: getRemainingQuotaPercent(window),
    resetsAt: toIso(window.resetsAt?.getTime() ?? null),
    windowSeconds: finiteOrNull(window.windowSeconds),
  };
}

function windowLabel(window: WindowInfo): string {
  const seconds = window.windowSeconds;
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "Quota";
  const hours = seconds / 3_600;
  if (hours <= 5) return "5h";
  if (hours <= 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function freshness(state: Readonly<AccountQuotaState> | undefined): DashboardQuotaFreshness {
  if (state?.errorMessage && state.provenance !== "cache-fallback" && state.info) {
    return "stale";
  }
  switch (state?.provenance) {
    case "network": return "fresh";
    case "hydrated-cache":
    case "cache-reuse": return "cached";
    case "cache-fallback": return "stale";
    default: return null;
  }
}

function isCandidateAccount(
  account: SavedAccountInfo,
  currentAccountId: string | null,
  quota: QuotaStoreSnapshot,
): boolean {
  if (account.id === currentAccountId || account.storageState !== "ready") return false;
  const state = quota.byAccountId.get(account.id);
  if (
    !state?.info
    || state.reloginRequired
    || state.info.unavailableReason
    || (state.errorMessage != null && state.provenance !== "cache-fallback")
  ) return false;
  const window = getFiveHourQuotaWindow(state.info);
  return window != null && Number.isFinite(window.usedPercent);
}

function compareDashboardAccounts(left: DashboardAccount, right: DashboardAccount): number {
  const rankDelta = quotaSortRank(left.quota.status) - quotaSortRank(right.quota.status);
  if (rankDelta !== 0) return rankDelta;
  const remainingDelta = (right.quota.fiveHour?.remainingPercent ?? -1)
    - (left.quota.fiveHour?.remainingPercent ?? -1);
  if (remainingDelta !== 0) return remainingDelta;
  const resetDelta = isoTime(left.quota.fiveHour?.resetsAt) - isoTime(right.quota.fiveHour?.resetsAt);
  if (resetDelta !== 0) return resetDelta;
  return left.accountId.localeCompare(right.accountId);
}

function quotaSortRank(status: DashboardQuotaStatus): number {
  switch (status) {
    case "available": return 0;
    case "loading": return 1;
    case "exhausted": return 2;
    case "relogin-required": return 3;
    case "no-data": return 4;
    case "unavailable": return 5;
    case "storage-locked": return 6;
    case "storage-pending": return 7;
    case "storage-invalid": return 8;
  }
}

function buildUsage(snapshot: UsageSnapshot): DashboardUsage {
  const total = projectTokens(snapshot.total);
  const unattributedTokens = safeToken(snapshot.unattributed.totalTokens);
  const attributedTokens = Math.max(0, total.totalTokens - unattributedTokens);
  const denominator = total.totalTokens;
  const segments = snapshot.subjects.map((subject) => {
    const subjectTotal = safeToken(subject.tokens.totalTokens);
    return {
      id: subject.id,
      kind: subject.kind,
      label: subject.label,
      sessionCount: safeToken(subject.sessionCount),
      totalTokens: subjectTotal,
      percent: finitePercent(subjectTotal, denominator),
      compactTokens: formatCompactTokens(subjectTotal),
    };
  });
  return {
    status: snapshot.status,
    coverage: snapshot.coverage,
    message: snapshot.status === "indexing"
      ? "Indexing local Codex sessions..."
      : snapshot.status === "uninitialized"
        ? "Waiting to index local Codex sessions."
        : snapshot.coverage === "partial"
          ? "Some local sessions could not be indexed."
          : null,
    total,
    compactTotal: formatCompactTokens(total.totalTokens),
    attributedTokens,
    attributedPercent: finitePercent(attributedTokens, denominator),
    unattributedTokens,
    sessionCount: safeToken(snapshot.sessionCount),
    trackingStartedAt: toIso(snapshot.trackingStartedAt),
    updatedAt: snapshot.status === "uninitialized" ? null : toIso(snapshot.updatedAt),
    segments,
  };
}

function projectTokens(tokens: TokenTotals): TokenTotals {
  return {
    inputTokens: safeToken(tokens.inputTokens),
    cachedInputTokens: safeToken(tokens.cachedInputTokens),
    outputTokens: safeToken(tokens.outputTokens),
    reasoningOutputTokens: safeToken(tokens.reasoningOutputTokens),
    totalTokens: safeToken(tokens.totalTokens),
  };
}

function subjectTokens(
  usage: UsageSnapshot,
  kind: "account" | "provider",
  source: StorageSource,
  name: string,
): number | null {
  if (usage.status !== "ready") return null;
  const id = stableSubjectId(kind, `${source}:${name}`);
  return safeToken(usage.subjects.find((subject) => subject.id === id)?.tokens.totalTokens ?? 0);
}

function safeWireApi(provider: SavedProviderInfo): "responses" | "chat" | null {
  const wireApi = provider.profile?.config.wire_api ?? provider.config.wire_api;
  return wireApi === "responses" || wireApi === "chat" ? wireApi : null;
}

function providerStorageState(
  provider: SavedProviderInfo,
): "ready" | "locked" | "pending" | "invalid" {
  if (provider.locked) return "locked";
  if (provider.pending) return "pending";
  if (provider.invalid) return "invalid";
  return "ready";
}

function duplicateNames(entries: readonly { name: string }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function disambiguator(
  entry: { name: string; source: StorageSource },
  duplicates: ReadonlySet<string>,
): "Local" | "Cloud" | null {
  if (!duplicates.has(entry.name)) return null;
  return entry.source === "cloud" ? "Cloud" : "Local";
}

function finitePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function safeToken(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function finiteOrNull(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function toIso(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoTime(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function windowResetTime(window: WindowInfo): number {
  const value = window.resetsAt?.getTime();
  return value != null && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
