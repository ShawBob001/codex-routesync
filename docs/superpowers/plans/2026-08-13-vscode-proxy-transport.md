# VS Code Proxy-Safe HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make quota queries and OAuth token refresh honor the SwitchBridge proxy inside a VS Code remote extension host without changing global editor proxy settings.

**Architecture:** Add one core HTTPS text transport that resolves explicit/environment/direct proxy modes and selects VS Code's preserved original request function when the patched function would discard an explicit agent. Route quota GET and refresh POST through it, then propagate the existing VS Code proxy context into all saved-account refresh paths.

**Tech Stack:** TypeScript, Node HTTPS, `https-proxy-agent`, Node test runner, esbuild VS Code bundle

---

### Task 1: Reproduce the VS Code HTTPS override in a core regression test

**Files:**
- Create: `packages/core/test/httpTransport.test.js`
- Create: `packages/core/src/httpTransport.ts`

- [ ] **Step 1: Write the failing request-selection test**

Create a test that installs a throwing patched request and a successful preserved original request:

```js
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
  const patched = https.request;
  const preserved = https.__vscodeOriginal;
  let originalCalls = 0;
  https.request = () => { throw new Error("VS Code override discarded explicit agent"); };
  https.__vscodeOriginal = {
    ...https,
    request(options, callback) {
      originalCalls += 1;
      assert.equal(options.agent.constructor.name, "HttpsProxyAgent");
      return createMockRequest(200, "ok")(options, callback);
    },
  };
  try {
    const response = await requestHttpsText({
      url: "https://example.test/usage",
      method: "GET",
      proxyUrl: "http://127.0.0.1:3128",
    });
    assert.equal(response.body, "ok");
    assert.equal(originalCalls, 1);
  } finally {
    https.request = patched;
    if (preserved === undefined) delete https.__vscodeOriginal;
    else https.__vscodeOriginal = preserved;
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/core && node --test packages/core/test/httpTransport.test.js`

Expected: FAIL because `dist/httpTransport.js` or `requestHttpsText` does not exist.

- [ ] **Step 3: Add the minimal transport API**

Implement the exported surface in `httpTransport.ts`:

```ts
export interface HttpsTextRequestOptions {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  proxyUrl?: string | null;
}

export interface HttpsTextResponse {
  statusCode: number | null;
  body: string;
}

export function requestHttpsText(
  options: HttpsTextRequestOptions,
): Promise<HttpsTextResponse>;
```

Resolve an explicit proxy into `HttpsProxyAgent`, use `(https as PatchedHttps).__vscodeOriginal?.request` when proxy mode is explicit, and otherwise use `https.request`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/core && node --test packages/core/test/httpTransport.test.js`

Expected: PASS with one test.

### Task 2: Preserve direct and environment proxy semantics

**Files:**
- Modify: `packages/core/test/httpTransport.test.js`
- Modify: `packages/core/src/httpTransport.ts`

- [ ] **Step 1: Add failing tests for three proxy modes**

Add independent tests asserting:

```js
async function withProxyEnvironment(values, fn) {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

await requestHttpsText({ url, method: "GET", proxyUrl: null });
// Uses preserved original request with no agent, so VS Code cannot inject a proxy.

await withProxyEnvironment({ HTTPS_PROXY: "http://127.0.0.1:3128" }, () =>
  requestHttpsText({ url, method: "GET" })
);
// Uses an HttpsProxyAgent and the preserved original request.

await withProxyEnvironment({ HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: ".example.test" }, () =>
  requestHttpsText({ url, method: "GET" })
);
// Uses no explicit agent because NO_PROXY matches.
```

Also verify unsupported proxy schemes reject with `Invalid or unavailable proxy configuration` and the message never includes the raw URL.

- [ ] **Step 2: Run the tests and verify RED**

Run the focused command from Task 1.

Expected: FAIL on direct/environment/NO_PROXY behavior.

- [ ] **Step 3: Move proxy resolution into the transport**

Move the existing lower/upper-case environment lookup, `NO_PROXY` matching, default port, and safe `HttpsProxyAgent` construction from `quota.ts` into `httpTransport.ts`. Select the preserved request when an agent is present or when `proxyUrl` was explicitly provided, including `null`.

- [ ] **Step 4: Run focused and core tests**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run test -w packages/core`

Expected: all core tests PASS.

### Task 3: Route quota GET through the shared transport

**Files:**
- Modify: `packages/core/test/quota.test.js`
- Modify: `packages/core/src/quota.ts`

- [ ] **Step 1: Add a failing quota test for preserved request selection**

Call `getQuotaInfo(auth, { proxyUrl })` with a throwing patched request and a successful `https.__vscodeOriginal.request`; assert parsed quota data is returned and the preserved request receives an `HttpsProxyAgent`.

- [ ] **Step 2: Run the quota test and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/core && node --test --test-name-pattern='proxy|preserved' packages/core/test/quota.test.js`

Expected: FAIL because quota still calls the patched `https.request` directly.

- [ ] **Step 3: Replace quota's private HTTPS implementation**

Use:

```ts
const response = await requestHttpsText({
  url: USAGE_URL,
  method: "GET",
  headers,
  timeoutMs: 15_000,
  proxyUrl: options.proxyUrl,
});
if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
  return response.body;
}
throw { statusCode: response.statusCode ?? undefined, body: response.body };
```

Delete the duplicated proxy and request helpers from `quota.ts`.

- [ ] **Step 4: Verify the quota and transport tests**

Run both core test files. Expected: PASS.

### Task 4: Route OAuth refresh POST through the transport

**Files:**
- Modify: `packages/core/test/refresh.test.js`
- Modify: `packages/core/src/refresh.ts`
- Modify: `packages/core/src/accounts.ts`

- [ ] **Step 1: Add failing refresh proxy tests**

Test `refreshAccessToken(auth, { proxyUrl })` under the same patched/preserved setup and assert the POST body is written through the preserved request. Add an accounts test that asserts `refreshAccount("work", { proxyUrl })` forwards the value.

- [ ] **Step 2: Run the tests and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/core && node --test --test-name-pattern='refresh.*proxy|proxy.*refresh' packages/core/test/*.test.js`

Expected: FAIL because refresh APIs do not accept `proxyUrl`.

- [ ] **Step 3: Add refresh request options and propagate them**

Implement:

```ts
export interface RefreshRequestOptions {
  proxyUrl?: string | null;
}

export async function refreshAccessToken(
  auth: AuthFile,
  options: RefreshRequestOptions = {},
): Promise<RefreshResponse>;
```

Make `SavedAccountOperationOptions` extend or include `proxyUrl?: string | null`, pass it from `refreshAccount` to `refreshAccessToken`, and add it to `refreshAndSave` options. Replace `postForm` internals with `requestHttpsText` and retain the existing HTTP error format.

- [ ] **Step 4: Run all core tests**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run test -w packages/core`

Expected: PASS.

### Task 5: Propagate SwitchBridge proxy context through VS Code refresh commands

**Files:**
- Modify: `packages/vscode/test/addAccount.test.js`
- Modify: `packages/vscode/src/savedEntries.ts`
- Modify: `packages/vscode/src/commands.ts`

- [ ] **Step 1: Add failing command tests**

Extend the VS Code mock with `proxy` and assert both existing-account refresh and batch Refresh Token use an agent whose sanitized proxy host/port are `127.0.0.1:3128`. Do not record full URLs, headers, or credentials.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/vscode && node --test --test-name-pattern='refresh.*proxy|proxy.*refresh' packages/vscode/test/addAccount.test.js`

Expected: FAIL because `refreshSavedAccountEntry` does not accept a proxy.

- [ ] **Step 3: Thread the proxy through local and cloud refresh**

Add `proxyUrl?: string | null` to `RefreshSavedAccountOptions`, pass it to both `refreshAccount` and `refreshCloudSavedAccountEntry`, and pass it onward to `refreshAccessToken`. In commands, resolve once per operation:

```ts
const refreshProxyUrl = createQuotaQueryContext().proxyUrl;
await refreshSavedAccountEntry(account, { proxyUrl: refreshProxyUrl });
```

- [ ] **Step 4: Run focused and full VS Code tests**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run test -w packages/vscode`

Expected: all extension tests PASS.

### Task 6: Remove email addresses from performance logs

**Files:**
- Modify: `packages/core/test/logging.test.js`
- Modify: `packages/core/src/quota.ts`

- [ ] **Step 1: Add a failing privacy assertion**

Enable detailed performance logging, query an auth fixture whose ID token contains `private@example.test`, and assert no output line contains that address.

- [ ] **Step 2: Run and verify RED**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/core && node --test --test-name-pattern='email' packages/core/test/logging.test.js`

Expected: FAIL because the decode stage currently logs the email.

- [ ] **Step 3: Log only presence metadata**

Replace `{ email }` in the performance stage with `{ hasEmail: email !== "unknown" }`.

- [ ] **Step 4: Verify privacy and core tests**

Run the logging test, then the full core test suite. Expected: PASS.

### Task 7: Real extension-runtime smoke test

**Files:**
- Modify: none

- [ ] **Step 1: Build the extension bundle**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run build -w packages/vscode`

Expected: esbuild exits 0.

- [ ] **Step 2: Query both accounts with the VS Code Node runtime**

Run a sanitized diagnostic script using the VS Code server's Node binary, the built core, and `proxyUrl: "http://127.0.0.1:3128"`. Print only account name, result kind, unavailable reason, window count, and reset-credit count.

Expected: both results have `kind: "ok"` and no `request_failed` reason.

- [ ] **Step 3: Run repository verification**

Run: `PATH=/tmp/csb-node.cfY4xx/bin:$PATH npm run verify`

Expected: exit 0 with no failed tests.
