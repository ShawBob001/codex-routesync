const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

class EventEmitter {
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

Module._load = function mockVscode(request, parent, isMain) {
  if (request === "vscode") return { EventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};

const { QuotaStore } = require("../dist/quotaStore.js");

Module._load = originalLoad;

const accountA = {
  id: "local:a",
  name: "a",
  source: "local",
  storageState: "ready",
};

function quotaInfo(usedPercent) {
  return {
    plan: "pro",
    primaryWindow: {
      usedPercent,
      resetsAt: new Date("2026-08-12T12:00:00.000Z"),
      windowSeconds: 18000,
    },
    secondaryWindow: null,
    additional: [],
    codeReview: null,
    credits: null,
    email: "account@example.com",
    tokenExpired: false,
    unavailableReason: null,
  };
}

const cachedQuota = {
  queriedAtMs: 1700000000000,
  info: quotaInfo(25),
};

function snapshot(accounts) {
  return {
    accounts,
    selection: { kind: "unknown", meta: null },
    byId: new Map(accounts.map((account) => [account.id, account])),
    bySourceAndName: new Map(),
    createdAt: 1700000000000,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("hydrates cached quota and returns detached snapshots", async () => {
  const store = new QuotaStore({
    now: () => 1700000005000,
    getCachedQuota: async (account) => {
      assert.equal(account.id, "local:a");
      return cachedQuota;
    },
    queryQuota: async () => {
      throw new Error("queryQuota should not be called during cache hydration");
    },
  });

  await store.reconcileAccounts([accountA]);

  const first = store.getSnapshot();
  const hydrated = first.byAccountId.get("local:a");
  assert.equal(hydrated.provenance, "hydrated-cache");
  assert.equal(hydrated.queriedAt, 1700000000000);
  assert.ok(hydrated.info);

  first.byAccountId.delete("local:a");
  hydrated.provenance = "mutated";
  hydrated.info.primaryWindow.usedPercent = 99;

  const second = store.getSnapshot();
  const unchanged = second.byAccountId.get("local:a");
  assert.ok(unchanged);
  assert.equal(unchanged.provenance, "hydrated-cache");
  assert.equal(unchanged.info.primaryWindow.usedPercent, 25);
});

test("prunes missing and non-ready account IDs", async () => {
  const store = new QuotaStore({
    now: () => 1700000005000,
    getCachedQuota: async () => cachedQuota,
    queryQuota: async () => cachedQuota,
  });

  await store.reconcileAccounts([
    accountA,
    { id: "local:b", storageState: "ready" },
  ]);
  assert.deepEqual([...store.getSnapshot().byAccountId.keys()].sort(), ["local:a", "local:b"]);

  await store.reconcileAccounts([{ id: "local:a", storageState: "error" }]);
  assert.deepEqual([...store.getSnapshot().byAccountId.keys()], []);
});

test("keeps cached info while loading and replaces it after a network success", async () => {
  let now = 1700000005000;
  const pending = deferred();
  const store = new QuotaStore({
    now: () => now,
    getCachedQuota: async () => cachedQuota,
    queryQuota: async () => pending.promise,
  });
  await store.reconcileAccounts([accountA]);

  const refresh = store.refreshQuota([accountA.id], {
    snapshot: snapshot([accountA]),
    reason: "manual",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const loading = store.get(accountA.id);
  assert.equal(loading.loading, true);
  assert.equal(loading.info.primaryWindow.usedPercent, 25);
  assert.equal(loading.refreshAttemptedAt, 1700000005000);

  now = 1700000009000;
  pending.resolve({ kind: "ok", displayName: "a", info: quotaInfo(40) });
  await refresh;
  const ready = store.get(accountA.id);
  assert.equal(ready.loading, false);
  assert.equal(ready.info.primaryWindow.usedPercent, 40);
  assert.equal(ready.provenance, "network");
  assert.equal(ready.queriedAt, 1700000009000);
});

test("marks cached fallback stale and keeps the cache query timestamp", async () => {
  const store = new QuotaStore({
    now: () => 1700000010000,
    getCachedQuota: async () => cachedQuota,
    queryQuota: async () => ({
      kind: "ok",
      displayName: "a",
      info: quotaInfo(25),
      usedCachedQuota: true,
      fallbackErrorMessage: "service unavailable",
      fallbackStatusCode: 503,
    }),
  });
  await store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  const state = store.get(accountA.id);
  assert.equal(state.provenance, "cache-fallback");
  assert.equal(state.queriedAt, cachedQuota.queriedAtMs);
  assert.equal(state.errorMessage, "service unavailable");
  assert.equal(state.errorStatusCode, 503);
  assert.equal(state.cacheReason, "HTTP 503: service unavailable");
});

test("records a failed query without inventing quota data", async () => {
  const store = new QuotaStore({
    now: () => 1700000010000,
    getCachedQuota: async () => null,
    queryQuota: async () => ({ kind: "not_found", message: "quota unavailable" }),
  });
  await store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  const state = store.get(accountA.id);
  assert.equal(state.loading, false);
  assert.equal(state.info, null);
  assert.equal(state.errorMessage, "quota unavailable");
  assert.equal(state.queriedAt, null);
  assert.equal(state.provenance, null);
});

test("marks relogin required without discarding cached quota", async () => {
  const store = new QuotaStore({
    getCachedQuota: async () => cachedQuota,
  });
  await store.reconcileAccounts([accountA]);
  store.markReloginRequired([accountA.id], "Sign in again");
  const state = store.get(accountA.id);
  assert.equal(state.info.primaryWindow.usedPercent, 25);
  assert.equal(state.reloginRequired, true);
  assert.equal(state.reloginMessage, "Sign in again");
});

test("ignores an older completion for the same account", async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const store = new QuotaStore({
    now: () => 1700000010000 + call,
    getCachedQuota: async () => null,
    queryQuota: async () => (++call === 1 ? first.promise : second.promise),
  });
  const options = { snapshot: snapshot([accountA]) };
  const oldRefresh = store.refreshQuota([accountA.id], options);
  const newRefresh = store.refreshQuota([accountA.id], options);
  second.resolve({ kind: "ok", displayName: "a", info: quotaInfo(20) });
  await newRefresh;
  first.resolve({ kind: "ok", displayName: "a", info: quotaInfo(90) });
  await oldRefresh;
  assert.equal(store.get(accountA.id).info.primaryWindow.usedPercent, 20);
});

test("keeps completions for different accounts", async () => {
  const accountB = { ...accountA, id: "local:b", name: "b" };
  const pending = new Map([[accountA.id, deferred()], [accountB.id, deferred()]]);
  const store = new QuotaStore({
    getCachedQuota: async () => null,
    queryQuota: async (account) => pending.get(account.id).promise,
  });
  const refresh = store.refreshQuota(undefined, { snapshot: snapshot([accountA, accountB]) });
  pending.get(accountB.id).resolve({ kind: "ok", displayName: "b", info: quotaInfo(30) });
  pending.get(accountA.id).resolve({ kind: "ok", displayName: "a", info: quotaInfo(10) });
  await refresh;
  assert.equal(store.get(accountA.id).info.primaryWindow.usedPercent, 10);
  assert.equal(store.get(accountB.id).info.primaryWindow.usedPercent, 30);
});
