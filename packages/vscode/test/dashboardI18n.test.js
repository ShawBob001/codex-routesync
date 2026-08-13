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
    "quota.windowLeft",
    "quota.resetCredits.applicableWithTotal",
    "quota.resetCredits.use",
    "quota.resetCredits.manage",
    "usage.chart.other",
    "usage.chart.empty",
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

test("dashboard catalogs expose editor header, language, and precise reset copy", () => {
  const required = new Set(REQUIRED_DASHBOARD_MESSAGE_KEYS);
  for (const key of [
    "dashboard.title",
    "dashboard.subtitle.account",
    "dashboard.subtitle.provider",
    "dashboard.subtitle.unknown",
    "language.label",
    "language.auto",
    "language.english",
    "language.chinese",
    "quota.reset.countdown",
    "quota.reset.due",
    "quota.reset.unavailable",
    "quota.reset.local",
    "quota.reset.utc",
    "quota.queriedAt",
    "quota.window.fiveHour",
    "quota.window.sevenDay",
    "quota.window.hours",
    "quota.window.additional",
    "quota.window.codeReview",
    "quota.resetCredits.available",
    "quota.resetCredits.applicable",
    "quota.resetCredits.applicableWithTotal",
    "quota.resetCredits.use",
    "quota.resetCredits.manage",
    "quota.resetCredits.noneApplicable",
    "usage.chart.aria",
    "usage.chart.empty",
    "usage.chart.other",
  ]) {
    assert.ok(required.has(key), `missing editor dashboard key: ${key}`);
  }
});

test("known quota windows have semantic English and Chinese labels", () => {
  assert.equal(translate("en", "quota.window.fiveHour"), "5 hours");
  assert.equal(translate("en", "quota.window.sevenDay"), "7 days");
  assert.equal(translate("zh-cn", "quota.window.fiveHour"), "5 小时");
  assert.equal(translate("zh-cn", "quota.window.sevenDay"), "7 天");
});

test("cached fallback copy is fixed and localized", () => {
  assert.equal(
    translate("en", "model.quotaRefreshFailedCached"),
    "Quota refresh failed. Showing the cached value.",
  );
  assert.equal(
    translate("zh-cn", "model.quotaRefreshFailedCached"),
    "配额刷新失败，正在显示缓存值。",
  );
});

test("dynamic quota windows and reset-credit counts remain explicit in both languages", () => {
  assert.equal(translate("en", "quota.window.hours", { count: 3 }), "3 hours");
  assert.equal(
    translate("en", "quota.resetCredits.applicableWithTotal", { applicable: 2, available: 4 }),
    "Usage-limit resets applicable now: 2 · total available: 4",
  );
  assert.equal(translate("zh-cn", "quota.window.hours", { count: 3 }), "3 小时");
  assert.equal(
    translate("zh-cn", "quota.resetCredits.applicableWithTotal", { applicable: 2, available: 4 }),
    "当前适用的用量限额重置次数：2 · 总可用次数：4",
  );
});

test("English and Chinese translations use identical interpolation placeholders", () => {
  const placeholders = (template) => [...template.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .sort();

  for (const key of Object.keys(DASHBOARD_CATALOGS.en)) {
    assert.deepEqual(
      placeholders(DASHBOARD_CATALOGS["zh-cn"][key]),
      placeholders(DASHBOARD_CATALOGS.en[key]),
      `placeholder mismatch for ${key}`,
    );
  }
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
