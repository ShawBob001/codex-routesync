import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const dashboardScript = path.join(packageRoot, "dist/webview/dashboard.js");
const dashboardCss = path.join(packageRoot, "dist/webview/dashboard.css");
const screenshotRoot = path.join(packageRoot, "test-results/dashboard");

const themes = {
  dark: {
    colorScheme: "dark",
    forcedColors: "none",
    vars: {
      "--vscode-foreground": "#d4d4d4",
      "--vscode-descriptionForeground": "#a7a7a7",
      "--vscode-sideBar-background": "#181818",
      "--vscode-editor-background": "#1e1e1e",
      "--vscode-editor-foreground": "#d4d4d4",
      "--vscode-editorWidget-background": "#252526",
      "--vscode-editorWidget-border": "#454545",
      "--vscode-sideBarSectionHeader-border": "#353535",
      "--vscode-panel-border": "#3b3b3b",
      "--vscode-editorWidget-background": "#252526",
      "--vscode-focusBorder": "#007fd4",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-background": "#0e639c",
      "--vscode-button-hoverBackground": "#1177bb",
      "--vscode-button-secondaryForeground": "#ffffff",
      "--vscode-button-secondaryBackground": "#3a3d41",
      "--vscode-button-secondaryHoverBackground": "#45494e",
      "--vscode-textLink-foreground": "#4daafc",
      "--vscode-checkbox-background": "#313131",
      "--vscode-checkbox-border": "#6b6b6b",
      "--vscode-dropdown-background": "#313131",
      "--vscode-dropdown-foreground": "#f0f0f0",
      "--vscode-dropdown-border": "#6b6b6b",
      "--vscode-badge-foreground": "#ffffff",
      "--vscode-badge-background": "#4d4d4d",
      "--vscode-progressBar-background": "#0e70c0",
      "--vscode-charts-blue": "#4daafc",
      "--vscode-charts-green": "#4ec9b0",
      "--vscode-charts-purple": "#c586c0",
      "--vscode-charts-yellow": "#dcdcaa",
      "--vscode-charts-orange": "#ce9178",
      "--vscode-charts-red": "#f14c4c",
      "--vscode-notifications-foreground": "#cccccc",
      "--vscode-notifications-background": "#252526",
      "--vscode-notificationsWarningIcon-foreground": "#cca700",
      "--vscode-widget-shadow": "rgba(0,0,0,.45)",
    },
  },
  light: {
    colorScheme: "light",
    forcedColors: "none",
    vars: {
      "--vscode-foreground": "#3b3b3b",
      "--vscode-descriptionForeground": "#646464",
      "--vscode-sideBar-background": "#f7f7f7",
      "--vscode-editor-background": "#ffffff",
      "--vscode-editor-foreground": "#3b3b3b",
      "--vscode-editorWidget-background": "#f7f7f7",
      "--vscode-editorWidget-border": "#d0d0d0",
      "--vscode-sideBarSectionHeader-border": "#d6d6d6",
      "--vscode-panel-border": "#d0d0d0",
      "--vscode-editorWidget-background": "#ffffff",
      "--vscode-focusBorder": "#0066b8",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-background": "#0078d4",
      "--vscode-button-hoverBackground": "#006cbe",
      "--vscode-button-secondaryForeground": "#333333",
      "--vscode-button-secondaryBackground": "#e5e5e5",
      "--vscode-button-secondaryHoverBackground": "#d5d5d5",
      "--vscode-textLink-foreground": "#006ab1",
      "--vscode-checkbox-background": "#ffffff",
      "--vscode-checkbox-border": "#8e8e8e",
      "--vscode-dropdown-background": "#ffffff",
      "--vscode-dropdown-foreground": "#333333",
      "--vscode-dropdown-border": "#8e8e8e",
      "--vscode-badge-foreground": "#ffffff",
      "--vscode-badge-background": "#676767",
      "--vscode-progressBar-background": "#0e70c0",
      "--vscode-charts-blue": "#007acc",
      "--vscode-charts-green": "#16825d",
      "--vscode-charts-purple": "#9b46a6",
      "--vscode-charts-yellow": "#8a7100",
      "--vscode-charts-orange": "#b24c00",
      "--vscode-charts-red": "#c42b1c",
      "--vscode-notifications-foreground": "#333333",
      "--vscode-notifications-background": "#ffffff",
      "--vscode-notificationsWarningIcon-foreground": "#8a7100",
      "--vscode-widget-shadow": "rgba(0,0,0,.18)",
    },
  },
  highContrast: {
    colorScheme: "dark",
    forcedColors: "active",
    vars: {
      "--vscode-foreground": "#ffffff",
      "--vscode-descriptionForeground": "#ffffff",
      "--vscode-sideBar-background": "#000000",
      "--vscode-editor-background": "#000000",
      "--vscode-editor-foreground": "#ffffff",
      "--vscode-editorWidget-background": "#000000",
      "--vscode-editorWidget-border": "#ffffff",
      "--vscode-panel-border": "#ffffff",
      "--vscode-focusBorder": "#f38518",
      "--vscode-button-foreground": "#000000",
      "--vscode-button-background": "#ffffff",
      "--vscode-button-hoverBackground": "#f38518",
      "--vscode-button-secondaryForeground": "#ffffff",
      "--vscode-button-secondaryBackground": "#000000",
      "--vscode-button-secondaryHoverBackground": "#222222",
      "--vscode-textLink-foreground": "#6fc3df",
      "--vscode-checkbox-background": "#000000",
      "--vscode-checkbox-border": "#ffffff",
      "--vscode-dropdown-background": "#000000",
      "--vscode-dropdown-foreground": "#ffffff",
      "--vscode-dropdown-border": "#ffffff",
      "--vscode-badge-foreground": "#000000",
      "--vscode-badge-background": "#ffffff",
      "--vscode-charts-blue": "#6fc3df",
      "--vscode-charts-green": "#3ff23f",
      "--vscode-charts-purple": "#d670d6",
      "--vscode-charts-yellow": "#ffff00",
      "--vscode-charts-orange": "#ff9d00",
      "--vscode-charts-red": "#ff6060",
      "--vscode-notifications-foreground": "#ffffff",
      "--vscode-notifications-background": "#000000",
      "--vscode-notificationsWarningIcon-foreground": "#ffff00",
      "--vscode-widget-shadow": "#ffffff",
    },
  },
};

function tokens(totalTokens, overrides = {}) {
  return {
    inputTokens: Math.max(0, totalTokens - 250),
    cachedInputTokens: 180,
    outputTokens: Math.min(250, totalTokens),
    reasoningOutputTokens: 40,
    totalTokens,
    ...overrides,
  };
}

function quota(status = "available", remainingPercent = 68, overrides = {}) {
  const hasValue = remainingPercent != null;
  return {
    status,
    refreshing: false,
    freshness: hasValue ? "fresh" : null,
    fiveHour: hasValue ? {
      label: "5h",
      remainingPercent,
      resetsAt: "2026-08-12T12:00:00.000Z",
      windowSeconds: 18000,
    } : null,
    secondary: hasValue ? {
      label: "7d",
      remainingPercent: 81,
      resetsAt: "2026-08-19T10:00:00.000Z",
      windowSeconds: 604800,
    } : null,
    message: null,
    queriedAt: "2026-08-12T09:59:00.000Z",
    refreshAttemptedAt: "2026-08-12T09:59:00.000Z",
    ...overrides,
  };
}

function account(id, name, remainingPercent, overrides = {}) {
  return {
    accountId: id,
    name,
    disambiguator: null,
    plan: "plus",
    localTokens: 1234,
    quota: quota(remainingPercent === 0 ? "exhausted" : "available", remainingPercent),
    ...overrides,
  };
}

function baseModel(overrides = {}) {
  return {
    version: 1,
    generatedAt: "2026-08-12T10:00:00.000Z",
    savedEntryCounts: { accounts: 3, providers: 1 },
    route: {
      kind: "account",
      accountId: "local:primary",
      name: "Research Account With A Deliberately Long Name",
      source: "local",
      disambiguator: "Local",
      plan: "pro",
      localTokens: 48290,
      quota: quota(),
    },
    autoSwitch: {
      enabled: true,
      appliesToCurrentRoute: true,
      ruleLabel: "Switch at 0%",
      candidate: {
        accountId: "cloud:backup",
        name: "Backup Research",
        disambiguator: "Cloud",
        remainingPercent: 88,
        resetsAt: "2026-08-12T11:00:00.000Z",
        freshness: "cached",
        advisory: true,
      },
    },
    sharedHistory: { enabled: true, label: "Shared history" },
    otherAccounts: [
      account("cloud:backup", "Backup Research", 88, { disambiguator: "Cloud" }),
      account("local:lab", "Laboratory Team Account With Very Long Text", 42),
      account("cloud:empty", "Exhausted", 0),
    ],
    usage: {
      status: "ready",
      coverage: "complete",
      message: null,
      total: tokens(98000, { inputTokens: 76000, cachedInputTokens: 21000, outputTokens: 22000, reasoningOutputTokens: 4300 }),
      compactTotal: "98K",
      attributedTokens: 90000,
      attributedPercent: 91.8367346939,
      unattributedTokens: 8000,
      sessionCount: 18,
      trackingStartedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-12T10:00:00.000Z",
      segments: [
        { id: "account:a", kind: "account", label: "Research Account", sessionCount: 9, totalTokens: 69000, percent: 70.408, compactTokens: "69K" },
        { id: "provider:b", kind: "provider", label: "API Proxy", sessionCount: 8, totalTokens: 20999, percent: 21.427, compactTokens: "21K" },
        { id: "account:tiny", kind: "account", label: "Tiny segment", sessionCount: 1, totalTokens: 1, percent: 0.001, compactTokens: "1" },
      ],
    },
    reload: { recommended: false, message: null },
    ...overrides,
  };
}

const fixtures = {
  accountReady: baseModel(),
  cachedRefreshing: baseModel({
    route: {
      ...baseModel().route,
      quota: quota("available", 68, { refreshing: true, freshness: "stale", message: "Refreshing quota..." }),
    },
  }),
  failed: baseModel({
    route: {
      ...baseModel().route,
      quota: quota("unavailable", null, { message: "Quota is unavailable." }),
    },
  }),
  relogin: baseModel({
    route: {
      ...baseModel().route,
      quota: quota("relogin-required", 68, { freshness: "stale", message: "Sign in again to refresh quota." }),
    },
  }),
  locked: baseModel({
    route: {
      ...baseModel().route,
      quota: quota("storage-locked", null, { message: "Unlock storage to view quota." }),
    },
  }),
  provider: baseModel({
    route: {
      kind: "provider",
      providerId: "local:proxy",
      name: "Laboratory API Proxy",
      source: "local",
      disambiguator: null,
      wireApi: "responses",
      storageState: "ready",
      localTokens: 28750,
    },
    autoSwitch: { ...baseModel().autoSwitch, appliesToCurrentRoute: false },
  }),
  providerLocked: baseModel({
    route: {
      kind: "provider",
      providerId: "cloud:proxy",
      name: "Locked API Proxy",
      source: "cloud",
      disambiguator: null,
      wireApi: null,
      storageState: "locked",
      localTokens: null,
    },
    autoSwitch: { ...baseModel().autoSwitch, appliesToCurrentRoute: false },
  }),
  unknown: baseModel({
    savedEntryCounts: { accounts: 0, providers: 0 },
    route: { kind: "unknown", label: "No active saved route", plan: null },
    autoSwitch: { enabled: false, appliesToCurrentRoute: false, ruleLabel: "Switch at 0%", candidate: null },
    otherAccounts: [],
    usage: { ...baseModel().usage, total: tokens(0), compactTotal: "0", attributedTokens: 0, attributedPercent: 0, unattributedTokens: 0, sessionCount: 0, segments: [] },
  }),
  indexing: baseModel({
    usage: { ...baseModel().usage, status: "indexing", coverage: "partial", message: "Indexing local Codex sessions..." },
  }),
  reload: baseModel({
    reload: { recommended: true, message: "Switched to account. Reload so Codex picks up the new configuration." },
  }),
};

const localeEn = { preference: "auto", effective: "en" };
const localeZh = { preference: "zh-cn", effective: "zh-cn" };

async function sendState(page, state, revision, locale = localeEn) {
  await page.evaluate(({ state, revision, locale }) => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "dashboard.state", revision, locale, state },
    }));
  }, { state, revision, locale });
}

async function mount(page, model, {
  width,
  theme,
  reducedMotion = "reduce",
  locale = localeEn,
  now = null,
}) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({
    colorScheme: themes[theme].colorScheme,
    forcedColors: themes[theme].forcedColors,
    reducedMotion,
  });
  await page.goto("about:blank");
  if (now) await page.clock.install({ time: new Date(now) });
  await page.setContent("<!doctype html><html lang='en'><head><title>Codex SwitchBridge</title></head><body><a class='skip-link' href='#app'>Skip to dashboard</a><main id='app' tabindex='-1'></main></body></html>");
  await page.evaluate(() => {
    const state = { persisted: undefined, outbound: [] };
    window.__dashboardHarness = state;
    window.acquireVsCodeApi = () => ({
      getState: () => state.persisted,
      setState: (value) => { state.persisted = value; },
      postMessage: (value) => { state.outbound.push(value); },
    });
  });
  const declarations = Object.entries(themes[theme].vars).map(([key, value]) => `${key}:${value}`).join(";");
  await page.addStyleTag({ content: `:root{${declarations};--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px}` });
  await page.addStyleTag({ path: dashboardCss });
  await page.addScriptTag({ path: dashboardScript });
  await sendState(page, model, 1, locale);
  await expect(page.locator(".route-section")).toBeVisible();
}

async function assertLayout(page) {
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    scrollingElement: document.scrollingElement?.scrollWidth ?? 0,
    documentElement: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    headerRight: document.querySelector(".dashboard-header")?.getBoundingClientRect().right ?? 0,
  }));
  expect(Math.max(overflow.scrollingElement, overflow.documentElement, overflow.body)).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.headerRight).toBeLessThanOrEqual(overflow.viewport);
  const sections = await page.locator(".dashboard-card").evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  }));
  for (let left = 0; left < sections.length; left += 1) {
    for (let right = left + 1; right < sections.length; right += 1) {
      const horizontal = Math.min(sections[left].right, sections[right].right)
        - Math.max(sections[left].left, sections[right].left);
      const vertical = Math.min(sections[left].bottom, sections[right].bottom)
        - Math.max(sections[left].top, sections[right].top);
      expect(horizontal > 1 && vertical > 1, `dashboard cards ${left} and ${right} overlap`).toBe(false);
    }
  }
  for (const rect of sections) {
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  }
  const buttons = page.locator("button:visible, input:visible, select:visible, summary:visible");
  expect(await buttons.count()).toBeGreaterThan(0);
}

async function assertKeyboardTraversal(page) {
  const controls = page.locator("a.skip-link, button:not([disabled]), input:not([disabled]), select:not([disabled]), summary");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  await controls.first().focus();
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await page.keyboard.press("Tab");
    const control = controls.nth(index);
    expect(await control.evaluate((node) => document.activeElement === node)).toBe(true);
    expect(await control.evaluate((node) => {
      const focusTarget = node instanceof HTMLInputElement && node.nextElementSibling
        ? node.nextElementSibling
        : node;
      return getComputedStyle(focusTarget).outlineStyle;
    })).not.toBe("none");
  }
}

for (const width of [240, 360, 480]) {
  for (const theme of ["dark", "light", "highContrast"]) {
    test(`account dashboard layout ${width}px ${theme}`, async ({ page }) => {
      await mount(page, fixtures.accountReady, { width, theme });
      await assertLayout(page);
      const ring = page.locator(".quota-ring");
      await expect(ring).toHaveAttribute("role", "progressbar");
      const box = await ring.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(width < 300 ? 87 : 107);
      expect(box.height).toBeGreaterThanOrEqual(width < 300 ? 87 : 107);
      await expect(page.getByText("Switch at 0%", { exact: true })).toBeVisible();
      await expect(page.getByText("Tiny segment", { exact: true })).toBeAttached();
      if (theme === "highContrast") {
        await expect(page.locator(".switch-control input")).toBeChecked();
        expect(await page.locator(".switch-track").evaluate((node) => getComputedStyle(node).forcedColorAdjust)).toBe("none");
      }
    });
  }
}

for (const width of [720, 960, 1200]) {
  test(`editor dashboard uses a wide graphical grid at ${width}px`, async ({ page }) => {
    await mount(page, fixtures.accountReady, {
      width,
      theme: width === 960 ? "light" : "dark",
      now: "2026-08-12T10:00:00.000Z",
    });
    await assertLayout(page);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator(".dashboard-header")).toBeVisible();
    const columns = await page.locator(".dashboard-grid").evaluate((node) => (
      getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length
    ));
    expect(columns).toBeGreaterThanOrEqual(2);
    const accountColumns = await page.locator(".account-list").evaluate((node) => (
      getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length
    ));
    expect(accountColumns).toBeGreaterThanOrEqual(2);
  });
}

test("language control switches immediately when the host confirms a new locale", async ({ page }) => {
  await mount(page, fixtures.accountReady, {
    width: 960,
    theme: "dark",
    locale: localeEn,
    now: "2026-08-12T10:00:00.000Z",
  });
  const focusKeys = await page.locator("#app button, #app input, #app select, #app summary").evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute("data-focus-key"))
  ));
  expect(focusKeys.every(Boolean)).toBe(true);
  expect(new Set(focusKeys).size).toBe(focusKeys.length);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page).toHaveTitle("Codex SwitchBridge Dashboard");
  await page.getByLabel("Dashboard language").selectOption("zh-cn");
  expect(await page.evaluate(() => window.__dashboardHarness.outbound.at(-1))).toMatchObject({
    type: "dashboard.locale.set",
    preference: "zh-cn",
  });

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: "dashboard.state",
      revision: 2,
      locale: { preference: "zh-cn", effective: "fr" },
      state,
    },
  })), fixtures.accountReady);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await sendState(page, fixtures.accountReady, 2, localeZh);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page).toHaveTitle("Codex SwitchBridge 仪表板");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
  await expect(page.getByText("当前路由", { exact: true })).toBeVisible();
  await expect(page.getByText("共享历史记录", { exact: true })).toBeVisible();
  await expect(page.getByText("本地", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("5 小时", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("7 天", { exact: true }).first()).toBeVisible();

  await page.getByLabel("仪表板语言").selectOption("en");
  await sendState(page, fixtures.accountReady, 3, { preference: "en", effective: "en" });
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
});

test("host rerenders preserve a surviving focused control without matching translated labels", async ({ page }) => {
  await mount(page, fixtures.accountReady, {
    width: 960,
    theme: "dark",
    locale: localeEn,
    now: "2026-08-12T10:00:00.000Z",
  });

  const englishLanguage = page.getByLabel("Dashboard language");
  await englishLanguage.focus();
  await englishLanguage.selectOption("zh-cn");
  await sendState(page, fixtures.accountReady, 2, localeZh);
  const chineseLanguage = page.getByLabel("仪表板语言");
  await expect(chineseLanguage).toBeFocused();

  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  await refresh.focus();
  await sendState(page, fixtures.cachedRefreshing, 3, localeZh);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeFocused();

  const details = page.getByText("Token 明细", { exact: true });
  await details.click();
  await expect(page.locator(".token-details")).toHaveAttribute("open", "");
  await sendState(page, fixtures.accountReady, 4, localeZh);
  await expect(page.locator(".token-details")).toHaveAttribute("open", "");
  await expect(page.getByText("Token 明细", { exact: true })).toBeFocused();
});

test("focus is not restored to a different or duplicate control when its keyed action disappears", async ({ page }) => {
  await mount(page, fixtures.relogin, { width: 960, theme: "light" });
  const routeSignIn = page.locator(".route-section").getByRole("button", { name: "Sign in", exact: true });
  await expect(routeSignIn).toHaveAttribute("data-focus-key", "route-account:local:primary:relogin");
  await routeSignIn.focus();
  await sendState(page, fixtures.accountReady, 2, localeEn);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-focus-key") ?? null)).toBeNull();
});

test("all quota windows show precise reset clocks and update without rerendering", async ({ page }) => {
  await mount(page, fixtures.accountReady, {
    width: 1200,
    theme: "dark",
    now: "2026-08-12T10:00:00.000Z",
  });
  const clocks = page.locator(".reset-clock");
  await expect(clocks).toHaveCount(9);
  await expect(page.getByText("Resets in 02h 00m 00s", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Upstream UTC: 2026-08-12T12:00:00.000Z", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".reset-local").first()).toContainText("12:00:00");
  await expect(page.getByText("Live quota", { exact: true }).first()).toBeVisible();
  const routeName = page.locator(".route-name");
  await routeName.evaluate((node) => { node.dataset.clockIdentity = "preserved"; });
  await page.clock.runFor(1_001);
  await expect(page.getByText("Resets in 01h 59m 59s", { exact: true }).first()).toBeVisible();
  await expect(routeName).toHaveAttribute("data-clock-identity", "preserved");
});

test("reset clocks expose due, missing, and invalid timestamps truthfully", async ({ page }) => {
  const resetStates = baseModel();
  resetStates.route = {
    ...resetStates.route,
    quota: quota("available", 68, {
      fiveHour: { label: "5h", remainingPercent: 68, resetsAt: "2026-08-12T09:59:59.000Z", windowSeconds: 18000 },
      secondary: { label: "7d", remainingPercent: 81, resetsAt: null, windowSeconds: 604800 },
    }),
  };
  resetStates.otherAccounts = [
    account("local:invalid", "Invalid reset", 42, {
      quota: quota("available", 42, {
        fiveHour: { label: "5h", remainingPercent: 42, resetsAt: "2026-02-30T00:00:00.000Z", windowSeconds: 18000 },
        secondary: null,
      }),
    }),
  ];
  await mount(page, resetStates, {
    width: 960,
    theme: "light",
    now: "2026-08-12T10:00:00.000Z",
  });
  await expect(page.getByText("Reset due", { exact: true })).toBeVisible();
  expect(await page.getByText("Reset time unavailable", { exact: true }).count()).toBeGreaterThanOrEqual(2);
});

test("account routes and other accounts always expose one generic reset clock when the primary window is absent", async ({ page }) => {
  const noWindows = baseModel();
  noWindows.route = {
    ...noWindows.route,
    quota: quota("storage-locked", null, {
      fiveHour: null,
      secondary: null,
      freshness: null,
      message: "Unlock storage to view quota.",
    }),
  };
  noWindows.otherAccounts = [
    account("local:no-window", "No reset metadata", null, {
      quota: quota("unavailable", null, {
        fiveHour: null,
        secondary: null,
        freshness: null,
        message: "Quota is unavailable.",
      }),
    }),
  ];
  await mount(page, noWindows, { width: 960, theme: "dark", now: "2026-08-12T10:00:00.000Z" });
  await expect(page.locator(".route-section .reset-clock")).toHaveCount(1);
  await expect(page.locator(".account-row .reset-clock")).toHaveCount(1);
  await expect(page.getByText("Reset time unavailable", { exact: true })).toHaveCount(2);

  await sendState(page, fixtures.provider, 2, localeEn);
  await expect(page.locator(".route-section .reset-clock")).toHaveCount(0);
});

test("cached refresh preserves the last quota while exposing freshness", async ({ page }) => {
  await mount(page, fixtures.cachedRefreshing, { width: 360, theme: "dark" });
  await expect(page.locator(".quota-ring")).toHaveAttribute("aria-valuenow", "68");
  await expect(page.getByText("Refreshing", { exact: true })).toBeVisible();
  await expect(page.getByText("Stale quota", { exact: true })).toBeVisible();
});

test("provider, unknown quota, current actions, and reload semantics", async ({ page }) => {
  await mount(page, fixtures.provider, { width: 360, theme: "dark" });
  await expect(page.locator(".provider-signal")).toBeVisible();
  await expect(page.locator(".quota-ring")).toHaveCount(0);
  await expect(page.getByText("account quota unavailable", { exact: false })).toBeVisible();

  await sendState(page, fixtures.providerLocked, 2, localeEn);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  expect(await page.evaluate(() => window.__dashboardHarness.outbound.at(-1))).toMatchObject({
    type: "dashboard.action",
    action: "unlockStorage",
    targetId: "cloud:proxy",
  });

  await sendState(page, fixtures.failed, 3, localeEn);
  const failedRow = page.locator(".account-row").filter({ hasText: "Exhausted" });
  await expect(failedRow.locator('[role="progressbar"]')).toHaveCount(1);
  await expect(page.locator(".quota-ring")).toHaveAttribute("role", "status");

  await sendState(page, fixtures.relogin, 4, localeEn);
  await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();

  await sendState(page, fixtures.locked, 5, localeEn);
  await expect(page.getByRole("button", { name: "Unlock" }).first()).toBeVisible();

  await sendState(page, fixtures.reload, 6, localeEn);
  await expect(page.locator(".reload-strip")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await assertLayout(page);
});

test("unknown, indexing, keyboard focus, stale revisions, and reduced motion", async ({ page }) => {
  await mount(page, fixtures.unknown, { width: 240, theme: "light" });
  await expect(page.locator(".unknown-signal")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add provider" })).toBeVisible();
  await assertLayout(page);

  await sendState(page, fixtures.indexing, 2, localeEn);
  await expect(page.getByText("Indexing local Codex sessions...", { exact: true })).toBeVisible();
  await assertKeyboardTraversal(page);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".switch-track")).transitionDuration)).toBe("0s");

  await sendState(page, fixtures.provider, 1, localeEn);
  await expect(page.locator(".provider-signal")).toHaveCount(0);
});

test("captures representative visual states", async ({ page }) => {
  fs.mkdirSync(screenshotRoot, { recursive: true });
  const captures = [
    ["account-240-dark.png", fixtures.accountReady, 240, "dark", localeEn],
    ["account-360-light.png", fixtures.accountReady, 360, "light", localeEn],
    ["provider-360-dark.png", fixtures.provider, 360, "dark", localeEn],
    ["error-360-high-contrast.png", fixtures.failed, 360, "highContrast", localeEn],
    ["reload-480-dark.png", fixtures.reload, 480, "dark", localeEn],
    ["account-1200-dark-en.png", fixtures.accountReady, 1200, "dark", localeEn],
    ["account-960-light-zh.png", fixtures.accountReady, 960, "light", localeZh],
  ];
  for (const [name, fixture, width, theme, captureLocale] of captures) {
    await mount(page, fixture, { width, theme, locale: captureLocale, now: "2026-08-12T10:00:00.000Z" });
    await assertLayout(page);
    await page.screenshot({ path: path.join(screenshotRoot, name), fullPage: true });
  }
});

test.beforeAll(async ({ browser }) => {
  expect(fs.existsSync(dashboardScript)).toBe(true);
  expect(fs.existsSync(dashboardCss)).toBe(true);
  const page = await browser.newPage();
  await page.setContent("<span id='font-check'>SwitchBridge</span>");
  const textWidth = await page.locator("#font-check").evaluate((node) => node.getBoundingClientRect().width);
  await page.close();
  expect(
    textWidth,
    "Chromium cannot measure text. Install browser dependencies and ensure Fontconfig can find fonts; on minimal Linux hosts set FONTCONFIG_FILE and FONTCONFIG_PATH before running test:visual.",
  ).toBeGreaterThan(0);
});
