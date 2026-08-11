const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const core = require("../dist");

function withCodexHome(t, config = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-shared-history-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  fs.writeFileSync(path.join(root, "config.toml"), config, "utf8");
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function readConfig(root) {
  return fs.readFileSync(path.join(root, "config.toml"), "utf8");
}

function runNodeWorker(script, args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Worker timed out. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Worker exited with code=${code} signal=${signal}. stdout=${stdout} stderr=${stderr}`));
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fs.existsSync(filePath);
}

test("activateProviderThroughOpenAI keeps one OpenAI history bucket", (t) => {
  const root = withCodexHome(t, [
    '# Keep this comment',
    'model_provider = "old-proxy"',
    'personality = "pragmatic"',
    '',
    '[model_providers.old-proxy]',
    'name = "Old"',
    'base_url = "https://old.example/v1"',
    'wire_api = "responses"',
    '',
  ].join("\n"));

  core.activateProviderThroughOpenAI("pro20", {
    name: "pro20",
    base_url: "https://proxy.example/v1",
    wire_api: "responses",
  });

  const config = readConfig(root);
  assert.doesNotMatch(config, /^model_provider\s*=/m);
  assert.match(config, /^openai_base_url = "https:\/\/proxy\.example\/v1"$/m);
  assert.match(config, /^personality = "pragmatic"$/m);
  assert.match(config, /^# Keep this comment$/m);
  assert.match(config, /\[model_providers\.old-proxy\]/);
  assert.match(config, /\[model_providers\.pro20\]/);
  assert.match(config, /\[model_providers\.pro20\][\s\S]*wire_api = "responses"/);
});

test("activateProviderThroughOpenAI stops provider updates before commented table headers", (t) => {
  const root = withCodexHome(t, [
    '[model_providers.pro20]',
    'name = "Old Pro"',
    'base_url = "https://old.example/v1"',
    'wire_api = "responses"',
    '',
    '[other] # keep this table comment',
    'name = "Other"',
    'base_url = "https://other.example/v1"',
    'wire_api = "chat"',
    '',
  ].join("\n"));

  core.activateProviderThroughOpenAI("pro20", {
    name: "New Pro",
    base_url: "https://proxy.example/v1",
    wire_api: "responses",
  });

  const config = readConfig(root);
  assert.match(config, /\[model_providers\.pro20\][\s\S]*name = "New Pro"/);
  assert.match(config, /\[model_providers\.pro20\][\s\S]*base_url = "https:\/\/proxy\.example\/v1"/);
  assert.match(config, /\[other\] # keep this table comment\nname = "Other"\nbase_url = "https:\/\/other\.example\/v1"\nwire_api = "chat"/);
});

test("activateProviderConfig updates an existing provider table with a trailing comment", (t) => {
  const root = withCodexHome(t, [
    '[model_providers.pro20] # keep provider comment',
    'name = "Old Pro"',
    'base_url = "https://old.example/v1"',
    'wire_api = "responses"',
    '',
  ].join("\n"));

  core.activateProviderConfig("pro20", {
    name: "New Pro",
    base_url: "https://proxy.example/v1",
    wire_api: "responses",
  });

  const config = readConfig(root);
  assert.equal(config.match(/\[model_providers\.pro20\]/g)?.length, 1);
  assert.match(config, /\[model_providers\.pro20\]\nname = "New Pro"\nbase_url = "https:\/\/proxy\.example\/v1"\nwire_api = "responses"/);
});

test("activateProviderConfig updates an existing provider table when trailing comment contains brackets", (t) => {
  const root = withCodexHome(t, [
    '[model_providers.pro20] # keep [comment]',
    'name = "Old Pro"',
    'base_url = "https://old.example/v1"',
    'wire_api = "responses"',
    '',
  ].join("\n"));

  core.activateProviderConfig("pro20", {
    name: "New Pro",
    base_url: "https://proxy.example/v1",
    wire_api: "responses",
  });

  const config = readConfig(root);
  assert.equal(config.match(/\[model_providers\.pro20\]/g)?.length, 1);
  assert.match(config, /\[model_providers\.pro20\]\nname = "New Pro"\nbase_url = "https:\/\/proxy\.example\/v1"\nwire_api = "responses"/);
});

test("activateProviderConfig scans quoted table names containing a bracket and hash", (t) => {
  const root = withCodexHome(t, [
    '[model_providers."foo] # bar"] # keep provider comment',
    'name = "Old Name"',
    'base_url = "https://old.example/v1"',
    'wire_api = "chat"',
    "",
  ].join("\n"));

  core.activateProviderConfig("foo] # bar", {
    name: "New Name",
    base_url: "https://new.example/v1",
    wire_api: "responses",
  });

  const config = readConfig(root);
  assert.equal(
    config.split(/\r?\n/).filter((line) => line.startsWith('[model_providers."foo] # bar"]')).length,
    1,
  );
  assert.match(config, /name = "New Name"/);
  assert.match(config, /base_url = "https:\/\/new\.example\/v1"/);
});

test("activateProviderConfig honors escaped quotes while scanning table endings", (t) => {
  const providerName = 'foo"] # bar';
  const renderedHeader = `[model_providers.${JSON.stringify(providerName)}]`;
  const root = withCodexHome(t, [
    `${renderedHeader} # keep provider comment`,
    'name = "Old Name"',
    'base_url = "https://old.example/v1"',
    'wire_api = "chat"',
    "",
  ].join("\n"));

  core.activateProviderConfig(providerName, {
    name: "Escaped Name",
    base_url: "https://escaped.example/v1",
    wire_api: "responses",
  });

  const config = readConfig(root);
  assert.equal(config.split(/\r?\n/).filter((line) => line.startsWith(renderedHeader)).length, 1);
  assert.match(config, /name = "Escaped Name"/);
  assert.match(config, /base_url = "https:\/\/escaped\.example\/v1"/);
});

test("getActiveModelProvider ignores assignments inside a quoted bracket table", (t) => {
  withCodexHome(t, [
    '[model_providers."foo]bar"] # provider comment',
    'model_provider = "nested-value"',
    'base_url = "https://relay.example/v1"',
  ].join("\n"));

  assert.equal(core.getActiveModelProvider(), null);
});

test("getOpenAIBaseUrlSnapshot returns the top-level string", (t) => {
  withCodexHome(t, [
    'openai_base_url = "https://original.example/v1" # user setting',
    '',
    '[x]',
    'openai_base_url = "table-value"',
    '',
  ].join("\n"));

  assert.deepEqual(core.getOpenAIBaseUrlSnapshot(), {
    present: true,
    value: "https://original.example/v1",
  });
});

test("setOpenAIBaseUrl changes only the top-level key and preserves CRLF", (t) => {
  const root = withCodexHome(
    t,
    'openai_base_url = "https://original.example/v1"\r\n\r\n[x]\r\nopenai_base_url = "table-value"\r\n'
  );

  core.setOpenAIBaseUrl("https://proxy.example/v1");

  const config = readConfig(root);
  assert.match(config, /^openai_base_url = "https:\/\/proxy\.example\/v1"\r$/m);
  assert.match(config, /\[x\]\r\nopenai_base_url = "table-value"/);
  assert.equal(config.replace(/\r\n/g, "").includes("\n"), false);
});

test("restoreOpenAIBaseUrl restores a present snapshot", (t) => {
  const root = withCodexHome(t, [
    'openai_base_url = "https://relay.example/v1"',
    '',
    '[x]',
    'openai_base_url = "table-value"',
    '',
  ].join("\n"));

  core.restoreOpenAIBaseUrl({
    present: true,
    value: "https://original.example/v1",
  });

  const config = readConfig(root);
  assert.match(config, /^openai_base_url = "https:\/\/original\.example\/v1"$/m);
  assert.match(config, /\[x\]\nopenai_base_url = "table-value"/);
});

test("restoreOpenAIBaseUrl removes a missing snapshot only at top level", (t) => {
  const root = withCodexHome(t, [
    'openai_base_url = "https://relay.example/v1"',
    'personality = "pragmatic"',
    '',
    '[x]',
    'openai_base_url = "table-value"',
    '',
  ].join("\n"));

  core.restoreOpenAIBaseUrl({ present: false, value: null });

  const config = readConfig(root);
  assert.deepEqual(core.getOpenAIBaseUrlSnapshot(), { present: false, value: null });
  assert.match(config, /^personality = "pragmatic"$/m);
  assert.match(config, /\[x\]\nopenai_base_url = "table-value"/);
});

test("activateProviderThroughOpenAI rejects invalid routing before changing config", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  const original = readConfig(root);

  assert.throws(
    () => core.activateProviderThroughOpenAI("chat-provider", {
      name: "chat-provider",
      base_url: "https://proxy.example/v1",
      wire_api: "chat",
    }),
    /wire_api = "responses"/
  );
  assert.equal(readConfig(root), original);

  assert.throws(
    () => core.activateProviderThroughOpenAI("empty-provider", {
      name: "empty-provider",
      base_url: "   ",
      wire_api: "responses",
    }),
    /base URL/
  );
  assert.equal(readConfig(root), original);
});

test("config writes preserve permissions and leave no temporary file", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  const configPath = path.join(root, "config.toml");
  fs.chmodSync(configPath, 0o640);

  core.setOpenAIBaseUrl("https://proxy.example/v1");

  assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(root), ["config.toml"]);
});

test("config writes preserve symlinked config.toml", (t) => {
  const root = withCodexHome(t, "");
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-shared-history-target-"));
  const targetPath = path.join(targetDir, "config.toml");
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(targetPath, 'personality = "pragmatic"\n', { mode: 0o640 });
  fs.unlinkSync(configPath);
  fs.symlinkSync(targetPath, configPath);
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  core.setOpenAIBaseUrl("https://proxy.example/v1");

  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
  assert.match(fs.readFileSync(targetPath, "utf8"), /^openai_base_url = "https:\/\/proxy\.example\/v1"$/m);
  assert.match(fs.readFileSync(targetPath, "utf8"), /^personality = "pragmatic"$/m);
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(root), ["config.toml"]);
});

test("new config files are private", (t) => {
  const root = withCodexHome(t);
  const configPath = path.join(root, "config.toml");
  fs.unlinkSync(configPath);

  core.setOpenAIBaseUrl("https://proxy.example/v1");

  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test("shared route restores the original base URL on account activation", (t) => {
  const root = withCodexHome(t, 'openai_base_url = "https://original.example/v1"\n');
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"official"}\n', { mode: 0o600 });

  core.activateProviderProfile(
    {
      kind: "provider",
      name: "pro20",
      auth: { OPENAI_API_KEY: "relay" },
      config: { name: "pro20", base_url: "https://proxy.example/v1", wire_api: "responses" },
    },
    { shareHistoryAcrossProviders: true, source: "account:personal", target: "provider:pro20" }
  );
  assert.deepEqual(core.getOpenAIBaseUrlSnapshot(), {
    present: true,
    value: "https://proxy.example/v1",
  });
  assert.deepEqual(core.getSharedHistoryRouteState(), {
    version: 1,
    activeProvider: "pro20",
    originalOpenAIBaseUrl: { present: true, value: "https://original.example/v1" },
  });

  core.activateAccountAuth(
    { auth_mode: "chatgpt", tokens: { access_token: "official" } },
    { source: "provider:pro20", target: "account:secondary" }
  );

  assert.deepEqual(core.getOpenAIBaseUrlSnapshot(), {
    present: true,
    value: "https://original.example/v1",
  });
  assert.equal(core.getSharedHistoryRouteState(), null);
  assert.doesNotMatch(readConfig(root), /^model_provider\s*=/m);
});

test("failed shared route mutation restores auth and config", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  const authPath = path.join(root, "auth.json");
  fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"before"}\n', { mode: 0o600 });
  const originalAuth = fs.readFileSync(authPath, "utf8");
  const originalConfig = readConfig(root);

  assert.throws(
    () =>
      core.activateProviderProfile(
        {
          kind: "provider",
          name: "broken",
          auth: { OPENAI_API_KEY: "after" },
          config: { name: "broken", base_url: "", wire_api: "responses" },
        },
        { shareHistoryAcrossProviders: true, source: "account:a", target: "provider:broken" }
      ),
    /base URL|Responses API/
  );

  assert.equal(fs.readFileSync(authPath, "utf8"), originalAuth);
  assert.equal(readConfig(root), originalConfig);
  assert.equal(core.getSharedHistoryRouteState(), null);
  assert.equal(fs.existsSync(path.join(root, "switchbridge-backups")), false);
  assert.equal(fs.existsSync(path.join(root, ".switchbridge-live-switch.lock")), false);
});

test("failed shared route state write rolls back auth and config mutations", (t) => {
  const root = withCodexHome(t, 'openai_base_url = "https://original.example/v1"\n');
  const authPath = path.join(root, "auth.json");
  const routeStatePath = path.join(root, "switchbridge-shared-history.json");
  fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"before"}\n', { mode: 0o600 });
  const originalAuth = fs.readFileSync(authPath, "utf8");
  const originalConfig = readConfig(root);
  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });
  fs.renameSync = function patchedRenameSync(oldPath, newPath) {
    if (String(newPath) === routeStatePath) {
      throw new Error("injected route state write failure");
    }
    return originalRenameSync.apply(this, arguments);
  };

  assert.throws(
    () =>
      core.activateProviderProfile(
        {
          kind: "provider",
          name: "pro20",
          auth: { OPENAI_API_KEY: "after" },
          config: { name: "pro20", base_url: "https://proxy.example/v1", wire_api: "responses" },
        },
        { shareHistoryAcrossProviders: true, source: "account:a", target: "provider:pro20" }
      ),
    /injected route state write failure/
  );

  assert.equal(fs.readFileSync(authPath, "utf8"), originalAuth);
  assert.equal(readConfig(root), originalConfig);
  assert.equal(fs.existsSync(routeStatePath), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "switchbridge-backups")), []);
  assert.equal(fs.existsSync(path.join(root, ".switchbridge-live-switch.lock")), false);
});

test("invalid shared route state snapshot shape throws", (t) => {
  const root = withCodexHome(t, 'openai_base_url = "https://original.example/v1"\n');
  fs.writeFileSync(
    path.join(root, "switchbridge-shared-history.json"),
    JSON.stringify({
      version: 1,
      activeProvider: "pro20",
      originalOpenAIBaseUrl: { present: true, value: null },
    })
  );

  assert.throws(() => core.getSharedHistoryRouteState(), /Invalid shared-history route state/);
});

test("live switch creates new auth.json as owner-only", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  const authPath = path.join(root, "auth.json");
  fs.rmSync(authPath, { force: true });

  core.activateProviderProfile(
    {
      kind: "provider",
      name: "pro20",
      auth: { OPENAI_API_KEY: "relay" },
      config: { name: "pro20", base_url: "https://proxy.example/v1", wire_api: "responses" },
    },
    { shareHistoryAcrossProviders: true, source: "account:a", target: "provider:pro20" }
  );

  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test("successful switches create completed redacted backups", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"before-secret"}\n', { mode: 0o600 });

  core.activateProviderProfile(
    {
      kind: "provider",
      name: "pro20",
      auth: { OPENAI_API_KEY: "after-secret" },
      config: { name: "pro20", base_url: "https://proxy.example/v1", wire_api: "responses" },
    },
    { shareHistoryAcrossProviders: true, source: "account:a", target: "provider:pro20" }
  );

  const backupRoot = path.join(root, "switchbridge-backups");
  const entries = fs.readdirSync(backupRoot);
  assert.equal(entries.length, 1);
  assert.equal(fs.statSync(backupRoot).mode & 0o777, 0o700);
  const backupDir = path.join(backupRoot, entries[0]);
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(backupDir, "auth.json")).mode & 0o777, 0o600);

  const manifestText = fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.source, "account:a");
  assert.equal(manifest.target, "provider:pro20");
  assert.match(manifestText, /auth\.json/);
  assert.doesNotMatch(manifestText, /before-secret|after-secret/);
});

test("withLiveSwitchLock is re-entrant across nested activation transactions", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  const lockDir = path.join(root, ".switchbridge-live-switch.lock");
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"before"}\n', { mode: 0o600 });

  const result = core.withLiveSwitchLock(
    { source: "account:outer", target: "account:final" },
    () => {
      const outerOwner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
      return core.withLiveSwitchLock(
        { source: "account:nested", target: "account:final" },
        () => {
          const nestedOwner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
          assert.equal(nestedOwner.token, outerOwner.token);
          core.activateAccountAuth(
            { auth_mode: "chatgpt", tokens: { access_token: "after" } },
            { source: "account:nested", target: "account:final" },
          );
          const ownerAfterActivation = JSON.parse(
            fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"),
          );
          assert.equal(ownerAfterActivation.token, outerOwner.token);
          return "nested-complete";
        },
      );
    },
  );

  assert.equal(result, "nested-complete");
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8")).tokens.access_token,
    "after",
  );

  assert.throws(
    () => core.withLiveSwitchLock(
      { source: "account:error", target: "account:error" },
      () => core.withLiveSwitchLock(
        { source: "account:nested-error", target: "account:error" },
        () => {
          throw new Error("nested failure");
        },
      ),
    ),
    /nested failure/,
  );
  assert.equal(fs.existsSync(lockDir), false);
});

test("high-level switches serialize provider auth sync with account activation", async (t) => {
  const root = withCodexHome(t, [
    'model_provider = "alpha"',
    "",
    "[model_providers.alpha]",
    'name = "alpha"',
    'base_url = "https://alpha.example/v1"',
    'wire_api = "responses"',
    "",
    "[model_providers.beta]",
    'name = "beta"',
    'base_url = "https://beta.example/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  const previousNamedAuthDir = process.env[core.NAMED_AUTH_DIR_ENV_VAR];
  core.setNamedAuthDir(root);
  t.after(() => core.setNamedAuthDir(previousNamedAuthDir));
  core.writeProviderProfile({
    kind: "provider",
    name: "alpha",
    auth: { OPENAI_API_KEY: "key-alpha" },
    config: { name: "alpha", base_url: "https://alpha.example/v1", wire_api: "responses" },
  });
  core.writeProviderProfile({
    kind: "provider",
    name: "beta",
    auth: { OPENAI_API_KEY: "key-beta" },
    config: { name: "beta", base_url: "https://beta.example/v1", wire_api: "responses" },
  });
  core.writeSavedAuthFile(path.join(root, "auth_work.json"), {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: "work",
      access_token: "access-work",
      refresh_token: "refresh-work",
    },
  });
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"key-alpha"}\n', { mode: 0o600 });

  const readyPath = path.join(root, "alpha-read-ready");
  const releasePath = path.join(root, "alpha-read-release");
  const betaDonePath = path.join(root, "beta-switch-done");
  const accountWorker = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const core = require(process.argv[1]);
    const root = process.argv[2];
    const readyPath = process.argv[3];
    const releasePath = process.argv[4];
    process.env.CODEX_HOME = root;
    core.setNamedAuthDir(root);
    const providerPath = path.join(root, "provider_alpha.json");
    const originalReadFileSync = fs.readFileSync;
    let paused = false;
    fs.readFileSync = function patchedReadFileSync(filePath) {
      if (!paused && path.resolve(String(filePath)) === path.resolve(providerPath)) {
        paused = true;
        fs.writeFileSync(readyPath, "ready", "utf8");
        const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(releasePath) && Date.now() < deadline) {
          Atomics.wait(signal, 0, 0, 10);
        }
        if (!fs.existsSync(releasePath)) {
          throw new Error("Timed out waiting to release the forced provider read.");
        }
      }
      return originalReadFileSync.apply(this, arguments);
    };
    const result = core.useAccount("work");
    if (!result.success) {
      throw new Error(result.message);
    }
    process.stdout.write("account-done\n");
  `;
  const providerWorker = String.raw`
    const fs = require("node:fs");
    const core = require(process.argv[1]);
    const root = process.argv[2];
    const donePath = process.argv[3];
    process.env.CODEX_HOME = root;
    core.setNamedAuthDir(root);
    const result = core.switchMode("beta");
    if (!result.success) {
      throw new Error(result.message);
    }
    fs.writeFileSync(donePath, "done", "utf8");
    process.stdout.write("provider-done\n");
  `;
  const corePath = path.resolve(__dirname, "..", "dist");
  const accountPromise = runNodeWorker(
    accountWorker,
    [corePath, root, readyPath, releasePath],
    15_000,
  );
  assert.equal(await waitForFile(readyPath), true, "account worker did not reach the forced read");
  const providerPromise = runNodeWorker(
    providerWorker,
    [corePath, root, betaDonePath],
    15_000,
  );
  const providerFinishedBeforeRelease = await waitForFile(betaDonePath, 500);
  fs.writeFileSync(releasePath, "release", "utf8");
  await Promise.all([accountPromise, providerPromise]);

  assert.equal(providerFinishedBeforeRelease, false, "provider switch bypassed the held source-sync lock");
  assert.equal(core.readProviderProfile("alpha").auth.OPENAI_API_KEY, "key-alpha");
  assert.equal(core.readProviderProfile("beta").auth.OPENAI_API_KEY, "key-beta");
  assert.equal(core.readNamedAuth("work").tokens.access_token, "access-work");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8")).OPENAI_API_KEY, "key-beta");
  assert.equal(core.getActiveModelProvider(), "beta");
  assert.equal(fs.existsSync(path.join(root, ".switchbridge-live-switch.lock")), false);
});

test("concurrent provider switches from separate processes leave one coherent transaction", async (t) => {
  const root = withCodexHome(t);
  fs.writeFileSync(
    path.join(root, "config.toml"),
    `# ${"x".repeat(2 * 1024 * 1024)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"initial"}\n', { mode: 0o600 });

  const workerScript = String.raw`
    const core = require(process.argv[1]);
    const root = process.argv[2];
    const name = process.argv[3];
    const startAt = Number(process.argv[4]);
    process.env.CODEX_HOME = root;
    setTimeout(() => {
      try {
        core.activateProviderProfile(
          {
            kind: "provider",
            name,
            auth: { OPENAI_API_KEY: "key-" + name },
            config: {
              name,
              base_url: "https://" + name + ".example/v1",
              wire_api: "responses",
            },
          },
          {
            shareHistoryAcrossProviders: true,
            source: "account:initial",
            target: "provider:" + name,
          }
        );
        process.stdout.write("done:" + name + "\n");
      } catch (error) {
        console.error(error && error.stack ? error.stack : String(error));
        process.exitCode = 1;
      }
    }, Math.max(0, startAt - Date.now()));
  `;
  const corePath = path.resolve(__dirname, "..", "dist");
  const startAt = String(Date.now() + 300);
  await Promise.all([
    runNodeWorker(workerScript, [corePath, root, "alpha", startAt]),
    runNodeWorker(workerScript, [corePath, root, "beta", startAt]),
  ]);

  const route = JSON.parse(
    fs.readFileSync(path.join(root, "switchbridge-shared-history.json"), "utf8")
  );
  assert.ok(["alpha", "beta"].includes(route.activeProvider));
  const auth = JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8"));
  assert.equal(auth.OPENAI_API_KEY, `key-${route.activeProvider}`);
  const baseUrl = readConfig(root).match(/^openai_base_url\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(baseUrl, `https://${route.activeProvider}.example/v1`);
  assert.equal(fs.existsSync(path.join(root, ".switchbridge-live-switch.lock")), false);

  const backupRoot = path.join(root, "switchbridge-backups");
  const manifests = fs.readdirSync(backupRoot).map((name) =>
    JSON.parse(fs.readFileSync(path.join(backupRoot, name, "manifest.json"), "utf8"))
  );
  assert.equal(manifests.length, 2);
  assert.deepEqual(manifests.map((manifest) => manifest.status), ["complete", "complete"]);
  const orderedManifests = [...manifests].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  assert.ok(
    Date.parse(orderedManifests[0].completedAt) <= Date.parse(orderedManifests[1].createdAt),
    "switch backup intervals must not overlap"
  );
});

test("stale live-switch lock is recovered before switching", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"before"}\n', { mode: 0o600 });
  const lockDir = path.join(root, ".switchbridge-live-switch.lock");
  fs.mkdirSync(lockDir, { mode: 0o700 });
  const staleAt = new Date(Date.now() - 10 * 60 * 1000);
  const ownerPath = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify({
    version: 1,
    token: "abandoned-token",
    pid: 2147483647,
    hostname: os.hostname(),
    acquiredAt: staleAt.toISOString(),
    source: "account:old",
    target: "provider:abandoned",
  }), { mode: 0o600 });
  fs.utimesSync(ownerPath, staleAt, staleAt);
  fs.utimesSync(lockDir, staleAt, staleAt);

  core.activateAccountAuth(
    { auth_mode: "chatgpt", tokens: { access_token: "after" } },
    { source: "account:old", target: "account:new" }
  );

  const auth = JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8"));
  assert.equal(auth.tokens.access_token, "after");
  assert.equal(fs.existsSync(lockDir), false);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith(".switchbridge-live-switch.lock.stale-")),
    []
  );
});

test("failed switch rollback removes its backup and preserves successful backups", (t) => {
  const root = withCodexHome(t, 'openai_base_url = "https://original.example/v1"\n');
  const authPath = path.join(root, "auth.json");
  const routeStatePath = path.join(root, "switchbridge-shared-history.json");
  fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"before"}\n', { mode: 0o600 });

  core.activateAccountAuth(
    { auth_mode: "chatgpt", tokens: { access_token: "official" } },
    { source: "account:before", target: "account:official" }
  );
  const originalAuth = fs.readFileSync(authPath, "utf8");
  const originalConfig = readConfig(root);
  const backupRoot = path.join(root, "switchbridge-backups");
  const successfulBackups = fs.readdirSync(backupRoot);
  assert.equal(successfulBackups.length, 1);

  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });
  fs.renameSync = function patchedRenameSync(oldPath, newPath) {
    if (String(newPath) === routeStatePath) {
      throw new Error("injected route state write failure");
    }
    return originalRenameSync.apply(this, arguments);
  };

  assert.throws(
    () => core.activateProviderProfile(
      {
        kind: "provider",
        name: "pro20",
        auth: { OPENAI_API_KEY: "relay" },
        config: { name: "pro20", base_url: "https://proxy.example/v1", wire_api: "responses" },
      },
      { shareHistoryAcrossProviders: true, source: "account:official", target: "provider:pro20" }
    ),
    /injected route state write failure/
  );

  assert.equal(fs.readFileSync(authPath, "utf8"), originalAuth);
  assert.equal(readConfig(root), originalConfig);
  assert.deepEqual(fs.readdirSync(backupRoot), successfulBackups);
  const survivingManifest = JSON.parse(
    fs.readFileSync(path.join(backupRoot, successfulBackups[0], "manifest.json"), "utf8")
  );
  assert.equal(survivingManifest.status, "complete");
  assert.equal(fs.existsSync(path.join(root, ".switchbridge-live-switch.lock")), false);
});

test("abandoned failed backups are bounded separately from completed backups", (t) => {
  const root = withCodexHome(t, 'personality = "pragmatic"\n');
  fs.writeFileSync(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"before"}\n', { mode: 0o600 });
  const backupRoot = path.join(root, "switchbridge-backups");
  fs.mkdirSync(backupRoot, { mode: 0o700 });
  for (let index = 0; index < 6; index += 1) {
    const backupDir = path.join(backupRoot, `failed-${String(index).padStart(2, "0")}`);
    fs.mkdirSync(backupDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(backupDir, "manifest.json"),
      JSON.stringify({ version: 1, status: "failed", createdAt: new Date().toISOString() }),
      { mode: 0o600 }
    );
    fs.writeFileSync(path.join(backupDir, "auth.json"), '{"OPENAI_API_KEY":"old-secret"}', { mode: 0o600 });
  }

  core.activateAccountAuth(
    { auth_mode: "chatgpt", tokens: { access_token: "official" } },
    { source: "account:before", target: "account:official" }
  );

  const statuses = fs.readdirSync(backupRoot).map((name) =>
    JSON.parse(fs.readFileSync(path.join(backupRoot, name, "manifest.json"), "utf8")).status
  );
  assert.equal(statuses.filter((status) => status === "failed").length, 3);
  assert.equal(statuses.filter((status) => status === "complete").length, 1);
});
