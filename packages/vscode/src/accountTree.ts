import * as vscode from "vscode";
import {
  getTokenExpiry,
  formatTokenExpiry,
  QuotaInfo,
  RELOGIN_REQUIRED_MESSAGE,
  WindowInfo,
} from "@codex-switchbridge/core";
import { startPerformanceLog } from "./log";
import { AccountQuotaState, QuotaStore } from "./quotaStore";
import {
  createSavedEntriesSnapshot,
  listSavedAccounts,
  SavedAccountInfo,
  SavedEntriesSnapshot,
} from "./savedEntries";
import { formatCompactTokens, stableSubjectId, UsageService } from "./tokenUsage";

interface AccountQuotaPresentationState {
  info: QuotaInfo | null;
  loading: boolean;
  error: boolean;
  updatedAt: number | null;
  cached?: boolean;
  cacheMessage?: string;
  cacheReason?: string;
  reloginRequired?: boolean;
  reloginMessage?: string;
}

export type AccountTreeNode = AccountGroupItem | AccountTreeItem | AccountDetailItem;
const LOG_PREFIX = "[codex-switchbridge:vscode:accountTree]";
export type AccountGroupKind = "local" | "cloud";

function toQuotaPresentationState(
  state: Readonly<AccountQuotaState> | undefined,
): AccountQuotaPresentationState | undefined {
  if (!state) return undefined;
  const cached = state.provenance === "hydrated-cache"
    || state.provenance === "cache-reuse"
    || state.provenance === "cache-fallback";
  return {
    info: state.info,
    loading: state.loading,
    error: state.errorMessage != null,
    updatedAt: state.queriedAt,
    cached,
    cacheMessage: cached
      ? state.cacheReason
        ? `Quota: Showing cached data; latest refresh failed: ${state.cacheReason}`
        : "Quota: Showing cached data"
      : undefined,
    cacheReason: state.cacheReason ?? undefined,
    reloginRequired: state.reloginRequired,
    reloginMessage: state.reloginMessage ?? undefined,
  };
}

function windowLabel(w: WindowInfo): string {
  if (w.windowSeconds == null) return "Quota";
  const hours = w.windowSeconds / 3600;
  if (hours <= 5) return "5h";
  if (hours <= 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatQuotaSummary(info: QuotaInfo | null): string | null {
  if (!info?.primaryWindow) {
    return null;
  }

  const parts = [`${windowLabel(info.primaryWindow)} ${Math.max(0, 100 - Math.round(info.primaryWindow.usedPercent))}%`];
  if (info.secondaryWindow) {
    parts.push(`${windowLabel(info.secondaryWindow)} ${Math.max(0, 100 - Math.round(info.secondaryWindow.usedPercent))}%`);
  }
  return parts.join(" · ");
}

function getQuotaUnavailableMessage(info: QuotaInfo | null | undefined): string | null {
  return info?.unavailableReason?.message ?? null;
}

function isQuotaInfoReloginRequired(info: QuotaInfo | null | undefined): boolean {
  return info?.unavailableReason?.code === "relogin_required";
}

function getQuotaStateReloginMessage(quotaState: AccountQuotaPresentationState | undefined): string | null {
  if (quotaState?.reloginRequired || isQuotaInfoReloginRequired(quotaState?.info)) {
    return quotaState?.reloginMessage ?? RELOGIN_REQUIRED_MESSAGE;
  }
  return null;
}

function isQuotaStateFailed(quotaState: AccountQuotaPresentationState | undefined): boolean {
  return Boolean(
    quotaState
    && !quotaState.loading
    && (quotaState.info?.unavailableReason || (quotaState.error && !quotaState.cached)),
  );
}

function isQuotaStateCached(quotaState: AccountQuotaPresentationState | undefined): boolean {
  return Boolean(quotaState && !quotaState.loading && !isQuotaStateFailed(quotaState) && quotaState.cached);
}

function formatResetTime(resetsAt: Date | null): string | null {
  if (!resetsAt) return null;
  const secs = Math.floor((resetsAt.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "Resets soon";

  const hours = Math.floor(secs / 3600);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `Resets in ${days}d${remainingHours}h`;
  }
  if (hours >= 1) {
    return `Resets in ${hours}h`;
  }
  return "Resets in <1h";
}

function formatWindowDescription(w: WindowInfo): string {
  const used = Math.round(w.usedPercent);
  const remaining = Math.max(0, 100 - used);
  const reset = formatResetTime(w.resetsAt);
  return reset
    ? `${used}% used / ${remaining}% remaining · ${reset}`
    : `${used}% used / ${remaining}% remaining`;
}

function formatWindowDetailDescription(w: WindowInfo): string {
  const used = Math.round(w.usedPercent);
  const remaining = Math.max(0, 100 - used);
  const reset = formatResetTime(w.resetsAt);
  return reset
    ? `${remaining}% remaining · ${reset}`
    : `${remaining}% remaining`;
}

function quotaIcon(usedPercent: number): vscode.ThemeIcon {
  const remaining = Math.max(0, 100 - Math.round(usedPercent));
  if (remaining === 0) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  }
  if (usedPercent >= 70) {
    return new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
  }
  if (usedPercent >= 50) {
    return new vscode.ThemeIcon("info", new vscode.ThemeColor("editorWarning.foreground"));
  }
  return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
}

function appendQuotaTooltip(lines: string[], info: QuotaInfo) {
  if (info.primaryWindow) {
    lines.push(`${windowLabel(info.primaryWindow)} quota: ${formatWindowDescription(info.primaryWindow)}`);
  }

  if (info.secondaryWindow) {
    lines.push(`${windowLabel(info.secondaryWindow)} quota: ${formatWindowDescription(info.secondaryWindow)}`);
  }

  for (const item of info.additional) {
    if (item.primary) {
      lines.push(`${item.name}: ${formatWindowDescription(item.primary)}`);
    }
    if (item.secondary) {
      lines.push(`${item.name} secondary: ${formatWindowDescription(item.secondary)}`);
    }
  }

  if (info.codeReview) {
    lines.push(`Code review: ${formatWindowDescription(info.codeReview)}`);
  }

  if (info.credits?.hasCredits) {
    lines.push("Extra credits: Available");
  }
  if (info.credits?.balance != null) {
    lines.push(`Credit balance: ${info.credits.balance}`);
  }
  if (info.resetCredits) {
    const applicable = info.resetCredits.applicableAvailableCount;
    lines.push(
      applicable != null && applicable !== info.resetCredits.availableCount
        ? `Rate-limit resets: ${applicable} applicable / ${info.resetCredits.availableCount} available`
        : `Rate-limit resets: ${info.resetCredits.availableCount} available`,
    );
  }
}

export class AccountDetailItem extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    tooltip?: string,
    public readonly parent?: AccountTreeItem,
    public readonly rawValue?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = parent ? `accountDetail:${parent.account.id}:${label}` : `accountDetail:${label}`;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = "accountDetail";
  }
}

export class AccountGroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: AccountTreeItem[],
    iconId: string,
    public readonly groupKind: AccountGroupKind,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `accountGroup:${groupKind}`;
    const trackedTokens = children.reduce((sum, child) => sum + (child.trackedTokens ?? 0), 0);
    const usageDescription = children.some((child) => child.trackedTokens == null)
      ? "Indexing usage"
      : `${formatCompactTokens(trackedTokens)} tracked`;
    this.description = `${children.length} saved · ${usageDescription}`;
    this.contextValue = groupKind === "local" ? "accountGroupLocal" : "accountGroupCloud";
    this.iconPath = new vscode.ThemeIcon(iconId);
    for (const child of children) {
      child.groupParent = this;
    }
  }
}

export class AccountTreeItem extends vscode.TreeItem {
  groupParent?: AccountGroupItem;

  constructor(
    public readonly account: SavedAccountInfo,
    public readonly quotaState?: AccountQuotaPresentationState,
    public readonly trackedTokens: number | null = null,
  ) {
    super(
      account.name,
      account.isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `account:${account.id}`;

    const email = account.meta?.email ?? account.publicEmail ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const parts: string[] = [];
    if (account.isCurrent) {
      parts.push("Active");
    }
    parts.push(account.source === "cloud" ? "Cloud" : "Local");
    if (trackedTokens != null) {
      parts.push(`${formatCompactTokens(trackedTokens)} tracked`);
    }
    const quotaSummary = formatQuotaSummary(quotaState?.info ?? null);
    const reloginMessage = getQuotaStateReloginMessage(quotaState);

    if (account.storageState === "locked") {
      parts.push("Storage locked");
    } else if (account.storageState === "pending") {
      parts.push("Payload pending");
    } else if (account.storageState === "invalid") {
      parts.push("Invalid saved auth");
    } else if (reloginMessage) {
      parts.push(reloginMessage);
    } else if (quotaState?.loading) {
      parts.push("Refreshing quota");
    } else if (quotaSummary) {
      parts.push(quotaSummary);
    } else if (getQuotaUnavailableMessage(quotaState?.info)) {
      parts.push(getQuotaUnavailableMessage(quotaState?.info)!);
    } else if (quotaState?.error) {
      parts.push("Quota unavailable");
    } else if (quotaState) {
      parts.push("No quota data");
    }

    this.description = parts.join(" · ");
    this.contextValue =
      account.source === "cloud" && account.storageState === "locked"
        ? "accountCloudLocked"
        : account.source === "cloud" && account.recoveryAvailable
          ? "accountCloudRecoverable"
        : account.source === "cloud"
          ? "accountCloud"
          : "accountLocal";

    if (reloginMessage) {
      this.iconPath = new vscode.ThemeIcon("sign-in", new vscode.ThemeColor("errorForeground"));
    } else if (account.storageState === "locked") {
      this.iconPath = new vscode.ThemeIcon("lock");
    } else if (account.storageState === "pending") {
      this.iconPath = account.recoveryAvailable
        ? new vscode.ThemeIcon("cloud-download", new vscode.ThemeColor("editorWarning.foreground"))
        : new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("editorWarning.foreground"));
    } else if (account.storageState === "invalid") {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
    } else if (isQuotaStateFailed(quotaState)) {
      this.iconPath = new vscode.ThemeIcon(
        account.isCurrent ? "pass-filled" : "account",
        new vscode.ThemeColor("errorForeground"),
      );
    } else if (isQuotaStateCached(quotaState)) {
      this.iconPath = new vscode.ThemeIcon(
        account.isCurrent ? "pass-filled" : "account",
        new vscode.ThemeColor("editorWarning.foreground"),
      );
    } else if (account.isCurrent) {
      this.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
    } else {
      this.iconPath = new vscode.ThemeIcon("account");
    }

    const tooltipLines = [
      `Account: ${account.name}`,
      `Email: ${email}`,
      `Plan: ${plan}`,
    ];
    tooltipLines.push(
      trackedTokens == null
        ? "Local token usage: Indexing"
        : `Tracked local token usage: ${trackedTokens.toLocaleString()} tokens`,
    );
    if (account.source === "cloud" && (account.syncVersion != null || account.syncUpdatedAt)) {
      tooltipLines.push(`Sync version: ${account.syncVersion ?? "legacy"}`);
      tooltipLines.push(`Updated: ${account.syncUpdatedAt ?? "unknown"}`);
    }

    if (account.storageState !== "ready") {
      tooltipLines.push(account.storageMessage ?? "Saved auth is unavailable");
      this.tooltip = tooltipLines.join("\n");
      return;
    }

    if (account.auth) {
      const expiry = getTokenExpiry(account.auth);
      const tokenStatus = formatTokenExpiry(account.auth);
      tooltipLines.push(`Token: ${tokenStatus}`);

      if (!reloginMessage && expiry && expiry.getTime() < Date.now()) {
        this.iconPath = new vscode.ThemeIcon(
          account.isCurrent ? "pass-filled" : "account",
          new vscode.ThemeColor("errorForeground")
        );
      }
    }

    if (reloginMessage) {
      tooltipLines.push(`Auth: ${reloginMessage}`);
      tooltipLines.push("Action: Re-login this account");
    }

    if (quotaState?.loading) {
      tooltipLines.push("Quota: Refreshing");
    } else if (quotaState?.info) {
      appendQuotaTooltip(tooltipLines, quotaState.info);
      if (quotaState.info.unavailableReason) {
        tooltipLines.push(`Quota: ${quotaState.info.unavailableReason.message}`);
      } else if (quotaState.cached) {
        tooltipLines.push(quotaState.cacheMessage ?? "Quota: Showing cached data");
      }
    } else if (quotaState?.error) {
      tooltipLines.push("Quota: Failed to load");
    }

    this.tooltip = tooltipLines.join("\n");
  }
}

export class AccountTreeProvider implements vscode.TreeDataProvider<AccountTreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<AccountTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootItems: AccountGroupItem[] = [];
  private currentAccounts: SavedAccountInfo[] | null = null;
  private readonly quotaSubscription: vscode.Disposable;

  constructor(
    private readonly quotaStore: QuotaStore,
    private readonly usageService?: UsageService,
  ) {
    this.quotaSubscription = quotaStore.onDidChange(() => {
      this.syncRootItems(this.currentAccounts ?? listSavedAccounts());
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  refresh(snapshot?: SavedEntriesSnapshot): void {
    const perf = startPerformanceLog(LOG_PREFIX, "accountTree.refresh");
    try {
      const currentSnapshot = snapshot ?? createSavedEntriesSnapshot();
      this.currentAccounts = currentSnapshot.accounts;
      this.quotaStore.reconcileAccounts(currentSnapshot.accounts);
      perf.mark("reconcile-quota-store");
      this.syncRootItems(currentSnapshot.accounts);
      perf.mark("sync-root-items");
      this._onDidChangeTreeData.fire(undefined);
      perf.finish();
    } catch (error) {
      perf.fail(error);
      throw error;
    }
  }

  getTreeItem(element: AccountTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AccountTreeNode): AccountTreeNode[] {
    if (!element) {
      return this.getRootItems();
    }

    if (element instanceof AccountGroupItem) {
      return this.findCurrentGroup(element.groupKind)?.children ?? [];
    }

    if (element instanceof AccountDetailItem) {
      return [];
    }

    return this.getAccountDetails(this.findCurrentAccountItem(element.account.id) ?? element);
  }

  getParent(element: AccountTreeNode): AccountTreeNode | undefined {
    if (element instanceof AccountDetailItem) {
      return element.parent ? (this.findCurrentAccountItem(element.parent.account.id) ?? element.parent) : undefined;
    }
    if (element instanceof AccountTreeItem) {
      const current = this.findCurrentAccountItem(element.account.id) ?? element;
      return current.groupParent
        ? (this.findCurrentGroup(current.groupParent.groupKind) ?? current.groupParent)
        : undefined;
    }
    return undefined;
  }

  dispose() {
    this.quotaSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getRootItems(): AccountGroupItem[] {
    if (this.rootItems.length === 0) {
      const accounts = this.currentAccounts ?? createSavedEntriesSnapshot().accounts;
      this.currentAccounts = accounts;
      this.syncRootItems(accounts);
    }
    return this.rootItems;
  }

  private findCurrentGroup(groupKind: AccountGroupKind): AccountGroupItem | undefined {
    return this.rootItems.find((group) => group.groupKind === groupKind);
  }

  private findCurrentAccountItem(accountId: string): AccountTreeItem | undefined {
    for (const group of this.rootItems) {
      const item = group.children.find((candidate) => candidate.account.id === accountId);
      if (item) {
        return item;
      }
    }
    return undefined;
  }

  private syncRootItems(accounts = listSavedAccounts(), options: { logPerformance?: boolean } = {}) {
    this.currentAccounts = accounts;
    const perf = options.logPerformance === false
      ? null
      : startPerformanceLog(LOG_PREFIX, "accountTree.syncRootItems", {
        accountCount: accounts.length,
      });
    const local: AccountTreeItem[] = [];
    const cloud: AccountTreeItem[] = [];
    const usageSnapshot = this.usageService?.getSnapshot();
    const usageBySubject = new Map(
      usageSnapshot?.subjects.map((subject) => [subject.id, subject.tokens.totalTokens]) ?? [],
    );
    const usageReady = usageSnapshot?.status === "ready";

    for (const account of accounts) {
      const subjectId = stableSubjectId("account", account.id);
      const trackedTokens = usageReady ? usageBySubject.get(subjectId) ?? 0 : null;
      const item = new AccountTreeItem(
        account,
        toQuotaPresentationState(this.quotaStore.get(account.id)),
        trackedTokens,
      );
      if (account.source === "cloud") {
        cloud.push(item);
      } else {
        local.push(item);
      }
    }

    const groups: AccountGroupItem[] = [];
    if (local.length > 0) {
      groups.push(new AccountGroupItem("Local Accounts", local, "device-desktop", "local"));
    }
    if (cloud.length > 0) {
      groups.push(new AccountGroupItem("Cloud Accounts", cloud, "cloud", "cloud"));
    }
    this.rootItems = groups;
    perf?.finish({
      localCount: local.length,
      cloudCount: cloud.length,
      groupCount: groups.length,
    });
  }

  private getAccountDetails(parent: AccountTreeItem): AccountDetailItem[] {
    const { account, quotaState } = parent;
    const email = account.meta?.email ?? account.publicEmail ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const items: AccountDetailItem[] = [];

    const emailItem = new AccountDetailItem("Email", email, email, parent, email);
    if (email !== "unknown") {
      emailItem.contextValue = "accountCopyableField";
    }
    emailItem.iconPath = new vscode.ThemeIcon("mail");
    items.push(emailItem);

    if (account.source === "cloud" && (account.syncVersion != null || account.syncUpdatedAt)) {
      const syncVersionItem = new AccountDetailItem(
        "Sync version",
        String(account.syncVersion ?? "legacy"),
        String(account.syncVersion ?? "legacy"),
        parent,
      );
      syncVersionItem.iconPath = new vscode.ThemeIcon("versions");
      items.push(syncVersionItem);

      const updatedItem = new AccountDetailItem(
        "Updated",
        account.syncUpdatedAt ?? "unknown",
        account.syncUpdatedAt ?? "unknown",
        parent,
      );
      updatedItem.iconPath = new vscode.ThemeIcon("history");
      items.push(updatedItem);

    }

    const planItem = new AccountDetailItem("Plan", plan, plan, parent);
    planItem.iconPath = new vscode.ThemeIcon("tag");
    items.push(planItem);

    const usageItem = new AccountDetailItem(
      "Tracked usage",
      parent.trackedTokens == null ? "Indexing" : `${formatCompactTokens(parent.trackedTokens)} tokens`,
      parent.trackedTokens == null
        ? "Local Codex token records are still being indexed."
        : `${parent.trackedTokens.toLocaleString()} local tokens attributed since tracking began.`,
      parent,
    );
    usageItem.iconPath = new vscode.ThemeIcon(parent.trackedTokens == null ? "loading~spin" : "pulse");
    items.push(usageItem);

    if (account.storageState !== "ready") {
      const storageItem = new AccountDetailItem(
        "Storage",
        account.storageState === "locked"
          ? "Locked"
          : account.storageState === "pending"
            ? "Payload pending"
            : "Invalid",
        account.storageMessage,
        parent
      );
      storageItem.iconPath =
        account.storageState === "locked"
          ? new vscode.ThemeIcon("lock")
          : account.storageState === "pending"
            ? new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("editorWarning.foreground"))
            : new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
      items.push(storageItem);
      return items;
    }

    if (account.auth) {
      const tokenStatus = formatTokenExpiry(account.auth);
      const tokenItem = new AccountDetailItem("Token", tokenStatus, tokenStatus, parent);
      const expiry = getTokenExpiry(account.auth);

      if (expiry && expiry.getTime() < Date.now()) {
        tokenItem.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
      } else {
        tokenItem.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
      }
      items.push(tokenItem);
    }

    const reloginMessage = getQuotaStateReloginMessage(quotaState);
    if (reloginMessage) {
      const reloginItem = new AccountDetailItem(
        "Auth",
        reloginMessage,
        "Refresh token cannot be recovered automatically. Re-login this account.",
        parent
      );
      reloginItem.iconPath = new vscode.ThemeIcon("sign-in", new vscode.ThemeColor("errorForeground"));
      items.push(reloginItem);
    }

    if (quotaState?.loading) {
      const loadingItem = new AccountDetailItem("Quota", "Refreshing", "Fetching quota information", parent);
      loadingItem.iconPath = new vscode.ThemeIcon("loading~spin");
      items.push(loadingItem);
      return items;
    }

    if (quotaState?.error && !quotaState.cached) {
      const errorItem = new AccountDetailItem("Quota", "Failed", "Quota request failed", parent);
      errorItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
      items.push(errorItem);
      return items;
    }

    if (!quotaState?.info) {
      const emptyItem = new AccountDetailItem("Quota", "No data", "No quota data is available yet", parent);
      emptyItem.iconPath = new vscode.ThemeIcon("circle-slash");
      items.push(emptyItem);
      return items;
    }

    const info = quotaState.info;
    if (info.unavailableReason) {
      const unavailableItem = new AccountDetailItem(
        "Quota",
        info.unavailableReason.message,
        info.unavailableReason.message,
        parent
      );
      unavailableItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
      items.push(unavailableItem);
      return items;
    }

    if (quotaState.cached) {
      const cacheStatus = quotaState.cacheReason?.match(/^HTTP \d+/)?.[0];
      const cacheItem = new AccountDetailItem(
        "Quota freshness",
        cacheStatus ? `Cached (${cacheStatus})` : "Cached",
        quotaState.cacheMessage ?? "Quota data came from cache",
        parent
      );
      cacheItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"));
      items.push(cacheItem);
    }

    if (info.primaryWindow) {
      const primaryItem = new AccountDetailItem(
        `${windowLabel(info.primaryWindow)} quota`,
        formatWindowDetailDescription(info.primaryWindow),
        formatWindowDetailDescription(info.primaryWindow),
        parent
      );
      primaryItem.iconPath = quotaIcon(info.primaryWindow.usedPercent);
      items.push(primaryItem);
    }

    if (info.secondaryWindow) {
      const secondaryItem = new AccountDetailItem(
        `${windowLabel(info.secondaryWindow)} quota`,
        formatWindowDetailDescription(info.secondaryWindow),
        formatWindowDetailDescription(info.secondaryWindow),
        parent
      );
      secondaryItem.iconPath = quotaIcon(info.secondaryWindow.usedPercent);
      items.push(secondaryItem);
    }

    for (const additional of info.additional) {
      if (additional.primary) {
        const primaryAdditionalItem = new AccountDetailItem(
          additional.name,
          formatWindowDetailDescription(additional.primary),
          formatWindowDetailDescription(additional.primary),
          parent
        );
        primaryAdditionalItem.iconPath = quotaIcon(additional.primary.usedPercent);
        items.push(primaryAdditionalItem);
      }

      if (additional.secondary) {
        const secondaryAdditionalItem = new AccountDetailItem(
          `${additional.name} secondary`,
          formatWindowDetailDescription(additional.secondary),
          formatWindowDetailDescription(additional.secondary),
          parent
        );
        secondaryAdditionalItem.iconPath = quotaIcon(additional.secondary.usedPercent);
        items.push(secondaryAdditionalItem);
      }
    }

    if (info.codeReview) {
      const codeReviewItem = new AccountDetailItem(
        "Code review",
        formatWindowDetailDescription(info.codeReview),
        formatWindowDetailDescription(info.codeReview),
        parent
      );
      codeReviewItem.iconPath = quotaIcon(info.codeReview.usedPercent);
      items.push(codeReviewItem);
    }

    if (info.resetCredits) {
      const available = info.resetCredits.availableCount;
      const applicable = info.resetCredits.applicableAvailableCount;
      const description = applicable != null && applicable !== available
        ? `${applicable} applicable / ${available} available`
        : `${available} available`;
      const resetCreditsItem = new AccountDetailItem(
        "Rate-limit resets",
        description,
        `Earned rate-limit resets: ${description}`,
        parent,
      );
      resetCreditsItem.iconPath = new vscode.ThemeIcon(
        available > 0 ? "debug-restart" : "circle-slash",
        available > 0 ? new vscode.ThemeColor("charts.green") : undefined,
      );
      items.push(resetCreditsItem);
    }

    if (info.credits?.hasCredits) {
      const creditsItem = new AccountDetailItem(
        "Extra credits",
        "Available",
        "This account has extra credits",
        parent
      );
      creditsItem.iconPath = new vscode.ThemeIcon("credit-card", new vscode.ThemeColor("charts.green"));
      items.push(creditsItem);
    }

    if (info.credits?.balance != null) {
      const balanceItem = new AccountDetailItem(
        "Credit balance",
        info.credits.balance,
        "Credit balance reported by the account service",
        parent,
      );
      balanceItem.iconPath = new vscode.ThemeIcon("credit-card");
      items.push(balanceItem);
    }

    return items;
  }
}

