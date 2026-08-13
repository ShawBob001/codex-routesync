const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const { requestHttpsText } = require("../dist/httpTransport.js");

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

async function withProxyEnvironment(values, fn) {
  const previous = Object.fromEntries(
    PROXY_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of PROXY_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const name of PROXY_ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function withHttpsImplementations(patchedRequest, originalRequest, fn) {
  const patched = https.request;
  const preserved = https.__vscodeOriginal;
  https.request = patchedRequest;
  https.__vscodeOriginal = { ...https, request: originalRequest };
  try {
    return await fn();
  } finally {
    https.request = patched;
    if (preserved === undefined) delete https.__vscodeOriginal;
    else https.__vscodeOriginal = preserved;
  }
}

function createMockRequest(statusCode, body) {
  return (_options, callback) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      callback(response);
      response.emit("data", body);
      response.emit("end");
    };
    return request;
  };
}

test("explicit proxy bypasses VS Code's patched https.request", async () => {
  let originalCalls = 0;
  await withHttpsImplementations(
    () => {
      throw new Error("VS Code override discarded explicit agent");
    },
    (options, callback) => {
      originalCalls += 1;
      assert.equal(options.agent.constructor.name, "HttpsProxyAgent");
      return createMockRequest(200, "ok")(options, callback);
    },
    async () => {
      const response = await requestHttpsText({
        url: "https://example.test/usage",
        method: "GET",
        proxyUrl: "http://127.0.0.1:3128",
      });
      assert.equal(response.body, "ok");
      assert.equal(originalCalls, 1);
    },
  );
});

test("explicit null bypasses VS Code's patched request and forces direct HTTPS", async () => {
  let originalCalls = 0;
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://environment-proxy.example:8080" },
    () => withHttpsImplementations(
      () => {
        throw new Error("VS Code override injected a proxy");
      },
      (options, callback) => {
        originalCalls += 1;
        assert.equal(options.agent, undefined);
        return createMockRequest(200, "direct")(options, callback);
      },
      async () => {
        const response = await requestHttpsText({
          url: "https://example.test/usage",
          method: "GET",
          proxyUrl: null,
        });
        assert.equal(response.body, "direct");
      },
    ),
  );
  assert.equal(originalCalls, 1);
});

test("environment HTTPS_PROXY uses a proxy agent and the preserved request", async () => {
  let originalCalls = 0;
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://127.0.0.1:3128" },
    () => withHttpsImplementations(
      () => {
        throw new Error("VS Code override discarded environment proxy agent");
      },
      (options, callback) => {
        originalCalls += 1;
        assert.equal(options.agent.constructor.name, "HttpsProxyAgent");
        assert.equal(options.agent.proxy.hostname, "127.0.0.1");
        return createMockRequest(200, "proxied")(options, callback);
      },
      async () => {
        const response = await requestHttpsText({
          url: "https://example.test/usage",
          method: "GET",
        });
        assert.equal(response.body, "proxied");
      },
    ),
  );
  assert.equal(originalCalls, 1);
});

test("NO_PROXY keeps undefined proxy mode on the patched direct request", async () => {
  let patchedCalls = 0;
  let originalCalls = 0;
  await withProxyEnvironment(
    {
      HTTPS_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: ".example.test",
    },
    () => withHttpsImplementations(
      (options, callback) => {
        patchedCalls += 1;
        assert.equal(options.agent, undefined);
        return createMockRequest(200, "bypassed")(options, callback);
      },
      () => {
        originalCalls += 1;
        throw new Error("preserved request should not be selected");
      },
      async () => {
        const response = await requestHttpsText({
          url: "https://api.example.test/usage",
          method: "GET",
        });
        assert.equal(response.body, "bypassed");
      },
    ),
  );
  assert.equal(patchedCalls, 1);
  assert.equal(originalCalls, 0);
});

test("response errors reject the request instead of leaving it pending", async () => {
  const responseError = new Error("response stream failed");
  await withProxyEnvironment(
    {},
    () => withHttpsImplementations(
      (_options, callback) => {
        const response = new EventEmitter();
        response.statusCode = 200;
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.destroy = () => {};
        request.write = () => {};
        request.end = () => {
          callback(response);
          setImmediate(() => response.emit("error", responseError));
        };
        return request;
      },
      () => {
        throw new Error("preserved request should not be selected");
      },
      () => assert.rejects(
        requestHttpsText({
          url: "https://example.test/usage",
          method: "GET",
        }),
        responseError,
      ),
    ),
  );
});

test("invalid proxy configuration is rejected without exposing credentials", async () => {
  const proxyUrl = "socks5://alice:never-print-this-password@proxy.example:1080";
  await assert.rejects(
    requestHttpsText({
      url: "https://example.test/usage",
      method: "GET",
      proxyUrl,
    }),
    (error) => {
      assert.equal(error.message, "Invalid or unavailable proxy configuration");
      assert.doesNotMatch(error.message, /alice|never-print-this-password|proxy\.example/);
      return true;
    },
  );
});
