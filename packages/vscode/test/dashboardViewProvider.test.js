const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function disposable(dispose = () => {}) {
  return { dispose };
}

function eventSource() {
  const listeners = new Set();
  return {
    event(listener) {
      listeners.add(listener);
      return disposable(() => listeners.delete(listener));
    },
    fire(value) {
      for (const listener of [...listeners]) listener(value);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function uri(path) {
  return {
    path,
    toString() { return `file://${path}`; },
  };
}

const createdPanels = [];
let pendingPostResults = [[true]];

function createWebviewPanel(postResults = [true]) {
  const messages = eventSource();
  const viewState = eventSource();
  const disposal = eventSource();
  const posted = [];
  const webview = {
    options: undefined,
    html: "",
    cspSource: "vscode-webview://test-source",
    asWebviewUri(resource) {
      return { toString: () => `vscode-resource:${resource.path}` };
    },
    postMessage(message) {
      posted.push(message);
      const result = postResults.length > 1 ? postResults.shift() : postResults[0];
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    onDidReceiveMessage: messages.event,
  };
  const panel = {
    visible: true,
    active: true,
    webview,
    revealCalls: [],
    disposed: false,
    onDidChangeViewState: viewState.event,
    onDidDispose: disposal.event,
    reveal(column) {
      this.revealCalls.push(column);
      this.visible = true;
      this.active = true;
      viewState.fire({ webviewPanel: this });
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      disposal.fire(undefined);
    },
  };
  return {
    panel,
    posted,
    deliver: (message) => messages.fire(message),
    setVisible(value) {
      panel.visible = value;
      panel.active = value;
      viewState.fire({ webviewPanel: panel });
    },
    dispose: () => panel.dispose(),
    listenerCounts: () => ({
      messages: messages.listenerCount,
      viewState: viewState.listenerCount,
      disposal: disposal.listenerCount,
    }),
  };
}

const vscodeMock = {
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath(base, ...segments) {
      return uri([base.path.replace(/\/$/, ""), ...segments].join("/"));
    },
  },
  window: {
    createWebviewPanel(viewType, title, showOptions, options) {
      const created = createWebviewPanel(pendingPostResults.shift() ?? [true]);
      created.createArgs = { viewType, title, showOptions, options };
      createdPanels.push(created);
      return created.panel;
    },
  },
};

const originalLoad = Module._load;
Module._load = function mockVscode(request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { DashboardViewProvider } = require("../dist/dashboardViewProvider.js");
Module._load = originalLoad;

function createHarness(options = {}) {
  createdPanels.length = 0;
  pendingPostResults = options.postResultsByPanel ?? [[true]];
  const changes = eventSource();
  let model = {
    marker: "initial",
    accounts: [{ id: "local:a" }, { id: "cloud:locked" }],
  };
  let locale = { preference: "auto", effective: "en" };
  const calls = [];
  const localeCalls = [];
  const actionErrors = [];
  let localeErrors = 0;
  let visibleRefreshes = 0;
  let modelFailures = 0;
  let modelErrors = 0;
  let freshTargetIds = ["local:a", "cloud:locked"];
  let localeSetter = (preference) => {
    localeCalls.push(preference);
    locale = { preference, effective: preference === "zh-cn" ? "zh-cn" : "en" };
  };
  const handlers = Object.fromEntries([
    "refreshDashboard",
    "switchMode",
    "configureAutoSwitch",
    "addAccount",
    "addProvider",
    "useRateLimitReset",
    "reloadWindow",
  ].map((name) => [name, () => calls.push([name])]));
  handlers.setAutoSwitch = (enabled) => calls.push(["setAutoSwitch", enabled]);
  handlers.reloginAccount = (targetId) => calls.push(["reloginAccount", targetId]);
  handlers.unlockStorage = (targetId) => calls.push(["unlockStorage", targetId]);

  const provider = new DashboardViewProvider({
    extensionUri: uri("/extension"),
    getModel: () => {
      if (modelFailures > 0) {
        modelFailures -= 1;
        throw new Error("model build failed");
      }
      return model;
    },
    getLocale: () => locale,
    setLanguagePreference: (preference) => localeSetter(preference),
    subscribe: changes.event,
    getTargetIds: (current) => current.accounts.map((account) => account.id),
    getFreshTargetIds: () => freshTargetIds,
    handlers,
    onActionError: (action) => actionErrors.push(action),
    onLocaleError: () => { localeErrors += 1; },
    onModelError: () => { modelErrors += 1; },
    shouldRefreshVisibleModel: (current) => current.marker === "needs-refresh",
    requestVisibleRefresh: () => { visibleRefreshes += 1; },
  });
  return {
    provider,
    changes,
    calls,
    localeCalls,
    actionErrors,
    show() {
      provider.show();
      return createdPanels.at(-1);
    },
    setModel(next) { model = next; },
    setLocale(next) { locale = next; },
    setLocaleSetter(next) { localeSetter = next; },
    setFreshTargetIds(next) { freshTargetIds = next; },
    failNextModelBuild() { modelFailures += 1; },
    get visibleRefreshes() { return visibleRefreshes; },
    get localeErrors() { return localeErrors; },
    get modelErrors() { return modelErrors; },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("constructing is lazy, while show creates and reveals one editor panel", () => {
  const harness = createHarness();
  assert.equal(createdPanels.length, 0);
  assert.equal(harness.changes.listenerCount, 1);

  const first = harness.show();
  assert.equal(createdPanels.length, 1);
  assert.equal(first.createArgs.viewType, "codexRouteSync.dashboard");
  assert.equal(first.createArgs.title, "Codex RouteSync");
  assert.equal(first.createArgs.showOptions, vscodeMock.ViewColumn.Active);
  assert.deepEqual(
    first.createArgs.options.localResourceRoots.map((root) => root.path),
    ["/extension/dist/webview"],
  );
  assert.equal(first.createArgs.options.enableScripts, true);
  assert.equal(first.createArgs.options.enableForms, false);
  assert.equal(first.createArgs.options.enableCommandUris, false);
  assert.equal(first.createArgs.options.enableFindWidget, true);
  assert.equal(first.createArgs.options.retainContextWhenHidden, false);

  harness.provider.show();
  assert.equal(createdPanels.length, 1);
  assert.deepEqual(first.panel.revealCalls, [undefined]);
  harness.provider.dispose();
});

test("show configures a local-only webview and nonce CSP shell", () => {
  const harness = createHarness();
  const created = harness.show();

  const html = created.panel.webview.html;
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src vscode-webview:\/\/test-source data:/);
  assert.match(html, /style-src vscode-webview:\/\/test-source/);
  assert.match(html, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /vscode-resource:\/extension\/dist\/webview\/dashboard\.css/);
  assert.match(html, /vscode-resource:\/extension\/dist\/webview\/dashboard\.js/);
  assert.doesNotMatch(html, /unsafe-inline|command:|https?:\/\//);
  assert.doesNotMatch(html, /"marker"|"initial"/);
  harness.provider.dispose();
});

test("closing releases panel listeners and a later show creates a new panel", () => {
  const harness = createHarness();
  const first = harness.show();
  assert.deepEqual(first.listenerCounts(), { messages: 1, viewState: 1, disposal: 1 });

  first.dispose();
  assert.deepEqual(first.listenerCounts(), { messages: 0, viewState: 0, disposal: 0 });
  const second = harness.show();
  assert.equal(createdPanels.length, 2);
  assert.notEqual(second.panel, first.panel);
  harness.provider.dispose();
});

test("ready posts the latest state, includes locale, and bursty changes coalesce", async () => {
  const harness = createHarness();
  const created = harness.show();

  harness.setModel({ marker: "before-ready", accounts: [{ id: "local:a" }] });
  harness.setLocale({ preference: "auto", effective: "zh-cn" });
  harness.changes.fire();
  harness.changes.fire();
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  assert.equal(created.posted.length, 1);
  assert.equal(created.posted[0].type, "dashboard.state");
  assert.equal(created.posted[0].state.marker, "before-ready");
  assert.deepEqual(created.posted[0].locale, { preference: "auto", effective: "zh-cn" });

  harness.setModel({ marker: "old", accounts: [{ id: "local:a" }] });
  harness.changes.fire();
  harness.setModel({ marker: "latest", accounts: [{ id: "local:a" }] });
  harness.changes.fire();
  harness.changes.fire();
  await flushMicrotasks();

  assert.equal(created.posted.length, 2);
  assert.equal(created.posted[1].state.marker, "latest");
  assert.ok(created.posted[1].revision > created.posted[0].revision);
  harness.provider.dispose();
});

test("every repeated ready marks dirty and posts the latest state", async () => {
  const harness = createHarness();
  const created = harness.show();
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  harness.setModel({ marker: "latest-after-reload", accounts: [] });
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  assert.equal(created.posted.length, 2);
  assert.equal(created.posted[1].state.marker, "latest-after-reload");
  harness.provider.dispose();
});

test("hidden panels stop delivery and require a new ready after becoming visible", async () => {
  const harness = createHarness();
  const created = harness.show();
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  created.setVisible(false);
  harness.setModel({ marker: "hidden", accounts: [] });
  harness.changes.fire();
  await flushMicrotasks();
  assert.equal(created.posted.length, 1);

  created.setVisible(true);
  await flushMicrotasks();
  assert.equal(created.posted.length, 1);
  harness.setModel({ marker: "newest", accounts: [] });
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();
  assert.equal(created.posted.length, 2);
  assert.equal(created.posted[1].state.marker, "newest");
  harness.provider.dispose();
});

test("routes only fixed actions and allows current fresh target IDs", async () => {
  const harness = createHarness();
  const created = harness.show();

  created.deliver({
    type: "dashboard.action",
    requestId: "1",
    action: "setAutoSwitch",
    enabled: true,
  });
  created.deliver({
    type: "dashboard.action",
    requestId: "2",
    action: "useRateLimitReset",
  });
  created.deliver({
    type: "dashboard.action",
    requestId: "2b",
    action: "reloginAccount",
    targetId: "local:a",
  });
  created.deliver({
    type: "dashboard.action",
    requestId: "3",
    action: "unlockStorage",
    targetId: "missing",
  });
  created.deliver({
    type: "dashboard.action",
    requestId: "4",
    action: "workbench.action.reloadWindow",
  });
  await flushMicrotasks();

  assert.deepEqual(harness.calls, [
    ["setAutoSwitch", true],
    ["useRateLimitReset"],
    ["reloginAccount", "local:a"],
  ]);

  harness.setModel({ marker: "changed", accounts: [] });
  created.deliver({
    type: "dashboard.action",
    requestId: "5",
    action: "reloginAccount",
    targetId: "local:a",
  });
  harness.setModel({ marker: "model-still-allows", accounts: [{ id: "local:a" }] });
  harness.setFreshTargetIds([]);
  created.deliver({
    type: "dashboard.action",
    requestId: "6",
    action: "reloginAccount",
    targetId: "local:a",
  });
  await flushMicrotasks();
  assert.equal(harness.calls.length, 3);
  harness.provider.dispose();
});

test("locale set calls only its setter and invalidates the successful result", async () => {
  const harness = createHarness();
  const created = harness.show();
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  created.deliver({
    type: "dashboard.locale.set",
    requestId: "locale-1",
    preference: "zh-cn",
  });
  await flushMicrotasks();

  assert.deepEqual(harness.localeCalls, ["zh-cn"]);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.actionErrors, []);
  assert.deepEqual(created.posted.at(-1).locale, { preference: "zh-cn", effective: "zh-cn" });
  harness.provider.dispose();
});

test("locale setter failures are contained and reported without action dispatch", async () => {
  for (const failure of ["sync", "async"]) {
    const harness = createHarness();
    const created = harness.show();
    harness.setLocaleSetter(() => {
      if (failure === "sync") throw new Error("locale update failed");
      return Promise.reject(new Error("locale update failed"));
    });

    assert.doesNotThrow(() => created.deliver({
      type: "dashboard.locale.set",
      requestId: `locale-${failure}`,
      preference: "zh-cn",
    }));
    await flushMicrotasks();

    assert.equal(harness.localeErrors, 1);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.actionErrors, []);
    harness.provider.dispose();
  }
});

test("contains synchronous action failures and reports the fixed action", async () => {
  const harness = createHarness();
  harness.provider.options.handlers.refreshDashboard = () => {
    throw new Error("synchronous action failure");
  };
  const created = harness.show();

  assert.doesNotThrow(() => created.deliver({
    type: "dashboard.action",
    requestId: "sync-failure",
    action: "refreshDashboard",
  }));
  await flushMicrotasks();

  assert.deepEqual(harness.actionErrors, ["refreshDashboard"]);
  harness.provider.dispose();
});

test("retries the latest state when webview delivery returns false or rejects", async () => {
  for (const firstFailure of [false, new Error("delivery failed")]) {
    const harness = createHarness({ postResultsByPanel: [[firstFailure, true]] });
    const created = harness.show();
    created.deliver({ type: "dashboard.ready" });
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(created.posted.length, 2);
    assert.equal(created.posted.at(-1).state.marker, "initial");
    harness.provider.dispose();
  }
});

test("recovers from a synchronous model-build failure on the next invalidation", async () => {
  const harness = createHarness();
  const created = harness.show();
  harness.failNextModelBuild();
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();
  assert.equal(created.posted.length, 0);
  assert.equal(harness.modelErrors, 1);

  harness.changes.fire();
  await flushMicrotasks();
  assert.equal(created.posted.length, 1);
  assert.equal(created.posted[0].state.marker, "initial");
  harness.provider.dispose();
});

test("requests one coalesced refresh when the first visible model lacks fresh quota", async () => {
  const harness = createHarness();
  harness.setModel({ marker: "needs-refresh", accounts: [{ id: "local:a" }] });
  const created = harness.show();
  created.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(harness.visibleRefreshes, 1);
  harness.changes.fire();
  harness.changes.fire();
  await flushMicrotasks();
  assert.equal(harness.visibleRefreshes, 1);
  harness.provider.dispose();
});

test("manager disposal releases the source, listeners, and current panel", () => {
  const harness = createHarness();
  const created = harness.show();
  harness.provider.dispose();

  assert.equal(harness.changes.listenerCount, 0);
  assert.equal(created.panel.disposed, true);
  assert.deepEqual(created.listenerCounts(), { messages: 0, viewState: 0, disposal: 0 });
  harness.provider.show();
  assert.equal(createdPanels.length, 1);
});
