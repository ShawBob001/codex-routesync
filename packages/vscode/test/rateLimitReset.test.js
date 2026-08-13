const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  AppServerUnsupportedError,
  createAppServerEnvironment,
  getRateLimitResetAction,
  RateLimitResetRefreshError,
  resolveBundledCodexExecutable,
  runRateLimitReset,
} = require("../dist/rateLimitReset.js");

function fakeProcess(onWrite) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin = {
    destroyed: false,
    write(chunk, callback) {
      onWrite(JSON.parse(String(chunk).trim()), child);
      callback?.();
      return true;
    },
    end() { this.destroyed = true; },
  };
  return child;
}

function respond(child, id, result) {
  queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id, result })}\n`)));
}

test("uses initialize, initialized, consume, and mandatory read with one idempotency key", async () => {
  const requests = [];
  let validations = 0;
  let spawned;
  const result = await runRateLimitReset({
    executable: "/trusted/codex",
    clientVersion: "0.7.0",
    idempotencyKey: "3bbcee75-14e6-427b-973d-4d8ef149371a",
    env: { CODEX_HOME: "/tmp/codex-home" },
    validateBeforeConsume: () => { validations += 1; return true; },
    spawnProcess: (_file, args, options) => {
      assert.deepEqual(args, ["app-server", "--stdio"]);
      assert.equal(options.shell, false);
      spawned = fakeProcess((message, child) => {
        requests.push(message);
        if (message.method === "initialize") respond(child, message.id, { userAgent: "codex", codexHome: "/tmp/codex-home", platformFamily: "unix", platformOs: "linux" });
        if (message.method === "account/rateLimitResetCredit/consume") respond(child, message.id, { outcome: "reset" });
        if (message.method === "account/rateLimits/read") respond(child, message.id, { rateLimits: {}, rateLimitsByLimitId: null, rateLimitResetCredits: null });
      });
      return spawned;
    },
  });

  assert.equal(result.outcome, "reset");
  assert.equal(validations, 1);
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "initialized",
    "account/rateLimitResetCredit/consume",
    "account/rateLimits/read",
  ]);
  assert.equal(requests[0].params.clientInfo.version, "0.7.0");
  assert.deepEqual(requests[2].params, {
    idempotencyKey: "3bbcee75-14e6-427b-973d-4d8ef149371a",
  });
  assert.equal(spawned.killed, true);
});

test("accepts only documented outcomes and still reads rate limits for non-reset outcomes", async () => {
  for (const outcome of ["nothingToReset", "noCredit", "alreadyRedeemed"]) {
    const methods = [];
    const result = await runRateLimitReset({
      executable: "codex",
      clientVersion: "0.7.0",
      idempotencyKey: "f6bab823-50ab-4a0c-81fb-d1f6c28bc79e",
      validateBeforeConsume: () => true,
      spawnProcess: () => fakeProcess((message, child) => {
        methods.push(message.method);
        if (message.method === "initialize") respond(child, message.id, {});
        if (message.method === "account/rateLimitResetCredit/consume") respond(child, message.id, { outcome });
        if (message.method === "account/rateLimits/read") respond(child, message.id, { rateLimits: {} });
      }),
    });
    assert.equal(result.outcome, outcome);
    assert.equal(methods.at(-1), "account/rateLimits/read");
  }
});

test("rejects account changes before sending a consuming request", async () => {
  const methods = [];
  await assert.rejects(() => runRateLimitReset({
    executable: "codex",
    clientVersion: "0.7.0",
    idempotencyKey: "fd015996-ed07-4e10-ae68-a30596518ef2",
    validateBeforeConsume: () => false,
    spawnProcess: () => fakeProcess((message, child) => {
      methods.push(message.method);
      if (message.method === "initialize") respond(child, message.id, {});
    }),
  }), { code: "account_changed" });
  assert.deepEqual(methods, ["initialize", "initialized"]);
});

test("rejects malformed, mismatched, oversized, and timed-out protocol responses", async () => {
  const cases = [
    (message, child) => child.stdout.emit("data", Buffer.from("not-json\n")),
    (message, child) => respond(child, Number(message.id) + 99, {}),
    (message, child) => child.stdout.emit("data", Buffer.alloc(70_000, 65)),
  ];
  for (const onWrite of cases) {
    await assert.rejects(() => runRateLimitReset({
      executable: "codex",
      clientVersion: "0.7.0",
      idempotencyKey: "3d812bd6-fe9d-49e2-b3a8-553156fc7102",
      timeoutMs: 100,
      validateBeforeConsume: () => true,
      spawnProcess: () => fakeProcess(onWrite),
    }));
  }
  await assert.rejects(() => runRateLimitReset({
    executable: "codex",
    clientVersion: "0.7.0",
    idempotencyKey: "59437c47-4173-40e7-a81b-492b2d828072",
    timeoutMs: 15,
    validateBeforeConsume: () => true,
    spawnProcess: () => fakeProcess(() => {}),
  }), { code: "timeout" });
});

test("reports a known consume outcome separately when the mandatory refresh fails", async () => {
  await assert.rejects(() => runRateLimitReset({
    executable: "/trusted/codex",
    clientVersion: "0.7.0",
    idempotencyKey: "8b6ded2a-8dff-4575-b592-b46f88862c17",
    validateBeforeConsume: () => true,
    spawnProcess: () => fakeProcess((message, child) => {
      if (message.method === "initialize") respond(child, message.id, {});
      if (message.method === "account/rateLimitResetCredit/consume") {
        respond(child, message.id, { outcome: "reset" });
      }
      if (message.method === "account/rateLimits/read") respond(child, message.id, { malformed: true });
    }),
  }), (error) => {
    assert.ok(error instanceof RateLimitResetRefreshError);
    assert.equal(error.code, "refresh_unconfirmed");
    assert.equal(error.outcome, "reset");
    return true;
  });
});

test("unknown reset applicability is management-only and never authorizes consume", () => {
  assert.equal(getRateLimitResetAction(null), "none");
  assert.equal(getRateLimitResetAction({ availableCount: 0, applicableAvailableCount: null }), "none");
  assert.equal(getRateLimitResetAction({ availableCount: 3, applicableAvailableCount: 0 }), "none");
  assert.equal(getRateLimitResetAction({ availableCount: 3, applicableAvailableCount: null }), "manage");
  assert.equal(getRateLimitResetAction({ availableCount: 3, applicableAvailableCount: 2 }), "consume");
});

test("proxy environment preserves inherited mode, maps explicit mode, and strips direct mode", () => {
  const base = { PATH: "/bin", HTTPS_PROXY: "old", http_proxy: "old", NO_PROXY: "localhost" };
  assert.deepEqual(createAppServerEnvironment(base, undefined), base);
  const explicit = createAppServerEnvironment(base, "http://user:secret@proxy.example:3128");
  assert.equal(explicit.HTTPS_PROXY, "http://user:secret@proxy.example:3128");
  assert.equal(explicit.HTTP_PROXY, explicit.HTTPS_PROXY);
  assert.equal(explicit.ALL_PROXY, explicit.HTTPS_PROXY);
  assert.equal(explicit.NO_PROXY, "localhost");
  const direct = createAppServerEnvironment(base, null);
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    assert.equal(direct[key], undefined);
  }
  assert.throws(() => createAppServerEnvironment(base, "file:///secret"), AppServerUnsupportedError);
});

test("bundled Codex resolution prefers the known OpenAI extension binary layout", () => {
  const existing = new Set(["/extension/bin/linux-x86_64/codex"]);
  assert.equal(resolveBundledCodexExecutable({
    extensionPath: "/extension",
    platform: "linux",
    arch: "x64",
    exists: (candidate) => existing.has(candidate),
  }), "/extension/bin/linux-x86_64/codex");
  assert.equal(resolveBundledCodexExecutable({
    extensionPath: "/extension",
    platform: "linux",
    arch: "arm64",
    exists: () => false,
  }), null);
});
