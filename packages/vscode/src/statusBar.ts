import * as vscode from "vscode";
import { QuotaInfo, WindowInfo, getModeDisplayName } from "@codex-switchbridge/core";
import { logInfo, logWarn, startPerformanceLog } from "./log";
import {
  createSavedEntriesSnapshot,
  getSavedAccountEntry,
  getSavedCurrentSelection,
  querySavedAccountQuota,
  SavedAccountQuotaQueryContext,
  SavedEntriesSnapshot,
} from "./savedEntries";
import { formatCompactTokens, stableSubjectId, UsageService } from "./tokenUsage";
const LOG_PREFIX = "[codex-switchbridge:vscode:statusBar]";

interface StatusBarRefreshOptions {
  skipQuota?: boolean;
  snapshot?: SavedEntriesSnapshot;
  queryContext?: SavedAccountQuotaQueryContext;
  reason?: string;
  refreshId?: string;
}

export interface ReloadRecommendationSnapshot {
  recommended: boolean;
  reason: string | null;
}

function windowLabel(window: WindowInfo): string {
  if (window.windowSeconds == null) return "quota";
  const hours = window.windowSeconds / 3600;
  if (hours <= 5) return "5h";
  if (hours <= 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function isFiveHourWindow(window: WindowInfo): boolean {
  if (window.windowSeconds == null) return false;
  return window.windowSeconds / 3600 <= 5;
}

function getPreferredStatusWindow(info: QuotaInfo): WindowInfo | null {
  if (info.primaryWindow && isFiveHourWindow(info.primaryWindow)) {
    return info.primaryWindow;
  }
  if (info.secondaryWindow && isFiveHourWindow(info.secondaryWindow)) {
    return info.secondaryWindow;
  }
  return info.primaryWindow ?? info.secondaryWindow ?? null;
}

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private reloadStatusBarItem: vscode.StatusBarItem;
  private configListener: vscode.Disposable | undefined;
  private reloadRecommended = false;
  private reloadReason: string | null = null;
  private readonly reloadRecommendationEmitter = new vscode.EventEmitter<ReloadRecommendationSnapshot>();
  private refreshGeneration = 0;

  readonly onDidChangeReloadRecommendation = this.reloadRecommendationEmitter.event;

  constructor(private readonly usageService?: UsageService) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = "codex-switchbridge.refreshQuota";
    this.statusBarItem.name = "Codex SwitchBridge Quota";
    this.reloadStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      101,
    );
    this.reloadStatusBarItem.command = "codex-switchbridge.reloadWindow";
    this.reloadStatusBarItem.name = "Codex SwitchBridge Reload Recommendation";
    this.reloadStatusBarItem.text = "$(debug-restart) Reload recommended";
    this.reloadStatusBarItem.tooltip = "Reload this VS Code window so Codex uses the newly selected account or provider.";
    this.updateVisibility();
  }

  private isVisibleEnabled(): boolean {
    return vscode.workspace.getConfiguration("codex-switchbridge").get<boolean>("showStatusBar", true);
  }

  private updateVisibility() {
    if (this.isVisibleEnabled()) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }

    if (this.isVisibleEnabled() && this.reloadRecommended) {
      this.reloadStatusBarItem.show();
    } else {
      this.reloadStatusBarItem.hide();
    }
  }

  markReloadRecommended(reason?: string): void {
    const nextReason = reason?.trim() || null;
    const changed = !this.reloadRecommended || this.reloadReason !== nextReason;
    this.reloadRecommended = true;
    this.reloadReason = nextReason;
    this.reloadStatusBarItem.tooltip = nextReason
      ? `${nextReason}\n\nClick to reload this VS Code window.`
      : "Reload this VS Code window so Codex uses the newly selected account or provider.";
    this.updateVisibility();
    if (changed) this.reloadRecommendationEmitter.fire(this.getReloadRecommendation());
  }

  clearReloadRecommendation(): void {
    const changed = this.reloadRecommended || this.reloadReason != null;
    this.reloadRecommended = false;
    this.reloadReason = null;
    this.updateVisibility();
    if (changed) this.reloadRecommendationEmitter.fire(this.getReloadRecommendation());
  }

  getReloadRecommendation(): ReloadRecommendationSnapshot {
    return {
      recommended: this.reloadRecommended,
      reason: this.reloadRecommended ? this.reloadReason : null,
    };
  }

  startConfigurationSync(context: vscode.ExtensionContext) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("codex-switchbridge.showStatusBar")
        || e.affectsConfiguration("codex-switchbridge.reloadWindowAfterSwitch")
      ) {
        if (
          e.affectsConfiguration("codex-switchbridge.reloadWindowAfterSwitch")
          && vscode.workspace
            .getConfiguration("codex-switchbridge")
            .get<string>("reloadWindowAfterSwitch", "statusBar") !== "statusBar"
        ) {
          this.clearReloadRecommendation();
        }
        this.updateVisibility();
        if (this.isVisibleEnabled()) {
          void this.refreshNow({
            snapshot: createSavedEntriesSnapshot(),
            reason: "config-change",
          }).catch((error) => {
            logWarn(LOG_PREFIX, "show-status-bar-refresh-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    });
    context.subscriptions.push(this.configListener);
  }

  async refreshNow(options: StatusBarRefreshOptions = {}) {
    const generation = ++this.refreshGeneration;
    const perf = startPerformanceLog(LOG_PREFIX, "statusBar.refreshNow", {
      skipQuota: options?.skipQuota ?? false,
      reason: options.reason ?? null,
      refreshId: options.refreshId ?? null,
    });
    if (!this.isVisibleEnabled()) {
      perf.finish({
        result: "hidden",
      });
      return;
    }

    try {
      const snapshot = options.snapshot ?? createSavedEntriesSnapshot();
      const selection = getSavedCurrentSelection(snapshot);
      perf.mark("get-saved-current-selection", {
        selectionKind: selection.kind,
        name: "name" in selection ? selection.name : null,
      });
      logInfo(LOG_PREFIX, "refresh-start", {
        selectionKind: selection.kind,
        name: "name" in selection ? selection.name : null,
      });

      if (selection.kind === "provider") {
        this.statusBarItem.command = "codex-switchbridge.refreshUsage";
        const modeLabel = getModeDisplayName(selection.name);
        const sourceLabel = selection.source === "cloud" ? "cloud" : "local";
        const usage = this.getTrackedUsage("provider", selection.source, selection.name);
        const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
        this.statusBarItem.text = `$(plug) ${modeLabel} · ${usageLabel}`;
        this.statusBarItem.tooltip = [
          `Mode: ${modeLabel}`,
          `Source: ${sourceLabel}`,
          usage == null
            ? "Tracked local token usage: Indexing"
            : `Tracked local token usage: ${usage.toLocaleString()} tokens`,
          this.getOverallUsageTooltip(),
          "Quota is unavailable in API Provider mode",
        ].join("\n");
        perf.finish({
          result: "provider",
          name: selection.name,
          source: selection.source,
        });
        return;
      }

      if (selection.kind !== "account") {
        this.statusBarItem.command = "codex-switchbridge.switchMode";
        this.statusBarItem.text = "$(account) Codex: No account";
        this.statusBarItem.tooltip = "No active Codex account detected";
        perf.finish({
          result: "no-account",
        });
        return;
      }

      const name = selection.name;
      this.statusBarItem.command = "codex-switchbridge.refreshQuota";
      if (options?.skipQuota) {
        const usage = this.getTrackedUsage("account", selection.source, selection.name);
        const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
        this.statusBarItem.text = `$(account) ${name} · ${usageLabel}`;
        this.statusBarItem.tooltip = [
          `Account: ${name}`,
          `Source: ${selection.source}`,
          usage == null
            ? "Tracked local token usage: Indexing"
            : `Tracked local token usage: ${usage.toLocaleString()} tokens`,
          this.getOverallUsageTooltip(),
          "Quota refresh pending",
        ].join("\n");
        perf.finish({
          result: "skip-quota",
          name,
          source: selection.source,
        });
        return;
      }

      const account = getSavedAccountEntry(name, selection.source, snapshot);
      perf.mark("get-saved-account-entry", {
        foundAccount: Boolean(account),
        name,
        source: selection.source,
      });
      if (!account) {
        const usage = this.getTrackedUsage("account", selection.source, selection.name);
        const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
        this.statusBarItem.text = `$(warning) ${name} · ${usageLabel}`;
        this.statusBarItem.tooltip = [
          `Account: ${name}`,
          `Source: ${selection.source}`,
          usage == null
            ? "Tracked local token usage: Indexing"
            : `Tracked local token usage: ${usage.toLocaleString()} tokens`,
          this.getOverallUsageTooltip(),
          "Saved entry is unavailable",
        ].join("\n");
        perf.finish({
          result: "missing-account",
          name,
          source: selection.source,
        });
        return;
      }

      const loadingUsage = this.getTrackedUsage("account", selection.source, selection.name);
      const loadingUsageLabel = loadingUsage == null
        ? "indexing"
        : `${formatCompactTokens(loadingUsage)} tokens`;
      this.statusBarItem.text = `$(loading~spin) ${name} · ${loadingUsageLabel}`;
      this.statusBarItem.tooltip = [
        `Account: ${name}`,
        `Source: ${selection.source}`,
        loadingUsage == null
          ? "Tracked local token usage: Indexing"
          : `Tracked local token usage: ${loadingUsage.toLocaleString()} tokens`,
        this.getOverallUsageTooltip(),
        "Refreshing quota",
      ].join("\n");
      const result = await querySavedAccountQuota(account, options.queryContext, {
        reason: options.reason,
      });
      if (generation !== this.refreshGeneration) {
        perf.finish({
          result: "stale",
          name,
          source: selection.source,
        });
        return;
      }
      perf.mark("query-saved-account-quota", {
        resultKind: result.kind,
      });
      if (result.kind !== "ok") {
        logWarn(LOG_PREFIX, "refresh-result-not-ok", {
          resultKind: result.kind,
          message: result.message,
          account: account.id,
        });
        const usage = this.getTrackedUsage("account", selection.source, selection.name);
        const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
        this.statusBarItem.text = `$(warning) ${name} · ${usageLabel}`;
        this.statusBarItem.tooltip = [
          `Account: ${name}`,
          `Source: ${selection.source}`,
          usage == null
            ? "Tracked local token usage: Indexing"
            : `Tracked local token usage: ${usage.toLocaleString()} tokens`,
          this.getOverallUsageTooltip(),
          `Quota: ${result.message}`,
        ].join("\n");
        perf.finish({
          resultKind: result.kind,
          name,
          source: selection.source,
        });
        return;
      }

      const { info } = result;
      const preferredWindow = getPreferredStatusWindow(info);

      if (preferredWindow) {
        const used = Math.round(preferredWindow.usedPercent);
        const remaining = Math.max(0, 100 - used);
        const icon =
          remaining === 0 ? "$(error)" : remaining <= 30 ? "$(warning)" : remaining <= 50 ? "$(info)" : "$(check)";
        const usage = this.getTrackedUsage("account", selection.source, selection.name);
        const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
        this.statusBarItem.text = `${icon} ${name}: ${remaining}% · ${usageLabel}`;

        let tip = `Account: ${name}\nSource: ${selection.source}\nEmail: ${info.email}\nPlan: ${info.plan}\n`;
        tip += `\n${windowLabel(preferredWindow)} quota: ${remaining}% remaining`;
        const otherWindow =
          preferredWindow === info.primaryWindow ? info.secondaryWindow : info.primaryWindow;
        if (otherWindow) {
          tip += `\n${windowLabel(otherWindow)} quota: ${Math.max(0, 100 - Math.round(otherWindow.usedPercent))}% remaining`;
        }
        if (info.resetCredits) {
          const applicable = info.resetCredits.applicableAvailableCount;
          tip += applicable != null && applicable !== info.resetCredits.availableCount
            ? `\nRate-limit resets: ${applicable} applicable / ${info.resetCredits.availableCount} available`
            : `\nRate-limit resets: ${info.resetCredits.availableCount} available`;
        }
        tip += `\n${usage == null ? "Tracked local token usage: Indexing" : `Tracked local token usage: ${usage.toLocaleString()} tokens`}`;
        tip += `\n${this.getOverallUsageTooltip()}`;
        this.statusBarItem.tooltip = tip;
      } else {
        const reason = info.unavailableReason?.message;
        const usage = this.getTrackedUsage("account", selection.source, selection.name);
        const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
        this.statusBarItem.text = `${reason ? "$(warning)" : "$(account)"} ${name} · ${usageLabel}`;
        this.statusBarItem.tooltip = [
          `Account: ${name}`,
          `Source: ${selection.source}`,
          `Email: ${info.email}`,
          `Plan: ${info.plan}`,
          usage == null
            ? "Tracked local token usage: Indexing"
            : `Tracked local token usage: ${usage.toLocaleString()} tokens`,
          this.getOverallUsageTooltip(),
          ...(reason ? [`Quota: ${reason}`] : []),
        ].join("\n");
      }
      logInfo(LOG_PREFIX, "refresh-finish", { account: name });
      perf.finish({
        resultKind: result.kind,
        name,
        source: selection.source,
        unavailableReason: info.unavailableReason?.code ?? null,
      });
    } catch (error) {
      logWarn(LOG_PREFIX, "refresh-error", {
        account: this.statusBarItem.text,
        error: error instanceof Error ? error.message : String(error),
      });
      if (generation === this.refreshGeneration) {
        this.statusBarItem.text = "$(warning) Codex SwitchBridge";
        this.statusBarItem.tooltip = "Quota lookup failed";
      }
      perf.fail(error);
    }
  }

  refreshUsagePresentation(snapshot?: SavedEntriesSnapshot): void {
    if (!this.isVisibleEnabled()) return;
    const savedSnapshot = snapshot ?? createSavedEntriesSnapshot();
    const selection = getSavedCurrentSelection(savedSnapshot);
    if (selection.kind === "provider") {
      void this.refreshNow({
        skipQuota: true,
        snapshot: savedSnapshot,
        reason: "usage-refresh",
      });
      return;
    }
    if (selection.kind !== "account") return;

    this.statusBarItem.command = "codex-switchbridge.refreshQuota";
    const usage = this.getTrackedUsage("account", selection.source, selection.name);
    const usageLabel = usage == null ? "indexing" : `${formatCompactTokens(usage)} tokens`;
    if (!this.statusBarItem.text.includes(selection.name)) {
      void this.refreshNow({
        skipQuota: true,
        snapshot: savedSnapshot,
        reason: "usage-refresh",
      });
      return;
    }

    this.statusBarItem.text = this.statusBarItem.text.replace(
      / · (?:indexing|[0-9.]+[KMB]? tokens)$/,
      ` · ${usageLabel}`,
    );
    const lines = String(this.statusBarItem.tooltip ?? "").split("\n");
    const trackedLine = usage == null
      ? "Tracked local token usage: Indexing"
      : `Tracked local token usage: ${usage.toLocaleString()} tokens`;
    const overallLine = this.getOverallUsageTooltip();
    replaceOrAppendTooltipLine(lines, "Tracked local token usage:", trackedLine);
    replaceOrAppendTooltipLine(lines, "Overall local token usage:", overallLine);
    this.statusBarItem.tooltip = lines.join("\n");
  }

  dispose() {
    this.configListener?.dispose();
    this.reloadRecommendationEmitter.dispose();
    this.statusBarItem.dispose();
    this.reloadStatusBarItem.dispose();
  }

  private getTrackedUsage(
    kind: "account" | "provider",
    source: "local" | "cloud",
    name: string,
  ): number | null {
    const snapshot = this.usageService?.getSnapshot();
    if (!snapshot || snapshot.status !== "ready") return null;
    const subjectId = stableSubjectId(kind, `${source}:${name}`);
    return snapshot.subjects.find((subject) => subject.id === subjectId)?.tokens.totalTokens ?? 0;
  }

  private getOverallUsageTooltip(): string {
    const snapshot = this.usageService?.getSnapshot();
    if (!snapshot || snapshot.status !== "ready") return "Overall local token usage: Indexing";
    return `Overall local token usage: ${snapshot.total.totalTokens.toLocaleString()} tokens`;
  }
}

function replaceOrAppendTooltipLine(lines: string[], prefix: string, value: string): void {
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) {
    lines[index] = value;
  } else {
    lines.push(value);
  }
}
