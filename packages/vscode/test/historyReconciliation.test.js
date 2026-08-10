const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseHistoryInventoryResult,
  parseHistoryMigrationResult,
  repairSharedHistory,
  selectHistoryMigrationSources,
} = require("../dist/historyReconciliation.js");

function createHarness(options = {}) {
  const calls = { runs: [], reloadRecommendations: [], errors: [] };
  return {
    calls,
    dependencies: {
      enabled: options.enabled ?? true,
      sourceProviders: options.sourceProviders ?? ["proxy"],
      targetProvider: options.targetProvider,
      async runMigration(source, target) {
        calls.runs.push({ source, target });
        if (options.errors?.[source]) throw options.errors[source];
        if (options.error) throw options.error;
        return options.results?.[source]
          ?? { rollout_updates: 0, thread_updates: 0, backup_dir: null };
      },
      async markReloadRecommended(summary) {
        calls.reloadRecommendations.push(summary);
      },
      async showErrorMessage(message) {
        calls.errors.push(message);
      },
    },
  };
}

test("history repair is disabled when shared history is off", async () => {
  const harness = createHarness({ enabled: false });
  const result = await repairSharedHistory(harness.dependencies);
  assert.equal(result, null);
  assert.equal(harness.calls.runs.length, 0);
});

test("history repair normalizes provider IDs and skips the target", async () => {
  const harness = createHarness({
    sourceProviders: [" proxy ", "openai", "proxy", "relay"],
  });
  const result = await repairSharedHistory(harness.dependencies);
  assert.deepEqual(harness.calls.runs, [
    { source: "proxy", target: "openai" },
    { source: "relay", target: "openai" },
  ]);
  assert.deepEqual(result.sources, ["proxy", "relay"]);
});

test("history inventory selection excludes only the shared target", () => {
  assert.deepEqual(
    selectHistoryMigrationSources(["orphaned-provider", "openai", "orphaned-provider"]),
    ["orphaned-provider"],
  );
});

test("clean history repair does not recommend reload", async () => {
  const harness = createHarness();
  const result = await repairSharedHistory(harness.dependencies);
  assert.equal(result.rollout_updates, 0);
  assert.equal(result.thread_updates, 0);
  assert.equal(harness.calls.reloadRecommendations.length, 0);
});

test("changed history repair aggregates results and recommends one reload", async () => {
  const harness = createHarness({
    sourceProviders: ["relay", "proxy"],
    results: {
      proxy: { rollout_updates: 1, thread_updates: 2, backup_dir: "/backup/proxy" },
      relay: { rollout_updates: 3, thread_updates: 4, backup_dir: "/backup/relay" },
    },
  });
  const result = await repairSharedHistory(harness.dependencies);
  assert.equal(result.rollout_updates, 4);
  assert.equal(result.thread_updates, 6);
  assert.deepEqual(result.backup_dirs, ["/backup/proxy", "/backup/relay"]);
  assert.equal(harness.calls.reloadRecommendations.length, 1);
  assert.deepEqual(harness.calls.reloadRecommendations[0], result);
});

test("history repair failure reports one error without recommending reload", async () => {
  const harness = createHarness({ error: new Error("database busy") });
  const result = await repairSharedHistory(harness.dependencies);
  assert.equal(result, null);
  assert.equal(harness.calls.errors.length, 1);
  assert.match(harness.calls.errors[0], /database busy/);
  assert.equal(harness.calls.reloadRecommendations.length, 0);
});

test("history repair returns a partial summary and recommends reload after a later source fails", async () => {
  const harness = createHarness({
    sourceProviders: ["beta", "alpha"],
    results: {
      alpha: { rollout_updates: 2, thread_updates: 1, backup_dir: "/backup/alpha" },
    },
    errors: {
      beta: new Error("database busy"),
    },
  });

  const result = await repairSharedHistory(harness.dependencies);

  assert.ok(result);
  assert.deepEqual(harness.calls.runs, [
    { source: "alpha", target: "openai" },
    { source: "beta", target: "openai" },
  ]);
  assert.deepEqual(result.completed_sources, ["alpha"]);
  assert.equal(result.failed_source, "beta");
  assert.equal(result.rollout_updates, 2);
  assert.equal(result.thread_updates, 1);
  assert.deepEqual(result.backup_dirs, ["/backup/alpha"]);
  assert.equal(harness.calls.reloadRecommendations.length, 1);
  assert.deepEqual(harness.calls.reloadRecommendations[0], result);
  assert.equal(harness.calls.errors.length, 1);
  assert.match(harness.calls.errors[0], /Completed 1 of 2 source migration/);
  assert.match(harness.calls.errors[0], /Completed updates were kept/);
  assert.match(harness.calls.errors[0], /database busy/);
});

test("history inventory parser validates provider IDs", () => {
  assert.deepEqual(
    parseHistoryInventoryResult('{"source_providers":["openai","orphaned-provider"]}'),
    { source_providers: ["openai", "orphaned-provider"] },
  );
  assert.throws(
    () => parseHistoryInventoryResult('{"source_providers":["openai",7]}'),
    /invalid result/,
  );
});

test("migration parser rejects malformed results", () => {
  assert.throws(
    () => parseHistoryMigrationResult('{"rollout_updates":-1,"thread_updates":0,"backup_dir":null}'),
    /invalid result/,
  );
});
