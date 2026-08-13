const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const core = require("@codex-switchbridge/core");
const SYNCED_CLOUD_STATE_KEY = "codex-switchbridge.syncedCloudState.v1";
const PERFORMANCE_LOG_PATTERN = / perf-(start|stage|finish|fail) /;

function createDisposable(fn = () => {}) {
  return {
    dispose: fn,
  };
}

function createVscodeMock() {
  const registeredCommands = new Map();
  const configurationListeners = new Set();
  const createdChannels = [];
  const createdPanels = [];
  const createdTreeViews = [];
  const createdStatusBarItems = [];
  const executedCommands = [];
  const secretOperations = [];
  const globalStateOperations = [];
  const extensionLookups = [];
  const extensionLookupErrors = new Map();
  const installedExtensions = new Map();
  const warningMessages = [];
  let warningMessageResult = Promise.resolve(undefined);
  const globalStoragePath = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-logging-global-storage-"));
  const globalStateValues = new Map([
    [SYNCED_CLOUD_STATE_KEY, {
      version: 1,
      accounts: {},
      providers: {},
      devices: [],
      autoRefreshDeviceName: null,
    }],
  ]);
  const config = {
    authDirectory: "",
    showStatusBar: false,
    quotaRefreshInterval: 30,
    detailedPerformanceLogging: false,
    syncedStorage: globalStateValues.get(SYNCED_CLOUD_STATE_KEY),
  };

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
    constructor(label) {
      this.label = label;
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
      registerWebviewViewProvider() {
        assert.fail("activation must not register a WebviewView provider");
      },
      createWebviewPanel() {
        createdPanels.push({});
        assert.fail("activation must not create the dashboard panel");
      },
      createTreeView(id) {
        const treeView = {
          ...createDisposable(),
          id,
          visible: false,
          onDidChangeVisibility() {
            return createDisposable();
          },
          reveal: async () => {},
        };
        createdTreeViews.push(treeView);
        return treeView;
      },
      createStatusBarItem() {
        const item = {
          show() {},
          hide() {},
          dispose() {},
          text: "",
          tooltip: "",
          command: undefined,
          name: "",
        };
        createdStatusBarItems.push(item);
        return item;
      },
      createOutputChannel(name, options) {
        const entries = [];
        let showCount = 0;
        let disposed = false;
        const channel = {
          name,
          options,
          entries,
          info(line) {
            entries.push({ level: "info", line });
          },
          warn(line) {
            entries.push({ level: "warn", line });
          },
          error(line) {
            entries.push({ level: "error", line });
          },
          show() {
            showCount += 1;
          },
          dispose() {
            disposed = true;
          },
          get showCount() {
            return showCount;
          },
          get disposed() {
            return disposed;
          },
        };
        createdChannels.push(channel);
        return channel;
      },
      createTerminal() {
        return {
          show() {},
          sendText() {},
        };
      },
      async showInputBox() {
        return undefined;
      },
      showWarningMessage(message, ...items) {
        warningMessages.push({ message, items });
        return warningMessageResult;
      },
      async showInformationMessage() {
        return undefined;
      },
      async showErrorMessage() {
        return undefined;
      },
      async showQuickPick() {
        return undefined;
      },
      async withProgress(_options, task) {
        return task();
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.ok(section === "codex-switchbridge" || section === "http");
        return {
          get(_key, defaultValue) {
            return section === "codex-switchbridge"
              ? config[_key] ?? defaultValue
              : defaultValue;
          },
          async update(key, value) {
            config[key] = value;
            const event = {
              affectsConfiguration(target) {
                return target === `codex-switchbridge.${key}`;
              },
            };
            for (const listener of configurationListeners) {
              listener(event, value);
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
        const command = registeredCommands.get(name);
        return command ? command(...args) : undefined;
      },
    },
    extensions: {
      getExtension(extensionId) {
        extensionLookups.push(extensionId);
        const error = extensionLookupErrors.get(extensionId);
        if (error) {
          throw error;
        }
        return installedExtensions.get(extensionId);
      },
    },
    env: {
      language: "en",
      clipboard: {
        async writeText() {},
      },
    },
    Uri: {
      file(filePath) {
        return { fsPath: filePath };
      },
    },
  };

  return {
    vscode,
    registeredCommands,
    createdChannels,
    createdPanels,
    createdTreeViews,
    createdStatusBarItems,
    executedCommands,
    configurationListeners,
    secretOperations,
    globalStateOperations,
    extensionLookups,
    extensionLookupErrors,
    installedExtensions,
    warningMessages,
    setWarningMessageResult(result) {
      warningMessageResult = result;
    },
    config,
    globalStoragePath,
    secrets: {
      async get(key) {
        secretOperations.push({ operation: "get", key });
        return undefined;
      },
      async store(key, value) {
        secretOperations.push({ operation: "store", key, value });
      },
      async delete(key) {
        secretOperations.push({ operation: "delete", key });
      },
    },
    globalState: {
      get(key) {
        globalStateOperations.push({ operation: "get", key });
        return globalStateValues.get(key);
      },
      setKeysForSync(keys) {
        globalStateOperations.push({ operation: "setKeysForSync", keys: [...keys] });
        this.syncedKeys = [...keys];
      },
      async update(key, value) {
        globalStateOperations.push({ operation: "update", key, value });
        if (value === undefined) {
          globalStateValues.delete(key);
        } else {
          globalStateValues.set(key, value);
        }
      },
    },
  };
}

test("installed previous extension blocks activation and offers its Extensions search", async (t) => {
  const mocked = createVscodeMock();
  mocked.installedExtensions.set("baoshichao001-dev.codex-switchbridge", { isActive: false });
  mocked.setWarningMessageResult(Promise.resolve("Open Previous Extension"));
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  t.after(() => {
    for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
    extension.deactivate();
  });

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(mocked.extensionLookups, ["baoshichao001-dev.codex-switchbridge"]);
  assert.equal(mocked.warningMessages.length, 1);
  assert.match(mocked.warningMessages[0].message, /previous/i);
  assert.match(mocked.warningMessages[0].message, /Codex RouteSync/);
  assert.match(mocked.warningMessages[0].message, /synced\/cloud accounts and API providers/i);
  assert.match(mocked.warningMessages[0].message, /move.*to Local/i);
  assert.match(mocked.warningMessages[0].message, /disable or uninstall/i);
  assert.match(mocked.warningMessages[0].message, /reload/i);
  assert.ok(
    mocked.warningMessages[0].message.indexOf("Move")
      < mocked.warningMessages[0].message.indexOf("disable or uninstall"),
    "the warning must require local migration before disabling the legacy extension",
  );
  assert.deepEqual(mocked.warningMessages[0].items, ["Open Previous Extension"]);
  assert.deepEqual(mocked.executedCommands, [{
    name: "workbench.extensions.search",
    args: ["@id:baoshichao001-dev.codex-switchbridge"],
  }]);
  assert.equal(mocked.registeredCommands.size, 0);
  assert.equal(mocked.createdTreeViews.length, 0);
  assert.equal(mocked.createdStatusBarItems.length, 0);
  assert.equal(mocked.createdChannels.length, 0);
  assert.equal(mocked.createdPanels.length, 0);
  assert.equal(context.subscriptions.length, 0);
  assert.equal(mocked.configurationListeners.size, 0);
  assert.deepEqual(mocked.secretOperations, []);
  assert.deepEqual(mocked.globalStateOperations, []);
});

test("legacy guard does not wait for warning dismissal", async () => {
  const mocked = createVscodeMock();
  mocked.installedExtensions.set("baoshichao001-dev.codex-switchbridge", { isActive: true });
  mocked.setWarningMessageResult(new Promise(() => {}));
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await Promise.race([
    extension.activate(context),
    new Promise((_, reject) => setTimeout(() => reject(new Error("legacy guard waited for warning dismissal")), 250)),
  ]);

  assert.equal(mocked.warningMessages.length, 1);
  assert.equal(context.subscriptions.length, 0);
});

test("installed 0.8.0 replacement identity also blocks RouteSync activation", async (t) => {
  const mocked = createVscodeMock();
  mocked.installedExtensions.set("ShawBob001.codex-switchbridge-vscode", { isActive: false });
  mocked.setWarningMessageResult(Promise.resolve("Open Previous Extension"));
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  t.after(() => {
    for (const subscription of context.subscriptions.reverse()) subscription?.dispose?.();
    extension.deactivate();
  });

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(mocked.extensionLookups, [
    "baoshichao001-dev.codex-switchbridge",
    "ShawBob001.codex-switchbridge-vscode",
  ]);
  assert.equal(mocked.warningMessages.length, 1);
  assert.match(mocked.warningMessages[0].message, /Codex RouteSync/);
  assert.deepEqual(mocked.warningMessages[0].items, ["Open Previous Extension"]);
  assert.deepEqual(mocked.executedCommands, [{
    name: "workbench.extensions.search",
    args: ["@id:ShawBob001.codex-switchbridge-vscode"],
  }]);
  assert.equal(mocked.registeredCommands.size, 0);
  assert.equal(mocked.createdTreeViews.length, 0);
  assert.equal(mocked.createdStatusBarItems.length, 0);
  assert.equal(mocked.createdChannels.length, 0);
  assert.deepEqual(mocked.secretOperations, []);
  assert.deepEqual(mocked.globalStateOperations, []);
});

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function makeAuthFile(accountId, options = {}) {
  const email = options.email ?? `${accountId}@example.com`;
  const plan = options.plan ?? "plus";
  return {
    ...(options.lastRefresh ? { last_refresh: options.lastRefresh } : {}),
    tokens: {
      access_token: options.accessToken ?? "access-token",
      refresh_token: options.refreshToken ?? "refresh-token",
      account_id: accountId,
      id_token: makeJwt({
        email,
        name: options.name ?? accountId,
        "https://api.openai.com/auth": {
          chatgpt_plan_type: plan,
        },
      }),
    },
  };
}

async function withDisabledIntervals(fn) {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const zeroTimeouts = [];
  global.setInterval = () => ({ __mockInterval: true });
  global.clearInterval = () => {};
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
    return await fn({ flushTimers });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

async function withSuccessfulHttps(fn, requestLog = []) {
  const originalRequest = https.request;
  https.request = (requestOptions, handler) => {
    requestLog.push(requestOptions);
    const hostname = requestOptions?.hostname;
    const body =
      hostname === "auth.openai.com"
        ? JSON.stringify({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            id_token: makeJwt({
              email: "perf@example.com",
              name: "perf-user",
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
                limit_window_seconds: 18000,
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

test("activate creates a dedicated VS Code log channel and writes startup logs into it", async () => {
  const mocked = createVscodeMock();
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });

  assert.equal(mocked.createdChannels.length, 1);
  assert.equal(mocked.createdPanels.length, 0);
  assert.equal(mocked.createdChannels[0].name, "Codex RouteSync");
  assert.deepEqual(mocked.createdChannels[0].options, { log: true });
  assert.ok(mocked.createdChannels[0].entries.length > 0);
  assert.ok(
    mocked.createdChannels[0].entries.some((entry) =>
      /\[codex-switchbridge:vscode:extension\] activate-start/.test(entry.line)
    )
  );

  extension.deactivate();
  assert.equal(mocked.createdChannels[0].disposed, true);
});

test("activate aggregates active auth-writing extensions into one non-blocking warning", async () => {
  const mocked = createVscodeMock();
  mocked.installedExtensions.set("wannanbigpig.codex-accounts-manager", { isActive: true });
  mocked.installedExtensions.set("techfetch-dev.codex-account-switch-vscode", { isActive: true });
  mocked.setWarningMessageResult(new Promise(() => {}));
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await Promise.race([
      extension.activate(context),
      new Promise((_, reject) => setTimeout(() => reject(new Error("activation waited for warning dismissal")), 250)),
    ]);
  });

  assert.deepEqual(mocked.extensionLookups, [
    "baoshichao001-dev.codex-switchbridge",
    "ShawBob001.codex-switchbridge-vscode",
    "wannanbigpig.codex-accounts-manager",
    "techfetch-dev.codex-account-switch-vscode",
  ]);
  assert.equal(mocked.warningMessages.length, 1);
  assert.match(mocked.warningMessages[0].message, /auth\/config/i);
  assert.match(mocked.warningMessages[0].message, /unauthorized/i);
  assert.match(mocked.warningMessages[0].message, /disable or uninstall/i);
  assert.match(mocked.warningMessages[0].message, /Reload Window/);
  assert.match(mocked.warningMessages[0].message, /wannanbigpig\.codex-accounts-manager/);
  assert.match(mocked.warningMessages[0].message, /techfetch-dev\.codex-account-switch-vscode/);
  assert.ok(
    mocked.createdChannels[0].entries.some((entry) =>
      entry.level === "warn"
      && entry.line.includes("conflicting-extensions-detected")
      && entry.line.includes('"extensionIds":["wannanbigpig.codex-accounts-manager","techfetch-dev.codex-account-switch-vscode"]')
    )
  );

  extension.deactivate();
});

test("activate ignores installed auth-writing extensions that are not active", async () => {
  const mocked = createVscodeMock();
  mocked.installedExtensions.set("wannanbigpig.codex-accounts-manager", { isActive: false });
  mocked.installedExtensions.set("techfetch-dev.codex-account-switch-vscode", { isActive: false });
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });

  assert.equal(mocked.warningMessages.length, 0);
  assert.equal(
    mocked.createdChannels[0].entries.some((entry) => entry.line.includes("conflicting-extensions-detected")),
    false
  );

  extension.deactivate();
});

test("activate continues conflict detection when one extension lookup throws", async () => {
  const mocked = createVscodeMock();
  mocked.extensionLookupErrors.set(
    "wannanbigpig.codex-accounts-manager",
    new Error("extension registry unavailable")
  );
  mocked.installedExtensions.set("techfetch-dev.codex-account-switch-vscode", { isActive: true });
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });

  assert.deepEqual(mocked.extensionLookups, [
    "baoshichao001-dev.codex-switchbridge",
    "ShawBob001.codex-switchbridge-vscode",
    "wannanbigpig.codex-accounts-manager",
    "techfetch-dev.codex-account-switch-vscode",
  ]);
  assert.equal(mocked.warningMessages.length, 1);
  assert.doesNotMatch(mocked.warningMessages[0].message, /wannanbigpig\.codex-accounts-manager/);
  assert.match(mocked.warningMessages[0].message, /techfetch-dev\.codex-account-switch-vscode/);
  assert.ok(
    mocked.createdChannels[0].entries.some((entry) =>
      entry.level === "warn"
      && entry.line.includes("conflicting-extension-check-failed")
      && entry.line.includes('"extensionId":"wannanbigpig.codex-accounts-manager"')
      && entry.line.includes('"error":"extension registry unavailable"')
    )
  );

  extension.deactivate();
});

test("showLogs command reveals the dedicated VS Code log channel", async () => {
  const mocked = createVscodeMock();
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });

  await mocked.registeredCommands.get("codex-routesync.showLogs")();

  assert.equal(mocked.createdChannels.length, 1);
  assert.equal(mocked.createdChannels[0].showCount, 1);

  extension.deactivate();
});

async function withAccountRefreshLoggingScenario(options, runAssertions) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vscode-perf-logging-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_perf-user.json"), makeAuthFile("acct-perf", {
      lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      name: "perf-user",
    }));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-perf", { name: "perf-user" }), null, 2),
      "utf-8"
    );

    const mocked = createVscodeMock();
    mocked.config.authDirectory = authDir;
    mocked.config.showStatusBar = true;
    mocked.config.detailedPerformanceLogging = options.detailedPerformanceLogging;
    if (options.proxy !== undefined) mocked.config.proxy = options.proxy;

    await withDisabledIntervals(async () => {
      const requestLog = [];
      await withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-routesync.refreshQuota")();

        await runAssertions(mocked, requestLog);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        extension.deactivate();
      }, requestLog);
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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("default performance logging suppresses performance entries", async () => {
  await withAccountRefreshLoggingScenario({ detailedPerformanceLogging: false }, async (mocked) => {
    const lines = mocked.createdChannels[0].entries.map((entry) => entry.line);
    assert.equal(lines.some((line) => PERFORMANCE_LOG_PATTERN.test(line)), false);
  });
});

test("debug performance logging emits account refresh timings to the output channel", async () => {
  await withAccountRefreshLoggingScenario({ detailedPerformanceLogging: true }, async (mocked) => {
    const lines = mocked.createdChannels[0].entries.map((entry) => entry.line);
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"durationMs\":")),
      true
    );
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"stage\":")),
      true
    );
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"querySavedAccountQuota\"") && line.includes("\"stage\":")),
      true
    );
  });
});

test("configured quota proxy reaches saved-account requests without entering logs", async () => {
  const secret = "extension-proxy-secret";
  await withAccountRefreshLoggingScenario(
    {
      detailedPerformanceLogging: true,
      proxy: `http://alice:${secret}@proxy.example:3128`,
    },
    async (mocked, requestLog) => {
      const usageRequest = requestLog.find((request) => request.hostname === "chatgpt.com");
      assert.ok(usageRequest);
      assert.equal(usageRequest.agent?.proxy?.hostname, "proxy.example");
      assert.doesNotMatch(
        mocked.createdChannels[0].entries.map((entry) => entry.line).join("\n"),
        new RegExp(`${secret}|proxy\\.example|alice`),
      );
    },
  );
});

test("account command diagnostics never contain decoded email addresses", () => {
  const commandsSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "commands.ts"),
    "utf-8",
  );
  assert.doesNotMatch(commandsSource, /\bemail:\s*result\.meta\?\.email/);
  assert.match(commandsSource, /hasEmail:\s*Boolean\(result\.meta\?\.email\)/);
});
