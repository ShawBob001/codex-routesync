const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDashboardClientMessage,
} = require("../dist/dashboardProtocol.js");

function action(action, fields = {}) {
  return {
    type: "dashboard.action",
    requestId: "request-1",
    action,
    ...fields,
  };
}

test("accepts the exact dashboard ready and action message shapes", () => {
  const messages = [
    { type: "dashboard.ready" },
    action("refreshDashboard"),
    action("switchMode"),
    action("setAutoSwitch", { enabled: true }),
    action("configureAutoSwitch"),
    action("addAccount"),
    action("addProvider"),
    action("reloginAccount", { targetId: "local:work" }),
    action("unlockStorage", { targetId: "cloud:locked" }),
    action("reloadWindow"),
  ];

  for (const message of messages) {
    assert.deepEqual(parseDashboardClientMessage(message), message);
  }
});

test("accepts exact dashboard locale preference messages", () => {
  for (const preference of ["auto", "en", "zh-cn"]) {
    const message = {
      type: "dashboard.locale.set",
      requestId: "request-1",
      preference,
    };
    assert.deepEqual(parseDashboardClientMessage(message), message);
  }
});

test("rejects malformed dashboard locale preference messages", () => {
  const valid = {
    type: "dashboard.locale.set",
    requestId: "request-1",
    preference: "auto",
  };
  const customPrototype = Object.assign(Object.create({ inherited: true }), valid);
  const messages = [
    { ...valid, preference: "fr" },
    { ...valid, extra: true },
    { type: valid.type, requestId: valid.requestId },
    { type: valid.type, preference: valid.preference },
    { ...valid, requestId: 1 },
    { ...valid, requestId: "x".repeat(129) },
    [],
    null,
    customPrototype,
    Object.assign(Object.create(null), valid),
  ];

  for (const message of messages) {
    assert.equal(parseDashboardClientMessage(message), null);
  }
});

test("rejects missing, extra, and unknown discriminants", () => {
  const messages = [
    {},
    { type: "dashboard.ready", extra: true },
    { type: "dashboard.action", requestId: "request-1" },
    action("runArbitraryCommand"),
    action("refreshDashboard", { command: "workbench.action.reloadWindow" }),
    { type: "other" },
  ];

  for (const message of messages) {
    assert.equal(parseDashboardClientMessage(message), null);
  }
});

test("rejects invalid request IDs and action-specific payloads", () => {
  const messages = [
    { ...action("refreshDashboard"), requestId: 1 },
    { ...action("refreshDashboard"), requestId: "" },
    { ...action("refreshDashboard"), requestId: "x".repeat(129) },
    action("setAutoSwitch"),
    action("setAutoSwitch", { enabled: "true" }),
    action("switchMode", { enabled: true }),
    action("reloginAccount"),
    action("reloginAccount", { targetId: "" }),
    action("unlockStorage", { targetId: "x".repeat(257) }),
    action("addAccount", { targetId: "local:a" }),
  ];

  for (const message of messages) {
    assert.equal(parseDashboardClientMessage(message), null);
  }
});

test("rejects arrays and objects with non-standard prototypes", () => {
  const inherited = Object.create({ type: "dashboard.ready" });
  const customPrototype = Object.create({ inherited: true });
  customPrototype.type = "dashboard.action";
  customPrototype.requestId = "request-1";
  customPrototype.action = "refreshDashboard";

  assert.equal(parseDashboardClientMessage([]), null);
  assert.equal(parseDashboardClientMessage(inherited), null);
  assert.equal(parseDashboardClientMessage(customPrototype), null);
  assert.equal(parseDashboardClientMessage(Object.create(null)), null);
});
