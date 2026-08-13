import * as vscode from "vscode";
import {
  DiagnosticLogLevel,
  getAccountIdentity,
  getCodexConfigDir,
  readCurrentAuth,
  setDiagnosticLogger,
  setDiagnosticLogOptions,
  setNamedAuthDir,
} from "@codex-switchbridge/core";
import { AccountTreeProvider } from "./accountTree";
import { ProviderTreeProvider } from "./providerTree";
import { QuotaStore } from "./quotaStore";
import { RefreshCoordinator } from "./refreshCoordinator";
import { StatusBarManager } from "./statusBar";
import { registerCommands } from "./commands";
import { buildDashboardModel, DashboardModel } from "./dashboardModel";
import { resolveDashboardLocale, LanguagePreference, translate } from "./dashboardI18n";
import { DashboardViewProvider } from "./dashboardViewProvider";
import { RoutesTreeProvider, RoutesTreeNode } from "./routesTree";
import { disposeLogging, initializeLogging, logInfo, logWarn, writeRawLog } from "./log";
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
import { maintainQuotaCache } from "./quotaCache";
import { resolveQuotaProxy } from "./quotaProxy";
import {
  AppServerUnsupportedError,
  createAppServerEnvironment,
  getRateLimitResetAction,
  RateLimitResetError,
  RateLimitResetRefreshError,
  resolveBundledCodexExecutable,
  runRateLimitReset,
} from "./rateLimitReset";

const LOG_PREFIX = "[codex-switchbridge:vscode:extension]";
const LEGACY_EXTENSION_ID = "baoshichao001-dev.codex-switchbridge";
const OPEN_LEGACY_EXTENSION_ACTION = "Open Legacy Extension";
const CONFLICTING_EXTENSION_IDS = [
  "wannanbigpig.codex-accounts-manager",
  "techfetch-dev.codex-account-switch-vscode",
] as const;

function legacyExtensionBlocksActivation(): boolean {
  if (!vscode.extensions.getExtension(LEGACY_EXTENSION_ID)) {
    return false;
  }

  void vscode.window.showWarningMessage(
    "The legacy Codex SwitchBridge extension is still installed. First use it to Move all synced/cloud accounts and API providers to Local. Then disable or uninstall it, reload VS Code, and open this replacement extension. You will need to enter the storage password again.",
    OPEN_LEGACY_EXTENSION_ACTION,
  ).then((selected) => {
    if (selected === OPEN_LEGACY_EXTENSION_ACTION) {
      void vscode.commands.executeCommand(
        "workbench.extensions.search",
        `@id:${LEGACY_EXTENSION_ID}`,
      );
    }
  });
  return true;
}

function warnAboutConflictingExtensions(): void {
  const activeExtensionIds: string[] = [];

  for (const extensionId of CONFLICTING_EXTENSION_IDS) {
    try {
      if (vscode.extensions.getExtension(extensionId)?.isActive === true) {
        activeExtensionIds.push(extensionId);
      }
    } catch (error) {
      logWarn(LOG_PREFIX, "conflicting-extension-check-failed", {
        extensionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (activeExtensionIds.length === 0) {
    return;
  }

  logWarn(LOG_PREFIX, "conflicting-extensions-detected", {
    extensionIds: activeExtensionIds,
    count: activeExtensionIds.length,
  });
  void vscode.window.showWarningMessage(
    `Active extensions ${activeExtensionIds.join(", ")} can also write Codex auth/config files, `
      + "which can cause Unauthorized errors. Disable or uninstall them, then run Developer: Reload Window."
  );
}

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

function getDashboardLanguagePreference(): LanguagePreference {
  const preference = vscode.workspace
    .getConfiguration("codex-switchbridge")
    .get<unknown>("language", "auto");
  return preference === "en" || preference === "zh-cn" ? preference : "auto";
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
  if (legacyExtensionBlocksActivation()) {
    return;
  }

  initializeLogging();
  logInfo(LOG_PREFIX, "activate-start", {});
  warnAboutConflictingExtensions();
  setDiagnosticLogger((level: DiagnosticLogLevel, line: string) => {
    writeRawLog(level, line);
  });
  applyNamedAuthDirSetting();
  applyDiagnosticLogSettings();
  maintainQuotaCache();
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
  let rateLimitResetPending = false;
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
    getLocale: () => {
      const preference = getDashboardLanguagePreference();
      return {
        preference,
        effective: resolveDashboardLocale(preference, vscode.env.language),
      };
    },
    setLanguagePreference: (preference) => vscode.workspace
      .getConfiguration("codex-switchbridge")
      .update("language", preference, vscode.ConfigurationTarget.Global),
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
            || event.affectsConfiguration("codex-switchbridge.language")
            || event.affectsConfiguration("codex-switchbridge.proxy")
            || event.affectsConfiguration("http.proxy")
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
      refreshDashboard: () => vscode.commands.executeCommand("codex-switchbridge-vscode.refreshDashboard"),
      switchMode: () => vscode.commands.executeCommand("codex-switchbridge-vscode.switchMode"),
      setAutoSwitch: (enabled) => vscode.commands.executeCommand(
        enabled ? "codex-switchbridge-vscode.enableAutoSwitch" : "codex-switchbridge-vscode.disableAutoSwitch",
      ),
      configureAutoSwitch: () => vscode.commands.executeCommand("codex-switchbridge-vscode.configureAutoSwitch"),
      addAccount: () => vscode.commands.executeCommand("codex-switchbridge-vscode.addAccount"),
      addProvider: () => vscode.commands.executeCommand("codex-switchbridge-vscode.addProvider"),
      useRateLimitReset: async () => {
        const localize = (key: Parameters<typeof translate>[1], args: Record<string, string | number> = {}) => {
          const preference = getDashboardLanguagePreference();
          return translate(resolveDashboardLocale(preference, vscode.env.language), key, args);
        };
        const activeAccount = (expectedId?: string) => {
          const snapshot = createSavedEntriesSnapshot();
          if (snapshot.selection.kind !== "account") return null;
          const account = snapshot.accounts.find((entry) => entry.isCurrent) ?? null;
          if (
            !account
            || (expectedId != null && account.id !== expectedId)
            || account.storageState !== "ready"
            || !account.auth
          ) return null;
          const savedIdentity = getAccountIdentity(account.auth);
          const liveIdentity = getAccountIdentity(readCurrentAuth());
          return savedIdentity && liveIdentity === savedIdentity ? account : null;
        };
        if (rateLimitResetPending) {
          await vscode.window.showInformationMessage(localize("quota.resetCredits.pending"));
          return;
        }
        const account = activeAccount();
        if (!account) {
          await vscode.window.showWarningMessage(localize("quota.resetCredits.accountChanged"));
          return;
        }
        const quota = quotaStore.get(account.id)?.info?.resetCredits ?? null;
        const resetAction = getRateLimitResetAction(quota);
        if (!quota || quota.availableCount <= 0) {
          await vscode.window.showInformationMessage(localize("quota.resetCredits.noneAvailable"));
          return;
        }
        if (resetAction === "none") {
          await vscode.window.showInformationMessage(localize("quota.resetCredits.noneApplicable"));
          return;
        }
        const usageUri = vscode.Uri.parse("https://chatgpt.com/codex/settings/usage");
        if (resetAction === "manage") {
          await vscode.env.openExternal(usageUri);
          return;
        }

        rateLimitResetPending = true;
        try {
          const confirmAction = localize("quota.resetCredits.confirmAction");
          const confirmed = await vscode.window.showWarningMessage(
            localize("quota.resetCredits.confirm", { account: account.name }),
            {
              modal: true,
              detail: localize("quota.resetCredits.confirmDetail"),
            },
            confirmAction,
          );
          if (confirmed !== confirmAction) return;
          if (!activeAccount(account.id)) {
            await vscode.window.showWarningMessage(localize("quota.resetCredits.accountChanged"));
            return;
          }
          const proxy = resolveQuotaProxy();
          if (!proxy.valid) {
            await vscode.window.showErrorMessage(localize("quota.resetCredits.invalidProxy"));
            return;
          }
          const openOfficialUsage = async () => {
            await vscode.window.showInformationMessage(localize("quota.resetCredits.unsupported"));
            await vscode.env.openExternal(usageUri);
          };
          const openAiExtensionPath = vscode.extensions.getExtension("openai.chatgpt")?.extensionUri.fsPath;
          const bundledExecutable = openAiExtensionPath
            ? resolveBundledCodexExecutable({ extensionPath: openAiExtensionPath })
            : null;
          if (!bundledExecutable) {
            await openOfficialUsage();
            return;
          }
          let result;
          try {
            result = await runRateLimitReset({
              executable: bundledExecutable,
              clientVersion: String(context.extension.packageJSON.version ?? ""),
              env: createAppServerEnvironment(process.env, proxy.proxyUrl),
              validateBeforeConsume: () => activeAccount(account.id) != null,
            });
          } catch (error) {
            if (error instanceof AppServerUnsupportedError) {
              await openOfficialUsage();
              return;
            }
            if (error instanceof RateLimitResetError && error.code === "account_changed") {
              await vscode.window.showWarningMessage(localize("quota.resetCredits.accountChanged"));
              return;
            }
            if (error instanceof RateLimitResetRefreshError) {
              const outcomeKey = `quota.resetCredits.outcome.${error.outcome}` as Parameters<typeof translate>[1];
              const openUsage = localize("quota.resetCredits.openUsage");
              const selected = await vscode.window.showWarningMessage(
                `${localize(outcomeKey, { account: account.name })} ${localize("quota.resetCredits.refreshUnconfirmed")}`,
                openUsage,
              );
              if (selected === openUsage) await vscode.env.openExternal(usageUri);
              return;
            }
            await vscode.window.showErrorMessage(localize("quota.resetCredits.failed"));
            return;
          }
          await vscode.commands.executeCommand("codex-switchbridge-vscode.refreshDashboard");
          const outcomeKey = `quota.resetCredits.outcome.${result.outcome}` as Parameters<typeof translate>[1];
          const message = localize(outcomeKey, { account: account.name });
          if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
            await vscode.window.showInformationMessage(message);
          } else {
            await vscode.window.showWarningMessage(message);
          }
        } finally {
          rateLimitResetPending = false;
          dashboardView.invalidate();
        }
      },
      reloginAccount: (targetId) => {
        const account = createSavedEntriesSnapshot().byId.get(targetId);
        if (account) return vscode.commands.executeCommand("codex-switchbridge-vscode.reloginAccount", { account });
      },
      unlockStorage: (_targetId) => vscode.commands.executeCommand("codex-switchbridge-vscode.unlockStorage"),
      reloadWindow: () => vscode.commands.executeCommand("codex-switchbridge-vscode.reloadWindow"),
    },
    onActionError: (action) => logInfo(LOG_PREFIX, "dashboard-action-failed", { action }),
    onLocaleError: () => logInfo(LOG_PREFIX, "dashboard-locale-update-failed", {}),
    onModelError: () => logInfo(LOG_PREFIX, "dashboard-model-build-failed", {}),
    shouldRefreshVisibleModel: dashboardNeedsQuotaRefresh,
    requestVisibleRefresh: () => {
      refreshCoordinator.scheduleQuotaRefresh({ reason: "manual", fullRefresh: true });
    },
  });
  const routesTree = new RoutesTreeProvider(
    accountTree,
    providerTree,
    () => resolveDashboardLocale(getDashboardLanguagePreference(), vscode.env.language),
  );
  const routesTreeView = vscode.window.createTreeView<RoutesTreeNode>("codexSwitchBridgeVscodeRoutes", {
    treeDataProvider: routesTree,
    showCollapseAll: true,
  });
  const showDashboardWhenVisible = ({ visible }: { visible: boolean }) => {
    if (visible) dashboardView.show();
  };
  const routesVisibilitySubscription = routesTreeView.onDidChangeVisibility(showDashboardWhenVisible);
  if (routesTreeView.visible) dashboardView.show();

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("codex-switchbridge.language")) {
      routesTree.refreshLocale();
      dashboardView.invalidate();
    }
    if (
      e.affectsConfiguration("codex-switchbridge.authDirectory")
      || e.affectsConfiguration("codex-switchbridge.defaultSaveTarget")
      || e.affectsConfiguration("codex-switchbridge.detailedPerformanceLogging")
      || e.affectsConfiguration("codex-switchbridge.shareHistoryAcrossProviders")
      || e.affectsConfiguration("codex-switchbridge.syncedStorage")
      || e.affectsConfiguration("codex-switchbridge.proxy")
      || e.affectsConfiguration("http.proxy")
    ) {
      logInfo(LOG_PREFIX, "configuration-changed", {
        authDirectory: e.affectsConfiguration("codex-switchbridge.authDirectory"),
        defaultSaveTarget: e.affectsConfiguration("codex-switchbridge.defaultSaveTarget"),
        detailedPerformanceLogging: e.affectsConfiguration("codex-switchbridge.detailedPerformanceLogging"),
        shareHistoryAcrossProviders: e.affectsConfiguration("codex-switchbridge.shareHistoryAcrossProviders"),
        quotaProxy: e.affectsConfiguration("codex-switchbridge.proxy")
          || e.affectsConfiguration("http.proxy"),
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
    dashboardView,
    routesTreeView,
    routesVisibilitySubscription,
    routesTree,
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
    routesTreeView,
    refreshCoordinator,
    usageService,
    () => dashboardView.show(),
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
