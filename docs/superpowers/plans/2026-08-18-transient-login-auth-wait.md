# Transient Login Auth Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RouteSync tolerate the short delay between device-login confirmation and creation of the transient `auth.json`.

**Architecture:** Add a focused polling helper that reads an auth file immediately and then every 250 ms until a 30-second deadline. The existing transient-login command will call it only after **Done**, while retaining its `finally` cleanup and cancellation behavior.

**Tech Stack:** TypeScript, Node.js timers, `@codex-switchbridge/core`, Node test runner, esbuild, VS Code VSIX packaging.

---

### Task 1: Add The Bounded Auth Wait Helper

**Files:**
- Create: `packages/vscode/src/loginAuthWait.ts`
- Create: `packages/vscode/test/loginAuthWait.test.js`
- Modify: `packages/vscode/scripts/build.mjs:13-31`

- [ ] **Step 1: Add the new module to test build entry points**

Add this entry beside the other source entry points in `packages/vscode/scripts/build.mjs`:

```js
loginAuthWait: path.join(packageDir, "src", "loginAuthWait.ts"),
```

- [ ] **Step 2: Write failing tests for immediate, delayed, and timed-out reads**

Create `packages/vscode/test/loginAuthWait.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { waitForAuthFile } = require("../dist/loginAuthWait.js");

test("returns auth immediately when it is already available", async () => {
  const auth = { tokens: { access_token: "token" } };
  let reads = 0;
  const result = await waitForAuthFile("/tmp/auth.json", {
    timeoutMs: 30_000,
    pollIntervalMs: 250,
    readAuth: () => {
      reads += 1;
      return auth;
    },
    delay: async () => assert.fail("immediate auth must not wait"),
  });
  assert.equal(result, auth);
  assert.equal(reads, 1);
});

test("returns auth when it appears during polling", async () => {
  const auth = { tokens: { access_token: "token" } };
  let reads = 0;
  const result = await waitForAuthFile("/tmp/auth.json", {
    timeoutMs: 500,
    pollIntervalMs: 250,
    readAuth: () => (++reads === 2 ? auth : null),
    delay: async () => {},
  });
  assert.equal(result, auth);
  assert.equal(reads, 2);
});

test("returns null when auth remains unavailable through the deadline", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForAuthFile("/tmp/auth.json", {
    timeoutMs: 500,
    pollIntervalMs: 250,
    readAuth: () => {
      reads += 1;
      return null;
    },
    delay: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.equal(result, null);
  assert.equal(reads, 3);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm run build -w packages/vscode && node --test packages/vscode/test/loginAuthWait.test.js`

Expected: FAIL because `packages/vscode/src/loginAuthWait.ts` or `waitForAuthFile` does not exist.

- [ ] **Step 4: Implement the minimal polling helper**

Create `packages/vscode/src/loginAuthWait.ts`:

```ts
import { AuthFile, readAuthFile } from "@codex-switchbridge/core";

type WaitForAuthFileOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  readAuth?: (authPath: string) => AuthFile | null;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function waitForAuthFile(
  authPath: string,
  options: WaitForAuthFileOptions = {},
): Promise<AuthFile | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readAuth = options.readAuth ?? readAuthFile;
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (true) {
    const auth = readAuth(authPath);
    if (auth) {
      return auth;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return null;
    }
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npm run build -w packages/vscode && node --test packages/vscode/test/loginAuthWait.test.js`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Commit the helper and tests**

```bash
git add packages/vscode/src/loginAuthWait.ts packages/vscode/test/loginAuthWait.test.js packages/vscode/scripts/build.mjs
git commit -m "fix: wait for transient login auth file"
```

### Task 2: Integrate The Wait Into Transient Login

**Files:**
- Modify: `packages/vscode/src/commands.ts:1-20,478-521,1395-1480,1600-1625`
- Modify: `packages/vscode/test/addAccount.test.js`

- [ ] **Step 1: Make the existing device-auth test reproduce the delayed write**

Rename `addAccount can use device auth for a new account` to `addAccount waits for delayed device auth after Done` and change its first information response from a synchronous write to:

```js
() => {
  setTimeout(
    () => writeLastTerminalAuth(mocked, makeAuthFile("acct-device")),
    10,
  );
  return "Done";
},
```

Keep its existing assertions that `codex login --device-auth` was sent and `auth_device-user.json` was saved. This makes the test fail under the current one-shot read and pass only when the command waits.

- [ ] **Step 2: Run the focused command test and verify RED**

Run: `npm run build -w packages/vscode && node --test --test-name-pattern="waits for device auth" packages/vscode/test/addAccount.test.js`

Expected: FAIL with the current missing-auth error because `commands.ts` reads only once.

- [ ] **Step 3: Call the polling helper after Done**

In `packages/vscode/src/commands.ts`, replace the direct read with:

```ts
import { waitForAuthFile } from "./loginAuthWait";

// Inside runTransientCodexLogin after action === "Done":
const auth = await waitForAuthFile(path.join(tempCodexHome, "auth.json"));
return { completed: true, auth };
```

- [ ] **Step 4: Replace generic missing-auth messages and update timeout coverage**

Define and reuse one message for add and re-login paths:

```ts
const TRANSIENT_AUTH_TIMEOUT_MESSAGE =
  "Codex did not write auth.json within 30 seconds. Wait for the terminal to show a successful login, then try again.";
```

Use it wherever a completed transient login returns `auth: null`.

In `reloginAccount leaves state unchanged when Done has no transient auth`, temporarily replace `global.setTimeout` and `Date.now` so every requested delay advances a fake clock and resolves immediately:

```js
const originalSetTimeout = global.setTimeout;
const originalDateNow = Date.now;
let fakeNow = 0;
global.setTimeout = (callback, delay, ...args) => {
  fakeNow += delay;
  return originalSetTimeout(callback, 0, ...args);
};
Date.now = () => fakeNow;
t.after(() => {
  global.setTimeout = originalSetTimeout;
  Date.now = originalDateNow;
});
```

Change its error assertion to:

```js
assert.match(
  mocked.errorMessages.at(-1)?.message ?? "",
  /did not write auth\.json within 30 seconds/i,
);
```

- [ ] **Step 5: Run command tests and verify GREEN**

Run: `npm run build -w packages/vscode && node --test --test-name-pattern="add account|re-login" packages/vscode/test/addAccount.test.js`

Expected: matching tests pass, 0 fail.

- [ ] **Step 6: Commit the integration**

```bash
git add packages/vscode/src/commands.ts packages/vscode/test/addAccount.test.js
git commit -m "fix: tolerate delayed device auth writes"
```

### Task 3: Verify, Package, And Install

**Files:**
- Generated: `packages/vscode/dist/loginAuthWait.js`
- Generated: `packages/vscode/dist/extension.js`
- Generated: `packages/vscode/codex-routesync-0.8.2.vsix`

- [ ] **Step 1: Run the complete VS Code extension test suite**

Run: `npm test -w packages/vscode`

Expected: all extension tests pass with 0 failures.

- [ ] **Step 2: Build and package the VSIX**

Run: `npm run package:vscode`

Expected: `packages/vscode/codex-routesync-0.8.2.vsix` is created successfully.

- [ ] **Step 3: Install the rebuilt extension**

Run:

```bash
"$HOME/.vscode-server/cli/servers/Stable-e4c7e7b1d6d060162f4aa7f8225271b67ce1df75/server/bin/remote-cli/code" \
  --install-extension packages/vscode/codex-routesync-0.8.2.vsix --force
```

Expected: VS Code reports successful installation of `codex-routesync`.

- [ ] **Step 4: Verify the installed bundle contains the wait behavior**

Run:

```bash
rg -n "did not write auth.json within 30 seconds|function waitForAuthFile" \
  "$HOME/.vscode-server/extensions/shawbob001.codex-routesync-0.8.2/dist/extension.js"
```

Expected: both the timeout message and bundled helper are present.

- [ ] **Step 5: Confirm the final diff is scoped**

Run: `git status --short && git diff HEAD~2 --stat`

Expected: only the planned source, tests, build entry point, spec, and plan are changed; no auth files or user settings are included.
