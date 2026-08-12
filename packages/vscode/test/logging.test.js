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
      createTreeView() {
        return createDisposable();
      },
      createStatusBarItem() {
        return {
          show() {},
          hide() {},
          dispose() {},
          text: "",
          tooltip: "",
          command: undefined,
          name: "",
        };
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
        assert.equal(section, "codex-switchbridge");
        return {
          get(_key, defaultValue) {
            return config[_key] ?? defaultValue;
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
      async get() {
        return undefined;
      },
      async store() {},
      async delete() {},
    },
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
      },
    },
  };
}

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

async function withSuccessfulHttps(fn) {
  const originalRequest = https.request;
  https.request = (requestOptions, handler) => {
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
  assert.equal(mocked.createdChannels[0].name, "Codex SwitchBridge");
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

  await mocked.registeredCommands.get("codex-switchbridge.showLogs")();

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

    await withDisabledIntervals(async () => {
      await withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-switchbridge.refreshQuota")();

        await runAssertions(mocked);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        extension.deactivate();
      });
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
