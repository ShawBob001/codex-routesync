import * as vscode from "vscode";
import {
  DiagnosticLogLevel,
  getCodexConfigDir,
  setDiagnosticLogger,
  setDiagnosticLogOptions,
  setNamedAuthDir,
} from "@codex-switchbridge/core";
import { AccountTreeProvider, AccountTreeNode } from "./accountTree";
import { ProviderTreeProvider, ProviderTreeNode } from "./providerTree";
import { QuotaStore } from "./quotaStore";
import { RefreshCoordinator } from "./refreshCoordinator";
import { StatusBarManager } from "./statusBar";
import { registerCommands } from "./commands";
import { buildDashboardModel, DashboardModel } from "./dashboardModel";
import { DashboardViewProvider } from "./dashboardViewProvider";
import { disposeLogging, initializeLogging, logInfo, writeRawLog } from "./log";
import { restoreSavedAuthPassphrase } from "./storagePassword";
import {
  createSavedEntriesSnapshot,
  hasEncryptedSyncedEntries,
  initializeSavedEntries,
  listSavedProviders,
} from "./savedEntries";
import { shareHistoryAcrossProviders } from "./sharedHistory";
import { UsageService } from "./tokenUsage";
import { knownUsageSubjects } from "./usageSubjects";

const LOG_PREFIX = "[codex-switchbridge:vscode:extension]";

function applyNamedAuthDirSetting() {
  const authDir = vscode.workspace
    .getConfiguration("codex-switchbridge")
    .get<string>("authDirectory", "");

  setNamedAuthDir(authDir);
}

function applyDiagnosticLogSettings() {
  const config = vscode.workspace.getConfiguration("codex-switchbridge");
  setDiagnosticLogOptions({
    detailedPerformanceLogging: config.get<boolean>("detailedPerformanceLogging", false),
  });
}

function getAutoSwitchEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("codex-switchbridge")
    .get<boolean>("autoSwitchOnZeroQuota", false);
}

function dashboardTargetIds(model: DashboardModel): string[] {
  const ids = new Set(model.otherAccounts.map((account) => account.accountId));
  if (model.route.kind === "account" && model.route.accountId) ids.add(model.route.accountId);
  if (model.route.kind === "provider" && model.route.providerId) ids.add(model.route.providerId);
  if (model.autoSwitch.candidate) ids.add(model.autoSwitch.candidate.accountId);
  return [...ids];
}

function dashboardNeedsQuotaRefresh(model: DashboardModel): boolean {
  const quotas = [
    ...(model.route.kind === "account" ? [model.route.quota] : []),
    ...model.otherAccounts.map((account) => account.quota),
  ];
  return quotas.some((quota) => (
    !["relogin-required", "storage-locked", "storage-pending", "storage-invalid"].includes(quota.status)
    && quota.freshness !== "fresh"
  ));
}

export async function activate(context: vscode.ExtensionContext) {
  initializeLogging();
  logInfo(LOG_PREFIX, "activate-start", {});
  setDiagnosticLogger((level: DiagnosticLogLevel, line: string) => {
    writeRawLog(level, line);
  });
  applyNamedAuthDirSetting();
  applyDiagnosticLogSettings();
  await initializeSavedEntries(context);
  await restoreSavedAuthPassphrase(context, {
    promptIfMissing: true,
    promptForLockedStorage: hasEncryptedSyncedEntries(),
  });

  const initialSnapshot = createSavedEntriesSnapshot();
  const usageService = new UsageService({
    codexHome: getCodexConfigDir(),
    memento: context.globalState,
    knownSubjects: knownUsageSubjects(initialSnapshot.accounts, listSavedProviders()),
    heartbeatIntervalMs: 0,
  });
  const quotaStore = new QuotaStore();
  const accountTree = new AccountTreeProvider(quotaStore, usageService);
  const providerTree = new ProviderTreeProvider(usageService);
  const statusBarManager = new StatusBarManager(usageService);
  let dashboardView: DashboardViewProvider;
  const refreshCoordinator = new RefreshCoordinator(
    accountTree,
    quotaStore,
    providerTree,
    statusBarManager,
    usageService,
    () => dashboardView.invalidate(),
  );
  dashboardView = new DashboardViewProvider({
    extensionUri: context.extensionUri,
    getModel: () => buildDashboardModel({
      saved: createSavedEntriesSnapshot(),
      providers: listSavedProviders(),
      quota: quotaStore.getSnapshot(),
      usage: usageService.getSnapshot(),
      autoSwitchEnabled: getAutoSwitchEnabled(),
      sharedHistoryEnabled: shareHistoryAcrossProviders(),
      reload: statusBarManager.getReloadRecommendation(),
      nowMs: Date.now(),
    }),
    subscribe: (listener) => {
      const subscriptions = [
        quotaStore.onDidChange(listener),
        usageService.onDidChange(listener),
        statusBarManager.onDidChangeReloadRecommendation(listener),
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (
            event.affectsConfiguration("codex-switchbridge.autoSwitchOnZeroQuota")
            || event.affectsConfiguration("codex-switchbridge.shareHistoryAcrossProviders")
            || event.affectsConfiguration("codex-switchbridge.authDirectory")
            || event.affectsConfiguration("codex-switchbridge.defaultSaveTarget")
            || event.affectsConfiguration("codex-switchbridge.syncedStorage")
          ) {
            listener();
          }
        }),
      ];
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    },
    getTargetIds: dashboardTargetIds,
    getFreshTargetIds: () => [
      ...createSavedEntriesSnapshot().accounts.map((account) => account.id),
      ...listSavedProviders().map((provider) => provider.id),
    ],
    handlers: {
      refreshDashboard: () => vscode.commands.executeCommand("codex-switchbridge.refreshDashboard"),
      switchMode: () => vscode.commands.executeCommand("codex-switchbridge.switchMode"),
      setAutoSwitch: (enabled) => vscode.commands.executeCommand(
        enabled ? "codex-switchbridge.enableAutoSwitch" : "codex-switchbridge.disableAutoSwitch",
      ),
      configureAutoSwitch: () => vscode.commands.executeCommand("codex-switchbridge.configureAutoSwitch"),
      addAccount: () => vscode.commands.executeCommand("codex-switchbridge.addAccount"),
      addProvider: () => vscode.commands.executeCommand("codex-switchbridge.addProvider"),
      reloginAccount: (targetId) => {
        const account = createSavedEntriesSnapshot().byId.get(targetId);
        if (account) return vscode.commands.executeCommand("codex-switchbridge.reloginAccount", { account });
      },
      unlockStorage: () => vscode.commands.executeCommand("codex-switchbridge.unlockStorage"),
      reloadWindow: () => vscode.commands.executeCommand("codex-switchbridge.reloadWindow"),
    },
    onActionError: (action) => logInfo(LOG_PREFIX, "dashboard-action-failed", { action }),
    onModelError: () => logInfo(LOG_PREFIX, "dashboard-model-build-failed", {}),
    shouldRefreshVisibleModel: dashboardNeedsQuotaRefresh,
    requestVisibleRefresh: () => {
      refreshCoordinator.scheduleQuotaRefresh({ reason: "manual", fullRefresh: true });
    },
  });
  const dashboardViewRegistration = vscode.window.registerWebviewViewProvider(
    "codexSwitchBridgeOverview",
    dashboardView,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const accountTreeView = vscode.window.createTreeView<AccountTreeNode>("codexSwitchBridgeAccounts", {
    treeDataProvider: accountTree,
    showCollapseAll: true,
  });
  const providerTreeView = vscode.window.createTreeView<ProviderTreeNode>("codexSwitchBridgeProviders", {
    treeDataProvider: providerTree,
    showCollapseAll: true,
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("codex-switchbridge.authDirectory")
      || e.affectsConfiguration("codex-switchbridge.defaultSaveTarget")
      || e.affectsConfiguration("codex-switchbridge.detailedPerformanceLogging")
      || e.affectsConfiguration("codex-switchbridge.shareHistoryAcrossProviders")
      || e.affectsConfiguration("codex-switchbridge.syncedStorage")
    ) {
      logInfo(LOG_PREFIX, "configuration-changed", {
        authDirectory: e.affectsConfiguration("codex-switchbridge.authDirectory"),
        defaultSaveTarget: e.affectsConfiguration("codex-switchbridge.defaultSaveTarget"),
        detailedPerformanceLogging: e.affectsConfiguration("codex-switchbridge.detailedPerformanceLogging"),
        shareHistoryAcrossProviders: e.affectsConfiguration("codex-switchbridge.shareHistoryAcrossProviders"),
      });
      applyNamedAuthDirSetting();
      applyDiagnosticLogSettings();
      void restoreSavedAuthPassphrase(context, {
        promptIfMissing: true,
        promptForLockedStorage: hasEncryptedSyncedEntries(),
      });
      void refreshCoordinator.refreshViews("config-change");

      refreshCoordinator.scheduleQuotaRefresh({
        reason: "config-change",
      });
    }
  });

  context.subscriptions.push(
    dashboardViewRegistration,
    dashboardView,
    accountTreeView,
    providerTreeView,
    usageService,
    quotaStore,
    accountTree,
    providerTree,
    statusBarManager,
    refreshCoordinator,
    configListener,
  );

  registerCommands(
    context,
    accountTree,
    quotaStore,
    providerTree,
    statusBarManager,
    accountTreeView,
    refreshCoordinator,
    usageService,
  );

  statusBarManager.startConfigurationSync(context);
  refreshCoordinator.startAutoRefresh(context);
  await refreshCoordinator.refreshViews("activate");
  refreshCoordinator.scheduleQuotaRefresh({
    reason: "activate",
  });
  logInfo(LOG_PREFIX, "activate-ready", {});
}

export function deactivate() {
  logInfo(LOG_PREFIX, "deactivate", {});
  setDiagnosticLogger(null);
  disposeLogging();
}
