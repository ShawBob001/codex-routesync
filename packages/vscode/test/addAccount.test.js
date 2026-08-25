const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const core = require("@codex-switchbridge/core");
const { stableSubjectId } = require("../dist/tokenUsage.js");

const extensionManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

const STORAGE_SECRET_KEY = "codex-switchbridge.savedAuthPassphrase";
const SYNCED_CLOUD_STATE_KEY = "codex-switchbridge.syncedCloudState.v1";
const SYNCED_CLOUD_ACCOUNT_KEY_PREFIX = "codex-switchbridge.syncedCloudAccount.v1.";
const SYNCED_CLOUD_PROVIDER_KEY_PREFIX = "codex-switchbridge.syncedCloudProvider.v1.";
const AUTH_UPDATED_AT_FIELD = "codex_switchbridge_auth_updated_at";
const LOCAL_TOKEN_USAGE_STATE_KEY = "codexSwitchBridge.localTokenUsage.v2";

function getLocalTokenUsageState(globalStateValues) {
  return globalStateValues.get(LOCAL_TOKEN_USAGE_STATE_KEY)
    ?? [...globalStateValues.entries()]
      .find(([key]) => key.startsWith(`${LOCAL_TOKEN_USAGE_STATE_KEY}.`))?.[1];
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function makeAuthFile(accountId, options = {}) {
  const email = options.email ?? `${accountId}@example.com`;
  const name = options.name ?? accountId;
  const plan = options.plan ?? "plus";
  return {
    ...(options.extraFields ?? {}),
    ...(options.lastRefresh ? { last_refresh: options.lastRefresh } : {}),
    ...((options.lastTokenAutoUpdate ?? options.lastCloudTokenSync)
      ? { last_token_auto_update: options.lastTokenAutoUpdate ?? options.lastCloudTokenSync }
      : {}),
    tokens: {
      access_token: options.accessToken ?? "access-token",
      refresh_token: options.refreshToken ?? "refresh-token",
      account_id: accountId,
      id_token: makeJwt({
        email,
        name,
        "https://api.openai.com/auth": {
          chatgpt_plan_type: plan,
        },
      }),
    },
  };
}

function readCloudAccount(config, name, passphrase) {
  core.setSavedAuthPassphrase(passphrase);
  const result = core.deserializeSavedValue(
    config.syncedStorage.accounts[name],
    "saved_auth"
  );
  core.setSavedAuthPassphrase(null);
  assert.equal(result.status, "ok");
  return result.value;
}

function readCloudProvider(config, name, passphrase) {
  core.setSavedAuthPassphrase(passphrase);
  const result = core.deserializeSavedValue(
    config.syncedStorage.providers[name],
    "saved_provider"
  );
  core.setSavedAuthPassphrase(null);
  assert.equal(result.status, "ok");
  return result.value;
}

function getCloudEnvelope(config, kind, name) {
  const entry =
    kind === "account"
      ? config.syncedStorage.accounts[name]
      : config.syncedStorage.providers[name];
  assert.equal(typeof entry, "object");
  assert.notEqual(entry, null);
  return entry;
}

function getSyncedCloudAccountKey(name) {
  return `${SYNCED_CLOUD_ACCOUNT_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function getSyncedCloudProviderKey(name) {
  return `${SYNCED_CLOUD_PROVIDER_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function getProtectedCloudAccountBackupPath(mocked, name) {
  return path.join(
    mocked.globalStoragePath,
    "cloud-account-recovery",
    "accounts",
    `${encodeURIComponent(name)}.json`
  );
}

function readMockSyncedStorage(globalStateValues, legacySyncedStorage) {
  const raw = globalStateValues.get(SYNCED_CLOUD_STATE_KEY) ?? legacySyncedStorage;
  const accounts = { ...(raw?.accounts ?? {}) };
  const providers = { ...(raw?.providers ?? {}) };
  const accountNames = new Set([
    ...Object.keys(accounts),
    ...(
      Array.isArray(raw?.accountNames)
        ? raw.accountNames.filter((name) => typeof name === "string")
        : []
    ),
  ]);
  const providerNames = new Set([
    ...Object.keys(providers),
    ...(
      Array.isArray(raw?.providerNames)
        ? raw.providerNames.filter((name) => typeof name === "string")
        : []
    ),
  ]);
  for (const name of accountNames) {
    const value = globalStateValues.get(getSyncedCloudAccountKey(name));
    if (value !== undefined) {
      accounts[name] = value;
    }
  }
  for (const name of providerNames) {
    const value = globalStateValues.get(getSyncedCloudProviderKey(name));
    if (value !== undefined) {
      providers[name] = value;
    }
  }
  const syncEntryNames = () => {
    const state = globalStateValues.get(SYNCED_CLOUD_STATE_KEY);
    if (state) {
      state.accountNames = Object.keys(accounts).sort();
      state.accounts = {};
      state.providerNames = Object.keys(providers).sort();
      state.providers = {};
    }
  };
  return {
    version: 1,
    accounts: new Proxy(accounts, {
      set(target, property, value) {
        if (typeof property !== "string") {
          return false;
        }
        target[property] = value;
        globalStateValues.set(getSyncedCloudAccountKey(property), value);
        syncEntryNames();
        return true;
      },
      deleteProperty(target, property) {
        if (typeof property !== "string") {
          return false;
        }
        delete target[property];
        globalStateValues.delete(getSyncedCloudAccountKey(property));
        syncEntryNames();
        return true;
      },
    }),
    accountNames: [...accountNames].sort(),
    providers: new Proxy(providers, {
      set(target, property, value) {
        if (typeof property !== "string") {
          return false;
        }
        target[property] = value;
        globalStateValues.set(getSyncedCloudProviderKey(property), value);
        syncEntryNames();
        return true;
      },
      deleteProperty(target, property) {
        if (typeof property !== "string") {
          return false;
        }
        delete target[property];
        globalStateValues.delete(getSyncedCloudProviderKey(property));
        syncEntryNames();
        return true;
      },
    }),
    providerNames: [...providerNames].sort(),
    devices: raw?.devices ?? [],
    autoRefreshDeviceName: raw?.autoRefreshDeviceName ?? null,
  };
}

function makeTokenCountRecord(totalTokens, timestamp) {
  const outputTokens = Math.min(25, totalTokens);
  const inputTokens = totalTokens - outputTokens;
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: Math.floor(inputTokens / 2),
          output_tokens: outputTokens,
          reasoning_output_tokens: Math.floor(outputTokens / 2),
          total_tokens: totalTokens,
        },
      },
    },
  };
}

function writeTokenUsageSession(codexHome, totalTokens) {
  const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365cbb";
  const sessionDir = path.join(codexHome, "sessions", "2025", "01", "02");
  const rolloutPath = path.join(
    sessionDir,
    `rollout-2025-01-02T03-04-05-${threadId}.jsonl`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2025-01-02T03:04:05.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        timestamp: "2025-01-02T03:04:05.000Z",
        model_provider: "openai",
      },
    })}\n${JSON.stringify(makeTokenCountRecord(totalTokens, "2025-01-02T03:05:00.000Z"))}\n`,
    "utf-8",
  );
  return rolloutPath;
}

function writeTokenUsageSessionAt(codexHome, options) {
  const startedAt = new Date(options.startedAt).toISOString();
  const tokenAt = new Date(options.tokenAt ?? options.startedAt + 10).toISOString();
  const sessionDir = path.join(codexHome, "sessions", "2026", "08", "11");
  const rolloutPath = path.join(
    sessionDir,
    `rollout-2026-08-11T00-00-00-${options.threadId}.jsonl`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: startedAt,
      type: "session_meta",
      payload: {
        id: options.threadId,
        timestamp: startedAt,
        model_provider: options.modelProvider ?? "openai",
      },
    })}\n${JSON.stringify(makeTokenCountRecord(options.totalTokens, tokenAt))}\n`,
    "utf-8",
  );
  return rolloutPath;
}

function installControlledQuotaHttps(usedPercent = 10) {
  const originalRequest = https.request;
  let resolveRequestStarted;
  let releaseResponse;
  let released = false;
  let requestCount = 0;
  const requestStarted = new Promise((resolve) => {
    resolveRequestStarted = resolve;
  });
  const responseReleased = new Promise((resolve) => {
    releaseResponse = resolve;
  });

  https.request = (requestOptions, handler) => {
    requestCount += 1;
    assert.equal(requestCount, 1, "controlled quota fixture expects one request");
    assert.equal(requestOptions?.hostname, "chatgpt.com");
    const response = new EventEmitter();
    response.statusCode = 200;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      handler(response);
      resolveRequestStarted({ ...requestOptions });
      void responseReleased.then(() => {
        response.emit("data", JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              reset_at: null,
            },
          },
        }));
        response.emit("end");
      });
    };
    return request;
  };

  return {
    requestStarted,
    release() {
      if (released) return;
      released = true;
      releaseResponse();
    },
    restore() {
      https.request = originalRequest;
    },
  };
}

function createTempExtensionEnvironment(t, prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  t.after(() => {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, codexHome, authDir };
}

async function withMockedHostname(hostname, fn) {
  const originalHostname = os.hostname;
  os.hostname = () => hostname;
  try {
    return await fn();
  } finally {
    os.hostname = originalHostname;
  }
}

function getAccountTreeRootItems(treeDataProvider) {
  return treeDataProvider.getChildren();
}

function getRoutesTree(mocked) {
  return mocked.treeViews.get("codexRouteSyncRoutes").treeDataProvider;
}

function getAccountRoots(mocked) {
  const groups = new Map();
  for (const item of getRoutesTree(mocked).getChildren()) {
    if (item?.account && item.groupParent) {
      groups.set(item.groupParent.groupKind, item.groupParent);
    }
  }
  return [...groups.values()];
}

function getProviderRoots(mocked) {
  return getRoutesTree(mocked).getChildren().filter((item) => item?.provider);
}

function getRouteBranchTree(mocked, kind) {
  const routes = getRoutesTree(mocked);
  return {
    getChildren(element) {
      if (element === undefined) {
        return kind === "accounts" ? getAccountRoots(mocked) : getProviderRoots(mocked);
      }
      if (kind === "accounts" && Array.isArray(element.children)) {
        return element.children;
      }
      return routes.getChildren(element);
    },
    getTreeItem(element) {
      return element;
    },
    getParent(element) {
      if (kind === "accounts" && element?.account) return element.groupParent;
      return routes.getParent(element);
    },
  };
}

function getAccountTreeView(mocked) {
  return { treeDataProvider: getRouteBranchTree(mocked, "accounts") };
}

function getProviderTreeView(mocked) {
  return { treeDataProvider: getRouteBranchTree(mocked, "providers") };
}

function getAccountTreeItems(treeDataProvider) {
  const items = [];
  const visit = (node) => {
    for (const child of treeDataProvider.getChildren(node)) {
      if (child?.account) {
        items.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(undefined);
  return items;
}

function getAccountDetailItems(treeDataProvider, accountItem) {
  return treeDataProvider.getChildren(accountItem);
}

function getQuotaStore(context) {
  const stores = context.subscriptions.filter((subscription) =>
    typeof subscription?.getSnapshot === "function"
    && typeof subscription?.reconcileAccounts === "function"
    && typeof subscription?.refreshQuota === "function"
    && typeof subscription?.markReloginRequired === "function"
  );
  assert.equal(stores.length, 1);
  return stores[0];
}

function createAccountTreeSnapshot(treeDataProvider) {
  const accounts = getAccountTreeItems(treeDataProvider).map((item) => item.account);
  const current = accounts.find((account) => account.isCurrent);
  return {
    accounts,
    selection: current
      ? { kind: "account", name: current.name, source: current.source, meta: current.meta ?? null }
      : { kind: "unknown", meta: null },
    byId: new Map(accounts.map((account) => [account.id, account])),
    bySourceAndName: new Map(accounts.map((account) => [`${account.source}:${account.name}`, account])),
    createdAt: Date.now(),
  };
}

function refreshQuotaThroughStore(context, treeDataProvider, targetIds, options = {}) {
  const snapshot = createAccountTreeSnapshot(treeDataProvider);
  return getQuotaStore(context).refreshQuota(targetIds, {
    ...options,
    snapshot,
    queryContext: options.queryContext ?? { snapshot, sharedQueries: new Map() },
  });
}

function countOperationLogs(lines, operation) {
  return lines.filter((line) => line.includes("perf-start") && line.includes(`"operation":"${operation}"`)).length;
}

function createDisposable(fn = () => {}) {
  return {
    dispose: fn,
  };
}

function createVscodeMock(options) {
  const registeredCommands = new Map();
  const executedCommands = [];
  const clipboardWrites = [];
  const sentTerminalCommands = [];
  const createdTerminals = [];
  const warningMessages = [];
  const informationMessages = [];
  const errorMessages = [];
  const inputBoxCalls = [];
  const inputBoxResponses = [...(options.inputBoxResponses ?? [])];
  const warningResponses = [...(options.warningResponses ?? [])];
  const infoResponses = [...(options.infoResponses ?? [])];
  const quickPickResponses = [...(options.quickPickResponses ?? [])];
  const secretState = new Map(Object.entries(options.secretValues ?? {}));
  const configurationUpdateErrors = new Map(Object.entries(options.configurationUpdateErrors ?? {}));
  const configurationUpdates = [];
  const configurationListeners = new Set();
  const treeViews = new Map();
  const treeRevealCalls = [];
  const webviewPanels = [];
  const createdChannels = [];
  const createdStatusBarItems = [];
  const globalStateValues = new Map(Object.entries(options.globalStateValues ?? {}));
  const syncedGlobalStateValues = new Map(Object.entries(options.syncedGlobalStateValues ?? {}));
  const globalStoragePath = options.globalStoragePath
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-global-storage-"));
  fs.mkdirSync(globalStoragePath, { recursive: true });
  const syncedStorage = options.syncedStorage
    ? {
        version: options.syncedStorage.version ?? 1,
        accounts: options.syncedStorage.accounts ?? {},
        providers: options.syncedStorage.providers ?? {},
        accountNames: options.syncedStorage.accountNames ?? Object.keys(options.syncedStorage.accounts ?? {}),
        providerNames: options.syncedStorage.providerNames ?? Object.keys(options.syncedStorage.providers ?? {}),
        devices: options.syncedStorage.devices ?? [],
        autoRefreshDeviceName: options.syncedStorage.autoRefreshDeviceName ?? null,
      }
    : {
        version: 1,
        accounts: {},
        accountNames: [],
        providers: {},
        providerNames: [],
        devices: [],
        autoRefreshDeviceName: null,
      };
  let legacySyncedStorage = JSON.parse(JSON.stringify(syncedStorage));

  const config = {
    authDirectory: options.authDirectory,
    proxy: options.proxy ?? "",
    reloadWindowAfterSwitch: options.reloadWindowAfterSwitch ?? "never",
    useDeviceAuthForLogin: options.useDeviceAuthForLogin ?? false,
    quotaRefreshInterval: 30,
    tokenAutoUpdate: options.tokenAutoUpdate ?? options.cloudTokenAutoUpdate ?? true,
    tokenAutoUpdateIntervalHours:
      options.tokenAutoUpdateIntervalHours ?? options.cloudTokenAutoUpdateIntervalHours ?? 24,
    showStatusBar: options.showStatusBar ?? false,
    detailedPerformanceLogging: options.detailedPerformanceLogging ?? false,
    shareHistoryAcrossProviders: options.shareHistoryAcrossProviders ?? false,
    defaultSaveTarget: options.defaultSaveTarget ?? "local",
    language: options.languagePreference ?? "auto",
  };
  Object.defineProperty(config, "syncedStorage", {
    enumerable: true,
    get() {
      return readMockSyncedStorage(globalStateValues, legacySyncedStorage);
    },
    set(value) {
      legacySyncedStorage = value;
    },
  });

  if (options.syncedStorage && !globalStateValues.has(SYNCED_CLOUD_STATE_KEY)) {
    for (const [name, account] of Object.entries(syncedStorage.accounts)) {
      globalStateValues.set(getSyncedCloudAccountKey(name), JSON.parse(JSON.stringify(account)));
    }
    for (const [name, provider] of Object.entries(syncedStorage.providers)) {
      globalStateValues.set(getSyncedCloudProviderKey(name), JSON.parse(JSON.stringify(provider)));
    }
    globalStateValues.set(SYNCED_CLOUD_STATE_KEY, {
      version: 1,
      accounts: {},
      accountNames: syncedStorage.accountNames.sort(),
      providers: {},
      providerNames: syncedStorage.providerNames.sort(),
      devices: [...syncedStorage.devices],
      autoRefreshDeviceName: syncedStorage.autoRefreshDeviceName,
    });
  }

  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return createDisposable(() => this.listeners.delete(listener));
      };
    }

    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose() {
      this.listeners.clear();
    }
  }

  class TreeItem {
    constructor(label, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  }

  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }

  const vscode = {
    EventEmitter,
    ThemeIcon,
    ThemeColor,
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    StatusBarAlignment: {
      Right: 2,
    },
    ProgressLocation: {
      Notification: 15,
    },
    ConfigurationTarget: {
      Global: 1,
    },
    ViewColumn: {
      Active: -1,
    },
    window: {
      createWebviewPanel(viewType, title, showOptions, panelOptions) {
        const messageEmitter = new EventEmitter();
        const viewStateEmitter = new EventEmitter();
        const disposalEmitter = new EventEmitter();
        const posted = [];
        const webview = {
          options: undefined,
          html: "",
          cspSource: "vscode-webview://codex-switchbridge-test",
          asWebviewUri(resource) {
            return {
              toString: () => `vscode-resource:${resource.fsPath}`,
            };
          },
          postMessage(message) {
            posted.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: messageEmitter.event,
        };
        const panel = {
          visible: true,
          active: true,
          webview,
          onDidChangeViewState: viewStateEmitter.event,
          onDidDispose: disposalEmitter.event,
          revealCalls: [],
          reveal(column) {
            this.revealCalls.push(column);
            this.visible = true;
            this.active = true;
            viewStateEmitter.fire({ webviewPanel: this });
          },
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            disposalEmitter.fire(undefined);
          },
        };
        const created = {
          viewType,
          title,
          showOptions,
          panelOptions,
          panel,
          posted,
          deliver(message) {
            messageEmitter.fire(message);
          },
          setVisible(visible) {
            panel.visible = visible;
            panel.active = visible;
            viewStateEmitter.fire({ webviewPanel: panel });
          },
          latestState() {
            return posted.filter((message) => message?.type === "dashboard.state").at(-1)?.state;
          },
          latestMessage() {
            return posted.filter((message) => message?.type === "dashboard.state").at(-1);
          },
          dispose() {
            panel.dispose();
            messageEmitter.dispose();
            viewStateEmitter.dispose();
            disposalEmitter.dispose();
          },
        };
        webviewPanels.push(created);
        return panel;
      },
      createTreeView(id, viewOptions) {
        const visibilityEmitter = new EventEmitter();
        const baseDisposable = createDisposable(() => visibilityEmitter.dispose());
        const treeView = {
          ...baseDisposable,
          visible: options.visibleTreeViewIds?.includes(id) ?? false,
          onDidChangeVisibility: visibilityEmitter.event,
          setVisible(visible) {
            this.visible = visible;
            visibilityEmitter.fire({ visible });
          },
        };
        treeView.id = id;
        treeView.treeDataProvider = viewOptions.treeDataProvider;
        treeView.reveal = async (element, revealOptions) => {
          treeRevealCalls.push({ id, element, options: revealOptions });
        };
        treeViews.set(id, treeView);
        return treeView;
      },
      createStatusBarItem() {
        const item = {
          visible: false,
          disposed: false,
          showCount: 0,
          show() {
            this.visible = true;
            this.showCount += 1;
          },
          hide() { this.visible = false; },
          dispose() { this.disposed = true; },
          text: "",
          tooltip: "",
          command: undefined,
          name: "",
        };
        createdStatusBarItems.push(item);
        return item;
      },
      createOutputChannel(name, channelOptions) {
        const entries = [];
        const channel = {
          name,
          options: channelOptions,
          entries,
          info() {},
          warn() {},
          error() {},
          appendLine() {},
          show() {},
          dispose() {},
        };
        channel.info = (line) => {
          if (options.outputChannelInfoThrowsOn && line.includes(options.outputChannelInfoThrowsOn)) {
            throw new Error("output channel write failed");
          }
          entries.push({ level: "info", line });
        };
        channel.warn = (line) => {
          entries.push({ level: "warn", line });
        };
        channel.error = (line) => {
          entries.push({ level: "error", line });
        };
        createdChannels.push(channel);
        return channel;
      },
      createTerminal(options) {
        let disposed = false;
        const terminal = {
          options,
          show() {},
          sendText(text) {
            sentTerminalCommands.push(text);
          },
          dispose() {
            disposed = true;
          },
          get disposed() {
            return disposed;
          },
        };
        createdTerminals.push(terminal);
        return terminal;
      },
      async showInputBox(inputOptions) {
        inputBoxCalls.push(inputOptions);
        return inputBoxResponses.shift();
      },
      async showWarningMessage(message, ...actions) {
        warningMessages.push({ message, actions });
        return warningResponses.shift();
      },
      async showInformationMessage(message, ...actions) {
        informationMessages.push({ message, actions });
        const next = infoResponses.shift();
        if (typeof next === "function") {
          return next(message, actions);
        }
        return next;
      },
      async showErrorMessage(message, ...actions) {
        errorMessages.push({ message, actions });
        return undefined;
      },
      async showQuickPick(items) {
        const next = quickPickResponses.shift();
        if (typeof next === "function") {
          return next(items);
        }
        return next;
      },
      async withProgress(_options, task) {
        return task();
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.ok(section === "codex-switchbridge" || section === "http");
        return {
          get(key, defaultValue) {
            if (section === "http") {
              return key === "proxy" ? options.httpProxy ?? defaultValue : defaultValue;
            }
            if (key === "syncedStorage" && options.legacyConfigurationSyncedStorage) {
              return legacySyncedStorage;
            }
            return config[key] ?? defaultValue;
          },
          async update(key, value, target) {
            const configuredError = configurationUpdateErrors.get(key);
            if (configuredError) {
              throw configuredError instanceof Error ? configuredError : new Error(String(configuredError));
            }
            configurationUpdates.push({ key, value, target });
            config[key] = value;
            const event = {
              affectsConfiguration(target) {
                return target === `codex-switchbridge.${key}`;
              },
            };
            for (const listener of configurationListeners) {
              listener(event);
            }
          },
        };
      },
      onDidChangeConfiguration(listener) {
        configurationListeners.add(listener);
        return createDisposable(() => configurationListeners.delete(listener));
      },
    },
    commands: {
      registerCommand(name, handler) {
        registeredCommands.set(name, handler);
        return createDisposable(() => registeredCommands.delete(name));
      },
      async executeCommand(name, ...args) {
        executedCommands.push({ name, args });
        if (name === "workbench.action.reloadWindow") {
          return undefined;
        }
        const command = registeredCommands.get(name);
        return command ? command(...args) : undefined;
      },
    },
    extensions: {
      getExtension() {
        return undefined;
      },
    },
    env: {
      language: options.language ?? "en",
      clipboard: {
        async writeText(value) {
          clipboardWrites.push(value);
        },
      },
    },
    Uri: {
      file(filePath) {
        return { fsPath: filePath, toString: () => `file://${filePath}` };
      },
      joinPath(base, ...segments) {
        const joined = path.join(base.fsPath, ...segments);
        return { fsPath: joined, toString: () => `file://${joined}` };
      },
    },
  };

  return {
    vscode,
    registeredCommands,
    executedCommands,
    clipboardWrites,
    sentTerminalCommands,
    createdTerminals,
    warningMessages,
    informationMessages,
    errorMessages,
    inputBoxCalls,
    treeViews,
    treeRevealCalls,
    webviewPanels,
    async readyDashboard() {
      await registeredCommands.get("codex-routesync.openDashboard")();
      const created = webviewPanels.at(-1);
      assert.ok(created, "openDashboard should create the dashboard WebviewPanel");
      created.deliver({ type: "dashboard.ready" });
      await Promise.resolve();
      await Promise.resolve();
      return created;
    },
    createdChannels,
    createdStatusBarItems,
    configurationUpdates,
    config,
    secrets: {
      async get(key) {
        return secretState.get(key);
      },
      async store(key, value) {
        secretState.set(key, value);
      },
      async delete(key) {
        secretState.delete(key);
      },
    },
    secretState,
    globalState: {
      get(key) {
        return globalStateValues.get(key);
      },
      setKeysForSync(keys) {
        this.syncedKeys = [...keys];
      },
      async update(key, value) {
        if (value === undefined) {
          globalStateValues.delete(key);
        } else {
          globalStateValues.set(key, value);
        }
        if (options.afterGlobalStateUpdate) {
          await options.afterGlobalStateUpdate(key, value, {
            globalStateValues,
            syncedGlobalStateValues,
          });
        }
        if (options.captureSyncedGlobalStateWrites && this.syncedKeys?.includes(key)) {
          if (value === undefined) {
            syncedGlobalStateValues.delete(key);
          } else {
            syncedGlobalStateValues.set(key, JSON.parse(JSON.stringify(value)));
          }
        }
      },
    },
    globalStateValues,
    syncedGlobalStateValues,
    globalStoragePath,
    legacySyncedStorage: () => legacySyncedStorage,
  };
}

function loadExtensionWithMockedVscode(vscodeMock) {
  const extensionPath = path.join(__dirname, "..", "dist", "extension.js");
  const originalLoad = Module._load;
  delete require.cache[extensionPath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return vscodeMock;
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require(extensionPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createExtensionContext(mocked) {
  return {
    subscriptions: [],
    extensionPath: path.join(__dirname, ".."),
    extensionUri: mocked.vscode.Uri.file(path.join(__dirname, "..")),
    secrets: mocked.secrets,
    globalState: mocked.globalState,
    globalStorageUri: {
      fsPath: mocked.globalStoragePath,
    },
  };
}

async function historyRepairDiscoversOrphanedProvider(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-history-reconciliation-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const sessionDir = path.join(codexHome, "sessions", "2026", "08", "10");
  const rollout = path.join(sessionDir, "rollout.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    rollout,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-1", model_provider: "orphaned-provider" },
    })}\n`,
    "utf-8",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "saved-profile-id",
      auth: { OPENAI_API_KEY: "sk-history-repair" },
      config: {
        name: "Friendly Display Name",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      showStatusBar: true,
      warningResponses: ["Repair History"],
    });
    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const unchanged = JSON.parse(fs.readFileSync(rollout, "utf-8"));
      assert.equal(unchanged.payload.model_provider, "orphaned-provider");
      assert.equal(
        mocked.informationMessages.some(({ message, actions }) =>
          message.includes("History was unified")
          && actions.includes("Reload")
          && actions.includes("Later")
        ),
        false,
      );
      assert.equal(
        mocked.executedCommands.some((entry) => entry.name === "workbench.action.reloadWindow"),
        false,
      );

      await mocked.registeredCommands.get("codex-routesync.repairSharedHistory")();
      const repaired = JSON.parse(fs.readFileSync(rollout, "utf-8"));
      assert.equal(repaired.payload.model_provider, "openai");
      const manifests = fs
        .readdirSync(path.join(codexHome, "switchbridge-history-migration-backups"))
        .map((name) => JSON.parse(fs.readFileSync(
          path.join(codexHome, "switchbridge-history-migration-backups", name, "manifest.json"),
          "utf-8",
        )));
      assert.deepEqual(manifests.map((manifest) => manifest.source), ["orphaned-provider"]);
      const reloadItem = mocked.createdStatusBarItems.find(
        (item) => item.command === "codex-routesync.reloadWindow",
      );
      assert.ok(reloadItem);
      assert.equal(reloadItem.visible, true);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function withDisabledIntervals(fn) {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const intervals = [];
  const zeroTimeouts = [];
  global.setInterval = (callback, delay, ...args) => {
    const handle = {
      __mockInterval: true,
      callback,
      delay,
      args,
      cleared: false,
    };
    intervals.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    if (handle?.__mockInterval) {
      handle.cleared = true;
    }
  };
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 0) {
      const handle = {
        __mockTimeout: true,
        callback,
        args,
        cleared: false,
      };
      zeroTimeouts.push(handle);
      return handle;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle?.__mockTimeout) {
      handle.cleared = true;
      return;
    }
    return originalClearTimeout(handle);
  };

  const flushTimers = async () => {
    while (true) {
      const handle = zeroTimeouts.find((timer) => !timer.cleared);
      if (!handle) {
        return;
      }
      handle.cleared = true;
      handle.callback(...handle.args);
      await Promise.resolve();
    }
  };

  try {
    return await fn({ flushTimers, intervals });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

async function withSuccessfulHttps(fn, mockOptions = {}) {
  const originalRequest = https.request;
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    mockOptions?.requestLog?.push?.({
      hostname,
      path: requestOptions?.path ?? "",
      method: requestOptions?.method ?? "GET",
      proxyUrl: requestOptions?.agent?.proxy?.href ?? null,
      authorization:
        requestOptions?.headers?.Authorization
        ?? requestOptions?.headers?.authorization
        ?? null,
    });
    const body =
      hostname === "auth.openai.com"
        ? JSON.stringify({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            id_token: makeJwt({
              email: "restored@example.com",
              name: "restored",
              "https://api.openai.com/auth": {
                chatgpt_plan_type: "plus",
              },
            }),
          })
        : JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                reset_at: null,
              },
            },
          });
    const response = {
      statusCode: 200,
      on(event, listener) {
        if (event === "data") {
          setImmediate(() => listener(body));
        }
        if (event === "end") {
          setImmediate(listener);
        }
        return response;
      },
    };

    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        handler(response);
      },
    };

    return request;
  };

  try {
    return await fn();
  } finally {
    https.request = originalRequest;
  }
}

async function withFailingHttps(fn, mockOptions = {}) {
  const originalRequest = https.request;
  https.request = (requestOptions) => {
    mockOptions?.requestLog?.push?.({
      hostname: requestOptions?.hostname,
      path: requestOptions?.path ?? "",
      method: requestOptions?.method ?? "GET",
    });
    const listeners = new Map();
    const request = {
      on(event, listener) {
        listeners.set(event, listener);
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        setImmediate(() => listeners.get("error")?.(new Error("quota network failed")));
      },
    };

    return request;
  };

  try {
    return await fn();
  } finally {
    https.request = originalRequest;
  }
}

async function withQuotaRejectedHttps(fn, mockOptions = {}) {
  const originalRequest = https.request;
  const statusCode = mockOptions.statusCode ?? 401;
  const rejectionBody = mockOptions.body ?? {
    detail: "authentication token expired",
  };
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    mockOptions?.requestLog?.push?.({
      hostname,
      path: requestOptions?.path ?? "",
      method: requestOptions?.method ?? "GET",
      authorization:
        requestOptions?.headers?.Authorization
        ?? requestOptions?.headers?.authorization
        ?? null,
    });
    const isQuotaRequest = hostname === "chatgpt.com";
    const body = isQuotaRequest
      ? JSON.stringify(rejectionBody)
      : JSON.stringify({
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
          id_token: makeJwt({
            email: "restored@example.com",
            name: "restored",
            "https://api.openai.com/auth": {
              chatgpt_plan_type: "plus",
            },
          }),
        });
    const response = {
      statusCode: isQuotaRequest ? statusCode : 200,
      on(event, listener) {
        if (event === "data") {
          setImmediate(() => listener(body));
        }
        if (event === "end") {
          setImmediate(listener);
        }
        return response;
      },
    };

    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        handler(response);
      },
    };

    return request;
  };

  try {
    return await fn();
  } finally {
    https.request = originalRequest;
  }
}

async function withRefreshTokenReusedHttps(fn, failure = {}) {
  const originalRequest = https.request;
  const failureMessage = failure.message
    ?? "Your refresh token has already been used to generate a new access token. Please try signing in again.";
  const failureCode = failure.code ?? "refresh_token_reused";
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    const isTokenRequest = hostname === "auth.openai.com";
    const body = isTokenRequest
      ? JSON.stringify({
          error: {
            message: failureMessage,
            type: "invalid_request_error",
            param: null,
            code: failureCode,
          },
        })
      : JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 10,
              reset_at: null,
            },
          },
        });
    const response = {
      statusCode: isTokenRequest ? 401 : 200,
      on(event, listener) {
        if (event === "data") {
          setImmediate(() => listener(body));
        }
        if (event === "end") {
          setImmediate(listener);
        }
        return response;
      },
    };

    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        handler(response);
      },
    };

    return request;
  };

  try {
    return await fn();
  } finally {
    https.request = originalRequest;
  }
}

async function waitForRefreshCoordinatorIdle(context) {
  const refreshCoordinator = getRefreshCoordinator(context);
  assert.ok(refreshCoordinator);
  await refreshCoordinator.whenIdle();
}

function countUsageRequests(requestLog) {
  return requestLog.filter((request) => request.hostname === "chatgpt.com").length;
}

function countAuthRefreshRequests(requestLog) {
  return requestLog.filter((request) => request.hostname === "auth.openai.com").length;
}

function writeLastTerminalAuth(mocked, auth) {
  const terminal = mocked.createdTerminals.at(-1);
  const codexHome = terminal?.options?.env?.CODEX_HOME;
  assert.equal(typeof codexHome, "string");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");
}

function getRefreshCoordinator(context) {
  return context.subscriptions.find(
    (item) =>
      item
      && typeof item.scheduleQuotaRefresh === "function"
      && typeof item.refreshViews === "function"
  );
}

test("addAccount waits for delayed device auth after Done", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-account-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-device"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const mocked = createVscodeMock({
    authDirectory: authDir,
    inputBoxResponses: ["device-user"],
    warningResponses: ["Use Device Auth"],
    infoResponses: [
      () => {
        setTimeout(
          () => writeLastTerminalAuth(mocked, makeAuthFile("acct-device")),
          10,
        );
        return "Done";
      },
      "Later",
    ],
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.addAccount")();

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);

        assert.deepEqual(mocked.sentTerminalCommands, ["codex login --device-auth"]);
        assert.match(
          mocked.warningMessages[0]?.message ?? "",
          /device auth/i
        );
        const savedAuthPath = path.join(authDir, "auth_device-user.json");
        assert.equal(fs.existsSync(savedAuthPath), true);
      })
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addAccount saves a new local account without switching away from the active account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-local-preserve-active-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const activeAuth = makeAuthFile("acct-active", {
    accessToken: "access-active-current",
    refreshToken: "refresh-active-current",
  });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), makeAuthFile("acct-active", {
    accessToken: "access-active-saved",
    refreshToken: "refresh-active-saved",
  }));
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(activeAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    authDirectory: authDir,
    inputBoxResponses: ["new-user"],
    warningResponses: ["Login"],
    infoResponses: [
      () => {
        writeLastTerminalAuth(
          mocked,
          makeAuthFile("acct-new", {
            accessToken: "access-new",
            refreshToken: "refresh-new",
          }),
        );
        return "Done";
      },
      "Later",
    ],
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-routesync.addAccount")();
        await waitForRefreshCoordinatorIdle(context);

        const savedNew = JSON.parse(fs.readFileSync(path.join(authDir, "auth_new-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const savedActive = JSON.parse(fs.readFileSync(path.join(authDir, "auth_active.json"), "utf-8"));
        assert.equal(savedNew.tokens.account_id, "acct-new");
        assert.equal(savedNew.tokens.access_token, "access-new");
        assert.equal(currentAuth.tokens.account_id, "acct-active");
        assert.equal(currentAuth.tokens.access_token, "access-active-current");
        assert.equal(savedActive.tokens.account_id, "acct-active");
        assert.equal(savedActive.tokens.access_token, "access-active-saved");
        const marker = mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection");
        assert.equal(marker?.kind, "account");
        assert.equal(marker?.name, "active");
        assert.equal(marker?.source, "local");
        assert.equal(countAuthRefreshRequests(requestLog), 0);
        const savedMessage = mocked.informationMessages.find(({ message }) =>
          message.includes('Account "new-user" was saved')
        );
        assert.ok(savedMessage);
        assert.equal(savedMessage.actions.includes("Reload"), false);
        assert.equal(savedMessage.actions.includes("Later"), false);
        assert.match(savedMessage.message, /not active/i);
        assert.match(savedMessage.message, /Switch Account/i);
        assert.doesNotMatch(savedMessage.message, /Reload/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addAccount saves bob1990 without replacing the active cloud google1 auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-local-preserve-cloud-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const googleAuth = makeAuthFile("acct-google1", {
    email: "google1@example.com",
    accessToken: "access-google1-current",
    refreshToken: "refresh-google1-current",
  });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("cloud-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", googleAuth, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(googleAuth, null, 2), "utf-8");

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          google1: cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "google1",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      },
      inputBoxResponses: ["bob1990"],
      warningResponses: ["Login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(
            mocked,
            makeAuthFile("acct-bob", {
              email: "bob1990@example.com",
              accessToken: "access-bob-login",
              refreshToken: "refresh-bob-login",
            }),
          );
          return "Done";
        },
        "Later",
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-routesync.addAccount")();
        await waitForRefreshCoordinatorIdle(context);

        core.setSavedAuthPassphrase("cloud-passphrase");
        const savedBobResult = core.readSavedAuthFileResult(path.join(authDir, "auth_bob1990.json"));
        core.setSavedAuthPassphrase(null);
        assert.equal(savedBobResult.status, "ok");
        const savedBob = savedBobResult.value;
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const cloudAuth = readCloudAccount(mocked.config, "google1", "cloud-passphrase");
        assert.equal(savedBob.tokens.account_id, "acct-bob");
        assert.equal(savedBob.tokens.access_token, "access-bob-login");
        assert.equal(currentAuth.tokens.account_id, "acct-google1");
        assert.equal(currentAuth.tokens.access_token, "access-google1-current");
        assert.equal(cloudAuth.tokens.account_id, "acct-google1");
        assert.equal(cloudAuth.tokens.access_token, "access-google1-current");
        assert.equal(getCloudEnvelope(mocked.config, "account", "google1").entryVersion, 2);
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), {
          kind: "account",
          name: "google1",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-05-01T00:00:00.000Z",
        });
        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(
          requestLog.some((request) => request.authorization === "Bearer access-google1-current"),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addAccount restores the active account when a duplicate local login is rejected", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-local-duplicate-restore-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), makeAuthFile("acct-active", {
    accessToken: "access-active-current",
    refreshToken: "refresh-active-current",
  }));
  core.writeSavedAuthFile(path.join(authDir, "auth_bob1990.json"), makeAuthFile("acct-bob", {
    email: "bob1990@example.com",
    accessToken: "access-bob-saved",
    refreshToken: "refresh-bob-saved",
  }));
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-active", {
      accessToken: "access-active-current",
      refreshToken: "refresh-active-current",
    }), null, 2),
    "utf-8",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const mocked = createVscodeMock({
    authDirectory: authDir,
    inputBoxResponses: ["microsoft2"],
    warningResponses: ["Login"],
    infoResponses: [
      () => {
        writeLastTerminalAuth(
          mocked,
          makeAuthFile("acct-bob", {
            email: "bob1990@example.com",
            accessToken: "access-bob-login",
            refreshToken: "refresh-bob-login",
          }),
        );
        return "Done";
      },
    ],
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        await mocked.registeredCommands.get("codex-routesync.addAccount")();
        await waitForRefreshCoordinatorIdle(context);

        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const savedBob = JSON.parse(fs.readFileSync(path.join(authDir, "auth_bob1990.json"), "utf-8"));
        assert.equal(fs.existsSync(path.join(authDir, "auth_microsoft2.json")), false);
        assert.equal(currentAuth.tokens.account_id, "acct-active");
        assert.equal(currentAuth.tokens.access_token, "access-active-current");
        assert.equal(savedBob.tokens.account_id, "acct-bob");
        assert.equal(savedBob.tokens.access_token, "access-bob-saved");
        const marker = mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection");
        assert.equal(marker?.kind, "account");
        assert.equal(marker?.name, "active");
        assert.equal(marker?.source, "local");
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /Duplicate add was rejected/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate restores the saved storage password from SecretStorage", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-storage-secret-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("secret-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "secret-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.useAccount")({
          account: { name: "work" },
        });

        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(currentAuth.tokens.account_id, "acct-work");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }
});

test("activate migrates legacy synced storage into synced globalState and registers the sync key", async () => {
  core.setSavedAuthPassphrase("migrate-passphrase");
  const syncedStorage = {
    version: 1,
    accounts: {
      migrated: core.serializeSavedValue("saved_auth", makeAuthFile("acct-migrated"), {
        requireEncryption: true,
      }),
    },
    providers: {},
    devices: ["device-a"],
    autoRefreshDeviceName: "device-a",
  };
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    syncedStorage,
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: undefined,
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("migrated"),
      ]);
      assert.deepEqual(mocked.config.syncedStorage.accounts, syncedStorage.accounts);
      assert.equal(mocked.legacySyncedStorage(), undefined);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activation keeps migrated globalState data active when clearing legacy synced settings fails", async () => {
  core.setSavedAuthPassphrase("legacy-failure-passphrase");
  const syncedStorage = {
    version: 1,
    accounts: {
      blocked: core.serializeSavedValue("saved_auth", makeAuthFile("acct-blocked"), {
        requireEncryption: true,
      }),
    },
    accountNames: ["blocked"],
    providers: {},
    providerNames: [],
    devices: ["device-a"],
    autoRefreshDeviceName: "device-a",
  };
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    syncedStorage,
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: undefined,
    },
    inputBoxResponses: ["legacy-failure-passphrase"],
    configurationUpdateErrors: {
      syncedStorage: new Error("EPERM legacy cleanup failed"),
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.equal(mocked.config.syncedStorage.accounts.blocked.email, "acct-blocked@example.com");
      assert.equal(mocked.config.syncedStorage.accounts.blocked.entryVersion, syncedStorage.accounts.blocked.entryVersion);
      assert.equal(mocked.config.syncedStorage.accounts.blocked.updatedAt, syncedStorage.accounts.blocked.updatedAt);
      assert.deepEqual(mocked.legacySyncedStorage(), syncedStorage);
      assert.equal(
        mocked.warningMessages.some((entry) => /migrated to extension state/i.test(entry.message)),
        true
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate materializes aggregate cloud accounts and providers into per-entry synced keys", async () => {
  const accountEntry = makeAuthFile("acct-aggregate", { email: "aggregate@example.com" });
  const providerEntry = {
    kind: "provider",
    name: "proxy",
    auth: { OPENAI_API_KEY: "sk-proxy" },
    config: {
      name: "proxy",
      base_url: "https://proxy.example.com/v1",
      wire_api: "responses",
    },
  };
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          aggregate: accountEntry,
        },
        accountNames: ["aggregate"],
        providers: {
          proxy: providerEntry,
        },
        providerNames: ["proxy"],
        devices: ["device-a"],
        autoRefreshDeviceName: "device-a",
      },
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providers, {});
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["aggregate"]);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["proxy"]);
      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudAccountKey("aggregate")), {
        ...accountEntry,
        email: "aggregate@example.com",
      });
      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudProviderKey("proxy")), providerEntry);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("aggregate"),
        getSyncedCloudProviderKey("proxy"),
      ]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate preserves names-only cloud account and provider index entries", async () => {
  const accountEntry = makeAuthFile("acct-present", { email: "present@example.com" });
  const providerEntry = {
    kind: "provider",
    name: "present-proxy",
    auth: { OPENAI_API_KEY: "sk-present" },
    config: {
      name: "present-proxy",
      base_url: "https://present.example.com/v1",
      wire_api: "responses",
    },
  };
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          present: accountEntry,
        },
        accountNames: ["missing", "present"],
        providers: {
          "present-proxy": providerEntry,
        },
        providerNames: ["missing-proxy", "present-proxy"],
        devices: ["device-a"],
        autoRefreshDeviceName: "device-a",
      },
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["missing", "present"]);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["missing-proxy", "present-proxy"]);
      assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("missing")), false);
      assert.equal(mocked.globalStateValues.has(getSyncedCloudProviderKey("missing-proxy")), false);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("missing"),
        getSyncedCloudAccountKey("present"),
        getSyncedCloudProviderKey("missing-proxy"),
        getSyncedCloudProviderKey("present-proxy"),
      ]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("delayed synced cloud account payload becomes available after refresh", async () => {
  core.setSavedAuthPassphrase("delayed-passphrase");
  const delayedAccount = core.serializeSavedValue(
    "saved_auth",
    makeAuthFile("acct-apple1", { email: "apple1@example.com" }),
    {
      requireEncryption: true,
    }
  );
  delayedAccount.entryVersion = 1;
  delayedAccount.updatedAt = "2026-05-25T00:00:00.000Z";
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: ["apple1"],
        providers: {},
        providerNames: [],
      },
    },
    secretValues: {
      [STORAGE_SECRET_KEY]: "delayed-passphrase",
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const accountTreeView = getAccountTreeView(mocked);
      let [appleItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

      assert.equal(appleItem.account.storageState, "pending");
      assert.match(appleItem.account.storageMessage, /payload has not synced/);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["apple1"]);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("apple1"),
      ]);

      await mocked.globalState.update(getSyncedCloudAccountKey("apple1"), delayedAccount);
      await mocked.registeredCommands.get("codex-routesync.refreshList")();

      [appleItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

      assert.equal(appleItem.account.storageState, "ready");
      assert.equal(appleItem.account.meta.email, "apple1@example.com");
      assert.equal(appleItem.account.syncVersion, 1);
      assert.equal(appleItem.account.syncUpdatedAt, "2026-05-25T00:00:00.000Z");

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("delayed synced cloud provider payload is pending until it becomes available", async () => {
  core.setSavedAuthPassphrase("delayed-provider-passphrase");
  const delayedProvider = core.serializeSavedValue(
    "saved_provider",
    {
      kind: "provider",
      name: "qingteng",
      auth: { OPENAI_API_KEY: "sk-qingteng" },
      config: {
        name: "qingteng",
        base_url: "https://qingteng.example.com/v1",
        wire_api: "responses",
      },
    },
    {
      requireEncryption: true,
    }
  );
  delayedProvider.entryVersion = 1;
  delayedProvider.updatedAt = "2026-07-12T00:00:00.000Z";
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: [],
        providers: {},
        providerNames: [],
      },
    },
    secretValues: {
      [STORAGE_SECRET_KEY]: "delayed-provider-passphrase",
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const providerTreeView = getProviderTreeView(mocked);
      assert.equal(
        providerTreeView.treeDataProvider
          .getChildren()
          .some((item) => item.provider.name === "qingteng" && item.provider.source === "cloud"),
        false,
      );

      mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames = ["qingteng"];
      await mocked.registeredCommands.get("codex-routesync.refreshList")();

      let [providerItem] = providerTreeView.treeDataProvider
        .getChildren()
        .filter((item) => item.provider.name === "qingteng" && item.provider.source === "cloud");

      assert.equal(providerItem.provider.pending, true);
      assert.equal(providerItem.provider.invalid, false);
      assert.match(providerItem.description, /payload pending/i);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudProviderKey("qingteng"),
      ]);

      await mocked.globalState.update(getSyncedCloudProviderKey("qingteng"), delayedProvider);
      await mocked.registeredCommands.get("codex-routesync.refreshList")();

      [providerItem] = providerTreeView.treeDataProvider
        .getChildren()
        .filter((item) => item.provider.name === "qingteng" && item.provider.source === "cloud");

      assert.equal(providerItem.provider.pending, false);
      assert.equal(providerItem.provider.invalid, false);
      assert.equal(providerItem.provider.profile.auth.OPENAI_API_KEY, "sk-qingteng");
      assert.equal(providerItem.provider.syncVersion, 1);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("remove account deletes a names-only cloud account index entry", async () => {
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: ["apple1"],
        providers: {},
        providerNames: [],
      },
    },
    secretValues: {
      [STORAGE_SECRET_KEY]: "unused-passphrase",
    },
    warningResponses: ["Remove"],
  });
  const backupPath = getProtectedCloudAccountBackupPath(mocked, "apple1");
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      version: 1,
      kind: "cloud_account_payload_backup",
      name: "apple1",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      syncVersion: null,
      syncUpdatedAt: null,
      payload: {
        ciphertext: "protected",
      },
    }),
    "utf-8"
  );

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const accountTreeView = getAccountTreeView(mocked);
      const [appleItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

      assert.ok(appleItem);
      assert.equal(fs.existsSync(backupPath), true);
      await mocked.registeredCommands.get("codex-routesync.removeAccount")(appleItem);

      assert.deepEqual(mocked.errorMessages, []);
      assert.deepEqual(mocked.warningMessages.map((message) => message.message), [
        'Remove account "apple1" from cloud storage?',
      ]);
      assert.equal(mocked.informationMessages.length, 1);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["apple1"]);
      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("apple1"))?.deleted, true);
      assert.equal(fs.existsSync(backupPath), false);
      assert.match(mocked.informationMessages[0]?.message ?? "", /Account "apple1" was removed/);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate keeps the highest-version payload when materializing cloud entries", async () => {
  const staleAccount = makeAuthFile("acct-stale", { email: "stale@example.com" });
  staleAccount.entryVersion = 3;
  staleAccount.updatedAt = "2026-05-01T00:00:00.000Z";
  const freshAccount = makeAuthFile("acct-fresh", { email: "fresh@example.com" });
  freshAccount.entryVersion = 7;
  freshAccount.updatedAt = "2026-05-02T00:00:00.000Z";
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          sync: freshAccount,
        },
        accountNames: ["sync"],
        providers: {},
        providerNames: [],
        devices: [],
        autoRefreshDeviceName: null,
      },
      [getSyncedCloudAccountKey("sync")]: staleAccount,
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("sync")).entryVersion, 7);
      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("sync")).email, "fresh@example.com");
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["sync"]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate restores names-only cloud entries from legacy payloads when available", async () => {
  const legacyAccount = makeAuthFile("acct-legacy", { email: "legacy@example.com" });
  legacyAccount.entryVersion = 4;
  legacyAccount.updatedAt = "2026-05-01T00:00:00.000Z";
  const legacyProvider = {
    kind: "provider",
    name: "legacy-proxy",
    auth: { OPENAI_API_KEY: "sk-legacy" },
    config: {
      name: "legacy-proxy",
      base_url: "https://legacy.example.com/v1",
      wire_api: "responses",
    },
    entryVersion: 5,
    updatedAt: "2026-05-02T00:00:00.000Z",
  };
  const mocked = createVscodeMock({
    legacyConfigurationSyncedStorage: true,
    syncedStorage: {
      version: 1,
      accounts: {
        legacy: legacyAccount,
      },
      providers: {
        "legacy-proxy": legacyProvider,
      },
      devices: [],
      autoRefreshDeviceName: null,
    },
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: ["legacy"],
        providers: {},
        providerNames: ["legacy-proxy"],
        devices: [],
        autoRefreshDeviceName: null,
      },
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("legacy")).entryVersion, 4);
      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("legacy")).email, "legacy@example.com");
      assert.equal(mocked.globalStateValues.get(getSyncedCloudProviderKey("legacy-proxy")).entryVersion, 5);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["legacy"]);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["legacy-proxy"]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate does not overwrite existing per-entry keys with aggregate legacy payloads", async () => {
  const staleAccount = makeAuthFile("acct-stale", { email: "stale@example.com" });
  const freshAccount = makeAuthFile("acct-fresh", { email: "fresh@example.com" });
  const staleProvider = {
    kind: "provider",
    name: "proxy",
    auth: { OPENAI_API_KEY: "sk-stale" },
    config: {
      name: "proxy",
      base_url: "https://stale.example.com/v1",
      wire_api: "responses",
    },
  };
  const freshProvider = {
    ...staleProvider,
    auth: { OPENAI_API_KEY: "sk-fresh" },
    config: {
      ...staleProvider.config,
      base_url: "https://fresh.example.com/v1",
    },
  };
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          sync: staleAccount,
        },
        accountNames: ["sync"],
        providers: {
          proxy: staleProvider,
        },
        providerNames: ["proxy"],
        devices: [],
        autoRefreshDeviceName: null,
      },
      [getSyncedCloudAccountKey("sync")]: freshAccount,
      [getSyncedCloudProviderKey("proxy")]: freshProvider,
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudAccountKey("sync")), {
        ...freshAccount,
        email: "fresh@example.com",
      });
      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudProviderKey("proxy")), freshProvider);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providers, {});

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("forget storage password removes the local secret and locks encrypted saved auth again", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-storage-forget-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("secret-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "secret-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.forgetStoragePassword")();

        await mocked.registeredCommands.get("codex-routesync.useAccount")({
          account: { name: "work" },
        });

        assert.match(mocked.warningMessages.at(-1)?.message ?? "", /remains locked/i);
        assert.equal(mocked.secretState.has(STORAGE_SECRET_KEY), false);
        assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }
});

test("locked cloud account uses public email from the account entry", async () => {
  try {
    core.setSavedAuthPassphrase("public-email-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-public", {
      email: "public@example.com",
    }), {
      requireEncryption: true,
    });
    cloudEntry.email = "public@example.com";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");
        const emailItem = getAccountDetailItems(accountTreeView.treeDataProvider, cloudItem)
          .find((item) => item.label === "Email");

        assert.equal(cloudItem.account.storageState, "locked");
        assert.equal(cloudItem.account.publicEmail, "public@example.com");
        assert.equal(emailItem?.description, "public@example.com");
        assert.match(cloudItem.tooltip, /Email: public@example\.com/);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
  }
});

test("unlocked legacy cloud account backfills public email without changing sync metadata", async () => {
  try {
    core.setSavedAuthPassphrase("backfill-email-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-backfill", {
      email: "backfill@example.com",
    }), {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 7;
    cloudEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "backfill-email-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const storedEntry = mocked.globalStateValues.get(getSyncedCloudAccountKey("sync-user"));
        assert.equal(storedEntry.email, "backfill@example.com");
        assert.equal(storedEntry.entryVersion, 7);
        assert.equal(storedEntry.updatedAt, "2026-05-01T00:00:00.000Z");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
  }
});

test("unlock command restores access to locked cloud accounts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-storage-unlock-command-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("unlock-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      inputBoxResponses: [undefined, "unlock-passphrase"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [lockedItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user");

        assert.equal(lockedItem.account.storageState, "locked");
        assert.equal(lockedItem.contextValue, "accountCloudLocked");

        await mocked.registeredCommands.get("codex-routesync.unlockStorage")();

        const [unlockedItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user");

        assert.equal(mocked.secretState.get(STORAGE_SECRET_KEY), "unlock-passphrase");
        assert.equal(unlockedItem.account.storageState, "ready");
        assert.match(
          mocked.informationMessages.at(-1)?.message ?? "",
          /saved auth storage is unlocked/i
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }
});

test("useAccount prompts again to unlock locked cloud auth after activation was skipped", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-storage-unlock-use-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("unlock-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      inputBoxResponses: [undefined, "unlock-passphrase"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [lockedItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(lockedItem);

        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(currentAuth.tokens.account_id, "acct-sync");
        assert.equal(mocked.secretState.get(STORAGE_SECRET_KEY), "unlock-passphrase");
        assert.equal(mocked.errorMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }
});

test("addAccount can save to synced settings when cloud storage is selected", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-cloud-account-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-cloud"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: ["sync-user", "cloud-passphrase", "cloud-passphrase"],
      warningResponses: ["Login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-cloud"));
          return "Done";
        },
        "Later",
      ],
      defaultSaveTarget: "cloud",
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.addAccount")();

        const syncedEntry = mocked.config.syncedStorage.accounts["sync-user"];
        assert.equal(typeof syncedEntry, "object");
        assert.equal(typeof syncedEntry.ciphertext, "string");
        assert.equal(syncedEntry.entryVersion, 1);
        assert.match(syncedEntry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(fs.existsSync(path.join(authDir, "auth_sync-user.json")), false);
        assert.equal(mocked.secretState.get(STORAGE_SECRET_KEY), "cloud-passphrase");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addAccount to cloud fails when the payload cannot be verified after write", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-cloud-account-unverified-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-cloud"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: ["sync-user", "cloud-passphrase", "cloud-passphrase"],
      warningResponses: ["Login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-cloud"));
          return "Done";
        },
      ],
      defaultSaveTarget: "cloud",
      afterGlobalStateUpdate(key, value, state) {
        if (key === getSyncedCloudAccountKey("sync-user") && value !== undefined) {
          state.globalStateValues.delete(key);
        }
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.addAccount")();

        assert.equal(mocked.config.syncedStorage.accounts["sync-user"], undefined);
        assert.equal(fs.existsSync(path.join(authDir, "auth_sync-user.json")), false);
        assert.equal(fs.existsSync(getProtectedCloudAccountBackupPath(mocked, "sync-user")), true);
        assert.match(
          [
            mocked.errorMessages.at(-1)?.message ?? "",
            mocked.warningMessages.at(-1)?.message ?? "",
            ...mocked.informationMessages.map((entry) => entry.message),
          ].join("\n"),
          /could not be verified/i,
        );
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes('Account "sync-user" was saved to cloud storage')),
          false,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("reloginAccount updates an active local account and marks reload recommended", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-active-local-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousAuth = makeAuthFile("acct-active", {
    accessToken: "access-old",
    refreshToken: "refresh-old",
  });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), previousAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(previousAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "statusBar",
      showStatusBar: true,
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "active",
          source: "local",
        },
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-active", {
            accessToken: "access-new",
            refreshToken: "refresh-new",
          }));
          return "Done";
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "active" && item.account.source === "local");
        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);
        await waitForRefreshCoordinatorIdle(context);

        const terminalHome = mocked.createdTerminals.at(-1)?.options?.env?.CODEX_HOME;
        assert.equal(typeof terminalHome, "string");
        assert.notEqual(terminalHome, codexHome);
        assert.equal(mocked.createdTerminals.at(-1)?.disposed, true);
        assert.equal(fs.existsSync(terminalHome), false);
        const savedAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_active.json"), "utf-8"));
        const liveAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-new");
        assert.equal(savedAuth.tokens.refresh_token, "refresh-new");
        assert.equal(liveAuth.tokens.access_token, "access-new");
        assert.equal(liveAuth.tokens.refresh_token, "refresh-new");
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), {
          kind: "account",
          name: "active",
          source: "local",
        });
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          0,
        );
        const statusBarManager = context.subscriptions.find(
          (subscription) => typeof subscription?.getReloadRecommendation === "function",
        );
        assert.ok(statusBarManager);
        const recommendation = statusBarManager.getReloadRecommendation();
        assert.equal(recommendation.recommended, true);
        assert.match(recommendation.reason ?? "", /account "active"/i);
        const reloadItem = mocked.createdStatusBarItems.find(
          (item) => item.command === "codex-routesync.reloadWindow",
        );
        assert.ok(reloadItem);
        assert.equal(reloadItem.visible, true);
        assert.equal(mocked.errorMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount removes its transient home when startup logging fails", async (t) => {
  const { tempRoot, codexHome, authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-relogin-log-failure-",
  );
  const loginTempParent = path.join(tempRoot, "login-temp");
  fs.mkdirSync(loginTempParent, { recursive: true });
  const auth = makeAuthFile("acct-active", { accessToken: "access-old", refreshToken: "refresh-old" });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), auth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");

  const mocked = createVscodeMock({
    authDirectory: authDir,
    warningResponses: ["Re-login"],
    outputChannelInfoThrowsOn: "login-terminal-started",
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      const accountTreeView = getAccountTreeView(mocked);
      const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "active" && item.account.source === "local");
      const previousTmpdir = os.tmpdir;
      os.tmpdir = () => loginTempParent;
      try {
        await assert.rejects(
          mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem),
          /output channel write failed/,
        );
      } finally {
        os.tmpdir = previousTmpdir;
      }

      assert.equal(mocked.createdTerminals.length, 0);
      assert.deepEqual(fs.readdirSync(loginTempParent), []);
      for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("reloginAccount activation does not asynchronously rewrite the current selection marker", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-marker-race-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const oldAuth = makeAuthFile("acct-a", {
    accessToken: "access-a-old",
    refreshToken: "refresh-a-old",
  });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_a.json"), oldAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(oldAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  let armed = false;
  let markerWritesAfterLogin = 0;
  try {
    const currentSelectionKey = "codex-switchbridge.currentSavedSelection";
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "never",
      globalStateValues: {
        [currentSelectionKey]: { kind: "account", name: "a", source: "local" },
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-a", {
            accessToken: "access-a-new",
            refreshToken: "refresh-a-new",
          }));
          armed = true;
          return "Done";
        },
      ],
      afterGlobalStateUpdate(key) {
        if (armed && key === currentSelectionKey) {
          markerWritesAfterLogin += 1;
        }
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const accountTreeView = getAccountTreeView(mocked);
        const [accountAItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "a" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountAItem);
        await waitForRefreshCoordinatorIdle(context);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_a.json"), "utf-8"));
        const liveAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-a-new");
        assert.equal(liveAuth.tokens.access_token, "access-a-new");
        assert.equal(markerWritesAfterLogin, 0);
        assert.deepEqual(mocked.globalStateValues.get(currentSelectionKey), {
          kind: "account",
          name: "a",
          source: "local",
        });

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount does not activate or reload when selection changes while login is open", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-activation-race-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const accountAOldAuth = makeAuthFile("acct-a", {
    accessToken: "access-a-old",
    refreshToken: "refresh-a-old",
  });
  const accountBAuth = makeAuthFile("acct-b", {
    accessToken: "access-b",
    refreshToken: "refresh-b",
  });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_a.json"), accountAOldAuth);
  core.writeSavedAuthFile(path.join(authDir, "auth_b.json"), accountBAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(accountAOldAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const currentSelectionKey = "codex-switchbridge.currentSavedSelection";
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      globalStateValues: {
        [currentSelectionKey]: { kind: "account", name: "a", source: "local" },
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-a", {
            accessToken: "access-a-new",
            refreshToken: "refresh-a-new",
          }));
          core.activateAccountAuth(accountBAuth, {
            source: "test-race",
            target: "account:local:b",
          });
          mocked.globalStateValues.set(currentSelectionKey, {
            kind: "account",
            name: "b",
            source: "local",
          });
          return "Done";
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const accountTreeView = getAccountTreeView(mocked);
        const [accountAItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "a" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountAItem);
        await waitForRefreshCoordinatorIdle(context);

        const savedAccountA = JSON.parse(fs.readFileSync(path.join(authDir, "auth_a.json"), "utf-8"));
        const liveAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAccountA.tokens.access_token, "access-a-new");
        assert.equal(savedAccountA.tokens.refresh_token, "refresh-a-new");
        assert.equal(liveAuth.tokens.account_id, "acct-b");
        assert.equal(liveAuth.tokens.access_token, "access-b");
        assert.deepEqual(mocked.globalStateValues.get(currentSelectionKey), {
          kind: "account",
          name: "b",
          source: "local",
        });
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          0,
        );

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount activates cloud auth, safely defers marker reconciliation, and reloads once", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-active-cloud-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const passphrase = "active-cloud-passphrase";
  const oldAuth = makeAuthFile("acct-cloud", { accessToken: "access-old", refreshToken: "refresh-old" });
  core.setSavedAuthPassphrase(passphrase);
  const cloudEntry = core.serializeSavedValue("saved_auth", oldAuth, { requireEncryption: true });
  cloudEntry.entryVersion = 1;
  cloudEntry.updatedAt = "2026-08-01T00:00:00.000Z";
  core.setSavedAuthPassphrase(null);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(oldAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      secretValues: { [STORAGE_SECRET_KEY]: passphrase },
      syncedStorage: { version: 1, accounts: { cloud: cloudEntry }, providers: {} },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "cloud",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-cloud", {
            accessToken: "access-new",
            refreshToken: "refresh-new",
          }));
          return "Done";
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "cloud" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);

        const savedAuth = readCloudAccount(mocked.config, "cloud", passphrase);
        const liveAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const envelope = getCloudEnvelope(mocked.config, "account", "cloud");
        const markerBeforeReconcile = mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection");
        assert.equal(savedAuth.tokens.access_token, "access-new");
        assert.equal(liveAuth.tokens.access_token, "access-new");
        assert.equal(envelope.entryVersion, 2);
        assert.equal(markerBeforeReconcile?.kind, "account");
        assert.equal(markerBeforeReconcile?.name, "cloud");
        assert.equal(markerBeforeReconcile?.source, "cloud");
        assert.equal(markerBeforeReconcile?.entryVersion, 1);
        assert.equal(markerBeforeReconcile?.updatedAt, "2026-08-01T00:00:00.000Z");
        assert.notEqual(mocked.createdTerminals.at(-1)?.options?.env?.CODEX_HOME, codexHome);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 1);
        assert.equal(mocked.errorMessages.length, 0);

        await mocked.registeredCommands.get("codex-routesync.useAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);
        const markerAfterReconcile = mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection");
        assert.equal(markerAfterReconcile?.entryVersion, envelope.entryVersion);
        assert.equal(markerAfterReconcile?.updatedAt, envelope.updatedAt);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 1);

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount rejects a different identity without changing saved or runtime state", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-identity-mismatch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const auth = makeAuthFile("acct-active", { accessToken: "access-old", refreshToken: "refresh-old" });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), auth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-other", {
            accessToken: "access-other",
            refreshToken: "refresh-other",
          }));
          return "Done";
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const savedBefore = fs.readFileSync(path.join(authDir, "auth_active.json"));
        const liveBefore = fs.readFileSync(path.join(codexHome, "auth.json"));
        const markerBefore = structuredClone(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"));
        const routeBefore = structuredClone(core.getSharedHistoryRouteState());
        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "active" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);

        const transientTerminal = mocked.createdTerminals.at(-1);
        assert.equal(transientTerminal?.disposed, true);
        assert.equal(fs.existsSync(transientTerminal?.options?.env?.CODEX_HOME), false);
        assert.deepEqual(fs.readFileSync(path.join(authDir, "auth_active.json")), savedBefore);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "auth.json")), liveBefore);
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), markerBefore);
        assert.deepEqual(core.getSharedHistoryRouteState(), routeBefore);
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /different account|overwrite was rejected/i);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 0);

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount rejects a cloud login result without a stable identity", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-cloud-missing-identity-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const passphrase = "missing-identity-passphrase";
  const auth = makeAuthFile("acct-cloud", { accessToken: "access-old", refreshToken: "refresh-old" });
  core.setSavedAuthPassphrase(passphrase);
  const cloudEntry = core.serializeSavedValue("saved_auth", auth, { requireEncryption: true });
  core.setSavedAuthPassphrase(null);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      secretValues: { [STORAGE_SECRET_KEY]: passphrase },
      syncedStorage: { version: 1, accounts: { cloud: cloudEntry }, providers: {} },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, {
            tokens: {
              access_token: "access-without-identity",
              refresh_token: "refresh-without-identity",
            },
          });
          return "Done";
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const savedBefore = structuredClone(getCloudEnvelope(mocked.config, "account", "cloud"));
        const liveBefore = fs.readFileSync(path.join(codexHome, "auth.json"));
        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "cloud" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);

        assert.deepEqual(getCloudEnvelope(mocked.config, "account", "cloud"), savedBefore);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "auth.json")), liveBefore);
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /stable identity|identity/i);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 0);

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount reports an activation failure after saving refreshed auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-activation-failure-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const oldAuth = makeAuthFile("acct-active", { accessToken: "access-old", refreshToken: "refresh-old" });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), oldAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(oldAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "active",
          source: "local",
        },
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-active", {
            accessToken: "access-new",
            refreshToken: "refresh-new",
          }));
          fs.writeFileSync(path.join(codexHome, "switchbridge-shared-history.json"), "{invalid", "utf-8");
          return "Done";
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "active" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);
        await waitForRefreshCoordinatorIdle(context);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_active.json"), "utf-8"));
        const liveAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-new");
        assert.equal(liveAuth.tokens.access_token, "access-old");
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /saved.*activat|activat.*failed/i);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 0);

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
        fs.rmSync(path.join(codexHome, "switchbridge-shared-history.json"), { force: true });
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount leaves state unchanged when Done has no transient auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-missing-auth-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const auth = makeAuthFile("acct-active", { accessToken: "access-old", refreshToken: "refresh-old" });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), auth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      warningResponses: ["Re-login"],
      infoResponses: ["Done"],
    });
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const savedBefore = fs.readFileSync(path.join(authDir, "auth_active.json"));
        const liveBefore = fs.readFileSync(path.join(codexHome, "auth.json"));
        const markerBefore = structuredClone(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"));
        const routeBefore = structuredClone(core.getSharedHistoryRouteState());

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "active" && item.account.source === "local");
        const originalSetTimeout = global.setTimeout;
        const originalDateNow = Date.now;
        let fakeNow = 0;
        global.setTimeout = (callback, delay, ...args) => {
          fakeNow += delay;
          queueMicrotask(() => callback(...args));
          return { __mockAuthWaitTimeout: true };
        };
        Date.now = () => fakeNow;
        try {
          await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);
        } finally {
          global.setTimeout = originalSetTimeout;
          Date.now = originalDateNow;
        }

        const transientTerminal = mocked.createdTerminals.at(-1);
        assert.equal(transientTerminal?.disposed, true);
        assert.equal(fs.existsSync(transientTerminal?.options?.env?.CODEX_HOME), false);
        assert.deepEqual(fs.readFileSync(path.join(authDir, "auth_active.json")), savedBefore);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "auth.json")), liveBefore);
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), markerBefore);
        assert.deepEqual(core.getSharedHistoryRouteState(), routeBefore);
        assert.match(
          mocked.errorMessages.at(-1)?.message ?? "",
          /did not write auth\.json within 30 seconds/i,
        );
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          0,
        );

        for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousNamedAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
  }

  await t.test("cleanup", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
});

test("reloginAccount updates an inactive cloud account without changing the active selection or reloading", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-relogin-cloud-globalstate-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), makeAuthFile("acct-active", {
    accessToken: "access-active-saved",
    refreshToken: "refresh-active-saved",
  }));
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-active", {
      accessToken: "access-active-current",
      refreshToken: "refresh-active-current",
    }), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.setSavedAuthPassphrase("cloud-passphrase");
    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-passphrase",
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          fs.writeFileSync(
            path.join(mocked.createdTerminals.at(-1).options.env.CODEX_HOME, "auth.json"),
            JSON.stringify(makeAuthFile("acct-cloud", {
              accessToken: "access-new",
              refreshToken: "refresh-new",
            }), null, 2),
            "utf-8"
          );
          return "Done";
        },
      ],
      syncedStorage: {
        version: 1,
        accounts: {
          cloud: core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud", {
            accessToken: "access-old",
            refreshToken: "refresh-old",
          }), {
            requireEncryption: true,
          }),
        },
        providers: {},
        devices: [],
        autoRefreshDeviceName: null,
      },
      configurationUpdateErrors: {
        syncedStorage: new Error("settings.json is locked"),
      },
    });
    core.setSavedAuthPassphrase(null);

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "cloud" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);

        const updated = readCloudAccount(mocked.config, "cloud", "cloud-passphrase");
        assert.equal(updated.tokens.access_token, "access-new");
        assert.equal(updated.tokens.refresh_token, "refresh-new");
        const activeAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(activeAuth.tokens.account_id, "acct-active");
        assert.equal(
          mocked.executedCommands.some((entry) => entry.name === "workbench.action.reloadWindow"),
          false,
        );
        assert.equal(
          mocked.informationMessages.some(({ actions }) => actions.includes("Reload") || actions.includes("Later")),
          false,
        );
        assert.equal(
          mocked.informationMessages.some(({ message }) =>
            message.includes("Account \"cloud\" was updated") && message.includes("Active selection stayed on \"active (local)\"")
          ),
          true,
        );
        assert.equal(mocked.errorMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("legacy cloud account upgrades with visible sync metadata on manual refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-legacy-upgrade-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("legacy-passphrase");
    const legacyEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
        lastRefresh: new Date().toISOString(),
      }),
      {
        requireEncryption: true,
      }
    );
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": legacyEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "legacy-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

        const syncedEntry = getCloudEnvelope(mocked.config, "account", "sync-user");
        assert.equal(syncedEntry.entryVersion, 1);
        assert.match(syncedEntry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

        const cloudAuth = readCloudAccount(mocked.config, "sync-user", "legacy-passphrase");
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("a delayed cloud-account refresh cannot overwrite a committed provider switch", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-refresh-switch-race-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const updatedAt = "2026-04-01T00:00:00.000Z";
  const accountAuth = makeAuthFile("acct-cloud", {
    accessToken: "access-cloud-current",
    refreshToken: "refresh-cloud-current",
    lastRefresh: updatedAt,
    extraFields: { [AUTH_UPDATED_AT_FIELD]: updatedAt },
  });

  try {
    core.setSavedAuthPassphrase("race-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", accountAuth, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 1;
    cloudEntry.updatedAt = updatedAt;
    core.setSavedAuthPassphrase(null);
    core.writeCurrentAuth(accountAuth);

    const mocked = createVscodeMock({
      showStatusBar: false,
      secretValues: {
        [STORAGE_SECRET_KEY]: "race-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: { work: cloudEntry },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "work",
          source: "cloud",
          entryVersion: 1,
          updatedAt,
        },
      },
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      const accountTreeView = getAccountTreeView(mocked);
      const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "work" && item.account.source === "cloud");
      assert.ok(cloudItem);

      const originalRequest = https.request;
      let resolveRequestStarted;
      const requestStarted = new Promise((resolve) => {
        resolveRequestStarted = resolve;
      });
      let releaseResponse;
      const responseReleased = new Promise((resolve) => {
        releaseResponse = resolve;
      });
      https.request = (requestOptions, handler) => {
        const response = new EventEmitter();
        response.statusCode = 200;
        const request = new EventEmitter();
        let body = "";
        request.setTimeout = () => request;
        request.destroy = () => {};
        request.write = (chunk) => {
          body += chunk;
        };
        request.end = () => {
          assert.equal(requestOptions.hostname, "auth.openai.com");
          assert.match(body, /refresh_token=refresh-cloud-current/);
          handler(response);
          resolveRequestStarted();
          void responseReleased.then(() => {
            response.emit("data", JSON.stringify({
              access_token: "access-cloud-rotated",
              refresh_token: "refresh-cloud-rotated",
              id_token: accountAuth.tokens.id_token,
            }));
            response.emit("end");
          });
        };
        return request;
      };

      try {
        const refreshPromise = mocked.registeredCommands
          .get("codex-routesync.refreshToken")(cloudItem);
        await requestStarted;
        core.activateProviderProfile(
          {
            kind: "provider",
            name: "proxy",
            auth: { OPENAI_API_KEY: "provider-secret" },
            config: {
              name: "proxy",
              base_url: "https://proxy.example/v1",
              wire_api: "responses",
            },
          },
          {
            shareHistoryAcrossProviders: true,
            source: "account:cloud:work",
            target: "provider:local:proxy",
          },
        );
        releaseResponse();
        await refreshPromise;
      } finally {
        releaseResponse?.();
        https.request = originalRequest;
      }

      const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
      assert.deepEqual(currentAuth, { OPENAI_API_KEY: "provider-secret" });
      assert.equal(core.getSharedHistoryRouteState()?.activeProvider, "proxy");
      assert.deepEqual(core.getOpenAIBaseUrlSnapshot(), {
        present: true,
        value: "https://proxy.example/v1",
      });
      const refreshedCloudAuth = readCloudAccount(mocked.config, "work", "race-passphrase");
      assert.equal(refreshedCloudAuth.tokens.access_token, "access-cloud-rotated");
      assert.equal(refreshedCloudAuth.tokens.refresh_token, "refresh-cloud-rotated");

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual cloud refresh increments visible sync version metadata", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-version-increment-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("increment-passphrase");
    const syncedEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
        lastRefresh: new Date().toISOString(),
      }),
      {
        requireEncryption: true,
      }
    );
    syncedEntry.entryVersion = 1;
    syncedEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    const siblingEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-sibling", {
        accessToken: "access-sibling-old",
        refreshToken: "refresh-sibling-old",
      }),
      {
        requireEncryption: true,
      }
    );
    siblingEntry.entryVersion = 5;
    siblingEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": syncedEntry,
          sibling: siblingEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "increment-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

        const nextEntry = getCloudEnvelope(mocked.config, "account", "sync-user");
        assert.equal(nextEntry.entryVersion, 2);
        assert.notEqual(nextEntry.updatedAt, "2026-04-01T00:00:00.000Z");
        assert.match(nextEntry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
        const nextSibling = getCloudEnvelope(mocked.config, "account", "sibling");
        assert.equal(nextSibling.entryVersion, 5);
        assert.equal(nextSibling.updatedAt, "2026-04-02T00:00:00.000Z");
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sync-user"))?.ciphertext, "string");
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sibling"))?.ciphertext, "string");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("switching identical account auth from local to cloud updates selection without reloading", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-identical-account-source-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "identical-account-passphrase";
    const auth = makeAuthFile("acct-identical", {
      accessToken: "access-identical",
      refreshToken: "refresh-identical",
    });
    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_same.json"), auth);
    const cloudEntry = core.serializeSavedValue("saved_auth", auth, { requireEncryption: true });
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");

    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: { same: cloudEntry },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "same",
          source: "local",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "same" && item.account.source === "cloud");
        await mocked.registeredCommands.get("codex-routesync.useAccount")(cloudItem);

        assert.equal(
          mocked.executedCommands.some((entry) => entry.name === "workbench.action.reloadWindow"),
          false,
        );
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), {
          kind: "account",
          name: "same",
          source: "cloud",
          entryVersion: null,
          updatedAt: null,
        });
        const currentCloudItem = getAccountTreeItems(accountTreeView.treeDataProvider)
          .find((item) => item.account.name === "same" && item.account.source === "cloud");
        assert.equal(currentCloudItem.account.isCurrent, true);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("switching identical provider profile from local to cloud updates selection without reloading", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-identical-provider-source-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "identical-provider-passphrase";
    const profile = {
      kind: "provider",
      name: "same-proxy",
      auth: { OPENAI_API_KEY: "sk-identical-provider" },
      config: {
        name: "same-proxy",
        base_url: "https://same.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(profile);
    const cloudEntry = core.serializeSavedValue("saved_provider", profile, { requireEncryption: true });
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    core.activateProviderProfile(profile, {
      shareHistoryAcrossProviders: true,
      source: "test",
      target: "provider:local:same-proxy",
    });

    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      reloadWindowAfterSwitch: "always",
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: { "same-proxy": cloudEntry },
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "provider",
          name: "same-proxy",
          source: "local",
        },
      },
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const providerTreeView = getProviderTreeView(mocked);
      const [cloudItem] = providerTreeView.treeDataProvider
        .getChildren()
        .filter((item) => item.provider?.name === "same-proxy" && item.provider?.source === "cloud");
      await mocked.registeredCommands.get("codex-routesync.switchProvider")(cloudItem);

      assert.equal(
        mocked.executedCommands.some((entry) => entry.name === "workbench.action.reloadWindow"),
        false,
      );
      assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), {
        kind: "provider",
        name: "same-proxy",
        source: "cloud",
        entryVersion: null,
        updatedAt: null,
      });
      const currentCloudItem = providerTreeView.treeDataProvider
        .getChildren()
        .find((item) => item.provider?.name === "same-proxy" && item.provider?.source === "cloud");
      assert.equal(currentCloudItem.provider.isCurrent, true);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("shared history local provider syncs current auth before switching accounts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-shared-local-provider-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    const accountAuth = makeAuthFile("acct-alpha");
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), accountAuth);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(accountAuth, null, 2), "utf-8");
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      reloadWindowAfterSwitch: "statusBar",
      showStatusBar: true,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "proxy" && item.provider?.source === "local");

        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);

        const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
        assert.doesNotMatch(config, /^model_provider\s*=/m);
        assert.match(config, /^openai_base_url = "https:\/\/proxy\.example\.com\/v1"$/m);
        assert.equal(core.getSharedHistoryRouteState()?.activeProvider, "proxy");
        assert.equal(
          mocked.executedCommands.some((entry) => entry.name === "workbench.action.reloadWindow"),
          false,
        );
        assert.equal(
          mocked.informationMessages.some(({ actions }) => actions.includes("Reload") && actions.includes("Later")),
          false,
        );
        const reloadItem = mocked.createdStatusBarItems.find(
          (item) => item.command === "codex-routesync.reloadWindow",
        );
        assert.ok(reloadItem);
        const statusBarManager = context.subscriptions.find(
          (subscription) => typeof subscription?.getReloadRecommendation === "function",
        );
        assert.ok(statusBarManager);
        const reloadChanges = [];
        const reloadSubscription = statusBarManager.onDidChangeReloadRecommendation(
          (snapshot) => reloadChanges.push(snapshot),
        );
        assert.equal(reloadItem.visible, true);
        assert.match(reloadItem.text, /Reload recommended/);
        assert.match(statusBarManager.getReloadRecommendation().reason ?? "", /Switched to mode/);
        const dashboard = await mocked.readyDashboard();
        assert.equal(dashboard.latestState()?.reload.recommended, true);
        assert.match(dashboard.latestState()?.reload.message ?? "", /Switched to mode/);
        assert.equal(
          mocked.informationMessages.some(({ actions }) => actions.includes("Reload") && actions.includes("Later")),
          false,
        );
        const reloadShowCount = reloadItem.showCount;

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "alpha" && item.account.source === "local");
        assert.ok(accountItem);

        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({ OPENAI_API_KEY: "sk-proxy-refreshed" }, null, 2),
          "utf-8",
        );

        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);

        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8")),
          { OPENAI_API_KEY: "sk-proxy-refreshed" },
        );
        assert.equal(reloadItem.showCount, reloadShowCount);
        assert.deepEqual(reloadChanges, []);
        const providerAfterReselect = core.readProviderProfileResult("proxy");
        assert.equal(providerAfterReselect.status, "ok");
        assert.equal(providerAfterReselect.value.auth.OPENAI_API_KEY, "sk-proxy-refreshed");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(accountItem);

        assert.deepEqual(mocked.errorMessages, []);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8")).tokens?.account_id,
          "acct-alpha",
        );
        assert.equal(core.getSharedHistoryRouteState(), null);
        assert.deepEqual(core.getOpenAIBaseUrlSnapshot(), { present: false, value: null });
        assert.equal(reloadChanges.length, 1);
        assert.match(reloadChanges[0].reason ?? "", /Switched to account/);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(dashboard.latestState()?.reload.recommended, true);
        assert.match(dashboard.latestState()?.reload.message ?? "", /Switched to account/);
        reloadSubscription.dispose();
        const savedProvider = core.readProviderProfileResult("proxy");
        assert.equal(savedProvider.status, "ok");
        assert.equal(savedProvider.value.auth.OPENAI_API_KEY, "sk-proxy-refreshed");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("shared history cloud provider syncs its current auth before switching to an account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-shared-cloud-provider-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha"),
    );
    core.writeProviderProfile({
      kind: "provider",
      name: "cloud-proxy",
      auth: { OPENAI_API_KEY: "sk-local-same-name" },
      config: {
        name: "cloud-proxy",
        base_url: "https://local-same-name.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    const providerProfile = {
      kind: "provider",
      name: "cloud-proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-proxy" },
      config: {
        name: "cloud-proxy",
        base_url: "https://cloud-proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setSavedAuthPassphrase("shared-cloud-provider-passphrase");
    const encryptedProvider = core.serializeSavedValue("saved_provider", providerProfile, {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);
    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      reloadWindowAfterSwitch: "always",
      secretValues: {
        [STORAGE_SECRET_KEY]: "shared-cloud-provider-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          "cloud-proxy": encryptedProvider,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "cloud-proxy" && item.provider?.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);

        const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
        assert.doesNotMatch(config, /^model_provider\s*=/m);
        assert.match(config, /^openai_base_url = "https:\/\/cloud-proxy\.example\.com\/v1"$/m);
        assert.equal(core.getSharedHistoryRouteState()?.activeProvider, "cloud-proxy");
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          1,
        );

        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({ OPENAI_API_KEY: "sk-cloud-proxy-refreshed" }, null, 2),
          "utf-8",
        );

        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);

        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8")),
          { OPENAI_API_KEY: "sk-cloud-proxy-refreshed" },
        );
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          1,
        );
        const providerAfterReselect = readCloudProvider(
          mocked.config,
          "cloud-proxy",
          "shared-cloud-provider-passphrase",
        );
        assert.equal(providerAfterReselect.auth.OPENAI_API_KEY, "sk-cloud-proxy-refreshed");

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "alpha" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(accountItem);

        const savedProvider = readCloudProvider(
          mocked.config,
          "cloud-proxy",
          "shared-cloud-provider-passphrase",
        );
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-cloud-proxy-refreshed");
        core.setNamedAuthDir(authDir);
        const sameNameLocalProvider = core.readProviderProfileResult("cloud-proxy");
        core.setNamedAuthDir(undefined);
        assert.equal(sameNameLocalProvider.status, "ok");
        assert.equal(sameNameLocalProvider.value.auth.OPENAI_API_KEY, "sk-local-same-name");
        assert.equal(core.getSharedHistoryRouteState(), null);
        const currentAuth = JSON.parse(
          fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
        );
        assert.equal(currentAuth.tokens.account_id, "acct-alpha");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("Switch Mode Account Mode prompts for and activates a saved account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-switch-mode-account-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const alphaAuth = makeAuthFile("acct-alpha");
    const betaAuth = makeAuthFile("acct-beta", { email: "beta@example.com" });
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), alphaAuth);
    core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), betaAuth);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(alphaAuth, null, 2),
      "utf-8",
    );

    let accountModePrompted = false;
    let accountSelectionPrompted = false;
    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      reloadWindowAfterSwitch: "never",
      quickPickResponses: [
        (items) => {
          accountModePrompted = true;
          return items.find((item) => item.action === "switch" && item.provider === null);
        },
        (items) => {
          accountSelectionPrompted = true;
          return items.find((item) => item.account?.name === "beta");
        },
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "proxy" && item.provider?.source === "local");
        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8")),
          { OPENAI_API_KEY: "sk-proxy" },
        );

        await mocked.registeredCommands.get("codex-routesync.switchMode")();

        assert.equal(accountModePrompted, true);
        assert.equal(accountSelectionPrompted, true);
        const currentAuth = JSON.parse(
          fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
        );
        assert.equal(currentAuth.tokens.account_id, "acct-beta");
        assert.equal(currentAuth.OPENAI_API_KEY, undefined);
        assert.equal(core.getSharedHistoryRouteState(), null);
        assert.deepEqual(
          mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"),
          { kind: "account", name: "beta", source: "local" },
        );
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Switched to account "beta"')
            && entry.message.includes("beta@example.com")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("provider switches keep model_provider when shared history setting is disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-shared-disabled-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "proxy" && item.provider?.source === "local");

        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);

        const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
        assert.match(config, /^model_provider = "proxy"$/m);
        assert.doesNotMatch(config, /^openai_base_url\s*=/m);
        assert.equal(core.getSharedHistoryRouteState(), null);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("cancelled relogin leaves an active local provider byte-for-byte unchanged", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-shared-relogin-restore-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      warningResponses: ["Re-login"],
      infoResponses: ["Cancel"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "proxy" && item.provider?.source === "local");
        await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);
        assert.equal(core.getSharedHistoryRouteState()?.activeProvider, "proxy");
        const liveAuthBefore = fs.readFileSync(path.join(codexHome, "auth.json"));
        const configBefore = fs.readFileSync(path.join(codexHome, "config.toml"));
        const markerBefore = structuredClone(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"));
        const routeBefore = structuredClone(core.getSharedHistoryRouteState());
        core.setNamedAuthDir(authDir);
        const savedProviderBefore = structuredClone(core.readProviderProfileResult("proxy"));
        core.setNamedAuthDir(undefined);

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "alpha" && item.account.source === "local");
        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);

        assert.equal(mocked.informationMessages.some((entry) => entry.message.includes("Exited provider mode")), false);
        const terminalHome = mocked.createdTerminals.at(-1)?.options?.env?.CODEX_HOME;
        assert.equal(typeof terminalHome, "string");
        assert.notEqual(terminalHome, codexHome);
        assert.equal(mocked.createdTerminals.at(-1)?.disposed, true);
        assert.equal(fs.existsSync(terminalHome), false);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "auth.json")), liveAuthBefore);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "config.toml")), configBefore);
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), markerBefore);
        assert.deepEqual(core.getSharedHistoryRouteState(), routeBefore);
        core.setNamedAuthDir(authDir);
        const savedProviderAfter = core.readProviderProfileResult("proxy");
        core.setNamedAuthDir(undefined);
        assert.deepEqual(savedProviderAfter, savedProviderBefore);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("cancelled relogin leaves an active cloud provider and same-name local provider unchanged", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-relogin-source-aware-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const accountAuth = makeAuthFile("acct-alpha");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), accountAuth);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local-unchanged" },
      config: {
        name: "proxy",
        base_url: "https://local-proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(accountAuth, null, 2),
      "utf-8",
    );

    const cloudProfile = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-old" },
      config: {
        name: "proxy",
        base_url: "https://cloud-proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setSavedAuthPassphrase("cloud-relogin-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProfile, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 1;
    cloudEntry.updatedAt = "2026-08-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      warningResponses: ["Re-login"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-relogin-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: { proxy: cloudEntry },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [cloudProviderItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "proxy" && item.provider?.source === "cloud");
        await mocked.registeredCommands.get("codex-routesync.switchProvider")(cloudProviderItem);
        assert.equal(core.getSharedHistoryRouteState()?.activeProvider, "proxy");

        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({ OPENAI_API_KEY: "sk-cloud-rotated-before-login" }, null, 2),
          "utf-8",
        );
        const liveAuthBefore = fs.readFileSync(path.join(codexHome, "auth.json"));
        const configBefore = fs.readFileSync(path.join(codexHome, "config.toml"));
        const routeBefore = structuredClone(core.getSharedHistoryRouteState());
        const markerBefore = structuredClone(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"));
        const cloudProviderBefore = structuredClone(getCloudEnvelope(mocked.config, "provider", "proxy"));
        core.setNamedAuthDir(authDir);
        const localProviderBefore = structuredClone(core.readProviderProfileResult("proxy"));
        core.setNamedAuthDir(undefined);

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "alpha" && item.account.source === "local");
        await mocked.registeredCommands.get("codex-routesync.reloginAccount")(accountItem);

        const savedCloudProvider = readCloudProvider(mocked.config, "proxy", "cloud-relogin-passphrase");
        assert.equal(savedCloudProvider.auth.OPENAI_API_KEY, "sk-cloud-old");
        assert.deepEqual(getCloudEnvelope(mocked.config, "provider", "proxy"), cloudProviderBefore);
        core.setNamedAuthDir(authDir);
        const savedLocalProvider = core.readProviderProfileResult("proxy");
        core.setNamedAuthDir(undefined);
        assert.deepEqual(savedLocalProvider, localProviderBefore);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "auth.json")), liveAuthBefore);
        assert.deepEqual(fs.readFileSync(path.join(codexHome, "config.toml")), configBefore);
        assert.deepEqual(core.getSharedHistoryRouteState(), routeBefore);
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), markerBefore);
        const terminalHome = mocked.createdTerminals.at(-1)?.options?.env?.CODEX_HOME;
        assert.equal(typeof terminalHome, "string");
        assert.notEqual(terminalHome, codexHome);
        assert.equal(mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length, 0);
        assert.equal(mocked.errorMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("syncing stale active cloud auth does not overwrite newer cloud auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-auth-newer-wins-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = authDir;

  try {
    const staleAuthTime = "2026-06-01T09:00:00.000Z";
    const freshAuthTime = "2026-06-01T10:00:00.000Z";
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-apple1", {
        accessToken: "access-apple-stale",
        refreshToken: "refresh-apple-stale",
        extraFields: {
          [AUTH_UPDATED_AT_FIELD]: staleAuthTime,
        },
      }), null, 2),
      "utf-8"
    );
    core.writeSavedAuthFile(path.join(authDir, "auth_local.json"), makeAuthFile("acct-local"));

    core.setSavedAuthPassphrase("newer-wins-passphrase");
    const freshCloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-apple1", {
        accessToken: "access-apple-fresh",
        refreshToken: "refresh-apple-fresh",
        extraFields: {
          [AUTH_UPDATED_AT_FIELD]: freshAuthTime,
        },
      }),
      {
        requireEncryption: true,
      }
    );
    freshCloudEntry.entryVersion = 2;
    freshCloudEntry.updatedAt = freshAuthTime;
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          apple1: freshCloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "apple1",
          source: "cloud",
          entryVersion: 1,
          updatedAt: staleAuthTime,
        },
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "newer-wins-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        const cloudAuth = readCloudAccount(mocked.config, "apple1", "newer-wins-passphrase");
        assert.equal(cloudAuth.tokens.access_token, "access-apple-fresh");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-apple-fresh");
        assert.equal(cloudAuth[AUTH_UPDATED_AT_FIELD], freshAuthTime);

        const cloudEntry = getCloudEnvelope(mocked.config, "account", "apple1");
        assert.equal(cloudEntry.entryVersion, 2);
        assert.equal(cloudEntry.updatedAt, freshAuthTime);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});


test("aggregate globalState cloud accounts materialize before single-account refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-aggregate-materialize-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("aggregate-passphrase");
    const syncedEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
        lastRefresh: new Date().toISOString(),
      }),
      {
        requireEncryption: true,
      }
    );
    syncedEntry.entryVersion = 1;
    syncedEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    const siblingEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-sibling", {
        accessToken: "access-sibling-old",
        refreshToken: "refresh-sibling-old",
      }),
      {
        requireEncryption: true,
      }
    );
    siblingEntry.entryVersion = 5;
    siblingEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      globalStateValues: {
        [SYNCED_CLOUD_STATE_KEY]: {
          version: 1,
          accounts: {
            "sync-user": syncedEntry,
            sibling: siblingEntry,
          },
          accountNames: ["sibling", "sync-user"],
          providers: {},
          devices: [],
          autoRefreshDeviceName: null,
        },
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "aggregate-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

        const nextEntry = getCloudEnvelope(mocked.config, "account", "sync-user");
        assert.equal(nextEntry.entryVersion, 2);
        assert.notEqual(nextEntry.updatedAt, "2026-04-01T00:00:00.000Z");

        const nextSibling = getCloudEnvelope(mocked.config, "account", "sibling");
        assert.equal(nextSibling.entryVersion, 5);
        assert.equal(nextSibling.updatedAt, "2026-04-02T00:00:00.000Z");

        const siblingAuth = readCloudAccount(mocked.config, "sibling", "aggregate-passphrase");
        assert.equal(siblingAuth.tokens.access_token, "access-sibling-old");
        assert.equal(siblingAuth.tokens.refresh_token, "refresh-sibling-old");

        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sync-user"))?.ciphertext, "string");
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sibling"))?.ciphertext, "string");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("cloud account tooltip keeps sync metadata while hiding redundant detail fields", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-account-tooltip-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("tooltip-passphrase");
    const syncedEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-tooltip"), {
      requireEncryption: true,
    });
    syncedEntry.entryVersion = 3;
    syncedEntry.updatedAt = "2026-04-05T06:07:08.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      secretValues: {
        [STORAGE_SECRET_KEY]: "tooltip-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          tooltip: syncedEntry,
        },
        providers: {},
      },
    });

    await withMockedHostname("device-tooltip", async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider);
          const details = getAccountDetailItems(accountTreeView.treeDataProvider, cloudItem);

          assert.match(String(cloudItem.tooltip ?? ""), /Sync version: 3/);
          assert.match(String(cloudItem.tooltip ?? ""), /Updated: 2026-04-05T06:07:08.000Z/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Source:/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Current device:/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Auto-refresh/);
          assert.equal(details.some((item) => item.label === "Source"), false);
          assert.equal(details.some((item) => item.label === "Current device"), false);
          assert.equal(details.some((item) => item.label.startsWith("Auto-refresh")), false);
          assert.equal(details.some((item) => item.label === "Sync version"), true);
          assert.equal(details.some((item) => item.label === "Updated"), true);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account details hide last refresh and support copying email", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-detail-refresh-copy-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const lastRefresh = "2026-04-09T09:54:28.060Z";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_ryanwalker.json"),
      makeAuthFile("acct-ryanwalker", {
        email: "ryanwalker@example.com",
        plan: "free",
        lastRefresh,
      })
    );
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "ryanwalker" && item.account.source === "local");
        const details = getAccountDetailItems(accountTreeView.treeDataProvider, accountItem);
        const emailItem = details.find((item) => item.label === "Email");

        assert.equal(emailItem?.contextValue, "accountCopyableField");
        assert.equal(emailItem?.description, "ryanwalker@example.com");
        assert.equal(details.some((item) => item.label === "Source"), false);
        assert.equal(details.some((item) => item.label === "Last refresh"), false);
        assert.doesNotMatch(String(accountItem.tooltip ?? ""), /Last refresh:/);
        assert.equal(details.some((item) => item.label === "Refresh token"), false);

        await mocked.registeredCommands.get("codex-routesync.copyAccountField")(emailItem);

        assert.deepEqual(mocked.clipboardWrites, ["ryanwalker@example.com"]);
        assert.match(mocked.informationMessages.at(-1)?.message ?? "", /copied email/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refresh quota command writes command, account tree, and status bar performance logs", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-refresh-quota-perf-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_perf-user.json"),
      makeAuthFile("acct-perf-user", {
        email: "perf-user@example.com",
        plan: "plus",
        lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-perf-user", {
          email: "perf-user@example.com",
          plan: "plus",
        }),
        null,
        2
      ),
      "utf-8"
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const quotaStores = context.subscriptions.filter((subscription) =>
          typeof subscription?.getSnapshot === "function"
          && typeof subscription?.reconcileAccounts === "function"
          && typeof subscription?.refreshQuota === "function"
          && typeof subscription?.markReloginRequired === "function"
        );
        assert.equal(quotaStores.length, 1);

        await mocked.registeredCommands.get("codex-routesync.refreshQuota")();
        await waitForRefreshCoordinatorIdle(context);

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"durationMs\":")),
          true
        );
        assert.equal(
          lines.some((line) => line.includes("[codex-switchbridge:vscode:quotaStore]") && line.includes("\"operation\":\"quotaStore.refreshQuota\"")),
          true
        );
        assert.equal(
          lines.some((line) => line.includes("[codex-switchbridge:vscode:statusBar]") && line.includes("\"operation\":\"statusBar.refreshNow\"")),
          true
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refresh command tolerates non-account context payloads", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-refresh-command-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: false,
      cloudTokenAutoUpdate: false,
      quickPickResponses: [
        (items) => {
          const refreshToken = items.find((item) => item.label === "Refresh Token");
          const refreshQuota = items.find((item) => item.label === "Refresh Quota");
          assert.equal(refreshToken?.description, "Select an account or All to refresh token and quota");
          assert.equal(refreshQuota?.description, "Refresh quota for all accounts");
          return items[0];
        },
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      await mocked.registeredCommands.get("codex-routesync.refresh")({});
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(mocked.errorMessages.length, 0);
      assert.equal(
        mocked.executedCommands.some((entry) => entry.name === "codex-routesync.refreshList"),
        true,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refreshToken command offers All and refreshes every saved account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-refresh-token-all-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", {
        accessToken: "access-alpha-old",
        refreshToken: "refresh-alpha-old",
      })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", {
        accessToken: "access-beta-old",
        refreshToken: "refresh-beta-old",
      })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-alpha", {
          accessToken: "access-alpha-old",
          refreshToken: "refresh-alpha-old",
        }),
        null,
        2
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      proxy: "http://127.0.0.1:5128",
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
      quickPickResponses: [
        (items) => {
          const allItem = items.find((item) => item.label === "All");
          assert.ok(allItem);
          assert.equal(allItem.description, "Refresh token and quota for all accounts");
          return allItem;
        },
      ],
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-routesync.refreshToken")();
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countAuthRefreshRequests(requestLog), 2);
        assert.equal(countUsageRequests(requestLog), 2);

        assert.deepEqual(
          requestLog
            .filter((request) => request.hostname === "auth.openai.com")
            .map((request) => request.proxyUrl),
          ["http://127.0.0.1:5128/", "http://127.0.0.1:5128/"],
        );

        const alphaAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_alpha.json"), "utf-8"));
        const betaAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_beta.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(alphaAuth.tokens.access_token, "access-rotated");
        assert.equal(alphaAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(betaAuth.tokens.access_token, "access-rotated");
        assert.equal(betaAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(currentAuth.tokens.access_token, "access-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes("Refreshed token and quota for 2 accounts")),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate in provider mode skips quota refresh and logs zero effective targets", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-activate-provider-mode-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const providerProfile = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(providerProfile);
    const switchResult = core.switchMode("proxy");
    assert.equal(switchResult.success, true);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(requestLog.length, 0);
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("\"operation\":\"refreshCoordinator.flushQuotaRefresh\"")
            && line.includes("\"reason\":\"activate\"")
            && line.includes("\"effectiveCount\":0")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate in account mode refreshes only the current account quota", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-activate-account-mode-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), makeAuthFile("acct-beta"));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-beta"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(requestLog.length, 1);
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("\"operation\":\"refreshCoordinator.flushQuotaRefresh\"")
            && line.includes("\"reason\":\"activate\"")
            && line.includes("\"effectiveCount\":1")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("five-second quota ticks do not rescan local token usage within one minute", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-usage-refresh-interval-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });
    mocked.config.quotaRefreshInterval = 5;

    await withDisabledIntervals(async ({ intervals }) => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      const quotaInterval = intervals.find((handle) => handle.delay === 5_000 && !handle.cleared);
      assert.ok(quotaInterval, "the five-second quota timer should be registered");
      const countFinishedOperation = (operation) => mocked.createdChannels
        .flatMap((channel) => channel.entries.map((entry) => entry.line))
        .filter((line) =>
          line.includes("perf-finish")
          && line.includes(`\"operation\":\"${operation}\"`)
        ).length;
      const quotaBefore = countFinishedOperation("refreshCoordinator.flushQuotaRefresh");
      const usageBefore = countFinishedOperation("refreshCoordinator.flushUsageRefresh");

      for (let tick = 0; tick < 3; tick += 1) {
        quotaInterval.callback(...quotaInterval.args);
        await waitForRefreshCoordinatorIdle(context);
      }

      assert.equal(
        countFinishedOperation("refreshCoordinator.flushQuotaRefresh") - quotaBefore,
        3,
      );
      assert.equal(
        countFinishedOperation("refreshCoordinator.flushUsageRefresh") - usageBefore,
        0,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("background quota refresh rotates one saved account per interval without extra status bar requests", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-auto-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const intervalHandles = [];
  const clearedIntervals = [];
  global.setInterval = (callback, ms) => {
    const handle = {
      callback,
      ms,
    };
    intervalHandles.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    clearedIntervals.push(handle);
  };

  try {
    const stableAccessAlpha = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    });
    const stableAccessBeta = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    });
    const stableAccessGamma = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    });
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", { accessToken: stableAccessAlpha })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", { accessToken: stableAccessBeta })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_gamma.json"),
      makeAuthFile("acct-gamma", { accessToken: stableAccessGamma })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-beta", { accessToken: stableAccessBeta }), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      const usageRequests = requestLog.filter((request) => request.hostname === "chatgpt.com");
      const selectionHeartbeat = intervalHandles.find((handle) => handle.ms === 60_000);
      const initialQuotaInterval = intervalHandles.find((handle) => handle.ms === 30_000);
      assert.ok(selectionHeartbeat);
      assert.ok(initialQuotaInterval);
      assert.equal(usageRequests.length, 1);
      assert.equal(usageRequests[0].authorization, `Bearer ${stableAccessBeta}`);

      await mocked.vscode.workspace
        .getConfiguration("codex-switchbridge")
        .update("quotaRefreshInterval", 5);

      assert.equal(clearedIntervals.length >= 1, true);
      assert.equal(clearedIntervals.includes(initialQuotaInterval), true);
      const firstFiveSecondInterval = intervalHandles.find(
        (handle) => handle.ms === 5_000 && !clearedIntervals.includes(handle),
      );
      assert.ok(firstFiveSecondInterval);

      await mocked.vscode.workspace
        .getConfiguration("codex-switchbridge")
        .update("quotaRefreshInterval", 1);

      assert.equal(clearedIntervals.length >= 2, true);
      assert.equal(clearedIntervals.includes(firstFiveSecondInterval), true);
      const activeFiveSecondInterval = intervalHandles.find(
        (handle) => handle.ms === 5_000 && !clearedIntervals.includes(handle),
      );
      assert.ok(activeFiveSecondInterval);

      activeFiveSecondInterval.callback();
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(countUsageRequests(requestLog), 2);
      assert.equal(
        requestLog.filter((request) => request.hostname === "chatgpt.com")[1]?.authorization,
        `Bearer ${stableAccessGamma}`
      );

      activeFiveSecondInterval.callback();
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(countUsageRequests(requestLog), 3);
      assert.equal(
        requestLog.filter((request) => request.hostname === "chatgpt.com")[2]?.authorization,
        `Bearer ${stableAccessAlpha}`
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    }, { requestLog });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refreshQuota command on Local Accounts group refreshes all local account quotas", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-local-group-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", { accessToken: "access-alpha" })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", { accessToken: "access-beta" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha", { accessToken: "access-alpha" }), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        requestLog.length = 0;
        const accountTreeView = getAccountTreeView(mocked);
        const localGroup = getAccountTreeRootItems(accountTreeView.treeDataProvider)
          .find((item) => item.contextValue === "accountGroupLocal");
        assert.ok(localGroup);

        await mocked.registeredCommands.get("codex-routesync.refreshQuota")(localGroup);

        const usageRequests = requestLog.filter((request) => request.hostname === "chatgpt.com");
        assert.equal(usageRequests.length, 2);
        assert.deepEqual(
          usageRequests.map((request) => request.authorization).sort(),
          ["Bearer access-alpha", "Bearer access-beta"]
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("second VS Code window reuses cached quota data and skips a fresh network request", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-quota-cache-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_cache-user.json"),
      makeAuthFile("acct-cache-user", { accessToken: "access-cache-user" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-cache-user", { accessToken: "access-cache-user" }), null, 2),
      "utf-8",
    );

    const firstWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(firstWindow.vscode);
        const context = createExtensionContext(firstWindow);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );

    const secondWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const secondRequestLog = [];
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(secondWindow.vscode);
        const context = createExtensionContext(secondWindow);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(secondWindow);
        const cacheItem = getAccountTreeItems(accountTreeView.treeDataProvider)
          .find((item) => item.account.name === "cache-user");
        assert.ok(cacheItem);
        assert.match(String(cacheItem.description ?? ""), /Quota 90%/);
        assert.doesNotMatch(String(cacheItem.description ?? ""), /No quota data/i);
        assert.equal(cacheItem.iconPath?.id, "pass-filled");
        assert.equal(cacheItem.iconPath?.color?.id, "editorWarning.foreground");
        const cacheDetails = getAccountDetailItems(accountTreeView.treeDataProvider, cacheItem);
        const freshnessItem = cacheDetails.find((item) => item.label === "Quota freshness");
        assert.equal(freshnessItem?.description, "Cached");
        assert.equal(freshnessItem?.iconPath?.color?.id, "editorWarning.foreground");

        await waitForRefreshCoordinatorIdle(context);
        assert.equal(countUsageRequests(secondRequestLog), 0);
        const cachedQuotaLogEvents = secondWindow.createdChannels
          .flatMap((channel) => channel.entries)
          .filter((entry) =>
            /hydrate-quota-state-from-cache|use-fresh-cache|reuse-stale-cache-while-locked|use-cache-after-wait|fallback-to-cache-after/.test(entry.line)
          );
        assert.ok(cachedQuotaLogEvents.some((entry) => entry.level === "warn" && /cache-user/.test(entry.line)));
        assert.equal(cachedQuotaLogEvents.filter((entry) => entry.level !== "warn").length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog: secondRequestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("current account uses yellow icon when quota refresh falls back to cache", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-quota-cache-fallback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_apple1.json"),
      makeAuthFile("acct-apple1", { accessToken: "access-apple1" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-apple1", { accessToken: "access-apple1" }), null, 2),
      "utf-8",
    );

    const firstWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: false,
      cloudTokenAutoUpdate: false,
    });
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(firstWindow.vscode);
        const context = createExtensionContext(firstWindow);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );

    const secondWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: false,
      cloudTokenAutoUpdate: false,
    });
    await withDisabledIntervals(() =>
      withQuotaRejectedHttps(async () => {
        const extension = loadExtensionWithMockedVscode(secondWindow.vscode);
        const context = createExtensionContext(secondWindow);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(secondWindow);
        const provider = accountTreeView.treeDataProvider;
        await refreshQuotaThroughStore(context, provider, ["local:apple1"], {
          reason: "manual",
          concurrency: 1,
        });
        const appleItem = getAccountTreeItems(provider)
          .find((item) => item.account.name === "apple1");
        assert.ok(appleItem);
        assert.match(String(appleItem.description ?? ""), /Quota 90%/);
        assert.equal(appleItem.iconPath?.id, "pass-filled");
        assert.equal(appleItem.iconPath?.color?.id, "editorWarning.foreground");
        assert.match(String(appleItem.tooltip ?? ""), /Showing cached data/);
        assert.match(String(appleItem.tooltip ?? ""), /HTTP 401/);

        const details = getAccountDetailItems(provider, appleItem);
        const freshnessItem = details.find((item) => item.label === "Quota freshness");
        assert.equal(freshnessItem?.description, "Cached (HTTP 401)");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("provider switch refreshes views without triggering quota requests", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-switch-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
      quickPickResponses: [
        (items) => items.find((item) => item.provider?.name === "proxy"),
      ],
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        requestLog.length = 0;
        await mocked.registeredCommands.get("codex-routesync.switchProvider")();
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(requestLog.length, 0);
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("\"operation\":\"refreshCoordinator.flushQuotaRefresh\"")
            && line.includes("\"reason\":\"provider-switch\"")
            && line.includes("\"effectiveCount\":0")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account and provider name prompts reject unsafe cross-platform filenames without throwing", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-entry-name-validation-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: [
        "nested/account",
        "bad:name",
        "nested\\renamed",
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      await mocked.registeredCommands.get("codex-routesync.addAccount")();
      await mocked.registeredCommands.get("codex-routesync.addProvider")();

      const accountTreeView = getAccountTreeView(mocked);
      const [workItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "work" && item.account.source === "local");
      await mocked.registeredCommands.get("codex-routesync.renameAccount")(workItem);

      assert.equal(mocked.inputBoxCalls.length, 3);
      assert.match(mocked.inputBoxCalls[0].validateInput("nested/account"), /path separators/i);
      assert.match(mocked.inputBoxCalls[1].validateInput("bad:name"), /invalid on Windows/i);
      assert.match(mocked.inputBoxCalls[2].validateInput("nested\\renamed"), /path separators/i);
      assert.deepEqual(
        mocked.errorMessages.map((entry) => entry.message),
        [
          "Saved entry names cannot contain path separators.",
          "Saved entry names cannot contain characters that are invalid on Windows.",
          "Saved entry names cannot contain path separators.",
        ],
      );
      assert.equal(mocked.createdTerminals.length, 0);
      assert.equal(fs.existsSync(path.join(authDir, "auth_nested", "account.json")), false);
      assert.equal(fs.existsSync(path.join(authDir, "provider_bad:name.json")), false);
      core.setNamedAuthDir(authDir);
      assert.equal(core.readNamedAuth("work")?.tokens?.account_id, "acct-work");
      core.setNamedAuthDir(undefined);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("creating a provider keeps each input box open across focus changes", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-input-focus-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      quickPickResponses: [
        (items) => items.find((item) => item.action === "create" && item.source === "local"),
      ],
      inputBoxResponses: [
        "my-proxy",
        "sk-test-provider",
        "https://proxy.example.com/v1",
        "responses",
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      await mocked.registeredCommands.get("codex-routesync.switchMode")();

      assert.equal(mocked.inputBoxCalls.length, 4);
      assert.deepEqual(
        mocked.inputBoxCalls.map((options) => options?.ignoreFocusOut),
        [true, true, true, true],
      );

      core.setNamedAuthDir(authDir);
      const providerResult = core.readProviderProfileResult("my-proxy");
      core.setNamedAuthDir(undefined);
      assert.equal(providerResult.status, "ok");
      assert.equal(providerResult.value.config.base_url, "https://proxy.example.com/v1");
      assert.equal(providerResult.value.config.wire_api, "responses");
      assert.equal(providerResult.value.auth.OPENAI_API_KEY, "sk-test-provider");

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refresh quota command reuses one saved entries snapshot for tree and status bar", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-refresh-quota-snapshot-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        mocked.createdChannels.forEach((channel) => {
          channel.entries.length = 0;
        });

        core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), makeAuthFile("acct-beta"));

        await mocked.registeredCommands.get("codex-routesync.refreshQuota")();
        await waitForRefreshCoordinatorIdle(context);

        const accountTreeView = getAccountTreeView(mocked);
        assert.equal(
          getAccountTreeItems(accountTreeView.treeDataProvider)
            .some((item) => item.account.name === "beta"),
          true,
          "refreshQuota should reconcile the account tree with its fresh saved-entry snapshot",
        );

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(countOperationLogs(lines, "listSavedAccounts"), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account tree keeps quota failures inside their source group", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-tree-groups-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-ok.json"), makeAuthFile("acct-local-ok"));
    core.writeSavedAuthFile(path.join(authDir, "auth_local-fail.json"), makeAuthFile("acct-local-fail"));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-local-fail"), null, 2),
      "utf-8"
    );

    core.setSavedAuthPassphrase("group-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud-ok"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-ok": cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "group-passphrase",
      },
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const provider = accountTreeView.treeDataProvider;
        await withFailingHttps(() => refreshQuotaThroughStore(
          context,
          provider,
          ["local:local-fail"],
          { reason: "manual", concurrency: 1 },
        ));

        const groups = getAccountTreeRootItems(provider);
        assert.deepEqual(groups.map((item) => item.label), [
          "Local Accounts",
          "Cloud Accounts",
        ]);
        assert.deepEqual(
          provider.getChildren(groups[0]).map((item) => item.account.name).sort(),
          ["local-fail", "local-ok"]
        );
        const failedLocalItem = provider.getChildren(groups[0]).find((item) => item.account.name === "local-fail");
        assert.equal(failedLocalItem?.iconPath?.id, "pass-filled");
        assert.equal(failedLocalItem?.iconPath?.color?.id, "errorForeground");
        assert.deepEqual(provider.getChildren(groups[1]).map((item) => item.account.name), ["cloud-ok"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account tree shows relogin required only after manual token refresh fails", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-tree-relogin-required-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("relogin-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-google1"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          google1: cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "relogin-passphrase",
      },
      cloudTokenAutoUpdate: true,
    });

    await withDisabledIntervals(() =>
      withRefreshTokenReusedHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const provider = accountTreeView.treeDataProvider;
        await refreshQuotaThroughStore(context, provider, ["cloud:google1"], {
          reason: "timer",
          concurrency: 1,
        });

        const [googleItem] = getAccountTreeItems(provider)
          .filter((item) => item.account.name === "google1" && item.account.source === "cloud");
        assert.doesNotMatch(String(googleItem.description ?? ""), /Relogin required/);

        await refreshQuotaThroughStore(context, provider, ["cloud:google1"], {
          reason: "timer",
          concurrency: 1,
        });
        const [resetGoogleItem] = getAccountTreeItems(provider)
          .filter((item) => item.account.name === "google1" && item.account.source === "cloud");
        assert.doesNotMatch(String(resetGoogleItem.description ?? ""), /Relogin required/);

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(resetGoogleItem);
        const [manualGoogleItem] = getAccountTreeItems(provider)
          .filter((item) => item.account.name === "google1" && item.account.source === "cloud");
        assert.match(String(manualGoogleItem.description ?? ""), /Relogin required/);
        assert.match(String(manualGoogleItem.tooltip ?? ""), /Re-login this account/);

        const details = getAccountDetailItems(provider, manualGoogleItem);
        const authDetail = details.find((item) => item.label === "Auth");
        assert.equal(authDetail?.description, "Relogin required");
        assert.match(String(authDetail?.tooltip ?? ""), /Refresh token cannot be recovered automatically/);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account tree resolves stale source group children from latest root state", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-tree-stale-source-group-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("stale-group-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud-fail"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-fail": cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "stale-group-passphrase",
      },
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const provider = accountTreeView.treeDataProvider;
        const quotaStore = getQuotaStore(context);
        quotaStore.reconcileAccounts(createAccountTreeSnapshot(provider).accounts);
        quotaStore.markReloginRequired(["cloud:cloud-fail"]);

        const firstGroups = getAccountTreeRootItems(provider);
        const staleCloudGroup = firstGroups[0];
        assert.equal(staleCloudGroup.label, "Cloud Accounts");
        assert.deepEqual(provider.getChildren(staleCloudGroup).map((item) => item.account.name), ["cloud-fail"]);

        await refreshQuotaThroughStore(context, provider, ["cloud:cloud-fail"], {
          reason: "manual",
          concurrency: 1,
        });

        const secondGroups = getAccountTreeRootItems(provider);
        assert.deepEqual(secondGroups.map((item) => item.label), ["Cloud Accounts"]);
        assert.deepEqual(provider.getChildren(secondGroups[0]).map((item) => item.account.name), ["cloud-fail"]);
        assert.deepEqual(provider.getChildren(staleCloudGroup).map((item) => item.account.name), ["cloud-fail"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud account mutations are blocked and can open settings json", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-account-conflict-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("conflict-passphrase");
    const initialEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud"), {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      warningResponses: ["Remove", "Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "conflict-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          stale: initialEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "stale" && item.account.source === "cloud");

        core.setSavedAuthPassphrase("conflict-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", { accessToken: "access-newer" }),
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.accounts.stale = bumpedEntry;

        await mocked.registeredCommands.get("codex-routesync.removeAccount")(cloudItem);

        assert.equal(mocked.config.syncedStorage.accounts.stale.entryVersion, 2);
        assert.equal(mocked.errorMessages.length, 0);
        assert.match(mocked.warningMessages[1]?.message ?? "", /conflict/i);
        assert.match(mocked.warningMessages[1]?.message ?? "", /expected version 1/i);
        assert.match(mocked.warningMessages[1]?.message ?? "", /current version 2/i);
        assert.ok(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson")
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("versioned cloud account snapshots do not recreate missing synced payloads on refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-account-missing-recreate-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("deleted-passphrase");
    const initialEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud"), {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "deleted-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          stale: initialEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "stale" && item.account.source === "cloud");

        delete mocked.config.syncedStorage.accounts.stale;

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

        assert.equal(mocked.config.syncedStorage.accounts.stale, undefined);
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /no longer has a synced payload/i);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson"),
          false
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud provider mutations are blocked and keep the latest synced entry", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-provider-conflict-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const providerProfile = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-old" },
      config: {
        name: "proxy",
        base_url: "https://example.com/v1",
        wire_api: "responses",
      },
    };

    core.setSavedAuthPassphrase("provider-conflict-passphrase");
    const initialEntry = core.serializeSavedValue("saved_provider", providerProfile, {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-conflict-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: initialEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "proxy" && item.provider.source === "cloud");

        core.setSavedAuthPassphrase("provider-conflict-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_provider",
          {
            ...providerProfile,
            auth: { OPENAI_API_KEY: "sk-new" },
          },
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        bumpedEntry.lastWriterAction = "save_provider_profile";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.providers.proxy = bumpedEntry;

        await mocked.registeredCommands.get("codex-routesync.moveProviderToLocal")(providerItem);

        assert.equal(fs.existsSync(path.join(authDir, "provider_proxy.json")), false);
        assert.equal(mocked.config.syncedStorage.providers.proxy.entryVersion, 2);
        assert.equal(mocked.errorMessages.length, 0);
        assert.match(mocked.warningMessages[0]?.message ?? "", /conflict/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /current version 2/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /last writer action save_provider_profile/i);
        assert.ok(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson")
        );

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-conflict-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-new");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("move account to local rejects an existing local account before cloud removal", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-move-local-rollback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const localAuthPath = path.join(authDir, "auth_work.json");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      localAuthPath,
      makeAuthFile("acct-local", {
        accessToken: "access-local-original",
        refreshToken: "refresh-local-original",
      })
    );
    core.setNamedAuthDir(undefined);

    core.setSavedAuthPassphrase("move-local-passphrase");
    const initialEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-original",
        refreshToken: "refresh-cloud-original",
      }),
      { requireEncryption: true }
    );
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "move-local-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          work: initialEntry,
        },
        providers: {},
        devices: [currentDeviceName],
        autoRefreshDeviceName: currentDeviceName,
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "cloud");

          core.setSavedAuthPassphrase("move-local-passphrase");
          const bumpedEntry = core.serializeSavedValue(
            "saved_auth",
            makeAuthFile("acct-cloud", {
              accessToken: "access-cloud-newer",
              refreshToken: "refresh-cloud-newer",
            }),
            { requireEncryption: true }
          );
          bumpedEntry.entryVersion = 2;
          bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
          core.setSavedAuthPassphrase(null);
          mocked.config.syncedStorage.accounts.work = bumpedEntry;

          await mocked.registeredCommands.get("codex-routesync.moveAccountToLocal")(cloudItem);

          core.setNamedAuthDir(authDir);
          const localResult = core.readSavedAuthFileResult(localAuthPath);
          core.setNamedAuthDir(undefined);

          assert.equal(localResult.status, "ok");
          assert.equal(localResult.value.tokens.access_token, "access-local-original");
          assert.equal(localResult.value.tokens.refresh_token, "refresh-local-original");
          assert.equal(mocked.config.syncedStorage.accounts.work.entryVersion, 2);
          assert.match(mocked.errorMessages[0]?.message ?? "", /already exists/i);
          assert.equal(mocked.warningMessages.length, 0);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("move provider to local rejects an existing local provider before cloud removal", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-move-local-rollback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const localProviderName = "proxy";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const localProfile = {
      kind: "provider",
      name: localProviderName,
      auth: { OPENAI_API_KEY: "sk-local-original" },
      config: {
        name: localProviderName,
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(localProfile);
    core.setNamedAuthDir(undefined);

    const cloudProfile = {
      kind: "provider",
      name: localProviderName,
      auth: { OPENAI_API_KEY: "sk-cloud-original" },
      config: {
        name: localProviderName,
        base_url: "https://cloud.example.com/v1",
        wire_api: "responses",
      },
    };

    core.setSavedAuthPassphrase("provider-move-passphrase");
    const initialEntry = core.serializeSavedValue("saved_provider", cloudProfile, {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-move-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          [localProviderName]: initialEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === localProviderName && item.provider.source === "cloud");

        core.setSavedAuthPassphrase("provider-move-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_provider",
          {
            ...cloudProfile,
            auth: { OPENAI_API_KEY: "sk-cloud-newer" },
          },
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.providers[localProviderName] = bumpedEntry;

        await mocked.registeredCommands.get("codex-routesync.moveProviderToLocal")(providerItem);

        core.setNamedAuthDir(authDir);
        const localResult = core.readProviderProfileResult(localProviderName);
        core.setNamedAuthDir(undefined);

        assert.equal(localResult.status, "ok");
        assert.equal(localResult.value.auth.OPENAI_API_KEY, "sk-local-original");
        assert.equal(mocked.config.syncedStorage.providers[localProviderName].entryVersion, 2);
        assert.match(mocked.errorMessages[0]?.message ?? "", /already exists/i);
        assert.equal(mocked.warningMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moving one local provider to cloud does not rewrite sibling cloud provider key", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-per-entry-write-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const localProfile = {
      kind: "provider",
      name: "local-proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "local-proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    };
    const siblingProfile = {
      kind: "provider",
      name: "sibling",
      auth: { OPENAI_API_KEY: "sk-sibling" },
      config: {
        name: "sibling",
        base_url: "https://sibling.example.com/v1",
        wire_api: "responses",
      },
    };

    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(localProfile);
    core.setNamedAuthDir(undefined);

    core.setSavedAuthPassphrase("provider-entry-passphrase");
    const siblingEntry = core.serializeSavedValue("saved_provider", siblingProfile, {
      requireEncryption: true,
    });
    siblingEntry.entryVersion = 3;
    siblingEntry.updatedAt = "2026-04-03T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          sibling: siblingEntry,
        },
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-entry-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [localItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "local-proxy" && item.provider.source === "local");
        const siblingBefore = JSON.parse(JSON.stringify(mocked.globalStateValues.get(getSyncedCloudProviderKey("sibling"))));

        await mocked.registeredCommands.get("codex-routesync.moveProviderToCloud")(localItem);

        assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudProviderKey("sibling")), siblingBefore);
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudProviderKey("local-proxy"))?.ciphertext, "string");
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providers, {});
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["local-proxy", "sibling"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moving a provider to cloud keeps the local profile when payload verification fails", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-move-readback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "qingteng",
      auth: { OPENAI_API_KEY: "sk-qingteng" },
      config: {
        name: "qingteng",
        base_url: "https://qingteng.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-move-readback-passphrase",
      },
      afterGlobalStateUpdate(key, value, state) {
        if (key === getSyncedCloudProviderKey("qingteng") && value !== undefined) {
          state.globalStateValues.delete(key);
        }
      },
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      const providerTreeView = getProviderTreeView(mocked);
      const [localItem] = providerTreeView.treeDataProvider
        .getChildren()
        .filter((item) => item.provider.name === "qingteng" && item.provider.source === "local");

      await mocked.registeredCommands.get("codex-routesync.moveProviderToCloud")(localItem);
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(fs.existsSync(path.join(authDir, "provider_qingteng.json")), true);
      assert.equal(mocked.globalStateValues.has(getSyncedCloudProviderKey("qingteng")), false);
      assert.match(mocked.errorMessages.at(-1).message, /could not be verified.*local provider was kept/i);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addProvider saves a new local provider without switching mode", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-provider-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-active"), null, 2),
    "utf-8",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: [
        "proxy",
        "sk-proxy",
        "https://proxy.example.com/v1",
        "responses",
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      await mocked.registeredCommands.get("codex-routesync.addProvider")();
      await waitForRefreshCoordinatorIdle(context);

      core.setNamedAuthDir(authDir);
      const savedProvider = core.readProviderProfile("proxy");

      assert.deepEqual(savedProvider, {
        kind: "provider",
        name: "proxy",
        auth: {
          OPENAI_API_KEY: "sk-proxy",
        },
        config: {
          name: "proxy",
          base_url: "https://proxy.example.com/v1",
          wire_api: "responses",
        },
      });
      assert.equal(core.getActiveModelProvider(), null);

      const providerTreeView = getProviderTreeView(mocked);
      const providerItems = providerTreeView.treeDataProvider.getChildren();
      assert.equal(providerItems.some((item) => item.provider?.name === "proxy"), true);
      core.setNamedAuthDir(undefined);
      assert.equal(
        mocked.informationMessages.some((entry) =>
          entry.message.includes('Created provider profile for "proxy" in local storage.')
        ),
        true,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addProvider saves and verifies a new cloud provider payload", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-cloud-provider-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    const mocked = createVscodeMock({
      defaultSaveTarget: "cloud",
      captureSyncedGlobalStateWrites: true,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-provider-passphrase",
      },
      inputBoxResponses: [
        "qingteng",
        "sk-qingteng",
        "https://qingteng.example.com/v1",
        "responses",
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      await mocked.registeredCommands.get("codex-routesync.addProvider")();
      await waitForRefreshCoordinatorIdle(context);

      const storedProvider = mocked.globalStateValues.get(getSyncedCloudProviderKey("qingteng"));
      assert.equal(typeof storedProvider?.ciphertext, "string");
      assert.equal(storedProvider.entryVersion, 1);
      assert.equal(storedProvider.lastWriterAction, "save_provider_profile");
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["qingteng"]);
      assert.equal(typeof mocked.syncedGlobalStateValues.get(getSyncedCloudProviderKey("qingteng"))?.ciphertext, "string");

      const providerTreeView = getProviderTreeView(mocked);
      const [providerItem] = providerTreeView.treeDataProvider
        .getChildren()
        .filter((item) => item.provider.name === "qingteng" && item.provider.source === "cloud");
      assert.equal(providerItem.provider.pending, false);
      assert.equal(providerItem.provider.invalid, false);
      assert.equal(providerItem.provider.profile.auth.OPENAI_API_KEY, "sk-qingteng");
      assert.equal(
        mocked.informationMessages.some((entry) =>
          entry.message.includes('Created provider profile for "qingteng" in cloud storage.')
        ),
        true,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("addProvider reports failure when a cloud provider payload cannot be read back", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-add-cloud-provider-readback-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    const mocked = createVscodeMock({
      defaultSaveTarget: "cloud",
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-provider-readback-passphrase",
      },
      inputBoxResponses: [
        "qingteng",
        "sk-qingteng",
        "https://qingteng.example.com/v1",
        "responses",
      ],
      afterGlobalStateUpdate(key, value, state) {
        if (key === getSyncedCloudProviderKey("qingteng") && value !== undefined) {
          state.globalStateValues.delete(key);
        }
      },
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      await mocked.registeredCommands.get("codex-routesync.addProvider")();
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(mocked.globalStateValues.has(getSyncedCloudProviderKey("qingteng")), false);
      assert.match(mocked.errorMessages.at(-1).message, /could not be verified.*payload is missing/i);
      assert.equal(
        mocked.informationMessages.some((entry) =>
          entry.message.includes('Created provider profile for "qingteng" in cloud storage.')
        ),
        false,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual token refresh marks invalidated refresh token as relogin required", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-tree-refresh-invalidated-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("invalidated-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-microsoft1"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          microsoft1: cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "invalidated-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withRefreshTokenReusedHttps(
        async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = getAccountTreeView(mocked);
          const provider = accountTreeView.treeDataProvider;
          const [accountItem] = getAccountTreeItems(provider)
            .filter((item) => item.account.name === "microsoft1" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-routesync.refreshToken")(accountItem);

          const [manualItem] = getAccountTreeItems(provider)
            .filter((item) => item.account.name === "microsoft1" && item.account.source === "cloud");
          assert.match(String(manualItem.description ?? ""), /Relogin required/);
          assert.match(String(manualItem.tooltip ?? ""), /Re-login this account/);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        },
        {
          code: "refresh_token_invalidated",
          message: "Your refresh token has been invalidated. Please try signing in again.",
        },
      )
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("remove provider asks for confirmation before deleting a local provider", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-remove-local-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const providerPath = path.join(authDir, "provider_proxy.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Remove"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "proxy" && item.provider.source === "local");

        await mocked.registeredCommands.get("codex-routesync.removeProvider")(providerItem);

        assert.equal(fs.existsSync(providerPath), false);
        assert.equal(mocked.warningMessages.length, 1);
        assert.equal(
          mocked.warningMessages[0].message,
          'Remove provider "proxy" from local storage?'
        );
        assert.deepEqual(mocked.warningMessages[0].actions, ["Remove", "Cancel"]);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(mocked.informationMessages[0]?.message, '✓ Removed provider "proxy"');

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("removing a cloud account writes a tombstone that blocks stale payload revival", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-remove-tombstone-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-remove-passphrase");
    const initialEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud-old"), {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      warningResponses: ["Remove"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-remove-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-old": initialEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "cloud-old" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.removeAccount")(cloudItem);

        const tombstone = mocked.globalStateValues.get(getSyncedCloudAccountKey("cloud-old"));
        assert.equal(tombstone?.deleted, true);
        assert.equal(tombstone?.entryVersion, 2);
        assert.equal(tombstone?.lastWriterAction, "delete_account");
        assert.equal(mocked.config.syncedStorage.accounts["cloud-old"]?.deleted, true);

        const syncedState = mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY);
        syncedState.accounts = { "cloud-old": initialEntry };
        syncedState.accountNames = ["cloud-old"];
        await mocked.registeredCommands.get("codex-routesync.refreshList")();

        const revivedItems = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "cloud-old" && item.account.source === "cloud");
        assert.equal(revivedItems.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("removing a cloud provider writes a tombstone that blocks stale payload revival", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-remove-tombstone-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const cloudProfile = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-original" },
      config: {
        name: "proxy",
        base_url: "https://cloud.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setSavedAuthPassphrase("provider-remove-passphrase");
    const initialEntry = core.serializeSavedValue("saved_provider", cloudProfile, {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 4;
    initialEntry.updatedAt = "2026-04-04T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      warningResponses: ["Remove"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-remove-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: initialEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "proxy" && item.provider.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.removeProvider")(providerItem);

        const tombstone = mocked.globalStateValues.get(getSyncedCloudProviderKey("proxy"));
        assert.equal(tombstone?.deleted, true);
        assert.equal(tombstone?.entryVersion, 5);
        assert.equal(tombstone?.lastWriterAction, "delete_provider");
        assert.equal(mocked.config.syncedStorage.providers.proxy?.deleted, true);

        const syncedState = mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY);
        syncedState.providers = { proxy: initialEntry };
        syncedState.providerNames = ["proxy"];
        await mocked.registeredCommands.get("codex-routesync.refreshList")();

        const revivedItems = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider?.name === "proxy" && item.provider.source === "cloud");
        assert.equal(revivedItems.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("cloud provider tooltip shows visible sync revision metadata", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-provider-tooltip-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("provider-tooltip-passphrase");
    const syncedEntry = core.serializeSavedValue(
      "saved_provider",
      {
        kind: "provider",
        name: "proxy",
        auth: { OPENAI_API_KEY: "sk-test" },
        config: {
          name: "proxy",
          base_url: "https://example.com/v1",
          wire_api: "responses",
        },
      },
      {
        requireEncryption: true,
      }
    );
    syncedEntry.entryVersion = 4;
    syncedEntry.updatedAt = "2026-04-06T07:08:09.000Z";
    syncedEntry.lastWriterAction = "sync_current_provider_auth";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-tooltip-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: syncedEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = getProviderTreeView(mocked);
        const [providerItem] = providerTreeView.treeDataProvider.getChildren();
        const details = providerTreeView.treeDataProvider.getChildren(providerItem);

        assert.match(String(providerItem.tooltip ?? ""), /Sync version: 4/);
        assert.match(String(providerItem.tooltip ?? ""), /Updated: 2026-04-06T07:08:09.000Z/);
        assert.doesNotMatch(String(providerItem.tooltip ?? ""), /Last writer device/);
        assert.match(String(providerItem.tooltip ?? ""), /Last writer action: sync_current_provider_auth/);
        assert.equal(details.some((item) => item.label === "Last writer device"), false);
        assert.equal(
          details.some((item) => item.label === "Last writer action" && item.description === "sync_current_provider_auth"),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moving a local provider to cloud records provider audit metadata", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-audit-move-cloud-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-audit-passphrase",
      },
    });

    await withMockedHostname("AuditDevice", async () =>
      withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const providerTreeView = getProviderTreeView(mocked);
          const [providerItem] = providerTreeView.treeDataProvider
            .getChildren()
            .filter((item) => item.provider.name === "proxy" && item.provider.source === "local");

          await mocked.registeredCommands.get("codex-routesync.moveProviderToCloud")(providerItem);

          const envelope = getCloudEnvelope(mocked.config, "provider", "proxy");
          assert.equal(envelope.entryVersion, 1);
          assert.equal("lastWriterDeviceName" in envelope, false);
          assert.equal(envelope.lastWriterAction, "move_provider_to_cloud");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        })
      )
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account tree shows duplicate local and cloud accounts with source labels", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-tree-sources-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("tree-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    const syncedStorage = {
      version: 1,
      accounts: {
        work: core.serializeSavedValue("saved_auth", makeAuthFile("acct-work"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "tree-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const items = getAccountTreeItems(accountTreeView.treeDataProvider);
        const groupLabels = getAccountTreeRootItems(accountTreeView.treeDataProvider).map((item) => item.label);
        const matching = items.filter((item) => item.account.name === "work");

        assert.equal(matching.length, 2);
        assert.deepEqual(
          matching.map((item) => item.account.source).sort(),
          ["cloud", "local"]
        );
        assert.ok(groupLabels.includes("Local Accounts"));
        assert.ok(groupLabels.includes("Cloud Accounts"));
        for (const item of matching) {
          assert.match(item.description ?? "", /local|cloud/i);
          assert.doesNotMatch(String(item.tooltip ?? ""), /Source:/i);
        }

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account migration moves saved auth between local and cloud storage", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-migration-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "move-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
        devices: [currentDeviceName],
        autoRefreshDeviceName: currentDeviceName,
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = getAccountTreeView(mocked);
          const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "local");

          await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);

          const backupPath = getProtectedCloudAccountBackupPath(mocked, "work");
          assert.equal(fs.existsSync(backupPath), true);
          const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
          assert.equal(backup.name, "work");
          assert.equal(typeof backup.payload?.ciphertext, "string");
          assert.equal(JSON.stringify(backup).includes("access-token"), false);
          assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), false);
          assert.equal(typeof mocked.config.syncedStorage.accounts.work?.ciphertext, "string");

          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-routesync.moveAccountToLocal")(cloudItem);

          assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), true);
          assert.equal(mocked.config.syncedStorage.accounts.work?.deleted, true);
          assert.equal(fs.existsSync(backupPath), false);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("renaming a cloud account moves its protected backup", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-rename-backup-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work", {
      email: "work@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: ["renamed-work"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "rename-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);

        const oldBackupPath = getProtectedCloudAccountBackupPath(mocked, "work");
        const newBackupPath = getProtectedCloudAccountBackupPath(mocked, "renamed-work");
        assert.equal(fs.existsSync(oldBackupPath), true);
        assert.equal(fs.existsSync(newBackupPath), false);

        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.renameAccount")(cloudItem);

        assert.equal(fs.existsSync(oldBackupPath), false);
        assert.equal(fs.existsSync(newBackupPath), true);
        const backup = JSON.parse(fs.readFileSync(newBackupPath, "utf-8"));
        assert.equal(backup.name, "renamed-work");
        assert.equal(typeof backup.payload?.ciphertext, "string");
        assert.equal(JSON.stringify(backup).includes("access-token"), false);
        assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("work")), false);
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("renamed-work"))?.ciphertext, "string");
        assert.deepEqual(
          mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames,
          ["renamed-work"]
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moveAccountToCloud syncs the payload together with the cloud index for another device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-migration-cross-device-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_apple1.json"), makeAuthFile("acct-apple1", {
      email: "apple1@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const source = createVscodeMock({
      authDirectory: authDir,
      captureSyncedGlobalStateWrites: true,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cross-device-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(source.vscode);
        const context = createExtensionContext(source);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(source);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "apple1" && item.account.source === "local");

        await source.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );

    const replicatedState = Object.fromEntries(source.syncedGlobalStateValues.entries());
    const target = createVscodeMock({
      globalStateValues: replicatedState,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cross-device-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(target.vscode);
        const context = createExtensionContext(target);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(target);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

        assert.equal(cloudItem.account.storageState, "ready");
        assert.equal(cloudItem.account.meta.email, "apple1@example.com");
        assert.equal(cloudItem.account.meta.plan, "pro");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("restoreCloudAccountPayload restores an index-only cloud account from protected backup", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-payload-restore-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_bob1990.json"), makeAuthFile("acct-bob1990", {
      email: "bob1990@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "restore-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "bob1990" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_bob1990.json")), false);
        assert.equal(fs.existsSync(getProtectedCloudAccountBackupPath(mocked, "bob1990")), true);
        mocked.globalStateValues.delete(getSyncedCloudAccountKey("bob1990"));
        await mocked.registeredCommands.get("codex-routesync.refreshList")();

        let [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "bob1990" && item.account.source === "cloud");

        assert.equal(cloudItem.account.storageState, "pending");
        assert.equal(cloudItem.account.recoveryAvailable, true);
        assert.equal(cloudItem.contextValue, "accountCloudRecoverable");
        assert.match(cloudItem.account.storageMessage, /protected local backup/i);

        await mocked.registeredCommands.get("codex-routesync.restoreCloudAccountPayload")(cloudItem);

        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("bob1990"))?.ciphertext, "string");
        [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "bob1990" && item.account.source === "cloud");
        assert.equal(cloudItem.account.storageState, "ready");
        assert.equal(cloudItem.account.meta.email, "bob1990@example.com");
        assert.equal(cloudItem.account.meta.plan, "pro");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("restoreCloudAccountPayload lists orphan protected backup when cloud index is missing", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-orphan-payload-restore-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_fanfan.json"), makeAuthFile("acct-fanfan", {
      email: "fanfan@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "restore-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "fanfan" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_fanfan.json")), false);
        assert.equal(fs.existsSync(getProtectedCloudAccountBackupPath(mocked, "fanfan")), true);

        mocked.globalStateValues.delete(getSyncedCloudAccountKey("fanfan"));
        const cloudState = mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY);
        cloudState.accountNames = cloudState.accountNames.filter((name) => name !== "fanfan");
        await mocked.registeredCommands.get("codex-routesync.refreshList")();

        let [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "fanfan" && item.account.source === "cloud");

        assert.equal(cloudItem.account.storageState, "pending");
        assert.equal(cloudItem.account.publicEmail, "fanfan@example.com");
        assert.equal(cloudItem.account.recoveryAvailable, true);
        assert.equal(cloudItem.contextValue, "accountCloudRecoverable");
        assert.match(cloudItem.account.storageMessage, /synced index and payload are missing/i);

        await mocked.registeredCommands.get("codex-routesync.restoreCloudAccountPayload")(cloudItem);

        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("fanfan"))?.ciphertext, "string");
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["fanfan"]);
        [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "fanfan" && item.account.source === "cloud");
        assert.equal(cloudItem.account.storageState, "ready");
        assert.equal(cloudItem.account.meta.email, "fanfan@example.com");
        assert.equal(cloudItem.account.meta.plan, "pro");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moveAccountToCloud keeps local auth when cloud payload cannot be read back", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-migration-readback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_apple1.json"), makeAuthFile("acct-apple1", {
      email: "apple1@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "readback-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
      afterGlobalStateUpdate(key, value, state) {
        if (key === getSyncedCloudAccountKey("apple1") && value !== undefined) {
          state.globalStateValues.delete(key);
        }
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "apple1" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_apple1.json")), true);
        assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("apple1")), false);
        assert.match(mocked.errorMessages.at(-1).message, /could not be verified/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("useAccount shares one cloud quota request between tree and status bar", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-use-account-quota-dedupe-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  core.setSavedAuthPassphrase("cloud-passphrase");
  const requestLog = [];
  const mocked = createVscodeMock({
    secretValues: {
      [STORAGE_SECRET_KEY]: "cloud-passphrase",
    },
    showStatusBar: true,
    syncedStorage: {
      version: 1,
      accounts: {
        sync: core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    },
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 1);
        assert.equal(countAuthRefreshRequests(requestLog), 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moveAccountToCloud avoids duplicate quota refresh after synced storage update", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-move-account-cloud-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-work"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    authDirectory: authDir,
    secretValues: {
      [STORAGE_SECRET_KEY]: "move-passphrase",
    },
    showStatusBar: true,
  });

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setNamedAuthDir(undefined);

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(localItem);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("hidden status bar also hides reload recommendations without extra quota requests", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-hidden-status-bar-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  core.setSavedAuthPassphrase("cloud-passphrase");
  const requestLog = [];
  const mocked = createVscodeMock({
    secretValues: {
      [STORAGE_SECRET_KEY]: "cloud-passphrase",
    },
    showStatusBar: false,
    reloadWindowAfterSwitch: "statusBar",
    syncedStorage: {
      version: 1,
      accounts: {
        hidden: core.serializeSavedValue("saved_auth", makeAuthFile("acct-hidden"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    },
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 0);
        const quotaItem = mocked.createdStatusBarItems.find(
          (item) => item.command === "codex-routesync.refreshQuota"
        );
        const reloadItem = mocked.createdStatusBarItems.find(
          (item) => item.command === "codex-routesync.reloadWindow"
        );
        assert.ok(quotaItem);
        assert.ok(reloadItem);
        assert.equal(quotaItem.visible, false);
        assert.equal(reloadItem.visible, false);

        requestLog.length = 0;
        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "hidden" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 1);
        assert.equal(quotaItem.visible, false);
        assert.equal(reloadItem.visible, false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moveAccountToLocal refreshes only the affected account quota", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-move-account-local-targeted-"));
  const codexHome = path.join(tempRoot, ".codex");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-work"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  core.setSavedAuthPassphrase("cloud-passphrase");
  const requestLog = [];
  const mocked = createVscodeMock({
    secretValues: {
      [STORAGE_SECRET_KEY]: "cloud-passphrase",
    },
    showStatusBar: true,
    syncedStorage: {
      version: 1,
      accounts: {
        work: core.serializeSavedValue("saved_auth", makeAuthFile("acct-work"), {
          requireEncryption: true,
        }),
        other: core.serializeSavedValue("saved_auth", makeAuthFile("acct-other"), {
          requireEncryption: true,
        }),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: currentDeviceName,
    },
  });

  try {
    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-routesync.moveAccountToLocal")(cloudItem);
          await waitForRefreshCoordinatorIdle(context);

          assert.equal(countUsageRequests(requestLog), 1);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("current cloud account reselect preserves rotated auth without reload before switching away", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-manual-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("manual-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_local-user.json"),
      makeAuthFile("acct-local")
    );
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date().toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
          lastRefresh: new Date().toISOString(),
        }),
        null,
        2
      ),
      "utf-8"
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      reloadWindowAfterSwitch: "always",
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "manual-passphrase",
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(cloudItem);

        const authAfterReselect = JSON.parse(
          fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
        );
        assert.equal(authAfterReselect.tokens.access_token, "access-cloud-current");
        assert.equal(authAfterReselect.tokens.refresh_token, "refresh-cloud-current");
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          0,
        );

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "manual-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-current");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-current");
        assert.equal(
          mocked.executedCommands.filter((entry) => entry.name === "workbench.action.reloadWindow").length,
          1,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("switching away from a cloud account ignores legacy device authority and updates cloud storage", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-switch-legacy-device-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("manual-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_local-user.json"),
      makeAuthFile("acct-local")
    );
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-saved",
        refreshToken: "refresh-cloud-saved",
      }),
      {
        requireEncryption: true,
      }
    );
    cloudEntry.entryVersion = 6;
    cloudEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": cloudEntry,
      },
      providers: {},
      devices: ["authorized-device"],
      autoRefreshDeviceName: "authorized-device",
    };
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
        }),
        null,
        2
      ),
      "utf-8"
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "manual-passphrase",
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 6,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      },
    });

    await withMockedHostname("legacy-other-device", async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = getAccountTreeView(mocked);
          const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "local-user" && item.account.source === "local");

          await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-current");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-current");
          assert.equal(mocked.config.syncedStorage.accounts["sync-user"].entryVersion, 7);
          assert.notEqual(mocked.config.syncedStorage.accounts["sync-user"].updatedAt, "2026-05-01T00:00:00.000Z");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud provider marker self-heals without overwriting newer cloud credentials before switching account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-marker-heal-account-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("provider-heal-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    const cloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-new" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-current-provider-old" }, null, 2),
      "utf-8",
    );
    core.activateProviderConfig("proxy", cloudProvider.config);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-heal-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: cloudEntry,
        },
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "provider",
          name: "proxy",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-heal-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-cloud-new");
        assert.equal(getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion, 2);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Detected newer synced cloud provider metadata for "proxy"')
            && entry.message.includes("from version 1 to 2")
          ),
          true,
        );
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("reconcile-current-cloud-marker")
            && line.includes("\"kind\":\"provider\"")
            && line.includes("\"name\":\"proxy\"")
            && line.includes("\"previousEntryVersion\":1")
            && line.includes("\"currentEntryVersion\":2")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud provider marker self-heals without overwriting newer cloud credentials before switching provider", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-marker-heal-provider-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("provider-heal-switch-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "local-proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "local-proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    });
    const cloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-new" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-current-provider-old" }, null, 2),
      "utf-8",
    );
    core.activateProviderConfig("proxy", cloudProvider.config);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-heal-switch-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: cloudEntry,
        },
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "provider",
          name: "proxy",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
      quickPickResponses: [
        (items) => items.find((item) => item.provider?.name === "local-proxy"),
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.switchMode")();

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-heal-switch-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-cloud-new");
        assert.equal(getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion, 2);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Detected newer synced cloud provider metadata for "proxy"')
            && entry.message.includes("from version 1 to 2")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("missing provider marker does not write active cloud credentials into a same-name local provider", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-missing-marker-source-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "provider-source-passphrase";
    const localProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local-keep" },
      config: {
        name: "proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    };
    const cloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-active" },
      config: {
        name: "proxy",
        base_url: "https://cloud.example.com/v1",
        wire_api: "responses",
      },
    };

    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    core.writeProviderProfile(localProvider);
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 1;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    core.activateProviderProfile(cloudProvider, {
      shareHistoryAcrossProviders: true,
      source: "test",
      target: "provider:cloud:proxy",
    });

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: cloudEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        core.setSavedAuthPassphrase(passphrase);
        const savedLocalProvider = core.readProviderProfile("proxy");
        core.setSavedAuthPassphrase(null);
        assert.equal(savedLocalProvider.auth.OPENAI_API_KEY, "sk-local-keep");
        assert.equal(savedLocalProvider.config.base_url, "https://local.example.com/v1");

        const savedCloudProvider = readCloudProvider(mocked.config, "proxy", passphrase);
        assert.equal(savedCloudProvider.auth.OPENAI_API_KEY, "sk-cloud-active");
        assert.equal(getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion, 1);
        assert.equal(mocked.errorMessages.length, 0);

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("adopt-missing-provider-source-marker")
            && line.includes('"provider":"proxy"')
            && line.includes('"source":"cloud"')
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("missing provider marker adopts a uniquely matching same-name local provider", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-missing-marker-local-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "provider-local-source-passphrase";
    const localProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local-active" },
      config: {
        name: "proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    };
    const cloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-keep" },
      config: {
        name: "proxy",
        base_url: "https://cloud.example.com/v1",
        wire_api: "responses",
      },
    };

    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    core.writeProviderProfile(localProvider);
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 1;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    core.activateProviderProfile(localProvider, {
      shareHistoryAcrossProviders: true,
      source: "test",
      target: "provider:local:proxy",
    });

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: cloudEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        const savedCloudProvider = readCloudProvider(mocked.config, "proxy", passphrase);
        assert.equal(savedCloudProvider.auth.OPENAI_API_KEY, "sk-cloud-keep");
        assert.equal(getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion, 1);
        assert.equal(mocked.errorMessages.length, 0);

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("adopt-missing-provider-source-marker")
            && line.includes('"provider":"proxy"')
            && line.includes('"source":"local"')
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale local provider marker resolves the only cloud entry without overwriting it", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-stale-local-marker-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "provider-stale-local-marker-passphrase";
    const savedCloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-saved" },
      config: {
        name: "proxy",
        base_url: "https://cloud.example.com/v1",
        wire_api: "responses",
      },
    };
    const runtimeCloudProvider = {
      ...savedCloudProvider,
      auth: { OPENAI_API_KEY: "sk-cloud-runtime" },
    };

    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_target.json"),
      makeAuthFile("acct-target"),
    );
    const cloudEntry = core.serializeSavedValue("saved_provider", savedCloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 1;
    cloudEntry.updatedAt = "2026-08-11T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    core.activateProviderProfile(runtimeCloudProvider, {
      shareHistoryAcrossProviders: true,
      source: "test",
      target: "provider:cloud:proxy",
    });

    const mocked = createVscodeMock({
      authDirectory: authDir,
      shareHistoryAcrossProviders: true,
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: { proxy: cloudEntry },
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "provider",
          name: "proxy",
          source: "local",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const providerTreeView = getProviderTreeView(mocked);
        const cloudItem = providerTreeView.treeDataProvider
          .getChildren()
          .find((item) => item.provider?.name === "proxy" && item.provider?.source === "cloud");
        assert.ok(cloudItem);
        const cloudWasCurrent = cloudItem.provider.isCurrent;

        const dashboard = await mocked.readyDashboard();
        const routeBeforeSwitch = dashboard.latestState()?.route;

        const accountTreeView = getAccountTreeView(mocked);
        const targetItem = getAccountTreeItems(accountTreeView.treeDataProvider)
          .find((item) => item.account.name === "target" && item.account.source === "local");
        assert.ok(targetItem);
        await mocked.registeredCommands.get("codex-routesync.useAccount")(targetItem);
        await Promise.resolve();
        await Promise.resolve();
        const routeAfterSwitch = dashboard.latestState()?.route;

        const cloudAfterSwitch = readCloudProvider(mocked.config, "proxy", passphrase);
        assert.deepEqual(
          {
            cloudWasCurrent,
            modeBeforeSwitch: routeBeforeSwitch?.kind,
            sourceBeforeSwitch: routeBeforeSwitch?.kind === "provider" ? routeBeforeSwitch.source : null,
            modeAfterSwitch: routeAfterSwitch?.kind,
            accountAfterSwitch: routeAfterSwitch?.kind === "account" ? routeAfterSwitch.name : null,
            apiKey: cloudAfterSwitch.auth.OPENAI_API_KEY,
            entryVersion: getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion,
          },
          {
            cloudWasCurrent: true,
            modeBeforeSwitch: "provider",
            sourceBeforeSwitch: "cloud",
            modeAfterSwitch: "account",
            accountAfterSwitch: "target",
            apiKey: "sk-cloud-saved",
            entryVersion: 1,
          },
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud account marker self-heals without overwriting newer cloud credentials before switching account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-marker-heal-account-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-heal-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-new",
        refreshToken: "refresh-cloud-new",
        extraFields: {
          [AUTH_UPDATED_AT_FIELD]: "2026-04-02T00:00:00.000Z",
        },
      }),
      {
        requireEncryption: true,
      },
    );
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
          lastRefresh: new Date().toISOString(),
          extraFields: {
            [AUTH_UPDATED_AT_FIELD]: "2026-04-01T00:00:00.000Z",
          },
        }),
        null,
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-heal-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        const cloudAuth = readCloudAccount(mocked.config, "sync-user", "account-heal-passphrase");
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-new");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-new");
        assert.equal(getCloudEnvelope(mocked.config, "account", "sync-user").entryVersion, 2);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Detected newer synced cloud account metadata for "sync-user"')
            && entry.message.includes("from version 1 to 2")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("versioned cloud account marker does not recreate missing synced payload before switching account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-marker-recreate-missing-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
          lastRefresh: new Date().toISOString(),
        }),
        null,
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "deleted-account-heal-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        assert.equal(mocked.config.syncedStorage.accounts["sync-user"], undefined);
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /no longer has a synced payload/i);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes("Detected newer synced cloud account metadata")),
          false,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("current cloud marker does not prompt when already up to date", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-marker-no-heal-current-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-current-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      {
        requireEncryption: true,
      },
    );
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
          lastRefresh: new Date().toISOString(),
        }),
        null,
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-current-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(localItem);

        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes("Detected newer synced cloud account metadata")),
          false,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud account marker does not overwrite a different current account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-marker-identity-guard-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-marker-guard-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_current-user.json"), makeAuthFile("acct-current"));
    core.writeSavedAuthFile(path.join(authDir, "auth_target-user.json"), makeAuthFile("acct-target"));
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      {
        requireEncryption: true,
      },
    );
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-current", {
          accessToken: "access-current",
          refreshToken: "refresh-current",
        }),
        null,
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-marker-guard-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-user": cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-switchbridge.currentSavedSelection": {
          kind: "account",
          name: "cloud-user",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [targetItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "target-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.useAccount")(targetItem);

        const cloudAuth = readCloudAccount(mocked.config, "cloud-user", "account-marker-guard-passphrase");
        assert.equal(cloudAuth.tokens.account_id, "acct-cloud");
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
        assert.equal(getCloudEnvelope(mocked.config, "account", "cloud-user").entryVersion, 2);
        assert.deepEqual(mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection"), {
          kind: "account",
          name: "target-user",
          source: "local",
        });

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("skip-cloud-account-sync-identity-mismatch")
            && line.includes("\"markerAccount\":\"cloud-user\"")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moving the current local account to cloud updates the current marker", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-move-current-marker-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_moving-user.json"), makeAuthFile("acct-moving"));
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-moving"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "move-current-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [movingItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "moving-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(movingItem);

        const marker = mocked.globalStateValues.get("codex-switchbridge.currentSavedSelection");
        assert.equal(marker.kind, "account");
        assert.equal(marker.name, "moving-user");
        assert.equal(marker.source, "cloud");
        assert.equal(marker.entryVersion, 1);
        assert.equal(typeof marker.updatedAt, "string");
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("moving-user"))?.ciphertext, "string");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual refresh still updates cloud tokens when automatic sync is disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-manual-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("refresh-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date().toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "refresh-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "refresh-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual cloud token refresh reloads newer synced tokens before consuming refresh token", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-manual-refresh-reload-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("refresh-reload-passphrase");
    const initialEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      { requireEncryption: true }
    );
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": initialEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "refresh-reload-passphrase",
      },
    });

    const authRequestBodies = [];
    const originalRequest = https.request;
    https.request = (requestOptions, handler) => {
      const hostname = requestOptions?.hostname;
      let requestBody = "";
      const responseBody =
        hostname === "auth.openai.com"
          ? JSON.stringify({
              access_token: "access-rotated",
              refresh_token: "refresh-rotated",
              id_token: makeJwt({
                email: "rotated@example.com",
                name: "rotated",
                "https://api.openai.com/auth": {
                  chatgpt_plan_type: "plus",
                },
              }),
            })
          : JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  reset_at: null,
                },
              },
            });

      const response = {
        statusCode: 200,
        on(event, listener) {
          if (event === "data") {
            setImmediate(() => listener(responseBody));
          }
          if (event === "end") {
            setImmediate(listener);
          }
          return response;
        },
      };

      const request = {
        on() {
          return request;
        },
        setTimeout() {
          return request;
        },
        destroy() {},
        write(chunk) {
          requestBody += String(chunk);
          return request;
        },
        end() {
          if (hostname === "auth.openai.com") {
            authRequestBodies.push(requestBody);
            if (requestBody.includes("refresh-cloud-old")) {
              response.statusCode = 401;
            }
          }
          handler(response);
        },
      };

      return request;
    };

    await withDisabledIntervals(async () => {
      try {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [staleCloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        core.setSavedAuthPassphrase("refresh-reload-passphrase");
        const newerEntry = core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-newer",
            refreshToken: "refresh-cloud-newer",
          }),
          { requireEncryption: true }
        );
        newerEntry.entryVersion = 2;
        newerEntry.updatedAt = "2026-05-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.accounts["sync-user"] = newerEntry;

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(staleCloudItem);

        assert.equal(authRequestBodies.length, 1, JSON.stringify({
          warnings: mocked.warningMessages,
          errors: mocked.errorMessages,
        }));
        assert.match(authRequestBodies[0], /refresh_token=refresh-cloud-newer/);
        assert.doesNotMatch(authRequestBodies[0], /refresh-cloud-old/);

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "refresh-reload-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-rotated", JSON.stringify({
          warnings: mocked.warningMessages,
          errors: mocked.errorMessages,
        }));
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(getCloudEnvelope(mocked.config, "account", "sync-user").entryVersion, 3);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      } finally {
        https.request = originalRequest;
      }
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual cloud token refresh persists rotated tokens after metadata conflict with same refresh token", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-manual-refresh-conflict-retry-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("refresh-conflict-passphrase");
    const initialEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      { requireEncryption: true }
    );
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": initialEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "refresh-conflict-passphrase",
      },
    });

    let conflictInjected = false;
    const originalRequest = https.request;
    https.request = (requestOptions, handler) => {
      const hostname = requestOptions?.hostname;
      const responseBody =
        hostname === "auth.openai.com"
          ? JSON.stringify({
              access_token: "access-rotated",
              refresh_token: "refresh-rotated",
              id_token: makeJwt({
                email: "rotated@example.com",
                name: "rotated",
                "https://api.openai.com/auth": {
                  chatgpt_plan_type: "plus",
                },
              }),
            })
          : JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  reset_at: null,
                },
              },
            });

      const response = {
        statusCode: 200,
        on(event, listener) {
          if (event === "data") {
            setImmediate(() => listener(responseBody));
          }
          if (event === "end") {
            setImmediate(listener);
          }
          return response;
        },
      };

      const request = {
        on() {
          return request;
        },
        setTimeout() {
          return request;
        },
        destroy() {},
        write() {
          return request;
        },
        end() {
          if (hostname === "auth.openai.com" && !conflictInjected) {
            conflictInjected = true;
            core.setSavedAuthPassphrase("refresh-conflict-passphrase");
            const conflictedEntry = core.serializeSavedValue(
              "saved_auth",
              makeAuthFile("acct-cloud", {
                accessToken: "access-cloud-metadata-only",
                refreshToken: "refresh-cloud-old",
              }),
              { requireEncryption: true }
            );
            conflictedEntry.entryVersion = 2;
            conflictedEntry.updatedAt = "2026-05-02T00:00:00.000Z";
            core.setSavedAuthPassphrase(null);
            mocked.config.syncedStorage.accounts["sync-user"] = conflictedEntry;
          }
          handler(response);
        },
      };

      return request;
    };

    await withDisabledIntervals(async () => {
      try {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

        assert.equal(conflictInjected, true);
        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "refresh-conflict-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(getCloudEnvelope(mocked.config, "account", "sync-user").entryVersion, 3);
        assert.equal(mocked.warningMessages.some((message) => /conflict/i.test(message.message ?? "")), false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      } finally {
        https.request = originalRequest;
      }
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer maintenance refreshes local tokens when remaining validity is below 120 hours", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-local-token-maintenance-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: nearExpiryAccessToken,
    refreshToken: "refresh-local-old",
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const refreshCoordinator = getRefreshCoordinator(context);
        assert.ok(refreshCoordinator);

        refreshCoordinator.scheduleQuotaRefresh({
          reason: "timer",
        });
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countAuthRefreshRequests(requestLog), 1);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-rotated");
        assert.equal(savedAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(currentAuth.tokens.access_token, "access-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer maintenance skips token refresh when token auto update is disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-token-maintenance-disabled-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: nearExpiryAccessToken,
    refreshToken: "refresh-local-old",
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
    tokenAutoUpdate: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const refreshCoordinator = getRefreshCoordinator(context);
        assert.ok(refreshCoordinator);

        refreshCoordinator.scheduleQuotaRefresh({
          reason: "timer",
        });
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countAuthRefreshRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(savedAuth.tokens.refresh_token, "refresh-local-old");
        assert.equal(currentAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(currentAuth.tokens.refresh_token, "refresh-local-old");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer maintenance refreshes cloud tokens while ignoring legacy auto-refresh device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-token-maintenance-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("maintenance-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
            refreshToken: "refresh-cloud-old",
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", "device-current"],
      autoRefreshDeviceName: "device-current",
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      proxy: "http://127.0.0.1:6128",
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "maintenance-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname("device-current", async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const refreshCoordinator = getRefreshCoordinator(context);
          assert.ok(refreshCoordinator);

          refreshCoordinator.scheduleQuotaRefresh({
            reason: "timer",
          });
          await waitForRefreshCoordinatorIdle(context);

          assert.equal(countAuthRefreshRequests(requestLog), 1);
          assert.equal(
            requestLog.find((request) => request.hostname === "auth.openai.com")?.proxyUrl,
            "http://127.0.0.1:6128/",
          );

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "maintenance-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer maintenance refreshes cloud tokens even when legacy auto-refresh device differs", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-token-maintenance-legacy-device-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("maintenance-skip-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
            refreshToken: "refresh-cloud-old",
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", currentDeviceName],
      autoRefreshDeviceName: "device-other",
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "maintenance-skip-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const refreshCoordinator = getRefreshCoordinator(context);
          assert.ok(refreshCoordinator);

          refreshCoordinator.scheduleQuotaRefresh({
            reason: "timer",
          });
          await waitForRefreshCoordinatorIdle(context);

          assert.equal(countAuthRefreshRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "maintenance-skip-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-rotated", JSON.stringify({
            warnings: mocked.warningMessages,
            errors: mocked.errorMessages,
          }));
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh leaves local tokens unchanged when the refresh token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-local-timer-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryRefreshToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: "access-local-old",
    refreshToken: nearExpiryRefreshToken,
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-local-old");
        assert.equal(savedAuth.tokens.refresh_token, nearExpiryRefreshToken);
        assert.equal(currentAuth.tokens.access_token, "access-local-old");
        assert.equal(currentAuth.tokens.refresh_token, nearExpiryRefreshToken);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh leaves local tokens unchanged when the access token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-local-near-expiry-access-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: nearExpiryAccessToken,
    refreshToken: "refresh-local-stable",
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(savedAuth.tokens.refresh_token, "refresh-local-stable");
        assert.equal(currentAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(currentAuth.tokens.refresh_token, "refresh-local-stable");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh leaves local tokens unchanged when the access token is expired", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-local-expired-access-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const expiredAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: expiredAccessToken,
    refreshToken: "refresh-local-stable",
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, expiredAccessToken);
        assert.equal(savedAuth.tokens.refresh_token, "refresh-local-stable");
        assert.equal(currentAuth.tokens.access_token, expiredAccessToken);
        assert.equal(currentAuth.tokens.refresh_token, "refresh-local-stable");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh keeps the local account unchanged", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-local-timer-refresh-disabled-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryRefreshToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: "access-local-old",
    refreshToken: nearExpiryRefreshToken,
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
    tokenAutoUpdate: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = getAccountTreeView(mocked);
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-local-old");
        assert.equal(savedAuth.tokens.refresh_token, nearExpiryRefreshToken);
        assert.equal(currentAuth.tokens.access_token, "access-local-old");
        assert.equal(currentAuth.tokens.refresh_token, nearExpiryRefreshToken);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh leaves cloud tokens unchanged when the refresh token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-timer-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("timer-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "timer-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "timer-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.notEqual(cloudAuth.tokens.refresh_token, "refresh-rotated");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh leaves cloud tokens unchanged when the access token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-near-expiry-access-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("timer-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
            refreshToken: "refresh-cloud-stable",
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "timer-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "timer-passphrase"
          );
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-stable");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer quota refresh leaves cloud tokens unchanged when the access token is expired", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-expired-access-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("expired-access-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
            refreshToken: "refresh-cloud-stable",
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "expired-access-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "expired-access-passphrase"
          );
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-stable");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("quota refresh does not refresh expired cloud access tokens", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-auto-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("auto-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "auto-passphrase",
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [cloudItem.account.id], {
            reason: "timer",
          });

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "auto-passphrase"
          );
          assert.notEqual(countUsageRequests(requestLog), 0);
          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("quota refresh does not update cloud auth even when sync metadata already exists", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-cloud-auto-throttle-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("throttle-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
            lastCloudTokenSync: new Date().toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "throttle-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [cloudItem.account.id], {
          reason: "timer",
        });

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "throttle-passphrase"
        );
        assert.notEqual(countUsageRequests(requestLog), 0);
        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate does not register devices when synced cloud state exists", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-no-device-register-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("device-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        sync: core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync", {
          lastRefresh: new Date().toISOString(),
          lastCloudTokenSync: new Date().toISOString(),
        }), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "device-passphrase",
      },
      cloudTokenAutoUpdate: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          assert.deepEqual(mocked.config.syncedStorage.devices, []);
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }

          const extensionAgain = loadExtensionWithMockedVscode(mocked.vscode);
          const contextAgain = createExtensionContext(mocked);
          await extensionAgain.activate(contextAgain);
          await waitForRefreshCoordinatorIdle(contextAgain);

          assert.deepEqual(mocked.config.syncedStorage.devices, []);

          for (const subscription of contextAgain.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate does not create a synced device entry when synced cloud state is empty", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-device-register-empty-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        assert.deepEqual(mocked.config.syncedStorage.devices, []);
        assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      });
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate ignores legacy synced devices without mutating cloud auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-legacy-devices-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("default-first-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other"],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "default-first-passphrase",
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "default-first-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, savedCloudAccessToken);
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.deepEqual(mocked.config.syncedStorage.devices, []);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("quota refresh preserves cloud auth while ignoring legacy selected device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-legacy-device-quota-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("explicit-select-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", currentDeviceName],
      autoRefreshDeviceName: currentDeviceName,
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "explicit-select-passphrase",
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await refreshQuotaThroughStore(context, accountTreeView.treeDataProvider, [cloudItem.account.id], {
            reason: "timer",
          });

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "explicit-select-passphrase"
          );
          assert.notEqual(countUsageRequests(requestLog), 0);
          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual cloud token refresh ignores legacy selected device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-legacy-device-manual-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("manual-override-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", currentDeviceName],
      autoRefreshDeviceName: "device-other",
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      httpProxy: "http://127.0.0.1:4128",
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "manual-override-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    const requestLog = [];
    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          let cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-override-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, savedCloudAccessToken);
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

          const accountTreeView = getAccountTreeView(mocked);
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          assert.equal(cloudItem.contextValue, "accountCloud");

          await mocked.registeredCommands.get("codex-routesync.refreshToken")(cloudItem);

          cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-override-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-rotated", JSON.stringify({
            warnings: mocked.warningMessages,
            errors: mocked.errorMessages,
          }));
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");
          assert.equal(
            requestLog.find((request) => request.hostname === "auth.openai.com")?.proxyUrl,
            "http://127.0.0.1:4128/",
          );
          assert.equal(mocked.warningMessages.length, 0);
          assert.equal(mocked.errorMessages.length, 0);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("legacy invalid selected auto-refresh device is ignored when quota refresh does not persist tokens", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-legacy-device-ignored-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("prompt-select-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other"],
      autoRefreshDeviceName: "device-missing",
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "prompt-select-passphrase",
      },
      quickPickResponses: [
        (items) => items.find((item) => item.deviceName === currentDeviceName),
      ],
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "prompt-select-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, savedCloudAccessToken);
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.deepEqual(mocked.config.syncedStorage.devices, []);
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("select auto-refresh device command is not registered", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-no-device-command-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
        devices: ["device-a", "device-b"],
        autoRefreshDeviceName: null,
      },
      quickPickResponses: [
        (items) => items.find((item) => item.deviceName === "device-b"),
      ],
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        assert.equal(mocked.registeredCommands.has("codex-routesync.selectAutoRefreshDevice"), false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      });
    });
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test(
  "history repair discovers an orphaned provider and ignores saved display names",
  historyRepairDiscoversOrphanedProvider,
);

test("missing account marker keeps duplicate local and cloud identities unattributed", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-marker-ambiguous-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "ambiguous-account-passphrase";
    const sharedAuth = makeAuthFile("acct-shared");
    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_duplicate.json"), sharedAuth);
    const cloudEntry = core.serializeSavedValue("saved_auth", sharedAuth, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 1;
    cloudEntry.updatedAt = "2026-08-11T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(sharedAuth, null, 2), "utf-8");

    const mocked = createVscodeMock({
      authDirectory: authDir,
      cloudTokenAutoUpdate: false,
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: { duplicate: cloudEntry },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365caa";
        const startedAt = Date.now() + 10;
        const sessionDir = path.join(codexHome, "sessions", "2026", "08", "11");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessionDir, `rollout-2026-08-11T00-00-00-${threadId}.jsonl`),
          `${JSON.stringify({
            timestamp: new Date(startedAt).toISOString(),
            type: "session_meta",
            payload: {
              id: threadId,
              timestamp: new Date(startedAt).toISOString(),
              model_provider: "openai",
            },
          })}\n${JSON.stringify(makeTokenCountRecord(40, new Date(startedAt + 10).toISOString()))}\n`,
          "utf-8",
        );
        await mocked.registeredCommands.get("codex-routesync.refreshUsage")();

        const dashboard = await mocked.readyDashboard();
        const dashboardState = dashboard.latestState();
        assert.equal(dashboardState?.usage.unattributedTokens, 33);
        assert.equal(dashboardState?.route.kind, "unknown");
        const accountTreeView = getAccountTreeView(mocked);
        const duplicateItems = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "duplicate");
        assert.equal(duplicateItems.length, 2);
        assert.equal(duplicateItems.some((item) => item.account.isCurrent), false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("missing account marker skips outgoing sync for ambiguous local and cloud identities", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-account-sync-ambiguous-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const passphrase = "ambiguous-account-sync-passphrase";
    const localAuth = makeAuthFile("acct-shared", {
      accessToken: "access-local-keep",
      refreshToken: "refresh-local-keep",
      extraFields: {
        [AUTH_UPDATED_AT_FIELD]: "2026-08-10T00:00:00.000Z",
      },
    });
    const cloudAuth = makeAuthFile("acct-shared", {
      accessToken: "access-cloud-keep",
      refreshToken: "refresh-cloud-keep",
      extraFields: {
        [AUTH_UPDATED_AT_FIELD]: "2026-08-11T00:00:00.000Z",
      },
    });
    const runtimeAuth = makeAuthFile("acct-shared", {
      accessToken: "access-runtime-new",
      refreshToken: "refresh-runtime-new",
      extraFields: {
        [AUTH_UPDATED_AT_FIELD]: "2026-08-12T00:00:00.000Z",
      },
    });

    core.setSavedAuthPassphrase(passphrase);
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_duplicate.json"), localAuth);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_target.json"),
      makeAuthFile("acct-target"),
    );
    const cloudEntry = core.serializeSavedValue("saved_auth", cloudAuth, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 3;
    cloudEntry.updatedAt = "2026-08-11T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(runtimeAuth, null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      cloudTokenAutoUpdate: false,
      secretValues: {
        [STORAGE_SECRET_KEY]: passphrase,
      },
      syncedStorage: {
        version: 1,
        accounts: { duplicate: cloudEntry },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const accountTreeView = getAccountTreeView(mocked);
        const [targetItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "target" && item.account.source === "local");
        assert.ok(targetItem);

        await mocked.registeredCommands.get("codex-routesync.useAccount")(targetItem);

        core.setSavedAuthPassphrase(passphrase);
        const savedLocal = core.readNamedAuth("duplicate");
        core.setSavedAuthPassphrase(null);
        assert.ok(savedLocal);
        assert.equal(savedLocal.tokens.access_token, "access-local-keep");
        assert.equal(savedLocal.tokens.refresh_token, "refresh-local-keep");
        assert.equal(savedLocal[AUTH_UPDATED_AT_FIELD], "2026-08-10T00:00:00.000Z");

        const savedCloud = readCloudAccount(mocked.config, "duplicate", passphrase);
        assert.equal(savedCloud.tokens.access_token, "access-cloud-keep");
        assert.equal(savedCloud.tokens.refresh_token, "refresh-cloud-keep");
        assert.equal(getCloudEnvelope(mocked.config, "account", "duplicate").entryVersion, 3);

        const lines = mocked.createdChannels.flatMap((channel) =>
          channel.entries.map((entry) => entry.line)
        );
        assert.equal(
          lines.some((line) => line.includes("skip-current-account-auth-sync-ambiguous")),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activation registers one unified route tree and focuses one dashboard panel when visible", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-usage-overview-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  writeTokenUsageSession(codexHome, 125);

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      language: "zh-TW",
    });
    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      assert.deepEqual([...mocked.treeViews.keys()], ["codexRouteSyncRoutes"]);
      assert.equal(mocked.webviewPanels.length, 0);
      const routesView = mocked.treeViews.get("codexRouteSyncRoutes");
      routesView.setVisible(true);
      assert.equal(mocked.webviewPanels.length, 1);
      routesView.setVisible(false);
      routesView.setVisible(true);
      assert.equal(mocked.webviewPanels.length, 1);

      const dashboard = await mocked.readyDashboard();
      assert.equal(mocked.webviewPanels.length, 1);
      assert.equal(dashboard.viewType, "codexRouteSync.dashboard");
      assert.equal(dashboard.showOptions, mocked.vscode.ViewColumn.Active);
      assert.equal(dashboard.latestState()?.usage.total.totalTokens, 75);
      assert.equal(dashboard.latestState()?.usage.compactTotal, "75");
      assert.deepEqual(dashboard.latestMessage()?.locale, {
        preference: "auto",
        effective: "zh-cn",
      });

      await mocked.registeredCommands.get("codex-routesync.openDashboard")();
      assert.equal(mocked.webviewPanels.length, 1);
      assert.deepEqual(dashboard.panel.revealCalls, [undefined, undefined, undefined]);

      assert.equal(
        extensionManifest.contributes.configuration.properties[
          "codex-switchbridge.language"
        ]?.type,
        "string",
      );

      dashboard.deliver({
        type: "dashboard.locale.set",
        requestId: "locale-en",
        preference: "en",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(mocked.configurationUpdates.at(-1), {
        key: "language",
        value: "en",
        target: mocked.vscode.ConfigurationTarget.Global,
      });
      assert.equal(
        extensionManifest.contributes.configuration.properties[
          "codex-switchbridge.language"
        ]?.type,
        "string",
      );
      assert.deepEqual(dashboard.latestMessage()?.locale, {
        preference: "en",
        effective: "en",
      });

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("unified route root lists accounts and API providers as sibling rows", async (t) => {
  const { codexHome, authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-flat-routes-",
  );
  const accountAuth = makeAuthFile("acct-flat-route");
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_account-route.json"), accountAuth);
  core.writeProviderProfile({
    kind: "provider",
    name: "api-route",
    auth: { OPENAI_API_KEY: "sk-flat-route" },
    config: {
      name: "api-route",
      base_url: "https://route.example.com/v1",
      wire_api: "responses",
    },
  });
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(accountAuth, null, 2), "utf-8");

  const mocked = createVscodeMock({ authDirectory: authDir });
  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      const routes = getRoutesTree(mocked);
      const roots = routes.getChildren();
      const account = roots.find((item) => item.account?.name === "account-route");
      const provider = roots.find((item) => item.provider?.name === "api-route");
      assert.ok(account);
      assert.ok(provider);
      assert.equal(routes.getParent(account), undefined);
      assert.equal(routes.getParent(provider), undefined);
      assert.equal(roots.some((item) => item.kind === "accounts" || item.kind === "providers"), false);
      assert.ok(routes.getChildren(account).some((item) => item.label === "Email"));
      assert.ok(routes.getChildren(provider).some((item) => item.label === "Status"));

      for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
    }),
  );
});

test("an initially visible unified route tree opens one dashboard during activation", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-visible-routes-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      visibleTreeViewIds: ["codexRouteSyncRoutes"],
    });
    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);
      assert.deepEqual([...mocked.treeViews.keys()], ["codexRouteSyncRoutes"]);
      assert.equal(mocked.webviewPanels.length, 1);
      mocked.treeViews.get("codexRouteSyncRoutes").setVisible(true);
      assert.equal(mocked.webviewPanels.length, 1);
      for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("expand all accounts reveals flat account rows through the unified tree", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-expand-routes-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(
    path.join(authDir, "auth_saved.json"),
    makeAuthFile("acct-expand-routes"),
  );
  core.setNamedAuthDir(undefined);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    const mocked = createVscodeMock({ authDirectory: authDir });
    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      await mocked.registeredCommands.get("codex-routesync.expandAllAccounts")();
      assert.ok(mocked.treeRevealCalls.length > 0);
      assert.ok(mocked.treeRevealCalls.every((call) => call.id === "codexRouteSyncRoutes"));
      assert.ok(mocked.treeRevealCalls.every((call) => call.options.expand === true));
      const routes = getRoutesTree(mocked);
      for (const { element } of mocked.treeRevealCalls) {
        assert.ok(element.account);
        assert.equal(routes.getParent(element), undefined);
      }

      for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refreshUsage reindexes rollout files and posts a newer dashboard state", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-refresh-usage-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  const rolloutPath = writeTokenUsageSession(codexHome, 100);

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const mocked = createVscodeMock({ authDirectory: authDir });
    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      const refreshUsage = mocked.registeredCommands.get("codex-routesync.refreshUsage");
      assert.equal(typeof refreshUsage, "function", "refreshUsage should be registered");
      const dashboard = await mocked.readyDashboard();
      const initialRevision = dashboard.posted.at(-1)?.revision ?? 0;
      fs.appendFileSync(
        rolloutPath,
        `${JSON.stringify(makeTokenCountRecord(275, "2025-01-02T03:06:00.000Z"))}\n`,
        "utf-8",
      );

      await refreshUsage();
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(dashboard.latestState()?.usage.total.totalTokens, 150);
      assert.ok(
        dashboard.posted.at(-1)?.revision > initialRevision,
        "refreshUsage should post a newer dashboard state",
      );

      const afterUsageRevision = dashboard.posted.at(-1)?.revision ?? 0;
      fs.appendFileSync(
        rolloutPath,
        `${JSON.stringify(makeTokenCountRecord(350, "2025-01-02T03:07:00.000Z"))}\n`,
        "utf-8",
      );
      const refreshDashboard = mocked.registeredCommands.get("codex-routesync.refreshDashboard");
      assert.equal(typeof refreshDashboard, "function", "refreshDashboard should be registered");
      await refreshDashboard();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(dashboard.latestState()?.usage.total.totalTokens, 188);
      assert.ok(dashboard.posted.at(-1)?.revision > afterUsageRevision);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("quota failure keeps attributed and overall token usage in the status bar", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-status-usage-quota-failure-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    const accountAuth = makeAuthFile("acct-status-usage");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), accountAuth);
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(accountAuth, null, 2), "utf-8");

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withFailingHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365cab";
        const startedAt = Date.now() + 10;
        const sessionDir = path.join(codexHome, "sessions", "2026", "08", "11");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessionDir, `rollout-2026-08-11T00-00-00-${threadId}.jsonl`),
          `${JSON.stringify({
            timestamp: new Date(startedAt).toISOString(),
            type: "session_meta",
            payload: {
              id: threadId,
              timestamp: new Date(startedAt).toISOString(),
              model_provider: "openai",
            },
          })}\n${JSON.stringify(makeTokenCountRecord(40, new Date(startedAt + 10).toISOString()))}\n`,
          "utf-8",
        );
        await mocked.registeredCommands.get("codex-routesync.refreshUsage")();
        await mocked.registeredCommands.get("codex-routesync.refreshQuota")();

        const quotaItem = mocked.createdStatusBarItems.find(
          (item) => item.command === "codex-routesync.refreshQuota",
        );
        assert.ok(quotaItem);
        assert.match(quotaItem.text, /33 tokens/);
        assert.match(String(quotaItem.tooltip), /Tracked local token usage: 33 tokens/);
        assert.match(String(quotaItem.tooltip), /Overall local token usage: 33 tokens/);
        assert.match(String(quotaItem.tooltip), /Quota: .*unavailable/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("provider tree masks API keys while the explicit copy command retains the value", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-provider-secret-tree-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const apiKey = "sk-live-super-secret-73Kx";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: apiKey },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({ authDirectory: authDir });
    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      const providerTreeView = getProviderTreeView(mocked);
      const providerItem = providerTreeView.treeDataProvider
        .getChildren()
        .find((item) => item.provider?.name === "proxy");
      assert.ok(providerItem);
      assert.equal(providerItem.id, "provider:local:proxy");
      assert.equal(providerItem.collapsibleState, mocked.vscode.TreeItemCollapsibleState.Collapsed);

      const apiKeyItem = providerTreeView.treeDataProvider
        .getChildren(providerItem)
        .find((item) => item.label === "OPENAI_API_KEY");
      assert.ok(apiKeyItem);
      assert.equal(apiKeyItem.id, "providerDetail:local:proxy:auth:OPENAI_API_KEY");
      assert.equal(apiKeyItem.collapsibleState, mocked.vscode.TreeItemCollapsibleState.None);
      assert.equal(apiKeyItem.contextValue, "providerCopyableField");
      const renderedText = [apiKeyItem.label, apiKeyItem.description, apiKeyItem.tooltip]
        .filter((value) => typeof value === "string")
        .join("\n");
      assert.doesNotMatch(renderedText, new RegExp(apiKey));
      assert.match(apiKeyItem.description, /^Configured \(/);

      await mocked.registeredCommands.get("codex-routesync.copyProviderField")(apiKeyItem);
      assert.deepEqual(mocked.clipboardWrites, [apiKey]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousNamedAuthDir;
    }
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("regression: a same-tick usage refresh preserves the current quota percentage", async (t) => {
  const { codexHome, authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-quota-usage-status-",
  );
  const accountAuth = makeAuthFile("acct-work");
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), accountAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(accountAuth, null, 2), "utf-8");
  writeTokenUsageSession(codexHome, 125);

  const mocked = createVscodeMock({
    authDirectory: authDir,
    showStatusBar: true,
    cloudTokenAutoUpdate: false,
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      try {
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const statusItem = mocked.createdStatusBarItems.find(
          (item) => item.command !== "codex-routesync.reloadWindow",
        );
        assert.ok(statusItem);
        assert.match(statusItem.text, /work: 90%/);
        assert.doesNotMatch(String(statusItem.tooltip), /Quota refresh pending/i);
      } finally {
        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }
    })
  );
});

test("regression: switching records the new usage selection before quota resolves", async (t) => {
  const { codexHome, authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-switch-usage-order-",
  );
  const alphaAuth = makeAuthFile("acct-alpha");
  const betaAuth = makeAuthFile("acct-beta");
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), alphaAuth);
  core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), betaAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(alphaAuth, null, 2), "utf-8");

  const mocked = createVscodeMock({
    authDirectory: authDir,
    showStatusBar: true,
    cloudTokenAutoUpdate: false,
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      let controlled;
      let idlePromise;
      try {
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        const accountTreeView = getAccountTreeView(mocked);
        const betaItem = getAccountTreeItems(accountTreeView.treeDataProvider)
          .find((item) => item.account.name === "beta" && item.account.source === "local");
        assert.ok(betaItem);

        controlled = installControlledQuotaHttps();
        await mocked.registeredCommands.get("codex-routesync.useAccount")(betaItem);
        idlePromise = waitForRefreshCoordinatorIdle(context);
        await controlled.requestStarted;

        const usageState = getLocalTokenUsageState(mocked.globalStateValues);
        assert.ok(usageState, "local usage tracking state should be persisted");
        assert.equal(
          usageState.timeline.at(-1)?.subjectId,
          stableSubjectId("account", "local:beta"),
          "the new account must be recorded while its quota request is still pending",
        );

        const startedAt = Date.now() + 20;
        writeTokenUsageSessionAt(codexHome, {
          threadId: "019e7bbd-eb68-7221-8bd9-7d9c51365cac",
          startedAt,
          tokenAt: startedAt + 10,
          totalTokens: 40,
        });
        controlled.release();
        controlled.restore();
        controlled = undefined;
        await idlePromise;
        idlePromise = undefined;

        const dashboard = await mocked.readyDashboard();
        const betaUsage = dashboard.latestState()?.usage.segments.find(
          (segment) => segment.kind === "account" && segment.label === "beta (Local)",
        );
        assert.ok(betaUsage, "the switched account should receive the new rollout usage");
        assert.equal(betaUsage.totalTokens, 33);
      } finally {
        controlled?.release();
        controlled?.restore();
        await idlePromise?.catch(() => {});
        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }
    })
  );
});

test("regression: provider switching persists usage selection before an automatic reload", async (t) => {
  const { codexHome, authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-provider-usage-reload-order-",
  );
  const accountAuth = makeAuthFile("acct-alpha");
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), accountAuth);
  core.writeProviderProfile({
    kind: "provider",
    name: "proxy",
    auth: { OPENAI_API_KEY: "sk-provider-usage-reload" },
    config: {
      name: "proxy",
      base_url: "https://proxy.example.com/v1",
      wire_api: "responses",
    },
  });
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(accountAuth, null, 2), "utf-8");

  const mocked = createVscodeMock({
    authDirectory: authDir,
    reloadWindowAfterSwitch: "always",
    shareHistoryAcrossProviders: true,
    cloudTokenAutoUpdate: false,
  });

  await withDisabledIntervals(async () => {
    const extension = loadExtensionWithMockedVscode(mocked.vscode);
    const context = createExtensionContext(mocked);
    try {
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);
      const providerTreeView = getProviderTreeView(mocked);
      const providerItem = providerTreeView.treeDataProvider
        .getChildren()
        .find((item) => item.provider?.name === "proxy" && item.provider?.source === "local");
      assert.ok(providerItem);

      const originalExecuteCommand = mocked.vscode.commands.executeCommand;
      let subjectAtReload = null;
      mocked.vscode.commands.executeCommand = async (name, ...args) => {
        if (name === "workbench.action.reloadWindow") {
          subjectAtReload = getLocalTokenUsageState(mocked.globalStateValues)
            ?.timeline?.at(-1)?.subjectId ?? null;
        }
        return originalExecuteCommand(name, ...args);
      };

      await mocked.registeredCommands.get("codex-routesync.switchProvider")(providerItem);

      assert.equal(
        subjectAtReload,
        stableSubjectId("provider", "local:proxy"),
        "the provider selection must be persisted before VS Code reloads the window",
      );
    } finally {
      await waitForRefreshCoordinatorIdle(context).catch(() => {});
      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    }
  });
});

test("regression: a stale quota response cannot overwrite a newer selection", async (t) => {
  const { codexHome, authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-status-quota-race-",
  );
  const alphaAuth = makeAuthFile("acct-alpha");
  const betaAuth = makeAuthFile("acct-beta");
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), alphaAuth);
  core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), betaAuth);
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(alphaAuth, null, 2), "utf-8");

  const mocked = createVscodeMock({
    authDirectory: authDir,
    showStatusBar: true,
    cloudTokenAutoUpdate: false,
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      let controlled;
      let staleRefreshPromise;
      try {
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        const accountTreeView = getAccountTreeView(mocked);
        const accounts = getAccountTreeItems(accountTreeView.treeDataProvider);
        const alphaItem = accounts.find(
          (item) => item.account.name === "alpha" && item.account.source === "local",
        );
        const betaItem = accounts.find(
          (item) => item.account.name === "beta" && item.account.source === "local",
        );
        assert.ok(alphaItem);
        assert.ok(betaItem);
        const statusItem = mocked.createdStatusBarItems.find(
          (item) => item.command !== "codex-routesync.reloadWindow",
        );
        assert.ok(statusItem);

        controlled = installControlledQuotaHttps();
        staleRefreshPromise = mocked.registeredCommands
          .get("codex-routesync.refreshQuota")(alphaItem);
        await controlled.requestStarted;
        await mocked.registeredCommands.get("codex-routesync.useAccount")(betaItem);
        assert.match(statusItem.text, /beta/);

        controlled.release();
        await staleRefreshPromise;
        staleRefreshPromise = undefined;
        assert.match(
          statusItem.text,
          /beta/,
          "the completed alpha request must not replace the newer beta status",
        );
      } finally {
        controlled?.release();
        await staleRefreshPromise?.catch(() => {});
        controlled?.restore();
        await waitForRefreshCoordinatorIdle(context).catch(() => {});
        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }
    })
  );
});

test("regression: provider details keep unique IDs for same-label built-in and auth fields", async (t) => {
  const { authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-provider-detail-ids-",
  );
  core.setNamedAuthDir(authDir);
  core.writeProviderProfile({
    kind: "provider",
    name: "proxy",
    auth: {
      OPENAI_API_KEY: "sk-provider-detail-id",
      Source: "auth-source",
    },
    config: {
      name: "proxy",
      base_url: "https://proxy.example.com/v1",
      wire_api: "responses",
    },
  });
  core.setNamedAuthDir(undefined);

  const mocked = createVscodeMock({ authDirectory: authDir });
  await withDisabledIntervals(async () => {
    const extension = loadExtensionWithMockedVscode(mocked.vscode);
    const context = createExtensionContext(mocked);
    try {
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);
      const providerTreeView = getProviderTreeView(mocked);
      const providerItem = providerTreeView.treeDataProvider
        .getChildren()
        .find((item) => item.provider?.name === "proxy");
      assert.ok(providerItem);
      const duplicateLabelItems = providerTreeView.treeDataProvider
        .getChildren(providerItem)
        .filter((item) => item.label === "Source");
      assert.equal(duplicateLabelItems.length, 2);
      assert.equal(
        new Set(duplicateLabelItems.map((item) => item.id)).size,
        duplicateLabelItems.length,
        "each provider detail row must expose a unique TreeItem ID",
      );
    } finally {
      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    }
  });
});

test("regression: provider-mode status bar refreshes the displayed token usage", async (t) => {
  const { authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-provider-status-command-",
  );
  core.setNamedAuthDir(authDir);
  core.writeProviderProfile({
    kind: "provider",
    name: "proxy",
    auth: { OPENAI_API_KEY: "sk-provider-status-command" },
    config: {
      name: "proxy",
      base_url: "https://proxy.example.com/v1",
      wire_api: "responses",
    },
  });
  const switchResult = core.switchMode("proxy");
  assert.equal(switchResult.success, true);
  core.setNamedAuthDir(undefined);

  const mocked = createVscodeMock({
    authDirectory: authDir,
    showStatusBar: true,
    cloudTokenAutoUpdate: false,
  });
  await withDisabledIntervals(async () => {
    const extension = loadExtensionWithMockedVscode(mocked.vscode);
    const context = createExtensionContext(mocked);
    try {
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);
      const statusItem = mocked.createdStatusBarItems.find(
        (item) => item.command !== "codex-routesync.reloadWindow",
      );
      assert.ok(statusItem);
      assert.match(statusItem.text, /proxy/i);
      const command = typeof statusItem.command === "string"
        ? statusItem.command
        : statusItem.command?.command;
      assert.equal(command, "codex-routesync.refreshUsage");
    } finally {
      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    }
  });
});

test("storage moves reject same-name destinations without changing credentials or usage", async (t) => {
  const { authDir } = createTempExtensionEnvironment(
    t,
    "csb-vscode-storage-move-collisions-",
  );
  const passphrase = "move-collision-passphrase";
  const accountToCloudLocal = makeAuthFile("acct-account-to-cloud-local", {
    accessToken: "access-account-to-cloud-local",
  });
  const accountToCloudRemote = makeAuthFile("acct-account-to-cloud-remote", {
    accessToken: "access-account-to-cloud-remote",
  });
  const accountToLocalLocal = makeAuthFile("acct-account-to-local-local", {
    accessToken: "access-account-to-local-local",
  });
  const accountToLocalRemote = makeAuthFile("acct-account-to-local-remote", {
    accessToken: "access-account-to-local-remote",
  });
  const providerToCloudLocal = {
    kind: "provider",
    name: "provider-to-cloud",
    auth: { OPENAI_API_KEY: "sk-provider-to-cloud-local" },
    config: {
      name: "provider-to-cloud",
      base_url: "https://provider-to-cloud-local.example.com/v1",
      wire_api: "responses",
    },
  };
  const providerToCloudRemote = {
    ...providerToCloudLocal,
    auth: { OPENAI_API_KEY: "sk-provider-to-cloud-remote" },
    config: {
      ...providerToCloudLocal.config,
      base_url: "https://provider-to-cloud-remote.example.com/v1",
    },
  };
  const providerToLocalLocal = {
    kind: "provider",
    name: "provider-to-local",
    auth: { OPENAI_API_KEY: "sk-provider-to-local-local" },
    config: {
      name: "provider-to-local",
      base_url: "https://provider-to-local-local.example.com/v1",
      wire_api: "responses",
    },
  };
  const providerToLocalRemote = {
    ...providerToLocalLocal,
    auth: { OPENAI_API_KEY: "sk-provider-to-local-remote" },
    config: {
      ...providerToLocalLocal.config,
      base_url: "https://provider-to-local-remote.example.com/v1",
    },
  };

  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_account-to-cloud.json"), accountToCloudLocal);
  core.writeSavedAuthFile(path.join(authDir, "auth_account-to-local.json"), accountToLocalLocal);
  core.writeProviderProfile(providerToCloudLocal);
  core.writeProviderProfile(providerToLocalLocal);
  core.setNamedAuthDir(undefined);
  core.setSavedAuthPassphrase(passphrase);
  const cloudAccounts = {
    "account-to-cloud": core.serializeSavedValue("saved_auth", accountToCloudRemote, {
      requireEncryption: true,
    }),
    "account-to-local": core.serializeSavedValue("saved_auth", accountToLocalRemote, {
      requireEncryption: true,
    }),
  };
  const cloudProviders = {
    "provider-to-cloud": core.serializeSavedValue("saved_provider", providerToCloudRemote, {
      requireEncryption: true,
    }),
    "provider-to-local": core.serializeSavedValue("saved_provider", providerToLocalRemote, {
      requireEncryption: true,
    }),
  };
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    authDirectory: authDir,
    secretValues: { [STORAGE_SECRET_KEY]: passphrase },
    syncedStorage: {
      version: 1,
      accounts: cloudAccounts,
      providers: cloudProviders,
    },
  });

  await withDisabledIntervals(async () => {
    const extension = loadExtensionWithMockedVscode(mocked.vscode);
    const context = createExtensionContext(mocked);
    try {
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);
      const accountTree = getAccountTreeView(mocked).treeDataProvider;
      const providerTree = getProviderTreeView(mocked).treeDataProvider;
      const accounts = getAccountTreeItems(accountTree);
      const providers = providerTree.getChildren();
      const accountToCloud = accounts.find((item) =>
        item.account.name === "account-to-cloud" && item.account.source === "local"
      );
      const accountToLocal = accounts.find((item) =>
        item.account.name === "account-to-local" && item.account.source === "cloud"
      );
      const providerToCloud = providers.find((item) =>
        item.provider?.name === "provider-to-cloud" && item.provider?.source === "local"
      );
      const providerToLocal = providers.find((item) =>
        item.provider?.name === "provider-to-local" && item.provider?.source === "cloud"
      );
      assert.ok(accountToCloud);
      assert.ok(accountToLocal);
      assert.ok(providerToCloud);
      assert.ok(providerToLocal);

      const localPaths = [
        path.join(authDir, "auth_account-to-cloud.json"),
        path.join(authDir, "auth_account-to-local.json"),
        path.join(authDir, "provider_provider-to-cloud.json"),
        path.join(authDir, "provider_provider-to-local.json"),
      ];
      const localBefore = localPaths.map((file) => fs.readFileSync(file, "utf8"));
      const cloudKeys = [
        getSyncedCloudAccountKey("account-to-cloud"),
        getSyncedCloudAccountKey("account-to-local"),
        getSyncedCloudProviderKey("provider-to-cloud"),
        getSyncedCloudProviderKey("provider-to-local"),
      ];
      const cloudBefore = cloudKeys.map((key) => structuredClone(mocked.globalStateValues.get(key)));
      const usageBefore = structuredClone(getLocalTokenUsageState(mocked.globalStateValues)?.remaps ?? {});

      await mocked.registeredCommands.get("codex-routesync.moveAccountToCloud")(accountToCloud);
      await mocked.registeredCommands.get("codex-routesync.moveAccountToLocal")(accountToLocal);
      await mocked.registeredCommands.get("codex-routesync.moveProviderToCloud")(providerToCloud);
      await mocked.registeredCommands.get("codex-routesync.moveProviderToLocal")(providerToLocal);

      assert.equal(mocked.errorMessages.length, 4);
      for (const { message } of mocked.errorMessages) assert.match(message, /already exists/i);
      assert.deepEqual(localPaths.map((file) => fs.readFileSync(file, "utf8")), localBefore);
      assert.deepEqual(
        cloudKeys.map((key) => mocked.globalStateValues.get(key)),
        cloudBefore,
      );
      assert.deepEqual(
        getLocalTokenUsageState(mocked.globalStateValues)?.remaps ?? {},
        usageBefore,
      );
    } finally {
      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    }
  });
});
