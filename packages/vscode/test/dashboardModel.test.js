const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDashboardModel,
} = require("../dist/dashboardModel.js");
const { stableSubjectId } = require("../dist/tokenUsage.js");

const NOW = Date.parse("2026-08-12T10:00:00.000Z");

function account(overrides = {}) {
  const source = overrides.source ?? "local";
  const name = overrides.name ?? "alpha";
  return {
    id: `${source}:${name}`,
    name,
    source,
    meta: { name, email: `${name}@example.com`, plan: "plus" },
    publicEmail: `${name}@example.com`,
    auth: {
      OPENAI_API_KEY: "SECRET_ACCOUNT_API_KEY",
      tokens: { access_token: "SECRET_ACCESS_TOKEN" },
    },
    isCurrent: false,
    storageState: "ready",
    storageMessage: "SECRET_ACCOUNT_STORAGE_ERROR",
    encrypted: false,
    syncVersion: null,
    syncUpdatedAt: null,
    ...overrides,
  };
}

function provider(overrides = {}) {
  const source = overrides.source ?? "local";
  const name = overrides.name ?? "proxy";
  return {
    id: `${source}:${name}`,
    name,
    source,
    isCurrent: false,
    invalid: false,
    locked: false,
    pending: false,
    storageMessage: "SECRET_PROVIDER_STORAGE_ERROR",
    encrypted: false,
    auth: { OPENAI_API_KEY: "SECRET_PROVIDER_API_KEY" },
    config: { base_url: "https://secret-user:secret-pass@example.test/v1", wire_api: "responses" },
    profile: {
      kind: "provider",
      name,
      auth: { OPENAI_API_KEY: "SECRET_PROFILE_KEY" },
      config: { name, base_url: "https://secret.example.test/v1", wire_api: "responses" },
    },
    syncVersion: null,
    syncUpdatedAt: null,
    lastWriterAction: null,
    ...overrides,
  };
}

function saved(accounts, selection) {
  return {
    accounts,
    selection,
    byId: new Map(accounts.map((entry) => [entry.id, entry])),
    bySourceAndName: new Map(
      accounts.map((entry) => [`${entry.source}:${entry.name}`, entry]),
    ),
    createdAt: NOW,
  };
}

function quotaInfo(usedPercent, overrides = {}) {
  return {
    plan: "plus",
    primaryWindow: {
      usedPercent,
      resetsAt: new Date("2026-08-12T12:00:00.000Z"),
      windowSeconds: 18_000,
    },
    secondaryWindow: null,
    additional: [],
    codeReview: null,
    credits: null,
    email: "private@example.com",
    tokenExpired: false,
    unavailableReason: null,
    ...overrides,
  };
}

function quotaState(accountId, info, overrides = {}) {
  return {
    accountId,
    info,
    loading: false,
    errorMessage: null,
    errorStatusCode: null,
    refreshAttemptedAt: NOW - 1_000,
    queriedAt: NOW - 2_000,
    provenance: "network",
    cacheReason: null,
    reloginRequired: false,
    reloginMessage: null,
    ...overrides,
  };
}

function tokens(totalTokens, overrides = {}) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
    ...overrides,
  };
}

function usage(subjects = [], overrides = {}) {
  return {
    updatedAt: NOW - 500,
    trackingStartedAt: NOW - 50_000,
    status: "ready",
    coverage: "complete",
    lastError: "SECRET_USAGE_ERROR",
    sessionCount: subjects.reduce((sum, subject) => sum + subject.sessionCount, 0),
    total: tokens(subjects.reduce((sum, subject) => sum + subject.tokens.totalTokens, 0)),
    unattributed: tokens(0),
    subjects,
    scan: {
      discoveredFiles: 2,
      rescannedFiles: 2,
      reusedFiles: 0,
      errors: 0,
      bytesRead: 100,
      chunksRead: 2,
    },
    ...overrides,
  };
}

function build({
  accounts = [],
  selection = { kind: "unknown", meta: null },
  providers = [],
  quota = new Map(),
  usageSnapshot = usage(),
  autoSwitchEnabled = true,
  sharedHistoryEnabled = true,
  reload = { recommended: false, reason: null },
} = {}) {
  return buildDashboardModel({
    saved: saved(accounts, selection),
    providers,
    quota: { revision: 7, byAccountId: quota },
    usage: usageSnapshot,
    autoSwitchEnabled,
    sharedHistoryEnabled,
    reload,
    nowMs: NOW,
  });
}

function assertSecretFree(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of [
    "SECRET_ACCOUNT_API_KEY",
    "SECRET_ACCESS_TOKEN",
    "SECRET_ACCOUNT_STORAGE_ERROR",
    "SECRET_PROVIDER_STORAGE_ERROR",
    "SECRET_PROVIDER_API_KEY",
    "SECRET_PROFILE_KEY",
    "secret-user",
    "secret.example.test",
    "SECRET_USAGE_ERROR",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel));
  }
  const forbiddenKeys = new Set([
    "auth", "config", "profile", "apiKey", "OPENAI_API_KEY",
    "base_url", "storageMessage", "lastError", "tokens",
  ]);
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    assert.equal(Object.getPrototypeOf(entry), Object.prototype);
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden DTO key: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

test("projects an account route with preferred five-hour quota and no secrets", () => {
  const current = account({ isCurrent: true });
  const cloudDuplicate = account({ source: "cloud", id: "cloud:alpha" });
  const state = quotaState(current.id, quotaInfo(32, {
    primaryWindow: {
      usedPercent: 10,
      resetsAt: new Date("2026-08-19T10:00:00.000Z"),
      windowSeconds: 604_800,
    },
    secondaryWindow: {
      usedPercent: 32,
      resetsAt: new Date("2026-08-12T12:00:00.000Z"),
      windowSeconds: 18_000,
    },
  }));
  const currentUsage = {
    id: stableSubjectId("account", "local:alpha"),
    kind: "account",
    label: "alpha",
    sessionCount: 2,
    tokens: tokens(125),
  };
  const model = build({
    accounts: [current, cloudDuplicate],
    selection: { kind: "account", name: "alpha", source: "local", meta: current.meta },
    quota: new Map([[current.id, state]]),
    usageSnapshot: usage([currentUsage]),
  });

  assert.equal(model.version, 1);
  assert.equal(model.route.kind, "account");
  assert.equal(model.route.accountId, current.id);
  assert.equal(model.route.disambiguator, "Local");
  assert.equal(model.route.localTokens, 125);
  assert.equal(model.route.quota.status, "available");
  assert.equal(model.route.quota.fiveHour.remainingPercent, 68);
  assert.equal(model.route.quota.fiveHour.label, "5h");
  assert.equal(model.route.quota.secondary.label, "7d");
  assertSecretFree(model);
  assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
});

test("provider mode exposes only an allowlisted wire API and never invents quota", () => {
  const current = provider({ isCurrent: true });
  const model = build({
    selection: { kind: "provider", name: "proxy", source: "local" },
    providers: [current],
    usageSnapshot: usage([{
      id: stableSubjectId("provider", "local:proxy"),
      kind: "provider",
      label: "proxy",
      sessionCount: 1,
      tokens: tokens(9),
    }]),
  });

  assert.equal(model.route.kind, "provider");
  assert.equal(model.route.wireApi, "responses");
  assert.equal(model.route.localTokens, 9);
  assert.equal(Object.hasOwn(model.route, "quota"), false);
  assert.equal(model.autoSwitch.appliesToCurrentRoute, false);
  assertSecretFree(model);

  const unsafe = build({
    selection: { kind: "provider", name: "proxy", source: "local" },
    providers: [provider({ profile: { config: { wire_api: "custom-secret" } } })],
  });
  assert.equal(unsafe.route.wireApi, null);
});

test("projects an unknown route without borrowing saved credentials", () => {
  const model = build({
    accounts: [account()],
    providers: [provider()],
    selection: { kind: "unknown", meta: { name: "Runtime", email: "runtime@example.com", plan: "team" } },
  });

  assert.deepEqual(model.route, {
    kind: "unknown",
    label: "No active saved route",
    plan: "team",
  });
  assertSecretFree(model);
});

test("distinguishes cached quota provenance and a failed refresh with retained data", () => {
  const current = account({ isCurrent: true });
  for (const [provenance, expected] of [
    ["hydrated-cache", "cached"],
    ["cache-reuse", "cached"],
    ["cache-fallback", "stale"],
  ]) {
    const model = build({
      accounts: [current],
      selection: { kind: "account", name: current.name, source: current.source, meta: current.meta },
      quota: new Map([[current.id, quotaState(current.id, quotaInfo(20), {
        provenance,
        ...(provenance === "cache-fallback" ? { errorMessage: "SECRET_FALLBACK_ERROR" } : {}),
      })]]),
    });
    assert.equal(model.route.quota.status, "available");
    assert.equal(model.route.quota.freshness, expected);
    assert.doesNotMatch(JSON.stringify(model), /SECRET_FALLBACK_ERROR/);
  }

  const failed = build({
    accounts: [current],
    selection: { kind: "account", name: current.name, source: current.source, meta: current.meta },
    quota: new Map([[current.id, quotaState(current.id, quotaInfo(20), {
      provenance: "network",
      errorMessage: "SECRET_RETAINED_ERROR",
    })]]),
  });
  assert.equal(failed.route.quota.status, "unavailable");
  assert.equal(failed.route.quota.freshness, "stale");
  assert.equal(failed.route.quota.fiveHour.remainingPercent, 80);
  assert.equal(failed.route.quota.message, "Quota refresh failed. Showing the last known value.");
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_RETAINED_ERROR/);
});

test("candidate ranking is advisory, deterministic, and excludes ineligible accounts", () => {
  const current = account({ name: "current", id: "local:current", isCurrent: true });
  const resetSoon = account({ name: "soon", id: "local:soon" });
  const resetLater = account({ name: "later", id: "local:later" });
  const exhausted = account({ name: "empty", id: "local:empty" });
  const relogin = account({ name: "login", id: "local:login" });
  const locked = account({ name: "locked", id: "local:locked", storageState: "locked" });
  const states = new Map([
    [current.id, quotaState(current.id, quotaInfo(100))],
    [resetSoon.id, quotaState(resetSoon.id, quotaInfo(20, {
      primaryWindow: { usedPercent: 20, resetsAt: new Date("2026-08-12T11:00:00.000Z"), windowSeconds: 18_000 },
    }), { provenance: "cache-fallback" })],
    [resetLater.id, quotaState(resetLater.id, quotaInfo(20, {
      primaryWindow: { usedPercent: 20, resetsAt: new Date("2026-08-12T13:00:00.000Z"), windowSeconds: 18_000 },
    }))],
    [exhausted.id, quotaState(exhausted.id, quotaInfo(100))],
    [relogin.id, quotaState(relogin.id, quotaInfo(1), { reloginRequired: true })],
  ]);
  const model = build({
    accounts: [resetLater, locked, current, exhausted, relogin, resetSoon],
    selection: { kind: "account", name: "current", source: "local", meta: current.meta },
    quota: states,
  });

  assert.equal(model.autoSwitch.ruleLabel, "Switch at 0%");
  assert.equal(model.autoSwitch.candidate.accountId, resetSoon.id);
  assert.equal(model.autoSwitch.candidate.advisory, true);
  assert.equal(model.autoSwitch.candidate.freshness, "stale");
  assert.deepEqual(
    model.otherAccounts.map((entry) => entry.accountId),
    [resetSoon.id, resetLater.id, exhausted.id, relogin.id, locked.id],
  );
});

test("candidate ties use account ID instead of saved-entry order", () => {
  const current = account({ name: "current", id: "local:current", isCurrent: true });
  const zulu = account({ name: "zulu", id: "local:zulu" });
  const alpha = account({ name: "alpha", id: "local:alpha" });
  const identicalQuota = (entry) => quotaState(entry.id, quotaInfo(25, {
    primaryWindow: {
      usedPercent: 25,
      resetsAt: new Date("2026-08-12T12:00:00.000Z"),
      windowSeconds: 18_000,
    },
  }));
  const model = build({
    accounts: [current, zulu, alpha],
    selection: { kind: "account", name: "current", source: "local", meta: current.meta },
    quota: new Map([
      [current.id, quotaState(current.id, quotaInfo(100))],
      [zulu.id, identicalQuota(zulu)],
      [alpha.id, identicalQuota(alpha)],
    ]),
  });

  assert.equal(model.autoSwitch.candidate.accountId, alpha.id);
});

test("candidate selection excludes failed, unavailable, and missing five-hour quota", () => {
  const current = account({ name: "current", id: "local:current", isCurrent: true });
  const failed = account({ name: "failed", id: "local:failed" });
  const unavailable = account({ name: "unavailable", id: "local:unavailable" });
  const noFiveHour = account({ name: "weekly", id: "local:weekly" });
  const fallback = account({ name: "fallback", id: "local:fallback" });
  const model = build({
    accounts: [current, failed, unavailable, noFiveHour, fallback],
    selection: { kind: "account", name: current.name, source: current.source, meta: current.meta },
    quota: new Map([
      [current.id, quotaState(current.id, quotaInfo(100))],
      [failed.id, quotaState(failed.id, quotaInfo(10), { errorMessage: "SECRET_FAILED_REFRESH" })],
      [unavailable.id, quotaState(unavailable.id, quotaInfo(10, {
        unavailableReason: { code: "request_failed", message: "SECRET_UNAVAILABLE", statusCode: 503 },
      }))],
      [noFiveHour.id, quotaState(noFiveHour.id, quotaInfo(10, {
        primaryWindow: { usedPercent: 10, resetsAt: null, windowSeconds: 604_800 },
      }))],
      [fallback.id, quotaState(fallback.id, quotaInfo(40), {
        provenance: "cache-fallback",
        errorMessage: "SECRET_FALLBACK",
      })],
    ]),
  });

  assert.equal(model.autoSwitch.candidate.accountId, fallback.id);
  assert.equal(model.autoSwitch.candidate.freshness, "stale");
  assert.doesNotMatch(JSON.stringify(model), /SECRET_/);
});

test("maps loading, errors, relogin, and storage states without raw messages", () => {
  const cases = [
    [account({ name: "loading", id: "local:loading" }), quotaState("local:loading", null, { loading: true }), "loading"],
    [account({ name: "error", id: "local:error" }), quotaState("local:error", null, { errorMessage: "SECRET_RAW_QUOTA_ERROR" }), "unavailable"],
    [account({ name: "login", id: "local:login" }), quotaState("local:login", quotaInfo(5), { reloginRequired: true, reloginMessage: "SECRET_RELOGIN" }), "relogin-required"],
    [account({ name: "locked", id: "local:locked", storageState: "locked" }), undefined, "storage-locked"],
    [account({ name: "pending", id: "local:pending", storageState: "pending" }), undefined, "storage-pending"],
    [account({ name: "invalid", id: "local:invalid", storageState: "invalid" }), undefined, "storage-invalid"],
  ];

  for (const [entry, state, expected] of cases) {
    const model = build({
      accounts: [entry],
      selection: { kind: "account", name: entry.name, source: entry.source, meta: entry.meta },
      quota: new Map(state ? [[entry.id, state]] : []),
    });
    assert.equal(model.route.quota.status, expected);
    assert.doesNotMatch(JSON.stringify(model), /SECRET_/);
  }
});

test("rejects non-finite quota percentages instead of serializing null as a number", () => {
  for (const usedPercent of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const current = account({ isCurrent: true });
    const model = build({
      accounts: [current],
      selection: { kind: "account", name: current.name, source: current.source, meta: current.meta },
      quota: new Map([[current.id, quotaState(current.id, quotaInfo(usedPercent))]]),
    });

    assert.equal(model.route.quota.status, "unavailable");
    assert.equal(model.route.quota.fiveHour, null);
    assert.doesNotMatch(JSON.stringify(model), /null[^}]*remainingPercent/);
    const visit = (value) => {
      if (typeof value === "number") assert.equal(Number.isFinite(value), true);
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(model);
  }
});

test("excludes non-finite quota values from advisory candidates", () => {
  const current = account({ name: "current", id: "local:current", isCurrent: true });
  const malformed = account({ name: "malformed", id: "local:malformed" });
  const model = build({
    accounts: [current, malformed],
    selection: { kind: "account", name: current.name, source: current.source, meta: current.meta },
    quota: new Map([
      [current.id, quotaState(current.id, quotaInfo(100))],
      [malformed.id, quotaState(malformed.id, quotaInfo(Number.NEGATIVE_INFINITY))],
    ]),
  });

  assert.equal(model.autoSwitch.candidate, null);
  assert.equal(model.otherAccounts[0].quota.status, "unavailable");
  assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
});

test("keeps all token totals and tiny segments with finite zero percentages", () => {
  const tiny = {
    id: stableSubjectId("account", "local:tiny"),
    kind: "account",
    label: "tiny",
    sessionCount: 1,
    tokens: tokens(1),
  };
  const large = {
    id: stableSubjectId("provider", "local:large"),
    kind: "provider",
    label: "large",
    sessionCount: 3,
    tokens: tokens(999),
  };
  const model = build({
    usageSnapshot: usage([tiny, large], {
      total: tokens(1_200, { inputTokens: 900, cachedInputTokens: 300, outputTokens: 300, reasoningOutputTokens: 50 }),
      unattributed: tokens(200),
    }),
    reload: { recommended: true, reason: "Switch complete" },
  });

  assert.deepEqual(model.usage.total, {
    inputTokens: 900,
    cachedInputTokens: 300,
    outputTokens: 300,
    reasoningOutputTokens: 50,
    totalTokens: 1_200,
  });
  assert.equal(model.usage.attributedTokens, 1_000);
  assert.equal(model.usage.segments.length, 2);
  assert.ok(model.usage.segments.find((segment) => segment.label === "tiny"));
  assert.equal(model.reload.recommended, true);
  assert.equal(model.reload.message, "Switch complete");

  const zero = build({ usageSnapshot: usage([], { total: tokens(0) }) });
  assert.deepEqual(zero.usage.segments, []);
  assert.equal(Number.isFinite(zero.usage.attributedPercent), true);
  assert.equal(zero.usage.attributedPercent, 0);
});

test("uses fixed safe messages for partial and indexing usage states", () => {
  const partial = build({
    usageSnapshot: usage([], { coverage: "partial", lastError: "SECRET_PARTIAL_ERROR" }),
  });
  assert.equal(partial.usage.message, "Some local sessions could not be indexed.");

  const indexing = build({
    usageSnapshot: usage([], { status: "indexing", lastError: "SECRET_INDEX_ERROR" }),
  });
  assert.equal(indexing.usage.message, "Indexing local Codex sessions...");
  assertSecretFree(indexing);
});
