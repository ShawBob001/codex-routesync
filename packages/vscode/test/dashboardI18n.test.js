const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DASHBOARD_CATALOGS,
  REQUIRED_DASHBOARD_MESSAGE_KEYS,
  dashboardLocaleTag,
  resolveDashboardLocale,
  translate,
} = require("../dist/dashboardI18n.js");

test("required dashboard message contract exactly covers both catalogs", () => {
  const required = [...REQUIRED_DASHBOARD_MESSAGE_KEYS].sort();
  const newlyReviewedKeys = [
    "navigation.skipToDashboard",
    "source.local",
    "source.cloud",
    "reload.afterSwitch",
    "reload.afterHistoryRepair",
  ];

  for (const key of newlyReviewedKeys) assert.ok(required.includes(key), `missing required key: ${key}`);
  assert.deepEqual(Object.keys(DASHBOARD_CATALOGS.en).sort(), required);
  assert.deepEqual(Object.keys(DASHBOARD_CATALOGS["zh-cn"]).sort(), required);
});

test("English and Chinese dashboard catalogs have identical keys", () => {
  assert.deepEqual(
    Object.keys(DASHBOARD_CATALOGS["zh-cn"]).sort(),
    Object.keys(DASHBOARD_CATALOGS.en).sort(),
  );
});

test("resolves automatic dashboard locales and falls back to English", () => {
  for (const language of ["zh-CN", "zh-Hans", "zh-cn", "ZH-hant"]) {
    assert.equal(resolveDashboardLocale("auto", language), "zh-cn");
  }

  for (const language of ["en-US", "fr-FR", "not-a-locale", "", undefined]) {
    assert.equal(resolveDashboardLocale("auto", language), "en");
  }
});

test("manual dashboard language preferences override the VS Code language", () => {
  assert.equal(resolveDashboardLocale("en", "zh-CN"), "en");
  assert.equal(resolveDashboardLocale("zh-cn", "en-US"), "zh-cn");
});

test("translation interpolates all placeholders as plain text", () => {
  assert.equal(
    translate("en", "usage.legendTooltip", {
      label: "<Team & Admin>",
      tokens: 1_234,
      sessions: "<script>alert(1)</script>",
    }),
    "<Team & Admin>: 1234 tokens across <script>alert(1)</script> sessions",
  );
});

test("reload recommendation templates preserve dynamic labels and counts", () => {
  assert.equal(
    translate("en", "reload.afterSwitch", { kind: "account", label: "<Work>" }),
    'Switched to account "<Work>". Reload so Codex picks up the new configuration.',
  );
  assert.equal(
    translate("zh-cn", "reload.afterHistoryRepair", { rollouts: 2, threads: 3 }),
    "历史记录修复更新了 2 条 rollout 记录和 3 条会话记录。",
  );
});

test("a missing localized entry safely falls back to English", () => {
  const chineseCatalog = DASHBOARD_CATALOGS["zh-cn"];
  const original = chineseCatalog["actions.refresh"];
  delete chineseCatalog["actions.refresh"];

  try {
    assert.equal(translate("zh-cn", "actions.refresh"), "Refresh");
  } finally {
    chineseCatalog["actions.refresh"] = original;
  }
});

test("returns stable locale tags for Intl formatting", () => {
  assert.equal(dashboardLocaleTag("en"), "en-US");
  assert.equal(dashboardLocaleTag("zh-cn"), "zh-CN");
});
