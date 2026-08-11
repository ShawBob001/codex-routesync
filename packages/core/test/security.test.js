const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../dist");

const originalCodexHome = process.env.CODEX_HOME;
const originalNamedAuthDir = process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switchbridge-security-"));
  const codexHome = path.join(root, "home");
  fs.mkdirSync(codexHome);
  process.env.CODEX_HOME = codexHome;
  core.setNamedAuthDir(codexHome);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, codexHome };
}

function makeAccountAuth(accountId = "acct-work") {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: `access-${accountId}`,
      refresh_token: `refresh-${accountId}`,
    },
  };
}

function makeProvider(name) {
  return {
    kind: "provider",
    name,
    auth: { OPENAI_API_KEY: `key-${name}` },
    config: {
      name,
      base_url: "https://relay.example/v1",
      wire_api: "responses",
    },
  };
}

test.afterEach(() => {
  core.setSavedAuthPassphrase(null);
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  if (originalNamedAuthDir === undefined) {
    delete process.env.CODEX_SWITCHBRIDGE_AUTH_DIR;
  } else {
    process.env.CODEX_SWITCHBRIDGE_AUTH_DIR = originalNamedAuthDir;
  }
});

test("saved entry names use one cross-platform validation policy", () => {
  for (const name of ["work", "Team Account", "corp.proxy", "api_provider-1", "\u4e2d\u6587"]) {
    assert.deepEqual(core.validateSavedEntryName(name), { valid: true });
  }

  const invalidNames = [
    ".",
    "..",
    "../escape",
    "..\\escape",
    "nested/account",
    "nested\\account",
    "control\u0000name",
    "control\u001fname",
    "bad:name",
    "bad*name",
    "trailing.",
    "trailing ",
  ];
  for (const name of invalidNames) {
    assert.equal(core.validateSavedEntryName(name).valid, false, name);
    assert.throws(() => core.getNamedAuthPath(name), /saved entry/i, name);
    assert.throws(() => core.getNamedProviderPath(name), /saved entry/i, name);
  }
});

test("saved entry lists ignore unsafe names, directories, and symlinks", (t) => {
  const { root, codexHome } = createWorkspace(t);
  fs.writeFileSync(path.join(codexHome, "auth_work.json"), "{}", "utf8");
  fs.writeFileSync(path.join(codexHome, "provider_corp.proxy.json"), "{}", "utf8");
  fs.writeFileSync(path.join(codexHome, "auth_bad\\name.json"), "{}", "utf8");
  fs.writeFileSync(path.join(codexHome, "provider_bad:name.json"), "{}", "utf8");
  fs.mkdirSync(path.join(codexHome, "auth_directory.json"));

  if (process.platform !== "win32") {
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "{}", "utf8");
    fs.symlinkSync(outside, path.join(codexHome, "auth_link.json"));
    fs.symlinkSync(outside, path.join(codexHome, "provider_link.json"));
    assert.throws(() => core.getNamedAuthPath("link"), /outside/i);
    assert.equal(core.useAccount("link").success, false);
    assert.equal(core.removeAccount("link").success, false);
    assert.equal(core.addAccountAuth("link", makeAccountAuth()).success, false);
    assert.equal(core.readProviderProfileResult("link").status, "invalid");
    assert.equal(core.deleteProviderProfile("link").success, false);
    assert.equal(core.switchMode("link").success, false);
  }

  assert.deepEqual(core.listNamedAuthFiles(), ["work"]);
  assert.deepEqual(core.listNamedProviderFiles(), ["corp.proxy"]);
});

test("account CRUD and import reject traversal without touching other paths", (t) => {
  const { root, codexHome } = createWorkspace(t);
  const auth = makeAccountAuth();
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, "unchanged", "utf8");

  const addResult = core.addAccountAuth("../../outside", auth);
  assert.equal(addResult.success, false);
  assert.match(addResult.message, /invalid account name/i);

  const importResult = core.importAccounts({
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: [
      { name: "../outside", auth },
      { name: "..\\outside", auth },
    ],
  });
  assert.deepEqual(importResult.imported, []);
  assert.equal(importResult.errors.length, 2);

  assert.equal(core.useAccount("../outside").success, false);
  assert.equal(core.removeAccount("..\\outside").success, false);

  const saved = core.addAccountAuth("work", auth);
  assert.equal(saved.success, true);
  const renameResult = core.renameAccount("work", "../outside");
  assert.equal(renameResult.success, false);
  assert.match(renameResult.message, /invalid account name/i);
  assert.equal(fs.existsSync(path.join(codexHome, "auth_work.json")), true);
  assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
});

test("provider CRUD rejects traversal names without throwing from result APIs", (t) => {
  const { root, codexHome } = createWorkspace(t);
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, "unchanged", "utf8");

  const readResult = core.readProviderProfileResult("../../outside");
  assert.equal(readResult.status, "invalid");
  assert.match(readResult.message, /invalid provider name/i);

  const deleteResult = core.deleteProviderProfile("..\\outside");
  assert.equal(deleteResult.success, false);
  assert.match(deleteResult.message, /invalid provider name/i);

  const switchResult = core.switchMode("../outside");
  assert.equal(switchResult.success, false);
  assert.match(switchResult.message, /invalid provider name/i);

  assert.throws(() => core.getDefaultProviderProfile("../outside"), /invalid provider name/i);
  assert.throws(() => core.writeProviderProfile(makeProvider("..\\outside")), /invalid provider name/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
  assert.deepEqual(fs.readdirSync(codexHome), []);
});

test("provider writes reject the reserved account name", (t) => {
  const { codexHome } = createWorkspace(t);

  assert.throws(() => core.getDefaultProviderProfile("account"), /reserved|provider name/i);
  assert.throws(() => core.writeProviderProfile(makeProvider("account")), /reserved|provider name/i);
  assert.equal(fs.existsSync(path.join(codexHome, "provider_account.json")), false);
});

test("provider reads and lists ignore a manually-created reserved account profile", (t) => {
  const { codexHome } = createWorkspace(t);
  fs.writeFileSync(
    path.join(codexHome, "provider_account.json"),
    JSON.stringify(makeProvider("account")),
    "utf8",
  );

  const result = core.readProviderProfileResult("account");
  assert.equal(result.status, "invalid");
  assert.match(result.message, /reserved|provider name/i);
  assert.deepEqual(core.listProviderModes(), []);
});

test("switchMode keeps account as a control mode instead of activating a reserved profile", (t) => {
  const { codexHome } = createWorkspace(t);
  fs.writeFileSync(
    path.join(codexHome, "provider_account.json"),
    JSON.stringify(makeProvider("account")),
    "utf8",
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAccountAuth("official")),
    "utf8",
  );

  const result = core.switchMode("account");

  assert.equal(result.success, true);
  assert.equal(core.getActiveModelProvider(), null);
  assert.equal(core.readCurrentAuth().tokens.account_id, "official");
  assert.notEqual(core.readCurrentAuth().OPENAI_API_KEY, "key-account");
});

test("saved JSON writes are atomic, private, and leave no temporary files", (t) => {
  const { codexHome } = createWorkspace(t);
  const target = path.join(codexHome, "auth_work.json");

  core.writeSavedJsonFile(target, "saved_auth", makeAccountAuth());
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), makeAccountAuth());
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }

  fs.chmodSync(target, 0o644);
  core.writeSavedJsonFile(target, "saved_auth", makeAccountAuth("acct-updated"));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(codexHome).some((name) => name.endsWith(".tmp")), false);
});

test("saved JSON write failure preserves the target and removes its temporary file", (t) => {
  const { codexHome } = createWorkspace(t);
  const target = path.join(codexHome, "auth_work.json");
  fs.writeFileSync(target, "original", { mode: 0o600 });
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === target) {
      throw new Error("simulated rename failure");
    }
    return originalRename(source, destination);
  };

  try {
    assert.throws(
      () => core.writeSavedJsonFile(target, "saved_auth", makeAccountAuth()),
      /simulated rename failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(codexHome), ["auth_work.json"]);
});

test("getActiveModelProvider treats table headers with trailing comments as table scope", (t) => {
  const { codexHome } = createWorkspace(t);
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "[model_providers.relay] # provider settings",
      'model_provider = "nested-value"',
      'base_url = "https://relay.example/v1"',
    ].join("\n"),
    "utf8",
  );

  assert.equal(core.getActiveModelProvider(), null);
});
