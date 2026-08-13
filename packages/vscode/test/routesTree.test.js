const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const packageRoot = path.join(__dirname, "..");

class MockEventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }

  dispose() {
    this.listeners.clear();
  }
}

class MockTreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MockThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class AccountGroupItem {}
class AccountTreeItem {}
class AccountDetailItem {}
class ProviderTreeItem {}
class ProviderDetailItem {}

function loadRoutesTree(t) {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-routes-tree-test-"));
  const outfile = path.join(bundleRoot, "routesTree.cjs");
  t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));

  buildSync({
    entryPoints: [path.join(packageRoot, "src", "routesTree.ts")],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    external: ["vscode", "./accountTree", "./providerTree"],
    logLevel: "silent",
  });

  const originalLoad = Module._load;
  Module._load = function mockDependencies(request, parent, isMain) {
    if (request === "vscode") {
      return {
        EventEmitter: MockEventEmitter,
        TreeItem: MockTreeItem,
        TreeItemCollapsibleState: { Expanded: 2 },
        ThemeIcon: MockThemeIcon,
      };
    }
    if (request === "./accountTree") {
      return { AccountGroupItem, AccountTreeItem, AccountDetailItem };
    }
    if (request === "./providerTree") {
      return { ProviderTreeItem, ProviderDetailItem };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(outfile);
  } finally {
    Module._load = originalLoad;
  }
}

function createDelegate(roots, childByParent = new Map()) {
  const emitter = new MockEventEmitter();
  const parents = new Map();
  for (const [parent, children] of childByParent) {
    for (const child of children) parents.set(child, parent);
  }
  return {
    onDidChangeTreeData: emitter.event,
    getRootItems() {
      return roots;
    },
    getChildren(element) {
      return element ? childByParent.get(element) ?? [] : roots;
    },
    getTreeItem(element) {
      return element;
    },
    getParent(element) {
      return parents.get(element);
    },
    fire(element) {
      emitter.fire(element);
    },
  };
}

test("unified routes tree delegates both account and provider branches", (t) => {
  const { RoutesTreeProvider } = loadRoutesTree(t);
  const accountRoot = new AccountGroupItem();
  const account = new AccountTreeItem();
  accountRoot.children = [account];
  const accountDetail = new AccountDetailItem();
  const providerRoot = new ProviderTreeItem();
  const providerDetail = new ProviderDetailItem();
  const accounts = createDelegate(
    [accountRoot],
    new Map([
      [accountRoot, [account]],
      [account, [accountDetail]],
    ]),
  );
  const providers = createDelegate([providerRoot], new Map([[providerRoot, [providerDetail]]]));
  const routes = new RoutesTreeProvider(accounts, providers, () => "en");

  const roots = routes.getChildren();
  assert.deepEqual(roots, [account, providerRoot]);
  assert.deepEqual(routes.getChildren(account), [accountDetail]);
  assert.deepEqual(routes.getChildren(providerRoot), [providerDetail]);
  assert.equal(routes.getParent(account), undefined);
  assert.equal(routes.getParent(accountDetail), account);
  assert.equal(routes.getParent(providerRoot), undefined);
  assert.equal(routes.getParent(providerDetail), providerRoot);
  assert.equal(routes.getTreeItem(account), account);
  assert.equal(routes.getTreeItem(providerRoot), providerRoot);

  routes.dispose();
});

test("delegate and locale changes refresh the flat unified root", (t) => {
  const { RoutesTreeProvider } = loadRoutesTree(t);
  const accounts = createDelegate([]);
  const providers = createDelegate([]);
  let locale = "en";
  const routes = new RoutesTreeProvider(accounts, providers, () => locale);
  const changes = [];
  routes.onDidChangeTreeData((element) => changes.push(element));

  accounts.fire(new AccountTreeItem());
  providers.fire(new ProviderTreeItem());
  assert.deepEqual(changes, [undefined, undefined]);

  locale = "zh-cn";
  routes.refreshLocale();
  assert.deepEqual(routes.getChildren(), []);
  assert.equal(changes.length, 3);
  assert.equal(changes[2], undefined);

  routes.dispose();
});
