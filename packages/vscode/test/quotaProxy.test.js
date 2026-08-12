const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { buildSync } = require("esbuild");

const packageRoot = path.join(__dirname, "..");
const PROXY_ENV_NAMES = [
  "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY",
  "no_proxy", "NO_PROXY",
];

function loadQuotaProxy(settings, outputLines) {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-quota-proxy-test-"));
  const outfile = path.join(bundleRoot, "quotaProxy.cjs");
  buildSync({
    entryPoints: [path.join(packageRoot, "src", "quotaProxy.ts")],
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
          getConfiguration(section) {
            return {
              get(key, fallback) {
                return settings[`${section}.${key}`] ?? fallback;
              },
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

  try {
    return { module: require(outfile), bundleRoot };
  } finally {
    Module._load = originalLoad;
  }
}

async function withProxyEnvironment(values, fn) {
  const previous = Object.fromEntries(PROXY_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of PROXY_ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  try {
    return await fn();
  } finally {
    for (const name of PROXY_ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("quota proxy resolution prefers extension setting, then VS Code, then environment", async (t) => {
  await withProxyEnvironment({ HTTPS_PROXY: "http://env.example:8080" }, async () => {
    const cases = [
      {
        settings: {
          "codex-switchbridge.proxy": "https://alice:extension-secret@extension.example:8443",
          "http.proxy": "http://vscode.example:3128",
        },
        source: "extension-setting",
        proxyUrl: "https://alice:extension-secret@extension.example:8443",
      },
      {
        settings: { "http.proxy": "http://vscode.example:3128" },
        source: "vscode-setting",
        proxyUrl: "http://vscode.example:3128",
      },
      {
        settings: {},
        source: "environment",
        // Let core resolve environment proxies so it can still honor NO_PROXY.
        proxyUrl: undefined,
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const outputLines = [];
      const loaded = loadQuotaProxy(fixture.settings, outputLines);
      t.after(() => fs.rmSync(loaded.bundleRoot, { recursive: true, force: true }));
      const resolved = loaded.module.resolveQuotaProxy();
      assert.deepEqual(resolved, {
        proxyUrl: fixture.proxyUrl,
        source: fixture.source,
        configured: true,
        valid: true,
      });
      assert.match(outputLines.at(-1) ?? "", new RegExp(`\\"source\\":\\"${fixture.source}\\"`));
      assert.doesNotMatch(outputLines.join("\n"), /extension-secret|extension\.example|vscode\.example|env\.example/);
      assert.equal(index >= 0, true);
    }
  });
});

test("environment proxy resolution stays delegated to core for NO_PROXY support", async (t) => {
  await withProxyEnvironment({
    HTTPS_PROXY: "http://env.example:8080",
    NO_PROXY: ".chatgpt.com",
  }, async () => {
    const outputLines = [];
    const loaded = loadQuotaProxy({}, outputLines);
    t.after(() => fs.rmSync(loaded.bundleRoot, { recursive: true, force: true }));

    const resolved = loaded.module.resolveQuotaProxy();
    assert.equal(resolved.source, "environment");
    assert.equal(resolved.configured, true);
    assert.equal(resolved.valid, true);
    assert.equal(resolved.proxyUrl, undefined);
    assert.equal(loaded.module.createQuotaQueryContext().proxyUrl, undefined);
    assert.doesNotMatch(outputLines.join("\n"), /env\.example|chatgpt\.com/);
  });
});

test("quota proxy resolution returns explicit direct mode when none is configured", async (t) => {
  await withProxyEnvironment({}, async () => {
    const outputLines = [];
    const loaded = loadQuotaProxy({}, outputLines);
    t.after(() => fs.rmSync(loaded.bundleRoot, { recursive: true, force: true }));
    assert.deepEqual(loaded.module.resolveQuotaProxy(), {
      proxyUrl: null,
      source: "direct",
      configured: false,
      valid: true,
    });
    assert.doesNotMatch(outputLines.join("\n"), /proxyUrl|credentials/);
  });
});

test("quota proxy diagnostics reject unsupported schemes without logging the URL", async (t) => {
  const secret = "proxy-password-must-not-appear";
  const outputLines = [];
  const loaded = loadQuotaProxy({
    "codex-switchbridge.proxy": `socks5://alice:${secret}@proxy.example:1080`,
  }, outputLines);
  t.after(() => fs.rmSync(loaded.bundleRoot, { recursive: true, force: true }));

  const resolved = loaded.module.resolveQuotaProxy();
  assert.equal(resolved.source, "extension-setting");
  assert.equal(resolved.configured, true);
  assert.equal(resolved.valid, false);
  assert.equal(resolved.proxyUrl, `socks5://alice:${secret}@proxy.example:1080`);
  assert.doesNotMatch(outputLines.join("\n"), new RegExp(`${secret}|proxy\\.example|alice`));
});
