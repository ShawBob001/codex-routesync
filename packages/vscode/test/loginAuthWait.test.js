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
    delay: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
  });

  assert.equal(result, null);
  assert.equal(reads, 3);
});
