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
import { RefreshCoordinator } from "./refreshCoordinator";
import { StatusBarManager } from "./statusBar";
import { registerCommands } from "./commands";
import { disposeLogging, initializeLogging, logInfo, writeRawLog } from "./log";
import { restoreSavedAuthPassphrase } from "./storagePassword";
import {
  createSavedEntriesSnapshot,
  getSavedCurrentSelection,
  hasEncryptedSyncedEntries,
  initializeSavedEntries,
  listSavedProviders,
} from "./savedEntries";
import { shareHistoryAcrossProviders } from "./sharedHistory";
import { UsageService } from "./tokenUsage";
import { OverviewTreeNode, OverviewTreeProvider } from "./usageTree";
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
  const accountTree = new AccountTreeProvider(usageService);
  const providerTree = new ProviderTreeProvider(usageService);
  const overviewTree = new OverviewTreeProvider(
    usageService,
    () => getSavedCurrentSelection(),
    shareHistoryAcrossProviders,
  );
  const statusBarManager = new StatusBarManager(usageService);
  const refreshCoordinator = new RefreshCoordinator(
    accountTree,
    providerTree,
    statusBarManager,
    usageService,
    overviewTree,
  );
  const overviewTreeView = vscode.window.createTreeView<OverviewTreeNode>("codexSwitchBridgeOverview", {
    treeDataProvider: overviewTree,
    showCollapseAll: true,
  });
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
    overviewTreeView,
    accountTreeView,
    providerTreeView,
    usageService,
    accountTree,
    providerTree,
    overviewTree,
    statusBarManager,
    refreshCoordinator,
    configListener,
  );

  registerCommands(
    context,
    accountTree,
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
