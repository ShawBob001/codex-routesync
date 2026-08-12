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

const vscodeMock = {
  Uri: {
    joinPath(base, ...segments) {
      return uri([base.path.replace(/\/$/, ""), ...segments].join("/"));
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

function createWebviewView(postResults = [true]) {
  const messages = eventSource();
  const visibility = eventSource();
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
  const view = {
    visible: true,
    webview,
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposal.event,
  };
  return {
    view,
    posted,
    deliver: (message) => messages.fire(message),
    setVisible(value) {
      view.visible = value;
      visibility.fire();
    },
    dispose: () => disposal.fire(),
    listenerCounts: () => ({
      messages: messages.listenerCount,
      visibility: visibility.listenerCount,
      disposal: disposal.listenerCount,
    }),
  };
}

function createHarness() {
  const changes = eventSource();
  let model = {
    marker: "initial",
    accounts: [{ id: "local:a" }, { id: "cloud:locked" }],
  };
  const calls = [];
  const actionErrors = [];
  let visibleRefreshes = 0;
  let modelFailures = 0;
  let freshTargetIds = ["local:a", "cloud:locked"];
  const handlers = Object.fromEntries([
    "refreshDashboard",
    "switchMode",
    "configureAutoSwitch",
    "addAccount",
    "addProvider",
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
    subscribe: changes.event,
    getTargetIds: (current) => current.accounts.map((account) => account.id),
    getFreshTargetIds: () => freshTargetIds,
    handlers,
    onActionError: (action) => actionErrors.push(action),
    shouldRefreshVisibleModel: (current) => current.marker === "needs-refresh",
    requestVisibleRefresh: () => { visibleRefreshes += 1; },
  });
  return {
    provider,
    changes,
    calls,
    actionErrors,
    setModel(next) { model = next; },
    setFreshTargetIds(next) { freshTargetIds = next; },
    failNextModelBuild() { modelFailures += 1; },
    get visibleRefreshes() { return visibleRefreshes; },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("resolve configures a local-only webview and a nonce CSP shell", () => {
  const harness = createHarness();
  const resolved = createWebviewView();
  harness.provider.resolveWebviewView(resolved.view);

  assert.equal(resolved.view.webview.options.enableScripts, true);
  assert.deepEqual(
    resolved.view.webview.options.localResourceRoots.map((root) => root.path),
    ["/extension/dist/webview"],
  );
  const html = resolved.view.webview.html;
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

test("ready posts the latest state once and bursty changes coalesce", async () => {
  const harness = createHarness();
  const resolved = createWebviewView();
  harness.provider.resolveWebviewView(resolved.view);

  harness.setModel({ marker: "before-ready", accounts: [{ id: "local:a" }] });
  harness.changes.fire();
  harness.changes.fire();
  resolved.deliver({ type: "dashboard.ready" });
  resolved.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  assert.equal(resolved.posted.length, 1);
  assert.equal(resolved.posted[0].type, "dashboard.state");
  assert.equal(resolved.posted[0].state.marker, "before-ready");

  harness.setModel({ marker: "old", accounts: [{ id: "local:a" }] });
  harness.changes.fire();
  harness.setModel({ marker: "latest", accounts: [{ id: "local:a" }] });
  harness.changes.fire();
  harness.changes.fire();
  await flushMicrotasks();

  assert.equal(resolved.posted.length, 2);
  assert.equal(resolved.posted[1].state.marker, "latest");
  assert.ok(resolved.posted[1].revision > resolved.posted[0].revision);
  harness.provider.dispose();
});

test("hidden and disposed views stop delivery without leaking listeners", async () => {
  const harness = createHarness();
  const first = createWebviewView();
  harness.provider.resolveWebviewView(first.view);
  first.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();

  first.setVisible(false);
  harness.setModel({ marker: "hidden", accounts: [] });
  harness.changes.fire();
  await flushMicrotasks();
  assert.equal(first.posted.length, 1);

  first.setVisible(true);
  await flushMicrotasks();
  assert.equal(first.posted.length, 2);
  assert.equal(first.posted[1].state.marker, "hidden");

  const second = createWebviewView();
  harness.provider.resolveWebviewView(second.view);
  assert.deepEqual(first.listenerCounts(), { messages: 0, visibility: 0, disposal: 0 });
  second.dispose();
  assert.deepEqual(second.listenerCounts(), { messages: 0, visibility: 0, disposal: 0 });
  assert.equal(harness.changes.listenerCount, 1);

  harness.provider.dispose();
  assert.equal(harness.changes.listenerCount, 0);
});

test("routes only fixed actions and allows current model target IDs", async () => {
  const harness = createHarness();
  const resolved = createWebviewView();
  harness.provider.resolveWebviewView(resolved.view);

  resolved.deliver({
    type: "dashboard.action",
    requestId: "1",
    action: "setAutoSwitch",
    enabled: true,
  });
  resolved.deliver({
    type: "dashboard.action",
    requestId: "2",
    action: "reloginAccount",
    targetId: "local:a",
  });
  resolved.deliver({
    type: "dashboard.action",
    requestId: "3",
    action: "unlockStorage",
    targetId: "missing",
  });
  resolved.deliver({
    type: "dashboard.action",
    requestId: "4",
    action: "workbench.action.reloadWindow",
  });
  await flushMicrotasks();

  assert.deepEqual(harness.calls, [
    ["setAutoSwitch", true],
    ["reloginAccount", "local:a"],
  ]);

  harness.setModel({ marker: "changed", accounts: [] });
  resolved.deliver({
    type: "dashboard.action",
    requestId: "5",
    action: "reloginAccount",
    targetId: "local:a",
  });
  await flushMicrotasks();
  assert.equal(harness.calls.length, 2);

  harness.setModel({ marker: "model-still-allows", accounts: [{ id: "local:a" }] });
  harness.setFreshTargetIds([]);
  resolved.deliver({
    type: "dashboard.action",
    requestId: "6",
    action: "reloginAccount",
    targetId: "local:a",
  });
  await flushMicrotasks();
  assert.equal(harness.calls.length, 2);
  harness.provider.dispose();
});

test("contains synchronous action failures and reports the fixed action", async () => {
  const harness = createHarness();
  harness.provider.options.handlers.refreshDashboard = () => {
    throw new Error("synchronous action failure");
  };
  const resolved = createWebviewView();
  harness.provider.resolveWebviewView(resolved.view);

  assert.doesNotThrow(() => resolved.deliver({
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
    const harness = createHarness();
    const resolved = createWebviewView([firstFailure, true]);
    harness.provider.resolveWebviewView(resolved.view);
    resolved.deliver({ type: "dashboard.ready" });
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(resolved.posted.length, 2);
    assert.equal(resolved.posted.at(-1).state.marker, "initial");
    harness.provider.dispose();
  }
});

test("recovers from a synchronous model-build failure on the next invalidation", async () => {
  const harness = createHarness();
  const resolved = createWebviewView();
  harness.provider.resolveWebviewView(resolved.view);
  harness.failNextModelBuild();
  resolved.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();
  assert.equal(resolved.posted.length, 0);

  harness.changes.fire();
  await flushMicrotasks();
  assert.equal(resolved.posted.length, 1);
  assert.equal(resolved.posted[0].state.marker, "initial");
  harness.provider.dispose();
});

test("requests one coalesced refresh when the first visible model lacks fresh quota", async () => {
  const harness = createHarness();
  const resolved = createWebviewView();
  harness.setModel({ marker: "needs-refresh", accounts: [{ id: "local:a" }] });
  harness.provider.resolveWebviewView(resolved.view);
  resolved.deliver({ type: "dashboard.ready" });
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(harness.visibleRefreshes, 1);
  harness.changes.fire();
  harness.changes.fire();
  await flushMicrotasks();
  assert.equal(harness.visibleRefreshes, 1);
  harness.provider.dispose();
});
