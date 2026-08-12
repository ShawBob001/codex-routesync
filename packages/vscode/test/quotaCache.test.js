const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const packageRoot = path.join(__dirname, "..");
const productionCacheFile = path.join(os.tmpdir(), "codex-switchbridge", "quota-cache-v1.json");

function snapshotFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function loadQuotaCache(bundleRoot, bundleName) {
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
              info() {},
              warn() {},
              error() {},
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
