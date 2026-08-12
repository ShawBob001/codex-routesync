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

async function mount(page, model, { width, theme, reducedMotion = "reduce" }) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({
    colorScheme: themes[theme].colorScheme,
    forcedColors: themes[theme].forcedColors,
    reducedMotion,
  });
  await page.goto("about:blank");
  await page.setContent("<!doctype html><html><head></head><body><main id='app' tabindex='-1'></main></body></html>");
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
  await page.evaluate((state) => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "dashboard.state", revision: 1, state },
    }));
  }, model);
  await expect(page.locator(".route-section")).toBeVisible();
}

async function assertLayout(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sections = await page.locator(".path-section").evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  }));
  for (let index = 1; index < sections.length; index += 1) {
    expect(sections[index].top).toBeGreaterThanOrEqual(sections[index - 1].bottom - 1);
  }
  for (const rect of sections) {
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  }
  const buttons = page.locator("button:visible, input:visible, summary:visible");
  expect(await buttons.count()).toBeGreaterThan(0);
}

async function assertKeyboardTraversal(page) {
  const controls = page.locator("button:not([disabled]), input:not([disabled]), summary");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
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

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard.state", revision: 2, state } })), fixtures.failed);
  const failedRow = page.locator(".account-row").filter({ hasText: "Exhausted" });
  await expect(failedRow.locator('[role="progressbar"]')).toHaveCount(1);
  await expect(page.locator(".quota-ring")).toHaveAttribute("role", "status");

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard.state", revision: 3, state } })), fixtures.relogin);
  await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard.state", revision: 4, state } })), fixtures.locked);
  await expect(page.getByRole("button", { name: "Unlock" }).first()).toBeVisible();

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard.state", revision: 5, state } })), fixtures.reload);
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

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard.state", revision: 2, state } })), fixtures.indexing);
  await expect(page.getByText("Indexing local Codex sessions...", { exact: true })).toBeVisible();
  await assertKeyboardTraversal(page);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".switch-track")).transitionDuration)).toBe("0s");

  await page.evaluate((state) => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard.state", revision: 1, state } })), fixtures.provider);
  await expect(page.locator(".provider-signal")).toHaveCount(0);
});

test("captures representative visual states", async ({ page }) => {
  fs.mkdirSync(screenshotRoot, { recursive: true });
  const captures = [
    ["account-240-dark.png", fixtures.accountReady, 240, "dark"],
    ["account-360-light.png", fixtures.accountReady, 360, "light"],
    ["provider-360-dark.png", fixtures.provider, 360, "dark"],
    ["error-360-high-contrast.png", fixtures.failed, 360, "highContrast"],
    ["reload-480-dark.png", fixtures.reload, 480, "dark"],
  ];
  for (const [name, fixture, width, theme] of captures) {
    await mount(page, fixture, { width, theme });
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
