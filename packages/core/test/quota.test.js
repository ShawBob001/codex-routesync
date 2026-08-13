const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const { getQuotaInfo } = require("../dist/quota.js");
const {
  setDiagnosticLogger,
  setDiagnosticLogOptions,
} = require("../dist/log.js");

const PROXY_ENV_NAMES = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
];
const originalProxyEnvironment = Object.fromEntries(
  PROXY_ENV_NAMES.map((name) => [name, process.env[name]]),
);
for (const name of PROXY_ENV_NAMES) delete process.env[name];
test.after(() => {
  for (const name of PROXY_ENV_NAMES) {
    const value = originalProxyEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

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

function withMockedHttpsRequest(mockImpl, fn) {
  const original = https.request;
  https.request = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      https.request = original;
    });
}

function withPatchedAndOriginalHttpsRequest(patchedImpl, originalImpl, fn) {
  const patched = https.request;
  const preserved = https.__vscodeOriginal;
  https.request = patchedImpl;
  https.__vscodeOriginal = { ...https, request: originalImpl };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      https.request = patched;
      if (preserved === undefined) delete https.__vscodeOriginal;
      else https.__vscodeOriginal = preserved;
    });
}

function createMockRequest(statusCode, body) {
  return (_options, handler) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;

    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      handler(response);
      response.emit("data", body);
      response.emit("end");
    };

    return request;
  };
}

test("getQuotaInfo reports missing auth tokens when access token is absent", async () => {
  const info = await getQuotaInfo({ OPENAI_API_KEY: "sk-test" });

  assert.equal(info.unavailableReason?.code, "missing_auth_tokens");
  assert.equal(info.unavailableReason?.message, "Missing auth tokens");
  assert.equal(info.primaryWindow, null);
  assert.equal(info.secondaryWindow, null);
});

test("getQuotaInfo reports workspace deactivated when usage API returns deactivated workspace", async () => {
  await withMockedHttpsRequest(
    createMockRequest(402, JSON.stringify({ detail: { code: "deactivated_workspace" } })),
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
        },
      });

      assert.equal(info.unavailableReason?.code, "workspace_deactivated");
      assert.equal(info.unavailableReason?.message, "Workspace deactivated");
      assert.equal(info.unavailableReason?.statusCode, 402);
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});

test("getQuotaInfo reports quota token rejected when usage API returns authentication errors", async () => {
  const requests = [];
  await withMockedHttpsRequest(
    (options, handler) => {
      requests.push(options?.hostname ?? "");
      return createMockRequest(401, JSON.stringify({ detail: "authentication token expired" }))(options, handler);
    },
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.message, "Quota API rejected current token");
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
      assert.deepEqual(requests, ["chatgpt.com"]);
    }
  );
});

test("getQuotaInfo does not refresh tokens after quota authentication failures", async () => {
  const requests = [];
  let persistCalled = false;
  await withMockedHttpsRequest(
    (options, handler) => {
      requests.push(options?.hostname ?? "");
      return createMockRequest(401, JSON.stringify({ detail: "authentication token expired" }))(options, handler);
    },
    async () => {
      const auth = {
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      };
      const info = await getQuotaInfo(auth, async () => {
        persistCalled = true;
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.statusCode, 401);
      assert.deepEqual(requests, ["chatgpt.com"]);
      assert.equal(persistCalled, false);
      assert.equal(auth.tokens.access_token, "header.payload.signature");
    }
  );
});

test("getQuotaInfo reports quota token rejected when usage API invalidates the token", async () => {
  await withMockedHttpsRequest(
    createMockRequest(401, JSON.stringify({
      error: {
        message: "Your authentication token has been invalidated. Please try signing in again.",
        type: "invalid_request_error",
        code: "token_invalidated",
        param: null,
      },
      status: 401,
    })),
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.message, "Quota API rejected current token (token_invalidated)");
      assert.equal(info.unavailableReason?.statusCode, 401);
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});

test("getQuotaInfo reports quota token rejected for generic quota auth failures", async () => {
  await withMockedHttpsRequest(
    createMockRequest(403, JSON.stringify({ error: { message: "Forbidden" } })),
    async () => {
      const info = await getQuotaInfo({
        tokens: {
          access_token: "header.payload.signature",
          refresh_token: "refresh-token",
        },
      });

      assert.equal(info.unavailableReason?.code, "quota_token_rejected");
      assert.equal(info.unavailableReason?.message, "Quota API rejected current token");
      assert.equal(info.unavailableReason?.statusCode, 403);
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow, null);
    }
  );
});

test("getQuotaInfo parses quota windows, credit estimates, and reset credits", async () => {
  const before = Date.now();
  await withMockedHttpsRequest(
    createMockRequest(200, JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: "8.5",
          reset_after_seconds: 90,
          limit_window_seconds: 604800,
        },
        secondary_window: {
          usedPercent: 25,
          resetAt: 2_000_000_000,
          limitWindowSeconds: 18000,
        },
      },
      credits: {
        has_credits: true,
        balance: "12.50",
        approx_local_messages: "40",
        approx_cloud_messages: 15,
      },
      rate_limit_reset_credits: {
        available_count: "3",
        applicable_available_count: 2,
      },
    })),
    async () => {
      const info = await getQuotaInfo({ tokens: { access_token: "header.payload.signature" } });
      const after = Date.now();

      assert.equal(info.plan, "plus");
      assert.equal(info.primaryWindow?.usedPercent, 8.5);
      assert.equal(info.primaryWindow?.windowSeconds, 604800);
      assert.equal(info.primaryWindow?.resetAfterSeconds, 90);
      assert.ok(info.primaryWindow.resetsAt.getTime() >= before + 90_000);
      assert.ok(info.primaryWindow.resetsAt.getTime() <= after + 90_000);
      assert.equal(info.secondaryWindow?.resetsAt.toISOString(), "2033-05-18T03:33:20.000Z");
      assert.deepEqual(info.credits, {
        hasCredits: true,
        balance: "12.50",
        approxLocalMessages: 40,
        approxCloudMessages: 15,
      });
      assert.deepEqual(info.resetCredits, {
        availableCount: 3,
        applicableAvailableCount: 2,
      });
      assert.equal(info.unavailableReason, null);
    },
  );
});

test("getQuotaInfo accepts numeric window durations and rejects invalid usage percentages", async () => {
  await withMockedHttpsRequest(
    createMockRequest(200, JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 101,
          limit_window_seconds: -18_000,
        },
        secondary_window: {
          used_percent: 12,
          limit_window_seconds: "604800",
        },
      },
    })),
    async () => {
      const info = await getQuotaInfo({ tokens: { access_token: "header.payload.signature" } });
      assert.equal(info.primaryWindow, null);
      assert.equal(info.secondaryWindow?.windowSeconds, 604_800);
    },
  );
});

test("getQuotaInfo tolerates camelCase reset credits and zero counts", async () => {
  await withMockedHttpsRequest(
    createMockRequest(200, JSON.stringify({
      rateLimitResetCredits: {
        availableCount: 0,
        applicableAvailableCount: 0,
      },
    })),
    async () => {
      const info = await getQuotaInfo({ tokens: { access_token: "header.payload.signature" } });
      assert.deepEqual(info.resetCredits, {
        availableCount: 0,
        applicableAvailableCount: 0,
      });
    },
  );
});

test("getQuotaInfo uses the preserved request for an explicit proxy", async () => {
  let originalCalls = 0;
  await withPatchedAndOriginalHttpsRequest(
    () => {
      throw new Error("VS Code override discarded quota proxy agent");
    },
    (options, handler) => {
      originalCalls += 1;
      assert.equal(options.method, "GET");
      assert.equal(options.hostname, "chatgpt.com");
      assert.equal(options.agent?.constructor?.name, "HttpsProxyAgent");
      return createMockRequest(200, JSON.stringify({ plan_type: "team" }))(options, handler);
    },
    async () => {
      const info = await getQuotaInfo(
        { tokens: { access_token: "header.payload.signature" } },
        { proxyUrl: "http://127.0.0.1:3128" },
      );
      assert.equal(info.unavailableReason, null);
      assert.equal(info.plan, "team");
    },
  );
  assert.equal(originalCalls, 1);
});

test("getQuotaInfo uses HTTPS_PROXY for the usage request without exposing credentials", async () => {
  let requestOptions;
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://alice:s3cr3t@proxy.example:3128" },
    () => withMockedHttpsRequest(
      (options, handler) => {
        requestOptions = options;
        return createMockRequest(200, "{}")(options, handler);
      },
      async () => {
        const info = await getQuotaInfo({ tokens: { access_token: "header.payload.signature" } });
        assert.equal(info.unavailableReason, null);
      },
    ),
  );

  assert.equal(requestOptions.hostname, "chatgpt.com");
  assert.equal(requestOptions.agent?.constructor?.name, "HttpsProxyAgent");
  assert.equal(requestOptions.agent?.proxy?.hostname, "proxy.example");
  assert.doesNotMatch(requestOptions.agent?.proxy?.href ?? "", /alice|s3cr3t/);
});

test("getQuotaInfo honors NO_PROXY and keeps the direct HTTPS path", async () => {
  let requestOptions;
  await withProxyEnvironment(
    {
      HTTPS_PROXY: "http://proxy.example:3128",
      NO_PROXY: ".chatgpt.com:443",
    },
    () => withMockedHttpsRequest(
      (options, handler) => {
        requestOptions = options;
        return createMockRequest(200, "{}")(options, handler);
      },
      () => getQuotaInfo({ tokens: { access_token: "header.payload.signature" } }),
    ),
  );

  assert.equal(requestOptions.agent, undefined);
});

test("getQuotaInfo falls back to HTTP_PROXY for an HTTPS target", async () => {
  let requestOptions;
  await withProxyEnvironment(
    { HTTP_PROXY: "http://fallback-proxy.example:8080" },
    () => withMockedHttpsRequest(
      (options, handler) => {
        requestOptions = options;
        return createMockRequest(200, "{}")(options, handler);
      },
      () => getQuotaInfo({ tokens: { access_token: "header.payload.signature" } }),
    ),
  );

  assert.equal(requestOptions.agent?.proxy?.hostname, "fallback-proxy.example");
  assert.equal(requestOptions.agent?.proxy?.port, "8080");
});

test("getQuotaInfo sanitizes invalid proxy configuration errors", async () => {
  const secret = "never-print-this-password";
  const info = await withProxyEnvironment(
    { HTTPS_PROXY: `socks5://alice:${secret}@proxy.example:1080` },
    () => getQuotaInfo({ tokens: { access_token: "header.payload.signature" } }),
  );

  assert.equal(info.unavailableReason?.code, "request_failed");
  assert.equal(info.unavailableReason?.message, "Quota unavailable");
  assert.doesNotMatch(JSON.stringify(info), new RegExp(secret));
});

test("getQuotaInfo prefers an explicit proxy over the extension-host environment", async () => {
  let requestOptions;
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://environment-proxy.example:8080" },
    () => withMockedHttpsRequest(
      (options, handler) => {
        requestOptions = options;
        return createMockRequest(200, "{}")(options, handler);
      },
      () => getQuotaInfo(
        { tokens: { access_token: "header.payload.signature" } },
        { proxyUrl: "http://explicit-proxy.example:3128" },
      ),
    ),
  );

  assert.equal(requestOptions.agent?.proxy?.hostname, "explicit-proxy.example");
  assert.equal(requestOptions.agent?.proxy?.port, "3128");
});

test("getQuotaInfo accepts explicit direct mode even when the environment has a proxy", async () => {
  let requestOptions;
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://environment-proxy.example:8080" },
    () => withMockedHttpsRequest(
      (options, handler) => {
        requestOptions = options;
        return createMockRequest(200, "{}")(options, handler);
      },
      () => getQuotaInfo(
        { tokens: { access_token: "header.payload.signature" } },
        { proxyUrl: null },
      ),
    ),
  );

  assert.equal(requestOptions.agent, undefined);
});

test("getQuotaInfo rejects an invalid explicit proxy without exposing credentials", async () => {
  const secret = "explicit-proxy-secret";
  const info = await withProxyEnvironment(
    { HTTPS_PROXY: "http://environment-proxy.example:8080" },
    () => getQuotaInfo(
      { tokens: { access_token: "header.payload.signature" } },
      { proxyUrl: `socks5://alice:${secret}@proxy.example:1080` },
    ),
  );

  assert.equal(info.unavailableReason?.code, "request_failed");
  assert.equal(info.unavailableReason?.message, "Quota unavailable");
  assert.doesNotMatch(JSON.stringify(info), new RegExp(secret));
});

test("getQuotaInfo redacts proxy connection failures from detailed diagnostics", async () => {
  const secret = "diagnostic-proxy-secret";
  const lines = [];
  setDiagnosticLogger((_level, line) => lines.push(line));
  setDiagnosticLogOptions({ detailedPerformanceLogging: true });
  try {
    await withMockedHttpsRequest(
      () => {
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.destroy = () => {};
        request.end = () => {
          request.emit("error", new Error(
            `connect failed through http://alice:${secret}@proxy.example:3128`,
          ));
        };
        return request;
      },
      async () => {
        const info = await getQuotaInfo({
          tokens: { access_token: "header.payload.signature" },
        });
        assert.equal(info.unavailableReason?.code, "request_failed");
      },
    );
  } finally {
    setDiagnosticLogger(null);
    setDiagnosticLogOptions({ detailedPerformanceLogging: false });
  }

  assert.ok(lines.some((line) => line.includes("perf-fail")));
  assert.doesNotMatch(lines.join("\n"), new RegExp(`${secret}|proxy\\.example|alice`));
});
