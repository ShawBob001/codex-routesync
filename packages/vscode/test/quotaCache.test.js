const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildSync } = require("esbuild");

const packageRoot = path.join(__dirname, "..");
const productionCacheFile = path.join(os.tmpdir(), "codex-switchbridge", "quota-cache-v1.json");

function snapshotFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function loadQuotaCache(bundleRoot, bundleName, outputLines = []) {
  const outfile = path.join(bundleRoot, `${bundleName}.cjs`);
  buildSync({
    entryPoints: [path.join(packageRoot, "src", "quotaCache.ts")],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    external: ["vscode"],
    logLevel: "silent",
  });

  const originalLoad = Module._load;
  Module._load = function mockVscode(request, parent, isMain) {
    if (request === "vscode") {
      return {
        workspace: {
          getConfiguration() {
            return { get: (_key, fallback) => fallback };
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

  try {
    return require(outfile);
  } finally {
    Module._load = originalLoad;
  }
}

function account(name) {
  return {
    id: `local:${name}`,
    name,
    source: "local",
    auth: {
      tokens: {
        account_id: `acct-${name}`,
        access_token: `access-${name}`,
      },
    },
  };
}

function quotaInfo(overrides = {}) {
  return {
    plan: "pro",
    primaryWindow: {
      usedPercent: 23,
      resetsAt: new Date(Date.now() + 60_000),
      windowSeconds: 604_800,
      resetAfterSeconds: 59.25,
    },
    secondaryWindow: null,
    additional: [],
    codeReview: null,
    credits: {
      hasCredits: true,
      balance: "12.34",
      approxLocalMessages: 17,
      approxCloudMessages: 8,
    },
    resetCredits: {
      availableCount: 3,
      applicableAvailableCount: 2,
    },
    email: "cache@example.com",
    tokenExpired: false,
    unavailableReason: null,
    ...overrides,
  };
}

test("Node tests use an isolated quota cache and preserve precise quota fields", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-test-"));
  const isolatedCacheDir = path.join(os.tmpdir(), "codex-switchbridge-tests", String(process.pid));
  const isolatedCacheFile = path.join(isolatedCacheDir, "quota-cache-v1.json");
  const beforeProduction = snapshotFile(productionCacheFile);
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;

  t.after(() => {
    if (previousOverride === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    }
    fs.rmSync(bundleRoot, { recursive: true, force: true });
    fs.rmSync(isolatedCacheDir, { recursive: true, force: true });
  });

  assert.ok(process.env.NODE_TEST_CONTEXT, "this regression test must run under node --test");
  fs.rmSync(isolatedCacheDir, { recursive: true, force: true });
  const cache = loadQuotaCache(bundleRoot, "isolated-cache");
  const fixtureAccount = account("fixture-account");
  cache.writeCachedQuotaSnapshot(fixtureAccount, quotaInfo());

  assert.ok(fs.existsSync(isolatedCacheFile));
  assert.equal(fs.statSync(isolatedCacheDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(isolatedCacheFile).mode & 0o777, 0o600);
  assert.deepEqual(snapshotFile(productionCacheFile), beforeProduction);

  const restored = cache.getCachedQuotaSnapshot(fixtureAccount);
  assert.ok(restored);
  assert.equal(restored.info.primaryWindow.resetAfterSeconds, 59.25);
  assert.deepEqual(restored.info.credits, {
    hasCredits: true,
    balance: "12.34",
    approxLocalMessages: 17,
    approxCloudMessages: 8,
  });
  assert.deepEqual(restored.info.resetCredits, {
    availableCount: 3,
    applicableAvailableCount: 2,
  });
});

test("cache directory override is honored and legacy quota fields default safely", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-override-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const beforeProduction = snapshotFile(productionCacheFile);
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    }
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "override-cache");
  const legacyAccount = account("legacy-account");
  cache.writeCachedQuotaSnapshot(legacyAccount, quotaInfo());
  const serialized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const [key] = Object.keys(serialized.entries);
  delete serialized.entries[key].info.primaryWindow.resetAfterSeconds;
  serialized.entries[key].info.credits = { hasCredits: true };
  delete serialized.entries[key].info.resetCredits;
  fs.writeFileSync(overrideFile, JSON.stringify(serialized, null, 2), "utf8");

  const restored = cache.getCachedQuotaSnapshot(legacyAccount);
  assert.ok(restored);
  assert.equal(restored.info.primaryWindow.resetAfterSeconds, null);
  assert.deepEqual(restored.info.credits, {
    hasCredits: true,
    balance: null,
    approxLocalMessages: null,
    approxCloudMessages: null,
  });
  assert.equal(restored.info.resetCredits, null);
  assert.deepEqual(snapshotFile(productionCacheFile), beforeProduction);
});

test("a damaged cached quota entry degrades field by field instead of breaking cache reads", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-damaged-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "damaged-cache");
  const damagedAccount = account("damaged-account");
  cache.writeCachedQuotaSnapshot(damagedAccount, quotaInfo());
  const serialized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const [key] = Object.keys(serialized.entries);
  serialized.entries[key].info.plan = 42;
  serialized.entries[key].info.email = null;
  serialized.entries[key].info.tokenExpired = "yes";
  serialized.entries[key].info.primaryWindow.usedPercent = "broken";
  serialized.entries[key].info.resetCredits = { availableCount: "broken" };
  serialized.entries[key].info.secondaryWindow = {
    usedPercent: 25,
    resetsAt: "not-a-date",
    windowSeconds: -1,
  };
  serialized.entries[key].info.additional = null;
  fs.writeFileSync(overrideFile, JSON.stringify(serialized), "utf8");

  const restored = cache.getCachedQuotaSnapshot(damagedAccount);
  assert.ok(restored);
  assert.equal(restored.info.plan, "unknown");
  assert.equal(restored.info.email, "unknown");
  assert.equal(restored.info.tokenExpired, false);
  assert.equal(restored.info.primaryWindow, null);
  assert.deepEqual(restored.info.secondaryWindow, {
    usedPercent: 25,
    resetsAt: null,
    windowSeconds: null,
    resetAfterSeconds: null,
  });
  assert.deepEqual(restored.info.additional, []);
  assert.equal(restored.info.resetCredits, null);
});

test("abnormal duplicate cache entries are pruned only when the cache is next written", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-hygiene-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) {
      delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    } else {
      process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    }
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "hygiene-cache");
  const realAccount = account("real-account");
  cache.writeCachedQuotaSnapshot(realAccount, quotaInfo());
  const cacheFile = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const [realKey] = Object.keys(cacheFile.entries);
  const fixture = structuredClone(cacheFile.entries[realKey]);
  fixture.accountId = "local:fixture";
  fixture.accountName = "fixture";
  for (let index = 0; index < 600; index += 1) {
    const key = index.toString(16).padStart(40, "0");
    cacheFile.entries[key] = {
      ...structuredClone(fixture),
      queriedAt: new Date(Date.now() - index).toISOString(),
    };
  }
  fs.writeFileSync(overrideFile, JSON.stringify(cacheFile), "utf8");
  const beforeRead = fs.readFileSync(overrideFile);

  assert.ok(cache.getCachedQuotaSnapshot(realAccount));
  assert.deepEqual(fs.readFileSync(overrideFile), beforeRead, "reads must not rewrite a user's cache");

  cache.writeCachedQuotaSnapshot(account("new-real-account"), quotaInfo());
  const normalized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const identities = Object.values(normalized.entries).map((entry) => entry.accountName);
  assert.ok(identities.includes("real-account"));
  assert.ok(identities.includes("new-real-account"));
  assert.equal(identities.filter((name) => name === "fixture").length, 1);
  assert.equal(identities.length, 3);
});

test("startup maintenance prunes abnormal duplicate cache entries without a quota write", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-startup-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "startup-maintenance-cache");
  const realAccount = account("startup-real-account");
  cache.writeCachedQuotaSnapshot(realAccount, quotaInfo());
  const cacheFile = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const [realKey] = Object.keys(cacheFile.entries);
  const fixture = structuredClone(cacheFile.entries[realKey]);
  fixture.accountId = "local:startup-fixture";
  fixture.accountName = "startup-fixture";
  for (let index = 0; index < 600; index += 1) {
    const key = (index + 10_000).toString(16).padStart(40, "0");
    cacheFile.entries[key] = {
      ...structuredClone(fixture),
      queriedAt: new Date(Date.now() - index).toISOString(),
    };
  }
  cacheFile.entries["f".repeat(40)] = {
    ...structuredClone(fixture),
    source: "invalid-source",
  };
  fs.writeFileSync(overrideFile, JSON.stringify(cacheFile), "utf8");

  const result = cache.maintainQuotaCache();
  const normalized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const identities = Object.values(normalized.entries).map((entry) => entry.accountName);
  assert.deepEqual(result, { changed: true, beforeCount: 602, afterCount: 2 });
  assert.equal(identities.filter((name) => name === "startup-fixture").length, 1);
  assert.ok(identities.includes("startup-real-account"));
});

test("cache maintenance deduplicates only within an opaque auth scope and preserves legacy entries", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-scope-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const homeA = path.join(bundleRoot, "home-a");
  const homeB = path.join(bundleRoot, "home-b");
  const authA = path.join(bundleRoot, "auth-a");
  const authB = path.join(bundleRoot, "auth-b");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousAuthDir === undefined) delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
    else process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = previousAuthDir;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "scope-cache");
  const sharedAccount = account("same-account");
  process.env.CODEX_HOME = homeA;
  process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = authA;
  cache.writeCachedQuotaSnapshot(sharedAccount, quotaInfo({
    primaryWindow: {
      usedPercent: 11,
      resetsAt: new Date(Date.now() + 60_000),
      windowSeconds: 604_800,
    },
  }));
  process.env.CODEX_HOME = homeB;
  process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = authB;
  cache.writeCachedQuotaSnapshot(sharedAccount, quotaInfo({
    primaryWindow: {
      usedPercent: 22,
      resetsAt: new Date(Date.now() + 60_000),
      windowSeconds: 604_800,
    },
  }));

  process.env.CODEX_HOME = homeA;
  process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = authA;
  assert.equal(cache.getCachedQuotaSnapshot(sharedAccount)?.info.primaryWindow?.usedPercent, 11);
  process.env.CODEX_HOME = homeB;
  process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = authB;
  assert.equal(cache.getCachedQuotaSnapshot(sharedAccount)?.info.primaryWindow?.usedPercent, 22);

  const serialized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const scopedEntries = Object.entries(serialized.entries);
  assert.equal(scopedEntries.length, 2, "separate CODEX_HOME/auth scopes must coexist");
  const scopeHashes = scopedEntries.map(([, entry]) => entry.scopeHash);
  assert.equal(new Set(scopeHashes).size, 2);
  for (const scopeHash of scopeHashes) assert.match(scopeHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(serialized), /home-a|home-b|auth-a|auth-b/);

  const [, newestScopeEntry] = scopedEntries.at(-1);
  serialized.entries["a".repeat(40)] = {
    ...structuredClone(newestScopeEntry),
    queriedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  const legacy = structuredClone(newestScopeEntry);
  delete legacy.scopeHash;
  legacy.accountId = "local:legacy-same-name";
  legacy.accountName = "legacy-same-name";
  serialized.entries["b".repeat(40)] = {
    ...structuredClone(legacy),
    queriedAt: new Date(Date.now() - 30_000).toISOString(),
  };
  serialized.entries["c".repeat(40)] = {
    ...structuredClone(legacy),
    queriedAt: new Date(Date.now() - 20_000).toISOString(),
  };
  fs.writeFileSync(overrideFile, JSON.stringify(serialized), "utf8");

  cache.maintainQuotaCache();
  const maintained = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const values = Object.values(maintained.entries);
  assert.equal(values.filter((entry) => entry.accountName === "same-account").length, 2);
  assert.equal(values.filter((entry) => entry.accountName === "legacy-same-name").length, 2);
  assert.equal(values.length, 4);
});

test("cache RMW waits for the global process lock and re-reads after acquiring it", async (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-rmw-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const globalLockDir = path.join(overrideDir, "quota-cache-file.lock");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;
  let worker = null;

  t.after(() => {
    worker?.kill();
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "rmw-cache");
  const bundleFile = path.join(bundleRoot, "rmw-cache.cjs");
  cache.writeCachedQuotaSnapshot(account("seed"), quotaInfo());
  const holderView = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const seedEntry = structuredClone(Object.values(holderView.entries)[0]);
  const ownerToken = "1".repeat(32);
  fs.mkdirSync(globalLockDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(globalLockDir, `owner-${ownerToken}`),
    ownerToken,
    { mode: 0o600 },
  );

  const workerScript = String.raw`
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "vscode") {
        return {
          workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
          window: { createOutputChannel: () => ({
            info() {}, warn() {}, error() {}, show() {}, dispose() {},
          }) },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const cache = require(process.argv[1]);
    process.stdout.write("STARTED\n");
    cache.writeCachedQuotaSnapshot({
      id: "local:worker",
      name: "worker",
      source: "local",
      auth: { tokens: { account_id: "acct-worker", access_token: "access-worker" } },
    }, {
      plan: "pro",
      primaryWindow: {
        usedPercent: 42,
        resetsAt: new Date(Date.now() + 60_000),
        windowSeconds: 604800,
      },
      secondaryWindow: null,
      additional: [],
      codeReview: null,
      credits: null,
      resetCredits: null,
      email: "worker@example.com",
      tokenExpired: false,
      unavailableReason: null,
    });
    process.stdout.write("DONE\n");
  `;
  worker = spawn(process.execPath, ["-e", workerScript, bundleFile], {
    env: {
      ...process.env,
      CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR: overrideDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  worker.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const workerExit = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  const started = await waitFor(() => stdout.includes("STARTED"), 2_000);
  assert.equal(started, true, `worker did not start: ${stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(stdout.includes("DONE"), false, "writer must wait while another process owns the cache lock");

  holderView.entries["e".repeat(40)] = {
    ...seedEntry,
    accountId: "local:holder",
    accountName: "holder",
    queriedAt: new Date().toISOString(),
  };
  fs.writeFileSync(overrideFile, JSON.stringify(holderView), { mode: 0o600 });
  fs.rmSync(globalLockDir, { recursive: true, force: true });

  const exitCode = await workerExit;
  assert.equal(exitCode, 0, stderr);
  const finalCache = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const names = Object.values(finalCache.entries).map((entry) => entry.accountName);
  assert.ok(names.includes("seed"));
  assert.ok(names.includes("holder"));
  assert.ok(names.includes("worker"), "writer must re-read the holder's update after lock acquisition");
});

test("cache maintenance uses the same global lock and normalizes the latest locked state", async (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-maintain-lock-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const globalLockDir = path.join(overrideDir, "quota-cache-file.lock");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;
  let worker = null;

  t.after(() => {
    worker?.kill();
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "maintain-lock-cache");
  const bundleFile = path.join(bundleRoot, "maintain-lock-cache.cjs");
  cache.writeCachedQuotaSnapshot(account("seed"), quotaInfo());
  const holderView = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const seedEntry = structuredClone(Object.values(holderView.entries)[0]);
  holderView.entries["d".repeat(40)] = {
    ...structuredClone(seedEntry),
    queriedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  fs.writeFileSync(overrideFile, JSON.stringify(holderView), { mode: 0o600 });

  const ownerToken = "4".repeat(32);
  fs.mkdirSync(globalLockDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(globalLockDir, `owner-${ownerToken}`),
    ownerToken,
    { mode: 0o600 },
  );
  const workerScript = String.raw`
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "vscode") {
        return {
          workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
          window: { createOutputChannel: () => ({
            info() {}, warn() {}, error() {}, show() {}, dispose() {},
          }) },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const cache = require(process.argv[1]);
    process.stdout.write("STARTED\n");
    cache.maintainQuotaCache();
    process.stdout.write("DONE\n");
  `;
  worker = spawn(process.execPath, ["-e", workerScript, bundleFile], {
    env: {
      ...process.env,
      CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR: overrideDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  worker.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const workerExit = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  assert.equal(await waitFor(() => stdout.includes("STARTED"), 2_000), true, stderr);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(stdout.includes("DONE"), false, "maintenance must wait for the global cache lock");

  holderView.entries["e".repeat(40)] = {
    ...structuredClone(seedEntry),
    accountId: "local:holder",
    accountName: "holder",
    queriedAt: new Date().toISOString(),
  };
  fs.writeFileSync(overrideFile, JSON.stringify(holderView), { mode: 0o600 });
  fs.rmSync(globalLockDir, { recursive: true, force: true });

  assert.equal(await workerExit, 0, stderr);
  const maintained = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  const names = Object.values(maintained.entries).map((entry) => entry.accountName);
  assert.deepEqual(names.sort(), ["holder", "seed"]);
});

test("global cache lock recovers stale owners and times out without an unlocked write", (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-lock-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const overrideFile = path.join(overrideDir, "quota-cache-v1.json");
  const globalLockDir = path.join(overrideDir, "quota-cache-file.lock");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const cache = loadQuotaCache(bundleRoot, "lock-cache");
  cache.writeCachedQuotaSnapshot(account("seed"), quotaInfo());
  const staleOwner = "2".repeat(32);
  fs.mkdirSync(globalLockDir, { mode: 0o700 });
  fs.writeFileSync(path.join(globalLockDir, `owner-${staleOwner}`), staleOwner, { mode: 0o600 });
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(globalLockDir, staleAt, staleAt);

  cache.writeCachedQuotaSnapshot(account("after-stale"), quotaInfo());
  let serialized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  assert.ok(Object.values(serialized.entries).some((entry) => entry.accountName === "after-stale"));
  assert.equal(fs.existsSync(globalLockDir), false);

  const activeOwner = "3".repeat(32);
  fs.mkdirSync(globalLockDir, { mode: 0o700 });
  fs.writeFileSync(path.join(globalLockDir, `owner-${activeOwner}`), activeOwner, { mode: 0o600 });
  const beforeTimedOutWrite = fs.readFileSync(overrideFile);
  cache.writeCachedQuotaSnapshot(account("must-not-write-unlocked"), quotaInfo());
  assert.deepEqual(fs.readFileSync(overrideFile), beforeTimedOutWrite);
  assert.equal(fs.existsSync(globalLockDir), true);
  serialized = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  assert.equal(
    Object.values(serialized.entries).some((entry) => entry.accountName === "must-not-write-unlocked"),
    false,
  );
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("cached fallback carries only an allowlisted reason code when the failed result provides one", async (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-cache-fallback-test-"));
  const overrideDir = path.join(bundleRoot, "cache");
  const previousOverride = process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
  process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = overrideDir;

  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR;
    else process.env.CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR = previousOverride;
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });

  const outputLines = [];
  const cache = loadQuotaCache(bundleRoot, "fallback-metadata-cache", outputLines);
  const unavailableAccount = account("unavailable-fallback");
  cache.writeCachedQuotaSnapshot(unavailableAccount, quotaInfo());
  const unavailable = await cache.queryQuotaWithCache(unavailableAccount, {
    minIntervalMs: 0,
    forceFetch: true,
    fetch: async () => ({
      kind: "ok",
      displayName: unavailableAccount.name,
      info: quotaInfo({
        primaryWindow: null,
        unavailableReason: {
          code: "request_failed",
          message: "RAW_PROXY_SECRET",
          statusCode: 503,
        },
      }),
    }),
  });
  assert.equal(unavailable.fallbackReasonCode, "request_failed");
  assert.equal(unavailable.fallbackStatusCode, 503);
  assert.equal(unavailable.fallbackRefreshFailed, true);

  for (const [name, fetch] of [
    ["not-found-fallback", async () => ({ kind: "not_found", message: "RAW_NOT_FOUND_SECRET" })],
    ["throw-fallback", async () => { throw new Error("RAW_THROW_SECRET"); }],
  ]) {
    const fallbackAccount = account(name);
    cache.writeCachedQuotaSnapshot(fallbackAccount, quotaInfo());
    const result = await cache.queryQuotaWithCache(fallbackAccount, {
      minIntervalMs: 0,
      forceFetch: true,
      fetch,
    });
    assert.equal(result.kind, "ok");
    assert.equal(result.usedCachedQuota, true);
    assert.equal(result.fallbackRefreshFailed, true);
    assert.equal(result.fallbackReasonCode, undefined);
  }
  assert.doesNotMatch(
    outputLines.join("\n"),
    /RAW_PROXY_SECRET|RAW_NOT_FOUND_SECRET|RAW_THROW_SECRET/,
  );
});
