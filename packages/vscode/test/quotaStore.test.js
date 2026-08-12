const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const outputLines = [];
let detailedPerformanceLogging = false;

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
  if (request === "vscode") {
    return {
      EventEmitter,
      workspace: {
        getConfiguration() {
          return {
            get: (key, fallback) => (
              key === "detailedPerformanceLogging" ? detailedPerformanceLogging : fallback
            ),
          };
        },
      },
      window: {
        createOutputChannel() {
          return {
            info(line) { outputLines.push(line); },
            warn(line) { outputLines.push(line); },
            error(line) { outputLines.push(line); },
            show() {},
            dispose() {},
          };
        },
      },
    };
  }
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
    getCachedQuota: (account) => {
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
    getCachedQuota: () => cachedQuota,
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
    getCachedQuota: () => cachedQuota,
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
  outputLines.length = 0;
  const secret = "raw-proxy-secret";
  const store = new QuotaStore({
    now: () => 1700000010000,
    getCachedQuota: () => cachedQuota,
    queryQuota: async () => ({
      kind: "ok",
      displayName: "a",
      info: quotaInfo(25),
      usedCachedQuota: true,
      fallbackRefreshFailed: true,
      fallbackErrorMessage: `service unavailable through http://alice:${secret}@proxy.example:3128`,
      fallbackStatusCode: 503,
      fallbackReasonCode: "request_failed",
    }),
  });
  await store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  const state = store.get(accountA.id);
  assert.equal(state.provenance, "cache-fallback");
  assert.equal(state.queriedAt, cachedQuota.queriedAtMs);
  assert.equal(state.errorMessage, "Refresh failed");
  assert.equal(state.errorStatusCode, 503);
  assert.equal(state.fallbackReasonCode, "request_failed");
  assert.equal(state.cacheReason, "HTTP 503");

  const resultLine = outputLines.find((line) => line.includes("quota-result"));
  assert.ok(resultLine);
  assert.match(resultLine, /\"unavailableReason\":\"request_failed\"/);
  assert.match(resultLine, /\"statusCode\":503/);
  assert.doesNotMatch(resultLine, /windowCount/);
  assert.doesNotMatch(outputLines.join("\n"), new RegExp(`${secret}|proxy\\.example|service unavailable`));
});

test("rejects non-allowlisted cached fallback diagnostics", async () => {
  outputLines.length = 0;
  const store = new QuotaStore({
    getCachedQuota: () => cachedQuota,
    queryQuota: async () => ({
      kind: "ok",
      displayName: "a",
      info: quotaInfo(25),
      usedCachedQuota: true,
      fallbackRefreshFailed: true,
      fallbackErrorMessage: "RAW_FALLBACK_SECRET",
      fallbackStatusCode: 999,
      fallbackReasonCode: "raw_fallback_secret",
    }),
  });

  await store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  const state = store.get(accountA.id);
  assert.equal(state.provenance, "cache-fallback");
  assert.equal(state.fallbackReasonCode, null);
  assert.equal(state.errorStatusCode, null);
  assert.equal(state.cacheReason, "Refresh failed");
  assert.doesNotMatch(outputLines.join("\n"), /RAW_FALLBACK_SECRET|raw_fallback_secret|999/);
});

test("records a failed query without inventing quota data", async () => {
  const store = new QuotaStore({
    now: () => 1700000010000,
    getCachedQuota: () => null,
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
    getCachedQuota: () => cachedQuota,
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
    getCachedQuota: () => null,
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
    getCachedQuota: () => null,
    queryQuota: async (account) => pending.get(account.id).promise,
  });
  const refresh = store.refreshQuota(undefined, { snapshot: snapshot([accountA, accountB]) });
  pending.get(accountB.id).resolve({ kind: "ok", displayName: "b", info: quotaInfo(30) });
  pending.get(accountA.id).resolve({ kind: "ok", displayName: "a", info: quotaInfo(10) });
  await refresh;
  assert.equal(store.get(accountA.id).info.primaryWindow.usedPercent, 10);
  assert.equal(store.get(accountB.id).info.primaryWindow.usedPercent, 30);
});

test("coalesces same-turn account completions into one change event", async () => {
  const accountB = { ...accountA, id: "local:b", name: "b" };
  const pending = new Map([[accountA.id, deferred()], [accountB.id, deferred()]]);
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async (account) => pending.get(account.id).promise,
  });
  const revisions = [];
  const subscription = store.onDidChange((state) => revisions.push(state.revision));

  const refresh = store.refreshQuota(undefined, { snapshot: snapshot([accountA, accountB]) });
  assert.deepEqual(revisions, [1]);
  pending.get(accountA.id).resolve({ kind: "ok", displayName: "a", info: quotaInfo(10) });
  pending.get(accountB.id).resolve({ kind: "ok", displayName: "b", info: quotaInfo(30) });
  await refresh;

  assert.deepEqual(revisions, [1, 2]);
  subscription.dispose();
  store.dispose();
});

test("reconciles cache state synchronously", () => {
  const store = new QuotaStore({ getCachedQuota: () => cachedQuota });
  const result = store.reconcileAccounts([accountA]);
  assert.equal(result, undefined);
  assert.equal(store.get(accountA.id).queriedAt, cachedQuota.queriedAtMs);
});

test("distinguishes cache reuse from a failed refresh fallback", async () => {
  const store = new QuotaStore({
    getCachedQuota: () => cachedQuota,
    queryQuota: async () => ({
      kind: "ok",
      displayName: "a",
      info: quotaInfo(25),
      usedCachedQuota: true,
    }),
  });
  await store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  const state = store.get(accountA.id);
  assert.equal(state.provenance, "cache-reuse");
  assert.equal(state.errorMessage, null);
  assert.equal(state.cacheReason, null);
  assert.equal(state.queriedAt, cachedQuota.queriedAtMs);
});

test("preserves a quota unavailable result without treating it as zero", async () => {
  const unavailable = quotaInfo(0);
  unavailable.primaryWindow = null;
  unavailable.unavailableReason = {
    code: "request_failed",
    message: "Quota service unavailable",
    statusCode: 503,
  };
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async () => ({ kind: "ok", displayName: "a", info: unavailable }),
  });
  await store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  const state = store.get(accountA.id);
  assert.equal(state.info.primaryWindow, null);
  assert.equal(state.info.unavailableReason.code, "request_failed");
  assert.equal(state.reloginRequired, false);
});

test("logs only sanitized quota result diagnostics", async () => {
  outputLines.length = 0;
  const secret = "proxy-secret-value";
  const unavailable = quotaInfo(0);
  unavailable.primaryWindow = null;
  unavailable.secondaryWindow = {
    usedPercent: 12,
    resetsAt: new Date("2026-08-13T00:00:00.000Z"),
    windowSeconds: 604800,
  };
  unavailable.unavailableReason = {
    code: "request_failed",
    message: `Quota unavailable through http://alice:${secret}@proxy.example:3128`,
    statusCode: 503,
  };
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async () => ({ kind: "ok", displayName: "secret-account", info: unavailable }),
  });

  await store.refreshQuota([accountA.id], {
    snapshot: snapshot([accountA]),
    reason: "manual",
    refreshId: "diagnostic-test",
  });

  const resultLine = outputLines.find((line) => line.includes("quota-result"));
  assert.ok(resultLine);
  assert.match(resultLine, /\"resultKind\":\"ok\"/);
  assert.match(resultLine, /\"unavailableReason\":\"request_failed\"/);
  assert.match(resultLine, /\"statusCode\":503/);
  assert.doesNotMatch(resultLine, /windowCount/);
  assert.doesNotMatch(outputLines.join("\n"), new RegExp(`${secret}|proxy\\.example|secret-account`));
});

test("limits concurrent account queries", async () => {
  const accounts = Array.from({ length: 6 }, (_, index) => ({
    ...accountA,
    id: `local:${index}`,
    name: String(index),
  }));
  let active = 0;
  let maximum = 0;
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async (account) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { kind: "ok", displayName: account.name, info: quotaInfo(10) };
    },
  });
  await store.refreshQuota(undefined, {
    snapshot: snapshot(accounts),
    concurrency: 2,
  });
  assert.equal(maximum, 2);
});

test("does not accept an old response after an account is removed and re-added", async () => {
  const old = deferred();
  const fresh = deferred();
  let calls = 0;
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async () => (++calls === 1 ? old.promise : fresh.promise),
  });
  const firstRefresh = store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  await new Promise((resolve) => setImmediate(resolve));
  store.reconcileAccounts([]);
  store.reconcileAccounts([accountA]);
  const secondRefresh = store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  fresh.resolve({ kind: "ok", displayName: "a", info: quotaInfo(15) });
  await secondRefresh;
  old.resolve({ kind: "ok", displayName: "a", info: quotaInfo(95) });
  await firstRefresh;
  assert.equal(store.get(accountA.id).info.primaryWindow.usedPercent, 15);
});

test("removing an account invalidates its in-flight refresh", async () => {
  const pending = deferred();
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async () => pending.promise,
  });
  const refresh = store.refreshQuota([accountA.id], { snapshot: snapshot([accountA]) });
  await new Promise((resolve) => setImmediate(resolve));
  store.reconcileAccounts([]);
  pending.resolve({ kind: "ok", displayName: "a", info: quotaInfo(75) });
  await refresh;
  assert.equal(store.get(accountA.id), undefined);
});

test("a corrupt cache entry does not block other accounts", () => {
  const accountB = { ...accountA, id: "local:b", name: "b" };
  const store = new QuotaStore({
    getCachedQuota: (account) => {
      if (account.id === accountA.id) throw new Error("corrupt cache secret");
      return cachedQuota;
    },
  });
  assert.doesNotThrow(() => store.reconcileAccounts([accountA, accountB]));
  assert.equal(store.get(accountA.id), undefined);
  assert.equal(store.get(accountB.id).queriedAt, cachedQuota.queriedAtMs);
});

test("normalizes non-finite concurrency without leaving accounts loading", async () => {
  const accounts = Array.from({ length: 6 }, (_, index) => ({
    ...accountA,
    id: `local:invalid-${index}`,
    name: String(index),
  }));
  let active = 0;
  let maximum = 0;
  const store = new QuotaStore({
    getCachedQuota: () => null,
    queryQuota: async (account) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { kind: "ok", displayName: account.name, info: quotaInfo(10) };
    },
  });
  await store.refreshQuota(undefined, {
    snapshot: snapshot(accounts),
    concurrency: Number.NaN,
  });
  assert.equal([...store.getSnapshot().byAccountId.values()].every((state) => !state.loading), true);
  assert.equal(maximum, 4);

  maximum = 0;
  await store.refreshQuota(undefined, {
    snapshot: snapshot(accounts),
    concurrency: Number.POSITIVE_INFINITY,
  });
  assert.equal([...store.getSnapshot().byAccountId.values()].every((state) => !state.loading), true);
  assert.equal(maximum, 4);
});

test("finishes stale request timers without logging account identifiers", async () => {
  const secretAccount = {
    ...accountA,
    id: "local:secret-account-id",
    name: "secret-account@example.com",
  };
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const originalDateNow = Date.now;
  let clock = 1700000100000;
  detailedPerformanceLogging = true;
  outputLines.length = 0;
  Date.now = () => {
    clock += 4000;
    return clock;
  };

  try {
    const store = new QuotaStore({
      getCachedQuota: () => null,
      queryQuota: async () => (++calls === 1 ? first.promise : second.promise),
    });
    const options = { snapshot: snapshot([secretAccount]), reason: "manual" };
    const oldRefresh = store.refreshQuota([secretAccount.id], options);
    const newRefresh = store.refreshQuota([secretAccount.id], options);
    second.resolve({ kind: "ok", displayName: secretAccount.name, info: quotaInfo(20) });
    await newRefresh;
    first.resolve({ kind: "ok", displayName: secretAccount.name, info: quotaInfo(90) });
    await oldRefresh;

    const accountFinishes = outputLines.filter((line) => (
      line.includes(" perf-finish ")
      && line.includes('"operation":"quotaStore.refreshQuota.account"')
    ));
    assert.equal(accountFinishes.length, 2);
    assert.doesNotMatch(outputLines.join("\n"), /secret-account@example\.com|local:secret-account-id/);
  } finally {
    Date.now = originalDateNow;
    detailedPerformanceLogging = false;
  }
});
