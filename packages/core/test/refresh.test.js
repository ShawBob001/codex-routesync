const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const core = require("../dist/index.js");

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

function createRefreshRequest(assertRequest) {
  return (options, handler) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    const request = new EventEmitter();
    let body = "";
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => {
      body += chunk;
    };
    request.end = () => {
      assertRequest(options, body);
      handler(response);
      response.emit("data", JSON.stringify({
        access_token: "access-rotated",
        refresh_token: "refresh-rotated",
        id_token: "id-rotated",
      }));
      response.emit("end");
    };
    return request;
  };
}

function createResponseRequest(statusCode, responseBody) {
  return (_options, handler) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      handler(response);
      response.emit("data", responseBody);
      response.emit("end");
    };
    return request;
  };
}

function captureDiagnosticLogs() {
  const lines = [];
  core.setDiagnosticLogger((level, line) => lines.push({ level, line }));
  return lines;
}

function throwingPatchedRequest() {
  throw new Error("VS Code override discarded refresh proxy agent");
}

function makeAuth(refreshToken = "refresh-current") {
  return {
    tokens: {
      account_id: "acct-work",
      access_token: "access-current",
      refresh_token: refreshToken,
      id_token: "id-current",
    },
  };
}

test("refreshAccessToken sends its POST through the preserved request for an explicit proxy", async () => {
  let originalCalls = 0;
  const result = await withHttpsImplementations(
    throwingPatchedRequest,
    createRefreshRequest((options, body) => {
      originalCalls += 1;
      assert.equal(options.method, "POST");
      assert.equal(options.hostname, "auth.openai.com");
      assert.equal(options.agent?.constructor?.name, "HttpsProxyAgent");
      assert.equal(options.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(options.headers["Content-Length"], String(Buffer.byteLength(body)));
      assert.match(body, /grant_type=refresh_token/);
      assert.match(body, /refresh_token=refresh-current/);
    }),
    () => core.refreshAccessToken(
      makeAuth(),
      { proxyUrl: "http://127.0.0.1:3128" },
    ),
  );

  assert.equal(originalCalls, 1);
  assert.equal(result.access_token, "access-rotated");
});

test("refreshAndSave passes explicit direct proxy mode to token refresh", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-refresh-save-proxy-"));
  const authPath = path.join(tempRoot, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify(makeAuth()), "utf-8");
  try {
    let originalCalls = 0;
    const updated = await withHttpsImplementations(
      throwingPatchedRequest,
      createRefreshRequest((options) => {
        originalCalls += 1;
        assert.equal(options.agent, undefined);
      }),
      () => core.refreshAndSave(authPath, { proxyUrl: null }),
    );

    assert.equal(originalCalls, 1);
    assert.equal(updated.tokens.access_token, "access-rotated");
    const saved = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    assert.equal(saved.tokens.refresh_token, "refresh-rotated");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refreshAccount passes its proxy option to token refresh", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-account-refresh-proxy-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempRoot;
  fs.writeFileSync(path.join(tempRoot, "auth_work.json"), JSON.stringify(makeAuth()), "utf-8");
  try {
    let originalCalls = 0;
    const result = await withHttpsImplementations(
      throwingPatchedRequest,
      createRefreshRequest((options, body) => {
        originalCalls += 1;
        assert.equal(options.agent?.constructor?.name, "HttpsProxyAgent");
        assert.match(body, /refresh_token=refresh-current/);
      }),
      () => core.refreshAccount(
        "work",
        { proxyUrl: "http://127.0.0.1:3128" },
      ),
    );

    assert.equal(result.success, true);
    assert.equal(originalCalls, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(tempRoot, "auth_work.json"), "utf-8"));
    assert.equal(saved.tokens.access_token, "access-rotated");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    core.setNamedAuthDir(undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refresh diagnostics redact raw proxy errors while preserving the thrown error", async () => {
  const proxyUrl = "http://alice:proxy-password@127.0.0.1:3128";
  const proxyError = new Error(`connect failed through ${proxyUrl}`);
  const lines = captureDiagnosticLogs();
  core.setDiagnosticLogOptions({ detailedPerformanceLogging: true });

  try {
    await assert.rejects(
      withHttpsImplementations(
        throwingPatchedRequest,
        () => {
          const request = new EventEmitter();
          request.setTimeout = () => request;
          request.destroy = () => {};
          request.write = () => {};
          request.end = () => setImmediate(() => request.emit("error", proxyError));
          return request;
        },
        () => core.refreshAccessToken(makeAuth(), { proxyUrl }),
      ),
      (error) => {
        assert.equal(error, proxyError);
        return true;
      },
    );

    const output = lines.map((entry) => entry.line).join("\n");
    assert.doesNotMatch(output, /alice|proxy-password|connect failed through/);
    assert.match(output, /"failureKind":"transport"/);
  } finally {
    core.setDiagnosticLogger(null);
    core.setDiagnosticLogOptions({ detailedPerformanceLogging: false });
  }
});

test("refresh diagnostics redact non-2xx response bodies while preserving HTTP errors", async () => {
  const responseBody = JSON.stringify({
    error: "refresh denied",
    credential: "response-body-secret",
  });
  const lines = captureDiagnosticLogs();
  core.setDiagnosticLogOptions({ detailedPerformanceLogging: true });

  try {
    await assert.rejects(
      withHttpsImplementations(
        throwingPatchedRequest,
        createResponseRequest(400, responseBody),
        () => core.refreshAccessToken(makeAuth(), { proxyUrl: null }),
      ),
      (error) => {
        assert.equal(error.message, `HTTP 400: ${responseBody}`);
        return true;
      },
    );

    const output = lines.map((entry) => entry.line).join("\n");
    assert.doesNotMatch(output, /response-body-secret|refresh denied/);
    assert.match(output, /"failureKind":"http_status"/);
    assert.match(output, /"statusCode":400/);
  } finally {
    core.setDiagnosticLogger(null);
    core.setDiagnosticLogOptions({ detailedPerformanceLogging: false });
  }
});
