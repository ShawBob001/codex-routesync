const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  UsageService,
  formatCompactTokens,
  stableSubjectId,
} = require("../dist/tokenUsage.js");

class MemoryMemento {
  constructor(initialValue) {
    this.value = initialValue;
    this.updates = 0;
  }

  async get() {
    return this.value;
  }

  async update(_key, value) {
    this.value = structuredClone(value);
    this.updates += 1;
  }
}

class SlowMemoryMemento extends MemoryMemento {
  async update(key, value) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await super.update(key, value);
  }
}

class KeyedMemoryMemento {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async update(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

function tempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csb-token-usage-"));
}

function sessionMeta(id, startedAt, provider = "openai") {
  return {
    timestamp: startedAt,
    type: "session_meta",
    payload: {
      id,
      timestamp: startedAt,
      model_provider: provider,
    },
  };
}

function tokenCount(totalTokens, observedAt, overrides = {}) {
  const inputTokens = overrides.inputTokens ?? Math.max(0, totalTokens - 20);
  const outputTokens = overrides.outputTokens ?? Math.min(20, totalTokens);
  const info = {
    total_token_usage: {
      input_tokens: inputTokens,
      cached_input_tokens: overrides.cachedInputTokens ?? Math.floor(inputTokens / 2),
      output_tokens: outputTokens,
      reasoning_output_tokens: overrides.reasoningOutputTokens ?? Math.floor(outputTokens / 2),
      total_tokens: totalTokens,
    },
  };
  if (overrides.lastTokens) {
    info.last_token_usage = {
      input_tokens: overrides.lastTokens.inputTokens,
      cached_input_tokens: overrides.lastTokens.cachedInputTokens,
      output_tokens: overrides.lastTokens.outputTokens,
      reasoning_output_tokens: overrides.lastTokens.reasoningOutputTokens,
      total_tokens: overrides.lastTokens.totalTokens,
    };
  }
  return {
    timestamp: observedAt,
    type: "event_msg",
    payload: {
      type: "token_count",
      info,
    },
  };
}

function writeSession(codexHome, location, name, records, suffix = "") {
  const directory = location === "archived_sessions"
    ? path.join(codexHome, location)
    : path.join(codexHome, location, "2026", "08", "11");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.jsonl`);
  const lines = records.map((record) =>
    typeof record === "string" ? record : JSON.stringify(record)
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n${suffix}`, "utf8");
  return file;
}

function subject(kind, identity, label, legacyProviderIds) {
  return {
    id: stableSubjectId(kind, identity),
    kind,
    label,
    ...(legacyProviderIds ? { legacyProviderIds } : {}),
  };
}

function sumHistoryTokens(history, field = "totalTokens") {
  return history.days.reduce((sum, day) => sum + day.total[field], history.undated[field]);
}

test("stable subject IDs are deterministic, opaque, and kind-specific", () => {
  const account = stableSubjectId("account", "account-123");
  assert.equal(account, stableSubjectId("account", "account-123"));
  assert.notEqual(account, stableSubjectId("provider", "account-123"));
  assert.match(account, /^account:[a-f0-9]{24}$/);
  assert.doesNotMatch(account, /account-123/);
  assert.throws(() => stableSubjectId("account", "   "), /non-empty/);
});

test("compact formatter keeps readable precision without inflating invalid values", () => {
  assert.equal(formatCompactTokens(0), "0");
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(1_000), "1K");
  assert.equal(formatCompactTokens(1_250), "1.25K");
  assert.equal(formatCompactTokens(12_500), "12.5K");
  assert.equal(formatCompactTokens(999_999), "1M");
  assert.equal(formatCompactTokens(1_250_000), "1.25M");
  assert.equal(formatCompactTokens(2_000_000_000), "2B");
  assert.equal(formatCompactTokens(-1), "0");
  assert.equal(formatCompactTokens(Number.NaN), "0");
});

test("reverse bootstrap reads the last valid cumulative total and reuses fingerprints", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  writeSession(codexHome, "sessions", "reverse", [
    sessionMeta("thread-reverse", 1_000),
    tokenCount(40, 1_100),
    tokenCount(120, 1_200, {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      reasoningOutputTokens: 10,
    }),
  ]);

  const service = new UsageService({
    codexHome,
    memento,
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  assert.equal(service.getSnapshot().status, "uninitialized");
  assert.equal(service.getSnapshot().trackingStartedAt, null);
  const first = await service.initialize();
  assert.equal(first.status, "ready");
  assert.equal(first.coverage, "complete");
  assert.equal(first.trackingStartedAt, 5_000);
  assert.equal(first.total.totalTokens, 120);
  assert.equal(first.total.inputTokens, 100);
  assert.equal(first.total.cachedInputTokens, 80);
  assert.equal(first.total.outputTokens, 20);
  assert.equal(first.total.reasoningOutputTokens, 10);
  assert.equal(first.unattributed.totalTokens, 120);
  assert.equal(first.scan.rescannedFiles, 1);

  const second = await service.refresh();
  assert.equal(second.total.totalTokens, 120);
  assert.equal(second.scan.rescannedFiles, 0);
  assert.equal(second.scan.reusedFiles, 1);
  service.dispose();
});

test("request usage does not count an inherited cumulative baseline twice", async () => {
  const codexHome = tempCodexHome();
  const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365cbe";
  const file = writeSession(codexHome, "sessions", `rollout-2026-08-11T00-00-00-${threadId}`, [
    sessionMeta(threadId, 1_000),
    JSON.stringify({ type: "response_item", payload: "x".repeat(128 * 1024) }),
    tokenCount(50_000_000, 1_100, {
      inputTokens: 900,
      cachedInputTokens: 600,
      outputTokens: 100,
      reasoningOutputTokens: 50,
      lastTokens: {
        inputTokens: 900,
        cachedInputTokens: 600,
        outputTokens: 100,
        reasoningOutputTokens: 50,
        totalTokens: 1_000,
      },
    }),
    tokenCount(50_000_000, 1_101, {
      inputTokens: 900,
      cachedInputTokens: 600,
      outputTokens: 100,
      reasoningOutputTokens: 50,
      lastTokens: {
        inputTokens: 900,
        cachedInputTokens: 600,
        outputTokens: 100,
        reasoningOutputTokens: 50,
        totalTokens: 1_000,
      },
    }),
    tokenCount(50_001_800, 1_200, {
      inputTokens: 2_500,
      cachedInputTokens: 1_800,
      outputTokens: 300,
      reasoningOutputTokens: 150,
      lastTokens: {
        inputTokens: 1_600,
        cachedInputTokens: 1_200,
        outputTokens: 200,
        reasoningOutputTokens: 100,
        totalTokens: 1_800,
      },
    }),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const initial = await service.initialize();
  assert.deepEqual(initial.total, {
    inputTokens: 2_500,
    cachedInputTokens: 1_800,
    outputTokens: 300,
    reasoningOutputTokens: 150,
    totalTokens: 2_800,
  });

  fs.appendFileSync(file, `${JSON.stringify(tokenCount(50_004_300, 1_300, {
    inputTokens: 4_800,
    cachedInputTokens: 3_600,
    outputTokens: 550,
    reasoningOutputTokens: 250,
    lastTokens: {
      inputTokens: 2_300,
      cachedInputTokens: 1_800,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 2_500,
    },
  }))}\n`, "utf8");
  const appended = await service.refresh();
  assert.equal(appended.total.totalTokens, 5_300);
  assert.equal(appended.total.inputTokens, 4_800);
  assert.equal(appended.total.cachedInputTokens, 3_600);
  service.dispose();
});

test("request usage keeps real work after a cumulative counter reset", async () => {
  const codexHome = tempCodexHome();
  const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365cbf";
  writeSession(codexHome, "sessions", `rollout-2026-08-11T00-00-00-${threadId}`, [
    sessionMeta(threadId, 1_100),
    tokenCount(80_000_000, 1_200, {
      inputTokens: 80_000_000,
      cachedInputTokens: 79_000_000,
      outputTokens: 100_000,
      reasoningOutputTokens: 50_000,
      lastTokens: {
        inputTokens: 1_000,
        cachedInputTokens: 700,
        outputTokens: 100,
        reasoningOutputTokens: 50,
        totalTokens: 1_100,
      },
    }),
    tokenCount(1_500, 1_300, {
      inputTokens: 1_400,
      cachedInputTokens: 900,
      outputTokens: 100,
      reasoningOutputTokens: 50,
      lastTokens: {
        inputTokens: 400,
        cachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 20,
        totalTokens: 450,
      },
    }),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.total.totalTokens, 1_550);
  assert.equal(snapshot.total.inputTokens, 1_400);
  assert.equal(snapshot.total.cachedInputTokens, 900);
  service.dispose();
});

test("usage history assigns timestamped increments to UTC days and active subjects", async () => {
  const codexHome = tempCodexHome();
  const account = subject("account", "daily-account", "Daily account");
  const provider = subject("provider", "daily-provider", "Daily provider");
  const initializedAt = Date.parse("2026-08-10T22:00:00.000Z");
  const accountAt = Date.parse("2026-08-10T23:00:00.000Z");
  const providerAt = Date.parse("2026-08-11T00:10:00.000Z");
  let now = initializedAt;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 3 * 60 * 60 * 1_000,
  });
  await service.initialize();
  now = accountAt;
  await service.recordSelection(account);
  now = providerAt;
  await service.recordSelection(provider);
  writeSession(codexHome, "sessions", "daily-history", [
    sessionMeta("daily-history-thread", Date.parse("2026-08-10T23:30:00.000Z")),
    tokenCount(100, Date.parse("2026-08-10T23:59:59.999Z")),
    tokenCount(160, Date.parse("2026-08-11T00:15:00.000Z")),
  ]);

  now = Date.parse("2026-08-11T01:00:00.000Z");
  const snapshot = await service.refresh();
  assert.deepEqual(snapshot.history.days.map((day) => day.date), ["2026-08-10", "2026-08-11"]);
  assert.equal(snapshot.history.days[0].total.totalTokens, 100);
  assert.equal(snapshot.history.days[0].estimated.totalTokens, 0);
  assert.equal(snapshot.history.days[0].estimatedUnattributed.totalTokens, 0);
  assert.equal(snapshot.history.days[0].unattributed.totalTokens, 0);
  assert.deepEqual(
    snapshot.history.days[0].subjects.map((entry) => [
      entry.id,
      entry.tokens.totalTokens,
      entry.estimated.totalTokens,
    ]),
    [[account.id, 100, 0]],
  );
  assert.equal(snapshot.history.days[1].total.totalTokens, 60);
  assert.equal(snapshot.history.days[1].estimated.totalTokens, 0);
  assert.equal(snapshot.history.days[1].estimatedUnattributed.totalTokens, 0);
  assert.equal(snapshot.history.days[1].unattributed.totalTokens, 0);
  assert.deepEqual(
    snapshot.history.days[1].subjects.map((entry) => [
      entry.id,
      entry.tokens.totalTokens,
      entry.estimated.totalTokens,
    ]),
    [[provider.id, 60, 0]],
  );
  assert.equal(snapshot.history.undated.totalTokens, 0);
  assert.equal(sumHistoryTokens(snapshot.history), snapshot.total.totalTokens);
  service.dispose();
});

test("usage history estimates historical and undated increments on the last observed UTC day", async () => {
  const codexHome = tempCodexHome();
  const relay = subject("provider", "historical-relay", "Historical relay", ["relay"]);
  const initializedAt = Date.parse("2026-08-10T00:00:00.000Z");
  writeSession(codexHome, "sessions", "historical-daily", [
    sessionMeta("historical-daily-thread", Date.parse("2026-08-01T12:00:00.000Z"), "relay"),
    tokenCount(75, Date.parse("2026-08-03T04:05:06.000Z")),
  ]);
  let now = initializedAt;
  const memento = new MemoryMemento();
  const service = new UsageService({
    codexHome,
    memento,
    knownSubjects: [relay],
    now: () => now,
    heartbeatIntervalMs: 0,
  });
  await service.initialize();
  writeSession(codexHome, "sessions", "undated-increment", [
    sessionMeta("undated-increment-thread", Date.parse("2026-08-11T10:00:00.000Z")),
    tokenCount(25, undefined),
  ]);

  now = Date.parse("2026-08-12T00:00:00.000Z");
  const snapshot = await service.refresh();
  assert.deepEqual(snapshot.history.days.map((day) => day.date), ["2026-08-03", "2026-08-11"]);
  assert.equal(snapshot.history.days[0].total.totalTokens, 75);
  assert.equal(snapshot.history.days[0].estimated.totalTokens, 75);
  assert.equal(snapshot.history.days[0].estimatedUnattributed.totalTokens, 0);
  assert.deepEqual(
    snapshot.history.days[0].subjects.map((entry) => [
      entry.id,
      entry.tokens.totalTokens,
      entry.estimated.totalTokens,
    ]),
    [[relay.id, 75, 75]],
  );
  assert.equal(snapshot.history.days[1].total.totalTokens, 25);
  assert.equal(snapshot.history.days[1].estimated.totalTokens, 25);
  assert.equal(snapshot.history.days[1].estimatedUnattributed.totalTokens, 25);
  assert.equal(snapshot.history.days[1].unattributed.totalTokens, 25);
  for (const field of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]) {
    assert.equal(sumHistoryTokens(snapshot.history, field), snapshot.total[field]);
  }
  assert.equal(memento.value.version, 3);
  assert.equal(Object.hasOwn(memento.value, "history"), false, "derived history must not be persisted");

  snapshot.history.days[0].total.totalTokens = 999_999;
  assert.equal(service.getSnapshot().history.days[0].total.totalTokens, 75);
  service.dispose();
});

test("usage history conserves records whose timestamps cannot form a UTC date as undated", async () => {
  const codexHome = tempCodexHome();
  writeSession(codexHome, "sessions", "invalid-calendar-date", [
    sessionMeta("invalid-calendar-date-thread", Number.MAX_VALUE),
    tokenCount(10, undefined),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 0,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.deepEqual(snapshot.history.days, []);
  assert.deepEqual(snapshot.history.undated, snapshot.total);
  assert.equal(sumHistoryTokens(snapshot.history), snapshot.total.totalTokens);
  service.dispose();
});

test("usage history changes notify listeners even when cumulative totals stay unchanged", async () => {
  const codexHome = tempCodexHome();
  let now = Date.parse("2026-08-01T00:00:00.000Z");
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => now,
    heartbeatIntervalMs: 0,
  });
  await service.initialize();
  const rollout = writeSession(codexHome, "sessions", "history-signature", [
    sessionMeta("history-signature-thread", Date.parse("2026-08-02T00:00:00.000Z")),
    tokenCount(50, Date.parse("2026-08-02T12:00:00.000Z")),
  ]);
  await service.refresh();
  let changes = 0;
  const disposable = service.onDidChange(() => { changes += 1; });
  const movedToken = tokenCount(50, Date.parse("2026-08-03T12:00:00.000Z"));
  movedToken.payload.padding = "fingerprint-change";
  fs.writeFileSync(
    rollout,
    `${JSON.stringify(sessionMeta("history-signature-thread", Date.parse("2026-08-02T00:00:00.000Z")))}\n${JSON.stringify(movedToken)}\n`,
    "utf8",
  );

  now = Date.parse("2026-08-04T00:00:00.000Z");
  const snapshot = await service.refresh();
  assert.deepEqual(snapshot.history.days.map((day) => day.date), ["2026-08-03"]);
  assert.ok(changes > 0, "history-only changes must update dashboard listeners");
  disposable.dispose();
  service.dispose();
});

test("a large normal rollout reads only its head metadata and tail token chunk", async () => {
  const codexHome = tempCodexHome();
  const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365cbb";
  writeSession(
    codexHome,
    "sessions",
    `rollout-2026-08-11T00-00-00-${threadId}`,
    [
      sessionMeta(threadId, 1_000),
      JSON.stringify({ type: "response_item", payload: "x".repeat(5 * 1024 * 1024) }),
      tokenCount(125, 1_200),
    ],
  );
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.total.totalTokens, 125);
  assert.ok(snapshot.scan.bytesRead <= 2 * 64 * 1024);
  assert.equal(snapshot.scan.chunksRead, 2);
  service.dispose();
});

test("forked rollouts subtract the inherited total before the last session metadata", async () => {
  const codexHome = tempCodexHome();
  writeSession(codexHome, "sessions", "fork", [
    sessionMeta("parent-thread", 1_000),
    tokenCount(40, 1_050, {
      inputTokens: 30,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningOutputTokens: 2,
    }),
    tokenCount(100, 1_100, {
      inputTokens: 80,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 8,
    }),
    sessionMeta("fork-thread", 1_200),
    tokenCount(165, 1_300, {
      inputTokens: 130,
      cachedInputTokens: 60,
      outputTokens: 35,
      reasoningOutputTokens: 13,
    }),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.sessionCount, 1);
  assert.deepEqual(snapshot.total, {
    inputTokens: 50,
    cachedInputTokens: 20,
    outputTokens: 15,
    reasoningOutputTokens: 5,
    totalTokens: 65,
  });
  service.dispose();
});

test("cumulative replay replaces cached usage and a file rollback does not double count", async () => {
  const codexHome = tempCodexHome();
  const file = writeSession(codexHome, "sessions", "replay", [
    sessionMeta("thread-replay", 1_000),
    tokenCount(100, 1_100),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  assert.equal((await service.initialize()).total.totalTokens, 100);

  fs.appendFileSync(file, `${JSON.stringify(tokenCount(180, 1_200))}\n`, "utf8");
  assert.equal((await service.refresh()).total.totalTokens, 180);

  fs.writeFileSync(
    file,
    `${JSON.stringify(sessionMeta("thread-replay", 1_000))}\n${JSON.stringify(tokenCount(70, 1_300))}\nrollback\n`,
    "utf8",
  );
  const rolledBack = await service.refresh();
  assert.equal(rolledBack.total.totalTokens, 70);
  assert.equal(rolledBack.sessionCount, 1);
  service.dispose();
});

test("malformed, truncated, and invalid token lines are ignored", async () => {
  const codexHome = tempCodexHome();
  const missingField = tokenCount(90, 1_300);
  delete missingField.payload.info.total_token_usage.reasoning_output_tokens;
  const negative = tokenCount(100, 1_400);
  negative.payload.info.total_token_usage.total_tokens = -1;
  writeSession(codexHome, "sessions", "malformed", [
    sessionMeta("thread-malformed", 1_000),
    tokenCount(55, 1_100),
    { type: "other", payload: { type: "token_count" } },
    missingField,
    negative,
    "{\"timestamp\":1500,\"type\":\"event_msg\",\"payload\":",
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.total.totalTokens, 55);
  assert.equal(snapshot.scan.errors, 0);
  service.dispose();
});

test("the same thread in active and archived sessions is counted once", async () => {
  const codexHome = tempCodexHome();
  writeSession(codexHome, "archived_sessions", "duplicate-old", [
    sessionMeta("thread-duplicate", 1_000),
    tokenCount(100, 1_100),
  ]);
  writeSession(codexHome, "sessions", "duplicate-new", [
    sessionMeta("thread-duplicate", 1_000),
    tokenCount(150, 1_200),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.scan.discoveredFiles, 2);
  assert.equal(snapshot.sessionCount, 1);
  assert.equal(snapshot.total.totalTokens, 150);
  service.dispose();
});

test("first activation leaves OpenAI history unattributed but maps unique legacy providers", async () => {
  const codexHome = tempCodexHome();
  const relay = subject("provider", "relay-profile", "Relay", ["relay"]);
  const duplicateOne = subject("provider", "duplicate-one", "Duplicate one", ["ambiguous"]);
  const duplicateTwo = subject("provider", "duplicate-two", "Duplicate two", ["ambiguous"]);
  writeSession(codexHome, "sessions", "old-openai", [
    sessionMeta("old-openai", 1_000, "openai"),
    tokenCount(40, 1_100),
  ]);
  writeSession(codexHome, "sessions", "old-relay", [
    sessionMeta("old-relay", 2_000, "relay"),
    tokenCount(60, 2_100),
  ]);
  writeSession(codexHome, "sessions", "old-ambiguous", [
    sessionMeta("old-ambiguous", 3_000, "ambiguous"),
    tokenCount(80, 3_100),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [relay, duplicateOne, duplicateTwo],
    now: () => 10_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.total.totalTokens, 180);
  assert.equal(snapshot.unattributed.totalTokens, 120);
  assert.equal(snapshot.subjects.find((item) => item.id === relay.id).tokens.totalTokens, 60);
  assert.equal(snapshot.subjects.find((item) => item.id === duplicateOne.id).tokens.totalTokens, 0);
  assert.equal(snapshot.subjects.find((item) => item.id === duplicateTwo.id).tokens.totalTokens, 0);
  service.dispose();
});

test("shared-history repair keeps cached legacy provider attribution after rewriting to openai", async () => {
  const codexHome = tempCodexHome();
  const relay = subject("provider", "repair-relay", "Repair relay", ["relay"]);
  const rollout = writeSession(codexHome, "sessions", "repair-provider", [
    sessionMeta("repair-thread", 1_000, "relay"),
    tokenCount(60, 1_100),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [relay],
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  const before = await service.initialize();
  assert.equal(before.subjects.find((item) => item.id === relay.id).tokens.totalTokens, 60);

  fs.writeFileSync(
    rollout,
    `${JSON.stringify(sessionMeta("repair-thread", 1_000, "openai"))}\n${JSON.stringify(tokenCount(60, 1_100))}\nrepaired\n`,
    "utf8",
  );
  const after = await service.refresh();
  assert.equal(after.subjects.find((item) => item.id === relay.id).tokens.totalTokens, 60);
  assert.equal(after.unattributed.totalTokens, 0);
  service.dispose();
});

test("selection transitions, heartbeats, and inactive gaps control future attribution", async () => {
  const codexHome = tempCodexHome();
  const account = subject("account", "account-a", "Account A");
  const provider = subject("provider", "provider-b", "Provider B");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 100,
  });
  await service.initialize();

  now = 1_100;
  await service.recordSelection(account);
  now = 1_180;
  await service.recordSelection(account);
  writeSession(codexHome, "sessions", "account-active", [
    sessionMeta("account-active", 1_250),
    tokenCount(30, 1_260),
  ]);
  writeSession(codexHome, "sessions", "inactive-gap", [
    sessionMeta("inactive-gap", 1_300),
    tokenCount(40, 1_310),
  ]);

  now = 1_400;
  await service.recordSelection(provider);
  writeSession(codexHome, "sessions", "provider-active", [
    sessionMeta("provider-active", 1_450),
    tokenCount(50, 1_460),
  ]);
  const snapshot = await service.refresh();
  assert.equal(snapshot.total.totalTokens, 120);
  assert.equal(snapshot.unattributed.totalTokens, 40);
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 30);
  assert.equal(snapshot.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 50);
  service.dispose();
});

test("repeated unknown selections extend one gap without growing the timeline", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento,
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 100,
  });
  await service.initialize();
  await service.recordSelection(null);
  now = 2_000;
  await service.recordSelection(null);
  now = 3_000;
  await service.recordSelection(null);

  assert.equal(memento.value.timeline.length, 1);
  assert.deepEqual(memento.value.timeline[0], {
    at: 1_000,
    activeUntil: 3_000,
    subjectId: null,
  });
  service.dispose();
});

test("one rollout attributes cumulative token deltas across a selection switch", async () => {
  const codexHome = tempCodexHome();
  const account = subject("account", "account-a", "Account A");
  const provider = subject("provider", "provider-p", "Provider P");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await service.initialize();

  now = 1_100;
  await service.recordSelection(account);
  const rolloutPath = writeSession(codexHome, "sessions", "shared-rollout", [
    sessionMeta("shared-thread", 1_150),
    tokenCount(30, 1_200),
  ]);
  await service.refresh();

  now = 1_300;
  await service.recordSelection(provider);
  fs.appendFileSync(rolloutPath, `${JSON.stringify(tokenCount(80, 1_400))}\n`, "utf8");
  const snapshot = await service.refresh();

  assert.equal(snapshot.total.totalTokens, 80);
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 30);
  assert.equal(snapshot.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 50);
  service.dispose();
});

test("one rollout preserves deltas across repeated account and provider switches", async () => {
  const codexHome = tempCodexHome();
  const account = subject("account", "repeat-account", "Repeat account");
  const provider = subject("provider", "repeat-provider", "Repeat provider");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await service.initialize();

  now = 1_100;
  await service.recordSelection(account);
  const rollout = writeSession(codexHome, "sessions", "repeat-rollout", [
    sessionMeta("repeat-thread", 1_150),
    tokenCount(20, 1_200),
  ]);
  await service.refresh();
  now = 1_300;
  await service.recordSelection(provider);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(50, 1_400))}\n`, "utf8");
  await service.refresh();
  now = 1_500;
  await service.recordSelection(account);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(90, 1_600))}\n`, "utf8");

  const snapshot = await service.refresh();
  assert.equal(snapshot.total.totalTokens, 90);
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 60);
  assert.equal(snapshot.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 30);
  service.dispose();
});

test("tracked rollout appends are tail-only and rollback starts a new attribution epoch", async () => {
  const codexHome = tempCodexHome();
  const account = subject("account", "append-account", "Append account");
  const provider = subject("provider", "append-provider", "Append provider");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await service.initialize();
  now = 1_100;
  await service.recordSelection(account);
  const rollout = writeSession(codexHome, "sessions", "long-tracked-rollout", [
    sessionMeta("long-tracked-thread", 1_150),
    tokenCount(30, 1_200),
    JSON.stringify({ type: "response_item", payload: "x".repeat(3 * 1024 * 1024) }),
  ]);
  await service.refresh();

  now = 1_300;
  await service.recordSelection(provider);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(80, 1_400))}\n`, "utf8");
  const appended = await service.refresh();
  assert.equal(appended.total.totalTokens, 80);
  assert.ok(appended.scan.bytesRead < 2_048, `read ${appended.scan.bytesRead} bytes`);
  assert.equal(appended.subjects.find((item) => item.id === account.id).tokens.totalTokens, 30);
  assert.equal(appended.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 50);

  now = 1_500;
  await service.recordSelection(account);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(20, 1_600))}\n`, "utf8");
  const rolledBack = await service.refresh();
  assert.equal(rolledBack.total.totalTokens, 20);
  assert.equal(rolledBack.subjects.find((item) => item.id === account.id).tokens.totalTokens, 20);
  assert.equal(rolledBack.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 0);
  service.dispose();
});

test("large same-selection histories persist a compressed lossless cache", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const account = subject("account", "compact-account", "Compact account");
  let now = 1_000;
  const options = {
    codexHome,
    memento,
    knownSubjects: [account],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 60_000,
  };
  const first = new UsageService(options);
  await first.initialize();
  now = 1_100;
  await first.recordSelection(account);
  const rollout = writeSession(codexHome, "sessions", "compact-increments", [
    sessionMeta("compact-increments-thread", 1_150),
    ...Array.from({ length: 10_000 }, (_, index) => tokenCount(index + 1, 1_200 + index)),
  ]);
  const initial = await first.refresh();
  assert.equal(initial.total.totalTokens, 10_000);
  assert.equal(initial.subjects.find((item) => item.id === account.id).tokens.totalTokens, 10_000);
  assert.equal(memento.value.files, undefined);
  assert.equal(memento.value.filesEncoding, "gzip-base64");
  assert.equal(typeof memento.value.filesCompressed, "string");
  assert.ok(JSON.stringify(memento.value).length < 50_000);
  first.dispose();

  now = 12_000;
  const restored = new UsageService(options);
  assert.equal((await restored.initialize()).total.totalTokens, 10_000);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(10_050, 12_100))}\n`, "utf8");
  const appended = await restored.refresh();
  assert.equal(appended.total.totalTokens, 10_050);
  assert.equal(appended.subjects.find((item) => item.id === account.id).tokens.totalTokens, 10_050);
  assert.equal(memento.value.files, undefined);
  assert.equal(memento.value.filesEncoding, "gzip-base64");
  restored.dispose();
});

test("reverse scan skips one huge unterminated irrelevant tail line in linear space", {
  timeout: 2_000,
}, async () => {
  const codexHome = tempCodexHome();
  const threadId = "019e7bbd-eb68-7221-8bd9-7d9c51365cbd";
  const suffix = JSON.stringify({ type: "response_item", payload: "x".repeat(4 * 1024 * 1024) });
  writeSession(
    codexHome,
    "sessions",
    `rollout-2026-08-11T00-00-00-${threadId}`,
    [sessionMeta(threadId, 1_000), tokenCount(75, 1_100)],
    suffix,
  );
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.total.totalTokens, 75);
  assert.ok(snapshot.scan.bytesRead <= Buffer.byteLength(suffix) + 2 * 64 * 1024);
  service.dispose();
});

test("concurrent windows merge selection timelines before persisting", async () => {
  const codexHome = tempCodexHome();
  const memento = new SlowMemoryMemento();
  const account = subject("account", "window-account", "Window account");
  const provider = subject("provider", "window-provider", "Window provider");
  let now = 1_000;
  const options = {
    codexHome,
    memento,
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  };
  const first = new UsageService(options);
  const second = new UsageService(options);
  await Promise.all([first.initialize(), second.initialize()]);

  await Promise.all([
    first.recordSelection(account, { at: 1_100 }),
    second.recordSelection(provider, { at: 1_200 }),
  ]);
  writeSession(codexHome, "sessions", "multi-window", [
    sessionMeta("multi-window-thread", 1_125),
    tokenCount(20, 1_150),
    tokenCount(50, 1_250),
  ]);

  const snapshot = await first.refresh();
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 20);
  assert.equal(snapshot.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 30);
  first.dispose();
  second.dispose();
});

test("a delayed selection can split usage scanned by another window", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const account = subject("account", "delayed-selection-account", "Delayed account");
  const provider = subject("provider", "delayed-selection-provider", "Delayed provider");
  let now = 1_000;
  const options = {
    codexHome,
    memento,
    knownSubjects: [account, provider],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  };
  const first = new UsageService(options);
  const delayed = new UsageService(options);
  await Promise.all([first.initialize(), delayed.initialize()]);
  now = 1_100;
  await first.recordSelection(account);

  const originalMkdir = fs.promises.mkdir;
  let releaseDelayedLock;
  let markDelayedLockEntered;
  const delayedLockEntered = new Promise((resolve) => {
    markDelayedLockEntered = resolve;
  });
  const delayedLockRelease = new Promise((resolve) => {
    releaseDelayedLock = resolve;
  });
  let intercepted = false;
  fs.promises.mkdir = async (target, ...args) => {
    if (!intercepted && String(target).includes("codex-switchbridge-token-usage-")) {
      intercepted = true;
      markDelayedLockEntered();
      await delayedLockRelease;
    }
    return originalMkdir.call(fs.promises, target, ...args);
  };

  let delayedSelection;
  try {
    now = 1_200;
    delayedSelection = delayed.recordSelection(provider);
    await delayedLockEntered;
    fs.promises.mkdir = originalMkdir;
    writeSession(codexHome, "sessions", "delayed-selection", [
      sessionMeta("delayed-selection-thread", 1_125),
      tokenCount(20, 1_150),
      tokenCount(50, 1_250),
    ]);
    now = 1_300;
    await first.refresh();
    releaseDelayedLock();
    await delayedSelection;
  } finally {
    fs.promises.mkdir = originalMkdir;
    releaseDelayedLock?.();
    await delayedSelection?.catch(() => {});
    first.dispose();
    delayed.dispose();
  }

  now = 2_000;
  const restored = new UsageService(options);
  const snapshot = await restored.initialize();
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 20);
  assert.equal(snapshot.subjects.find((item) => item.id === provider.id).tokens.totalTokens, 30);
  restored.dispose();
});

test("releasing an old cache lock cannot delete a replacement owner", async () => {
  const codexHome = tempCodexHome();
  const account = subject("account", "lock-owner-account", "Lock owner account");
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [account],
    now: () => 1_000,
    heartbeatIntervalMs: 0,
  });
  await service.initialize();

  const originalUnlink = fs.promises.unlink;
  const replacementToken = "f".repeat(32);
  let replacementOwnerPath = null;
  let replacementLockDirectory = null;
  fs.promises.unlink = async (target, ...args) => {
    const targetPath = String(target);
    const ownerName = path.basename(targetPath);
    if (
      replacementOwnerPath === null
      && ownerName.startsWith("owner")
      && targetPath.includes("codex-switchbridge-token-usage-")
    ) {
      replacementLockDirectory = path.dirname(targetPath);
      await fs.promises.rm(replacementLockDirectory, { recursive: true, force: true });
      await fs.promises.mkdir(replacementLockDirectory);
      const replacementName = ownerName === "owner"
        ? "owner"
        : `owner-${replacementToken}`;
      replacementOwnerPath = path.join(replacementLockDirectory, replacementName);
      await fs.promises.writeFile(replacementOwnerPath, replacementToken, "utf8");
    }
    return originalUnlink.call(fs.promises, target, ...args);
  };

  try {
    await service.recordSelection(account, { at: 1_100 });
  } finally {
    fs.promises.unlink = originalUnlink;
    service.dispose();
  }

  try {
    assert.ok(replacementOwnerPath, "the test should replace the lock during release");
    assert.equal(fs.existsSync(replacementOwnerPath), true);
  } finally {
    if (replacementLockDirectory) {
      fs.rmSync(replacementLockDirectory, { recursive: true, force: true });
    }
  }
});

test("a stale window preserves remaps and indexed files written by another window", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const oldAccount = subject("account", "window-old", "Window old");
  const renamedAccount = subject("account", "window-renamed", "Window renamed");
  let now = 1_000;
  const options = {
    codexHome,
    memento,
    knownSubjects: [oldAccount, renamedAccount],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  };
  const first = new UsageService(options);
  const stale = new UsageService(options);
  await Promise.all([first.initialize(), stale.initialize()]);
  await first.remapSubject(oldAccount.id, renamedAccount);
  now = 1_100;
  await stale.recordSelection(oldAccount);
  writeSession(codexHome, "sessions", "remap-window", [
    sessionMeta("remap-window-thread", 1_150),
    tokenCount(25, 1_200),
  ]);
  await first.refresh();

  now = 1_300;
  await stale.recordSelection(oldAccount);
  const snapshot = stale.getSnapshot();
  assert.equal(snapshot.total.totalTokens, 25);
  assert.equal(
    snapshot.subjects.find((item) => item.id === renamedAccount.id).tokens.totalTokens,
    25,
  );
  first.dispose();
  stale.dispose();
});

test("a stale raw remap is materialized before the old subject is recreated", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const original = subject("account", "stale-recreated-old", "Old account");
  const renamed = subject("account", "stale-recreated-new", "Renamed account");
  let now = 1_000;
  const options = {
    codexHome,
    memento,
    knownSubjects: [original],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  };
  const first = new UsageService(options);
  const stale = new UsageService(options);
  await Promise.all([first.initialize(), stale.initialize()]);
  await first.remapSubject(original.id, renamed);

  now = 1_100;
  await stale.recordSelection(original);
  writeSession(codexHome, "sessions", "stale-recreated-remap", [
    sessionMeta("stale-recreated-remap-thread", 1_150),
    tokenCount(30, 1_200),
  ]);
  await first.refresh();
  first.dispose();
  stale.dispose();

  now = 2_000;
  const restored = new UsageService({
    ...options,
    knownSubjects: [original, renamed],
  });
  const snapshot = await restored.initialize();
  assert.equal(snapshot.subjects.find((item) => item.id === renamed.id).tokens.totalTokens, 30);
  assert.equal(snapshot.subjects.find((item) => item.id === original.id).tokens.totalTokens, 0);
  restored.dispose();
});

test("retiring a subject preserves old usage without attaching it to a recreated entry", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const account = subject("account", "recreated-account", "Recreated account");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento,
    knownSubjects: [account],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await service.initialize();
  now = 1_100;
  await service.recordSelection(account);
  const rollout = writeSession(codexHome, "sessions", "retired-rollout", [
    sessionMeta("retired-thread", 1_150),
    tokenCount(30, 1_200),
  ]);
  await service.refresh();

  now = 1_300;
  const retiredId = await service.retireSubject(account.id);
  assert.notEqual(retiredId, account.id);
  assert.match(retiredId, /^account:[a-f0-9]{24}$/);
  now = 1_400;
  await service.recordSelection(account);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(50, 1_500))}\n`, "utf8");
  const snapshot = await service.refresh();

  assert.equal(snapshot.subjects.find((item) => item.id === retiredId).tokens.totalTokens, 30);
  assert.equal(snapshot.subjects.find((item) => item.id === retiredId).label, "Retired account");
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 20);
  service.dispose();

  now = 2_000;
  const restored = new UsageService({
    codexHome,
    memento,
    knownSubjects: [account],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  const restoredSnapshot = await restored.initialize();
  assert.equal(
    restoredSnapshot.subjects.find((item) => item.id === retiredId).tokens.totalTokens,
    30,
  );
  assert.equal(
    restoredSnapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens,
    20,
  );
  restored.dispose();
});

test("retiring one ambiguous provider does not claim shared legacy history", async () => {
  const codexHome = tempCodexHome();
  const local = subject("provider", "local:shared", "Local shared", ["shared"]);
  const cloud = subject("provider", "cloud:shared", "Cloud shared", ["shared"]);
  writeSession(codexHome, "sessions", "ambiguous-retirement", [
    sessionMeta("ambiguous-retirement-thread", 1_000, "shared"),
    tokenCount(40, 1_100),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [local, cloud],
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  assert.equal((await service.initialize()).unattributed.totalTokens, 40);

  const retiredId = await service.retireSubject(local.id);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.unattributed.totalTokens, 40);
  assert.equal(snapshot.subjects.find((item) => item.id === retiredId).tokens.totalTokens, 0);
  assert.equal(snapshot.subjects.find((item) => item.id === cloud.id).tokens.totalTokens, 0);
  service.dispose();
});

test("cache restores without rescanning and corrupt cache state is rebuilt", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  writeSession(codexHome, "sessions", "cached", [
    sessionMeta("thread-cached", 1_000),
    tokenCount(75, 1_100),
  ]);
  const first = new UsageService({
    codexHome,
    memento,
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  assert.equal((await first.initialize()).scan.rescannedFiles, 1);
  first.dispose();

  const restored = new UsageService({
    codexHome,
    memento,
    now: () => 6_000,
    heartbeatIntervalMs: 0,
  });
  const restoredSnapshot = await restored.initialize();
  assert.equal(restoredSnapshot.total.totalTokens, 75);
  assert.equal(restoredSnapshot.scan.rescannedFiles, 0);
  assert.equal(restoredSnapshot.scan.reusedFiles, 1);
  restored.dispose();

  memento.value = { version: 1, homeKey: "wrong-home", files: "broken" };
  const rebuilt = new UsageService({
    codexHome,
    memento,
    now: () => 7_000,
    heartbeatIntervalMs: 0,
  });
  const rebuiltSnapshot = await rebuilt.initialize();
  assert.equal(rebuiltSnapshot.total.totalTokens, 75);
  assert.equal(rebuiltSnapshot.scan.rescannedFiles, 1);
  rebuilt.dispose();
});

test("persisted cache contains counters and opaque IDs but no labels, paths, or provider names", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const privateLabel = "private-account@example.test";
  const privateProvider = "private-provider-name";
  const account = subject("account", "private-account-id", privateLabel);
  writeSession(codexHome, "sessions", "private-rollout-name", [
    sessionMeta("private-thread-id", 1_000, privateProvider),
    tokenCount(20, 1_100),
  ]);
  const service = new UsageService({
    codexHome,
    memento,
    knownSubjects: [account],
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  await service.initialize();
  await service.recordSelection(account, { at: 5_100 });

  const persisted = JSON.stringify(memento.value);
  assert.doesNotMatch(persisted, /private-account@example\.test/);
  assert.doesNotMatch(persisted, /private-provider-name/);
  assert.doesNotMatch(persisted, /private-thread-id/);
  assert.doesNotMatch(persisted, /private-rollout-name/);
  assert.doesNotMatch(persisted, new RegExp(codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(persisted, /filesCompressed/);
  assert.match(persisted, /gzip-base64/);
  service.dispose();
});

test("persisted selection timelines survive restart while downtime remains unattributed", async () => {
  const codexHome = tempCodexHome();
  const memento = new MemoryMemento();
  const account = subject("account", "persistent-account", "Persistent account");
  let now = 1_000;
  const first = new UsageService({
    codexHome,
    memento,
    knownSubjects: [account],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 100,
  });
  await first.initialize();
  now = 1_100;
  await first.recordSelection(account);
  first.dispose();

  writeSession(codexHome, "sessions", "before-close", [
    sessionMeta("before-close", 1_150),
    tokenCount(25, 1_160),
  ]);
  writeSession(codexHome, "sessions", "during-downtime", [
    sessionMeta("during-downtime", 2_000),
    tokenCount(35, 2_010),
  ]);
  now = 3_000;
  const restored = new UsageService({
    codexHome,
    memento,
    knownSubjects: [account],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 100,
  });
  const snapshot = await restored.initialize();
  assert.equal(snapshot.subjects.find((item) => item.id === account.id).tokens.totalTokens, 25);
  assert.equal(snapshot.unattributed.totalTokens, 35);
  restored.dispose();
});

test("subject remapping updates aggregated usage and change listeners", async () => {
  const codexHome = tempCodexHome();
  const oldAccount = subject("account", "old-account", "Old account");
  const newAccount = subject("account", "new-account", "New account");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [oldAccount],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 100,
  });
  let changes = 0;
  const listener = service.onDidChange(() => { changes += 1; });
  await service.initialize();
  now = 1_100;
  await service.recordSelection(oldAccount);
  writeSession(codexHome, "sessions", "remap", [
    sessionMeta("thread-remap", 1_150),
    tokenCount(45, 1_160),
  ]);
  await service.refresh();
  await service.remapSubject(oldAccount.id, newAccount);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.subjects.find((item) => item.id === newAccount.id).tokens.totalTokens, 45);
  assert.equal(snapshot.subjects.some((item) => item.id === oldAccount.id), false);
  assert.ok(changes >= 2);
  listener.dispose();
  service.dispose();
  await assert.rejects(service.refresh(), /disposed/);
});

test("subject remapping is reversible", async () => {
  const codexHome = tempCodexHome();
  const original = subject("account", "reversible-original", "Original account");
  const moved = subject("account", "reversible-moved", "Moved account");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [original],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await service.initialize();
  now = 1_100;
  await service.recordSelection(original);
  writeSession(codexHome, "sessions", "reversible-remap", [
    sessionMeta("reversible-remap-thread", 1_150),
    tokenCount(30, 1_200),
  ]);
  await service.refresh();

  now = 1_300;
  await service.remapSubject(original.id, moved);
  now = 1_400;
  await service.remapSubject(moved.id, original);
  const snapshot = service.getSnapshot();

  assert.equal(snapshot.subjects.find((item) => item.id === original.id).tokens.totalTokens, 30);
  assert.equal(snapshot.subjects.some((item) => item.id === moved.id), false);
  service.dispose();
});

test("a remapped subject ID can be reused without inheriting the moved usage", async () => {
  const codexHome = tempCodexHome();
  const original = subject("account", "reused-original", "Original account");
  const renamed = subject("account", "reused-renamed", "Renamed account");
  let now = 1_000;
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [original],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await service.initialize();
  now = 1_100;
  await service.recordSelection(original);
  const rollout = writeSession(codexHome, "sessions", "reused-remap", [
    sessionMeta("reused-remap-thread", 1_150),
    tokenCount(30, 1_200),
  ]);
  await service.refresh();

  now = 1_300;
  await service.remapSubject(original.id, renamed);
  now = 1_400;
  await service.recordSelection(original);
  fs.appendFileSync(rollout, `${JSON.stringify(tokenCount(50, 1_500))}\n`, "utf8");
  const snapshot = await service.refresh();

  assert.equal(snapshot.subjects.find((item) => item.id === renamed.id).tokens.totalTokens, 30);
  assert.equal(snapshot.subjects.find((item) => item.id === original.id).tokens.totalTokens, 20);
  service.dispose();
});

test("moving a provider subject preserves uniquely mapped legacy history", async () => {
  const codexHome = tempCodexHome();
  const local = subject("provider", "local:relay", "Relay (Local)", ["relay"]);
  const cloud = subject("provider", "cloud:relay", "Relay (Cloud)", ["relay"]);
  writeSession(codexHome, "sessions", "legacy-provider-remap", [
    sessionMeta("legacy-provider-remap-thread", 1_000, "relay"),
    tokenCount(40, 1_100),
  ]);
  const service = new UsageService({
    codexHome,
    memento: new MemoryMemento(),
    knownSubjects: [local],
    now: () => 5_000,
    heartbeatIntervalMs: 0,
  });
  const initial = await service.initialize();
  assert.equal(initial.subjects.find((item) => item.id === local.id).tokens.totalTokens, 40);

  await service.remapSubject(local.id, cloud);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.subjects.find((item) => item.id === cloud.id).tokens.totalTokens, 40);
  assert.equal(snapshot.unattributed.totalTokens, 0);
  service.dispose();
});

test("usage state is isolated by CODEX_HOME", async () => {
  const firstHome = tempCodexHome();
  const secondHome = tempCodexHome();
  const memento = new KeyedMemoryMemento();
  const firstAccount = subject("account", "first-home", "First home account");
  let now = 1_000;
  const first = new UsageService({
    codexHome: firstHome,
    memento,
    knownSubjects: [firstAccount],
    now: () => now,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  await first.initialize();
  now = 1_100;
  await first.recordSelection(firstAccount);
  writeSession(firstHome, "sessions", "first-home-rollout", [
    sessionMeta("first-home-thread", 1_150),
    tokenCount(30, 1_200),
  ]);
  await first.refresh();
  first.dispose();

  const second = new UsageService({
    codexHome: secondHome,
    memento,
    now: () => 2_000,
    heartbeatIntervalMs: 0,
  });
  await second.initialize();
  second.dispose();

  const restored = new UsageService({
    codexHome: firstHome,
    memento,
    knownSubjects: [firstAccount],
    now: () => 3_000,
    heartbeatIntervalMs: 0,
    inactiveGapMs: 1_000,
  });
  const snapshot = await restored.initialize();
  assert.equal(snapshot.subjects.find((item) => item.id === firstAccount.id).tokens.totalTokens, 30);
  assert.equal(snapshot.unattributed.totalTokens, 0);
  restored.dispose();
});
