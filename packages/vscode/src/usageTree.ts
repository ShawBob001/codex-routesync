import * as vscode from "vscode";
import { getModeDisplayName } from "@codex-switchbridge/core";
import type { SavedSelection } from "./savedEntries";
import {
  formatCompactTokens,
  TokenTotals,
  UsageService,
  UsageSnapshot,
} from "./tokenUsage";

type OverviewItemKind = "mode" | "history" | "usage" | "subjects" | "detail" | "subject";

export type OverviewTreeNode = OverviewTreeItem;

function sourceLabel(source: "local" | "cloud"): string {
  return source === "cloud" ? "Cloud" : "Local";
}

function formatTimestamp(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Not started";
  return new Date(value).toLocaleString();
}

function subtractTokens(total: TokenTotals, excluded: TokenTotals): TokenTotals {
  return {
    inputTokens: Math.max(0, total.inputTokens - excluded.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - excluded.cachedInputTokens),
    outputTokens: Math.max(0, total.outputTokens - excluded.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - excluded.reasoningOutputTokens),
    totalTokens: Math.max(0, total.totalTokens - excluded.totalTokens),
  };
}

function tokenDescription(value: number): string {
  return `${formatCompactTokens(value)} tokens`;
}

export class OverviewTreeItem extends vscode.TreeItem {
  constructor(
    public readonly itemKind: OverviewItemKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    id: string,
    public readonly parent?: OverviewTreeItem,
  ) {
    super(label, collapsibleState);
    this.id = id;
    this.contextValue = `overview:${itemKind}`;
  }
}

export class OverviewTreeProvider implements vscode.TreeDataProvider<OverviewTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<OverviewTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly usageSubscription: { dispose(): void };

  constructor(
    private readonly usageService: UsageService,
    private readonly getSelection: () => SavedSelection,
    private readonly isSharedHistoryEnabled: () => boolean,
  ) {
    this.usageSubscription = usageService.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: OverviewTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OverviewTreeNode): OverviewTreeNode[] {
    const snapshot = this.usageService.getSnapshot();
    if (!element) return this.getRootItems(snapshot);
    if (element.itemKind === "usage") return this.getUsageDetails(element, snapshot);
    if (element.itemKind === "subjects") return this.getSubjectItems(element, snapshot);
    return [];
  }

  getParent(element: OverviewTreeNode): OverviewTreeNode | undefined {
    return element.parent;
  }

  dispose(): void {
    this.usageSubscription.dispose();
    this.emitter.dispose();
  }

  private getRootItems(snapshot: UsageSnapshot): OverviewTreeItem[] {
    const selection = this.getSelection();
    const mode = new OverviewTreeItem(
      "mode",
      selection.kind === "provider"
        ? getModeDisplayName(selection.name)
        : selection.kind === "account"
          ? selection.name
          : "No active selection",
      vscode.TreeItemCollapsibleState.None,
      "overview:mode",
    );
    mode.description = selection.kind === "provider"
      ? `API Provider · ${sourceLabel(selection.source)}`
      : selection.kind === "account"
        ? `Account · ${sourceLabel(selection.source)}`
        : "Codex auth was not matched";
    mode.iconPath = selection.kind === "provider"
      ? new vscode.ThemeIcon("plug", new vscode.ThemeColor("charts.green"))
      : selection.kind === "account"
        ? new vscode.ThemeIcon("account", new vscode.ThemeColor("charts.green"))
        : new vscode.ThemeIcon("question", new vscode.ThemeColor("editorWarning.foreground"));
    mode.tooltip = selection.kind === "unknown"
      ? "No saved Codex account or API Provider matches the active runtime auth."
      : `${mode.description}: ${"name" in selection ? selection.name : "unknown"}`;
    mode.command = { command: "codex-switchbridge.switchMode", title: "Switch Mode" };

    const sharedHistory = this.isSharedHistoryEnabled();
    const history = new OverviewTreeItem(
      "history",
      "Conversation history",
      vscode.TreeItemCollapsibleState.None,
      "overview:history",
    );
    history.description = sharedHistory ? "Shared across compatible modes" : "Provider-specific";
    history.iconPath = new vscode.ThemeIcon(
      sharedHistory ? "link" : "debug-disconnect",
      new vscode.ThemeColor(sharedHistory ? "charts.green" : "editorWarning.foreground"),
    );
    history.tooltip = sharedHistory
      ? "Account mode and Responses-compatible API Providers use one local Codex history identity."
      : "API Providers keep their own local Codex history identity.";

    const usage = new OverviewTreeItem(
      "usage",
      "Local token usage",
      vscode.TreeItemCollapsibleState.Expanded,
      "overview:usage",
    );
    usage.description = snapshot.status === "indexing"
      ? "Indexing..."
      : snapshot.status === "uninitialized"
        ? "Waiting to index"
        : tokenDescription(snapshot.total.totalTokens);
    usage.iconPath = snapshot.status === "indexing"
      ? new vscode.ThemeIcon("loading~spin")
      : snapshot.coverage === "partial"
        ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"))
        : new vscode.ThemeIcon("pulse", new vscode.ThemeColor("charts.blue"));
    usage.tooltip = "Tokens reported in local Codex rollout records. This is not a billing or cost total.";

    const attributed = subtractTokens(snapshot.total, snapshot.unattributed);
    const subjects = new OverviewTreeItem(
      "subjects",
      "Tracked by selection",
      vscode.TreeItemCollapsibleState.Expanded,
      "overview:subjects",
    );
    subjects.description = snapshot.status === "ready"
      ? `${tokenDescription(attributed.totalTokens)} · ${snapshot.subjects.length} entries`
      : "Indexing usage...";
    subjects.iconPath = new vscode.ThemeIcon("list-tree");
    subjects.tooltip = `Per-entry attribution started ${formatTimestamp(snapshot.trackingStartedAt)}.`;

    return [mode, history, usage, subjects];
  }

  private getUsageDetails(parent: OverviewTreeItem, snapshot: UsageSnapshot): OverviewTreeItem[] {
    const attributed = subtractTokens(snapshot.total, snapshot.unattributed);
    const metrics: Array<{ id: string; label: string; value: number; icon: string; tooltip: string }> = [
      {
        id: "total",
        label: "Recorded total",
        value: snapshot.total.totalTokens,
        icon: "symbol-numeric",
        tooltip: "Input plus output tokens recorded in local Codex rollout files.",
      },
      {
        id: "input",
        label: "Input",
        value: snapshot.total.inputTokens,
        icon: "arrow-right",
        tooltip: "All recorded input tokens. Cached input is included in this number.",
      },
      {
        id: "output",
        label: "Output",
        value: snapshot.total.outputTokens,
        icon: "arrow-left",
        tooltip: "All recorded output tokens. Reasoning output is included in this number.",
      },
      {
        id: "cached",
        label: "Cached input",
        value: snapshot.total.cachedInputTokens,
        icon: "database",
        tooltip: "Cached input is a subset of input and is not added to the recorded total again.",
      },
      {
        id: "reasoning",
        label: "Reasoning output",
        value: snapshot.total.reasoningOutputTokens,
        icon: "lightbulb",
        tooltip: "Reasoning output is a subset of output and is not added to the recorded total again.",
      },
      {
        id: "attributed",
        label: "Attributed",
        value: attributed.totalTokens,
        icon: "verified",
        tooltip: "Usage assigned to a saved selection after local tracking began.",
      },
      {
        id: "unattributed",
        label: "Earlier or unattributed",
        value: snapshot.unattributed.totalTokens,
        icon: "question",
        tooltip: "Older shared-history sessions and activity outside an observed selection cannot be assigned safely.",
      },
    ];

    const items = metrics.map((metric) => {
      const item = new OverviewTreeItem(
        "detail",
        metric.label,
        vscode.TreeItemCollapsibleState.None,
        `overview:usage:${metric.id}`,
        parent,
      );
      item.description = tokenDescription(metric.value);
      item.tooltip = metric.tooltip;
      item.iconPath = new vscode.ThemeIcon(metric.icon);
      return item;
    });

    const sessions = new OverviewTreeItem(
      "detail",
      "Indexed sessions",
      vscode.TreeItemCollapsibleState.None,
      "overview:usage:sessions",
      parent,
    );
    sessions.description = String(snapshot.sessionCount);
    sessions.iconPath = new vscode.ThemeIcon("comment-discussion");
    sessions.tooltip = `${snapshot.scan.discoveredFiles} rollout file(s), ${snapshot.scan.reusedFiles} reused from the local index.`;
    items.push(sessions);

    const tracking = new OverviewTreeItem(
      "detail",
      "Tracking since",
      vscode.TreeItemCollapsibleState.None,
      "overview:usage:tracking",
      parent,
    );
    tracking.description = formatTimestamp(snapshot.trackingStartedAt);
    tracking.iconPath = new vscode.ThemeIcon("calendar");
    items.push(tracking);

    const updated = new OverviewTreeItem(
      "detail",
      "Last indexed",
      vscode.TreeItemCollapsibleState.None,
      "overview:usage:updated",
      parent,
    );
    updated.description = snapshot.status === "uninitialized" ? "Not yet" : formatTimestamp(snapshot.updatedAt);
    updated.iconPath = new vscode.ThemeIcon("history");
    updated.tooltip = snapshot.coverage === "partial"
      ? snapshot.lastError ?? "Some rollout files could not be indexed."
      : "Local token index is complete for the discovered rollout files.";
    items.push(updated);

    return items;
  }

  private getSubjectItems(parent: OverviewTreeItem, snapshot: UsageSnapshot): OverviewTreeItem[] {
    if (snapshot.subjects.length === 0) {
      const empty = new OverviewTreeItem(
        "detail",
        "No attributed selections yet",
        vscode.TreeItemCollapsibleState.None,
        "overview:subjects:empty",
        parent,
      );
      empty.description = "New sessions will appear here";
      empty.iconPath = new vscode.ThemeIcon("circle-large-outline");
      return [empty];
    }

    return snapshot.subjects.map((subject) => {
      const item = new OverviewTreeItem(
        "subject",
        subject.label,
        vscode.TreeItemCollapsibleState.None,
        `overview:subject:${subject.id}`,
        parent,
      );
      item.description = `${tokenDescription(subject.tokens.totalTokens)} · ${subject.sessionCount} session${subject.sessionCount === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon(subject.kind === "account" ? "account" : "plug");
      item.tooltip = [
        `${subject.kind === "account" ? "Account" : "API Provider"}: ${subject.label}`,
        `Total: ${subject.tokens.totalTokens.toLocaleString()} tokens`,
        `Input: ${subject.tokens.inputTokens.toLocaleString()}`,
        `Output: ${subject.tokens.outputTokens.toLocaleString()}`,
        `Cached input: ${subject.tokens.cachedInputTokens.toLocaleString()}`,
        `Reasoning output: ${subject.tokens.reasoningOutputTokens.toLocaleString()}`,
      ].join("\n");
      return item;
    });
  }
}
