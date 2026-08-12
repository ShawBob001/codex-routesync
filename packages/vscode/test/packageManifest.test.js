const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rawManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
);

const englishNlsPath = path.join(__dirname, "..", "package.nls.json");
const chineseNlsPath = path.join(__dirname, "..", "package.nls.zh-cn.json");

function readCatalogIfPresent(catalogPath) {
  return fs.existsSync(catalogPath)
    ? JSON.parse(fs.readFileSync(catalogPath, "utf-8"))
    : {};
}

function nlsKey(value) {
  return typeof value === "string" && /^%([^%]+)%$/.exec(value)?.[1];
}

function localizeManifest(value, catalog) {
  if (Array.isArray(value)) return value.map((item) => localizeManifest(item, catalog));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, localizeManifest(item, catalog)]),
    );
  }
  if (typeof value !== "string") return value;
  const key = nlsKey(value);
  return key ? catalog[key] ?? value : value;
}

const manifest = localizeManifest(rawManifest, readCatalogIfPresent(englishNlsPath));

const commands = manifest.contributes.commands;

test("VS Code-owned user-visible contributions use complete English and Chinese NLS catalogs", () => {
  assert.equal(fs.existsSync(englishNlsPath), true, "package.nls.json must exist");
  assert.equal(fs.existsSync(chineseNlsPath), true, "package.nls.zh-cn.json must exist");

  const english = readCatalogIfPresent(englishNlsPath);
  const chinese = readCatalogIfPresent(chineseNlsPath);
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  const languageNeutralBrandKeys = new Set([
    "extension.displayName",
    "viewContainer.title",
    "command.category",
    "configuration.title",
  ]);

  const localizedValues = [
    ["displayName", rawManifest.displayName],
    ["description", rawManifest.description],
  ];

  for (const [index, container] of
    (rawManifest.contributes.viewsContainers.activitybar ?? []).entries()) {
    localizedValues.push([`viewsContainers.activitybar[${index}].title`, container.title]);
  }
  for (const [containerId, views] of Object.entries(rawManifest.contributes.views ?? {})) {
    for (const [index, view] of views.entries()) {
      localizedValues.push([`views.${containerId}[${index}].name`, view.name]);
    }
  }
  for (const [index, welcome] of (rawManifest.contributes.viewsWelcome ?? []).entries()) {
    localizedValues.push([`viewsWelcome[${index}].contents`, welcome.contents]);
  }
  for (const [index, command] of (rawManifest.contributes.commands ?? []).entries()) {
    localizedValues.push([`commands[${index}].title`, command.title]);
    localizedValues.push([`commands[${index}].category`, command.category]);
  }

  const configuration = rawManifest.contributes.configuration;
  localizedValues.push(["configuration.title", configuration.title]);
  for (const [settingId, setting] of Object.entries(configuration.properties ?? {})) {
    for (const property of [
      "description",
      "markdownDescription",
      "deprecationMessage",
      "markdownDeprecationMessage",
    ]) {
      if (setting[property] !== undefined) {
        localizedValues.push([`configuration.${settingId}.${property}`, setting[property]]);
      }
    }
    for (const [index, description] of (setting.enumDescriptions ?? []).entries()) {
      localizedValues.push([
        `configuration.${settingId}.enumDescriptions[${index}]`,
        description,
      ]);
    }
  }

  for (const [location, value] of localizedValues) {
    const key = nlsKey(value);
    assert.ok(key, `${location} must contain one complete %key% placeholder`);
    assert.equal(typeof english[key], "string", `${location} is missing English key ${key}`);
    assert.ok(english[key].trim().length > 0, `${key} must have a default English value`);
    assert.equal(typeof chinese[key], "string", `${location} is missing Chinese key ${key}`);
    assert.ok(chinese[key].trim().length > 0, `${key} must have a Chinese value`);
    if (!languageNeutralBrandKeys.has(key)) {
      assert.match(chinese[key], /[\u3400-\u9fff]/u, `${key} must be translated into Chinese`);
    }
  }
});

test("extension identity is Codex SwitchBridge 0.5.1", () => {
  assert.equal(manifest.name, "codex-switchbridge");
  assert.equal(manifest.displayName, "Codex SwitchBridge");
  assert.equal(manifest.publisher, "baoshichao001-dev");
  assert.equal(manifest.version, "0.5.1");
  assert.match(manifest.description, /accounts and API providers/i);
  assert.match(manifest.description, /shared local conversation history/i);
  assert.match(manifest.description, /token usage/i);
  assert.ok(manifest.keywords.includes("api-provider"));
  assert.ok(manifest.keywords.includes("conversation-history"));
  assert.ok(manifest.keywords.includes("responses-api"));
});

test("S-Bridge brand assets are self-contained and Marketplace-ready", () => {
  const resources = path.join(__dirname, "..", "resources");
  const colorSvg = fs.readFileSync(
    path.join(resources, "icon-color.svg"),
    "utf-8",
  );
  const activitySvg = fs.readFileSync(
    path.join(resources, "icon.svg"),
    "utf-8",
  );
  const png = fs.readFileSync(path.join(resources, "icon.png"));

  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);

  for (const svg of [colorSvg, activitySvg]) {
    assert.doesNotMatch(svg, /<(?:text|image)\b/i);
    assert.doesNotMatch(svg, /<(?:style|font)\b/i);
    assert.doesNotMatch(svg, /\b(?:href|xlink:href)=/i);
    assert.doesNotMatch(svg, /\bstyle\s*=/i);
    assert.doesNotMatch(svg, /font-family|@import|xml-stylesheet/i);
    assert.doesNotMatch(svg, /url\(/i);
  }

  assert.match(colorSvg, /#111827/i);
  assert.match(colorSvg, /#2f66e8/i);
  assert.match(colorSvg, /#58d4e8/i);
  assert.match(colorSvg, /#ffffff/i);
  assert.match(activitySvg, /currentColor/);
  assert.doesNotMatch(activitySvg, /#[0-9a-f]{3,8}/i);

  const activityPaints = [
    ...activitySvg.matchAll(/\b(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi),
  ].map((match) => match[1]);
  assert.deepEqual(
    new Set(activityPaints),
    new Set(["currentColor", "none"]),
  );
});

test("activity view uses a native Dashboard launcher and keeps management trees native", () => {
  const views = manifest.contributes.views["codex-switchbridge"] ?? [];
  assert.deepEqual(
    views.map((view) => view.id),
    [
      "codexSwitchBridgeOverview",
      "codexSwitchBridgeAccounts",
      "codexSwitchBridgeProviders",
    ],
  );

  const overview = views.find((view) => view.id === "codexSwitchBridgeOverview");
  const accounts = views.find((view) => view.id === "codexSwitchBridgeAccounts");
  const providers = views.find((view) => view.id === "codexSwitchBridgeProviders");
  assert.equal(overview?.name, "Dashboard");
  assert.equal(overview?.type, undefined);
  assert.equal(overview?.showCollapseAll, undefined);
  assert.equal(accounts?.type, undefined);
  assert.equal(providers?.type, undefined);

  const overviewTitleCommands = (manifest.contributes.menus["view/title"] ?? [])
    .filter((item) => item.when === "view == codexSwitchBridgeOverview")
    .sort((left, right) => left.group.localeCompare(right.group))
    .map((item) => item.command);
  assert.deepEqual(
    overviewTitleCommands,
    ["codex-switchbridge.openDashboard"],
  );

  const openDashboard = commands.find(
    (command) => command.command === "codex-switchbridge.openDashboard",
  );
  assert.equal(openDashboard?.title, "Open Dashboard");
  assert.equal(openDashboard?.category, "Codex SwitchBridge");
  assert.equal(openDashboard?.icon, "$(open-preview)");
});

test("production build includes dashboard browser assets and excludes raw webview sources", () => {
  const packageRoot = path.join(__dirname, "..");
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "webview", "dashboard.js")), true);
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "webview", "dashboard.css")), true);

  const ignored = fs.readFileSync(path.join(packageRoot, ".vscodeignore"), "utf-8");
  assert.match(ignored, /^webview\/\*\*$/m);
  assert.doesNotMatch(ignored, /^dist\/webview\/\*\*$/m);
});

test("visual tests rebuild dashboard assets before launching Playwright", () => {
  assert.match(
    manifest.scripts["test:visual"],
    /^npm run build && playwright test /,
  );
});

test("Marketplace publishing rebuilds and publishes the exact versioned VSIX", () => {
  assert.equal(manifest.scripts["prepublish:marketplace"], "npm run package");
  assert.equal(
    manifest.scripts["publish:marketplace"],
    "node ./scripts/publish-marketplace.mjs",
  );
});

test("production build includes the history migration helper", () => {
  const helper = path.join(__dirname, "..", "dist", "scripts", "migrate-history-provider.py");
  assert.equal(fs.existsSync(helper), true);
  assert.match(fs.readFileSync(helper, "utf-8"), /--json/);
});

test("extension runs in the workspace extension host", () => {
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
});

test("extension commands use category for the shared prefix", () => {
  const extensionCommands = commands.filter((command) =>
    command.command.startsWith("codex-switchbridge.")
  );

  assert.ok(extensionCommands.length > 0);

  for (const command of extensionCommands) {
    assert.equal(command.category, "Codex SwitchBridge");
    assert.match(command.title, /^(?!Codex SwitchBridge: ).+/);
  }
});

test("account item context actions keep concise titles", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-switchbridge.reloginAccount")?.title,
    "Re-login Account"
  );
  assert.equal(
    byId.get("codex-switchbridge.renameAccount")?.title,
    "Rename Account"
  );
  assert.equal(
    byId.get("codex-switchbridge.removeAccount")?.title,
    "Remove Account"
  );
  assert.equal(
    byId.get("codex-switchbridge.refreshToken")?.title,
    "Refresh Token"
  );
});

test("device auth login setting is opt-in", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-switchbridge.useDeviceAuthForLogin"
    ];

  assert.equal(setting?.type, "boolean");
  assert.equal(setting?.default, false);
  assert.match(setting?.description ?? "", /device code authorization/i);
});

test("dashboard language setting supports automatic, English, and Simplified Chinese", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-switchbridge.language"
    ];

  assert.equal(setting?.type, "string");
  assert.equal(setting?.default, "auto");
  assert.deepEqual(setting?.enum, ["auto", "en", "zh-cn"]);
  assert.equal(setting?.scope, "window");
  assert.match(setting?.description ?? "", /dashboard language/i);
  assert.equal(setting?.enumDescriptions?.length, 3);
  assert.match(setting?.enumDescriptions?.[0] ?? "", /follow VS Code/i);
  assert.match(setting?.enumDescriptions?.[1] ?? "", /English/i);
  assert.match(setting?.enumDescriptions?.[2] ?? "", /Simplified Chinese/i);
});

test("storage password commands are contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-switchbridge.unlockStorage")?.title,
    "Unlock Storage"
  );
  assert.equal(
    byId.get("codex-switchbridge.setStoragePassword")?.title,
    "Set Storage Password"
  );
  assert.equal(
    byId.get("codex-switchbridge.changeStoragePassword")?.title,
    "Change Storage Password"
  );
  assert.equal(
    byId.get("codex-switchbridge.forgetStoragePassword")?.title,
    "Forget Local Storage Password"
  );
});

test("storage target settings are contributed", () => {
  const properties = manifest.contributes.configuration.properties;

  assert.equal(
    properties["codex-switchbridge.defaultSaveTarget"]?.default,
    "local"
  );
  assert.deepEqual(
    properties["codex-switchbridge.defaultSaveTarget"]?.enum,
    ["local", "cloud"]
  );
  assert.equal(
    properties["codex-switchbridge.syncedStorage"]?.type,
    "object"
  );
  assert.match(
    properties["codex-switchbridge.defaultSaveTarget"]?.enumDescriptions?.[1] ?? "",
    /synced extension storage/i
  );
  assert.match(
    properties["codex-switchbridge.syncedStorage"]?.markdownDeprecationMessage ?? "",
    /legacy migration-only setting/i
  );
  assert.equal(
    properties["codex-switchbridge.detailedPerformanceLogging"]?.type,
    "boolean"
  );
  assert.equal(
    properties["codex-switchbridge.detailedPerformanceLogging"]?.default,
    false
  );
  assert.match(
    properties["codex-switchbridge.detailedPerformanceLogging"]?.description ?? "",
    /debug-only/i
  );
});

test("quota refresh setting defaults to 30 seconds for rotating background refresh", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-switchbridge.quotaRefreshInterval"
    ];

  assert.equal(setting?.type, "number");
  assert.equal(setting?.default, 30);
  assert.equal(setting?.minimum, 5);
  assert.match(setting?.description ?? "", /background/i);
  assert.match(setting?.description ?? "", /one saved account/i);
  assert.match(setting?.description ?? "", /rotation/i);
});

test("token auto update setting defaults to enabled", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-switchbridge.tokenAutoUpdate"
    ];

  assert.equal(setting?.type, "boolean");
  assert.equal(setting?.default, true);
  assert.match(setting?.description ?? "", /automatically refresh saved account tokens/i);
  assert.match(setting?.description ?? "", /background timer/i);
});

test("auto-switch settings are contributed with conservative defaults", () => {
  const properties = manifest.contributes.configuration.properties;
  const enabledSetting = properties["codex-switchbridge.autoSwitchOnZeroQuota"];
  const cooldownSetting = properties["codex-switchbridge.autoSwitchCooldownSeconds"];

  assert.equal(enabledSetting?.type, "boolean");
  assert.equal(enabledSetting?.default, false);
  assert.match(enabledSetting?.description ?? "", /5-hour quota reaches 0%/i);

  assert.equal(cooldownSetting?.type, "number");
  assert.equal(cooldownSetting?.default, 90);
  assert.equal(cooldownSetting?.minimum, 15);
  assert.match(cooldownSetting?.description ?? "", /retrying automatic switching/i);
});

test("shared history is enabled by default for account and provider continuity", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-switchbridge.shareHistoryAcrossProviders"
    ];

  assert.equal(setting?.type, "boolean");
  assert.equal(setting?.default, true);
  assert.match(setting?.description ?? "", /new local Codex conversation history/i);
  assert.match(setting?.description ?? "", /Repair Shared Conversation History/i);

  const repairCommand = commands.find(
    (command) => command.command === "codex-switchbridge.repairSharedHistory"
  );
  assert.equal(repairCommand?.title, "Repair Shared Conversation History");
});

test("reload behavior defaults to a non-blocking status-bar recommendation", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-switchbridge.reloadWindowAfterSwitch"
    ];

  assert.equal(setting?.default, "statusBar");
  assert.deepEqual(setting?.enum, ["never", "statusBar", "always"]);
  assert.match(setting?.enumDescriptions?.[1] ?? "", /without interrupting/i);
});

test("storage migration commands are contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-switchbridge.moveAccountToCloud")?.title,
    "Move Account To Cloud"
  );
  assert.equal(
    byId.get("codex-switchbridge.restoreCloudAccountPayload")?.title,
    "Restore Cloud Payload From Protected Backup"
  );
  assert.equal(
    byId.get("codex-switchbridge.moveAccountToLocal")?.title,
    "Move Account To Local"
  );
  assert.equal(
    byId.get("codex-switchbridge.moveProviderToCloud")?.title,
    "Move API Provider To Cloud"
  );
  assert.equal(
    byId.get("codex-switchbridge.moveProviderToLocal")?.title,
    "Move API Provider To Local"
  );
  assert.equal(
    byId.get("codex-switchbridge.removeProvider")?.title,
    "Remove API Provider"
  );
  assert.equal(
    byId.get("codex-switchbridge.enableAutoSwitch")?.title,
    "Enable Auto-Switch"
  );
  assert.equal(
    byId.get("codex-switchbridge.disableAutoSwitch")?.title,
    "Disable Auto-Switch"
  );
  assert.equal(
    byId.get("codex-switchbridge.configureAutoSwitch")?.title,
    "Auto-Switch Settings"
  );
});

test("account inline actions do not include remove", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const inlineAccountActions = contextMenus.filter(
    (item) =>
      item.when ===
        "view == codexSwitchBridgeAccounts && (viewItem == accountLocal || viewItem == accountCloud)" &&
      typeof item.group === "string" &&
      item.group.startsWith("inline@")
  );

  assert.deepEqual(
    inlineAccountActions.map((item) => item.command).sort(),
    ["codex-switchbridge.useAccount"]
  );
});

test("refreshable account item context menu exposes refresh actions", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const refreshAccountActions = contextMenus.filter((item) =>
    typeof item.when === "string"
    && item.when.includes("view == codexSwitchBridgeAccounts")
    && item.when.includes("accountLocal")
    && item.when.includes("accountCloud")
    && typeof item.group === "string"
    && item.group.startsWith("refresh@")
  );

  assert.deepEqual(
    refreshAccountActions.map((item) => item.command).sort(),
    [
      "codex-switchbridge.refreshList",
      "codex-switchbridge.refreshQuota",
      "codex-switchbridge.refreshToken",
    ]
  );
});

test("cloud account context menu exposes refresh token", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const refreshAccountActions = contextMenus.filter(
    (item) =>
      item.when ===
        "view == codexSwitchBridgeAccounts && (viewItem == accountLocal || viewItem == accountCloud)" &&
      typeof item.group === "string" &&
      item.group.startsWith("refresh@")
  );

  assert.deepEqual(
    refreshAccountActions.map((item) => item.command).sort(),
    [
      "codex-switchbridge.refreshList",
      "codex-switchbridge.refreshQuota",
      "codex-switchbridge.refreshToken",
    ]
  );
});

test("cloud account context menu exposes move account to local", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const moveAccountToLocal = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.moveAccountToLocal"
      && item.when === "view == codexSwitchBridgeAccounts && viewItem == accountCloud"
  );

  assert.equal(moveAccountToLocal?.group, "context@4");
});

test("recoverable cloud account context menu exposes explicit restore", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const restore = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.restoreCloudAccountPayload"
      && item.when === "view == codexSwitchBridgeAccounts && viewItem == accountCloudRecoverable"
  );
  const remove = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.removeAccount"
      && item.when ===
        "view == codexSwitchBridgeAccounts && (viewItem == accountLocal || viewItem == accountCloud || viewItem == accountCloudRecoverable)"
  );

  assert.equal(restore?.group, "context@1");
  assert.equal(remove?.group, "context@3");
});

test("account group context menu exposes refresh quota for local and cloud groups", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const localGroupRefresh = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.refreshQuota"
      && item.when ===
        "view == codexSwitchBridgeAccounts && viewItem == accountGroupLocal"
  );
  const cloudGroupRefresh = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.refreshQuota"
      && item.when ===
        "view == codexSwitchBridgeAccounts && viewItem == accountGroupCloud"
  );

  assert.equal(localGroupRefresh?.group, "refresh@1");
  assert.equal(cloudGroupRefresh?.group, "refresh@1");
});

test("provider context menu exposes remove for local and cloud providers", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const removeProvider = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.removeProvider" &&
      item.when ===
        "view == codexSwitchBridgeProviders && (viewItem == providerLocal || viewItem == providerCloud)"
  );

  assert.equal(removeProvider?.group, "context@3");
});

test("provider context menu exposes switch provider inline action", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const switchProvider = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.switchProvider" &&
      item.when ===
        "view == codexSwitchBridgeProviders && (viewItem == providerLocal || viewItem == providerCloud)"
  );

  assert.equal(
    byId.get("codex-switchbridge.switchProvider")?.title,
    "Switch API Provider"
  );
  assert.equal(switchProvider?.group, "inline@1");
});

test("providers view title menu exposes add provider", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const addProvider = titleMenus.find(
    (item) =>
      item.command === "codex-switchbridge.addProvider" &&
      item.when === "view == codexSwitchBridgeProviders"
  );
  const providerWelcome = manifest.contributes.viewsWelcome.find(
    (item) => item.view === "codexSwitchBridgeProviders"
  );

  assert.equal(
    byId.get("codex-switchbridge.addProvider")?.title,
    "Add API Provider"
  );
  assert.equal(addProvider?.group, "navigation@3");
  assert.equal(
    providerWelcome?.contents.includes("command:codex-switchbridge.addProvider"),
    true
  );
});

test("accounts view title menu exposes a single refresh entrypoint", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const accountViewCommands = titleMenus
    .filter((item) => item.when === "view == codexSwitchBridgeAccounts")
    .map((item) => item.command);

  const manualRefreshCommands = [
    "codex-switchbridge.refresh",
    "codex-switchbridge.refreshList",
    "codex-switchbridge.refreshQuota",
    "codex-switchbridge.refreshToken",
  ];
  const present = manualRefreshCommands.filter((command) =>
    accountViewCommands.includes(command)
  );

  assert.deepEqual(present, ["codex-switchbridge.refresh"]);
});

test("accounts view title menu is ordered by semantic groups", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const accountTitleItems = titleMenus
    .filter((item) => item.when?.startsWith("view == codexSwitchBridgeAccounts"))
    .sort((left, right) => {
      const leftOrder = Number(left.group?.match(/@(\d+)$/)?.[1] ?? 0);
      const rightOrder = Number(right.group?.match(/@(\d+)$/)?.[1] ?? 0);

      return leftOrder - rightOrder;
    });

  assert.deepEqual(
    accountTitleItems.map((item) => item.command),
    [
      "codex-switchbridge.refresh",
      "codex-switchbridge.expandAllAccounts",
      "codex-switchbridge.addAccount",
      "codex-switchbridge.importAccounts",
      "codex-switchbridge.reloadWindow",
      "codex-switchbridge.enableAutoSwitch",
      "codex-switchbridge.disableAutoSwitch",
    ]
  );
  assert.deepEqual(
    accountTitleItems.map((item) => item.group),
    [
      "navigation@1",
      "navigation@2",
      "navigation@3",
      "navigation@4",
      "navigation@6",
      "navigation@8",
      "navigation@8",
    ]
  );
});

test("accounts view title menu hides switch mode and auto-switch settings", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const enabledItem = titleMenus.find(
    (item) =>
      item.command === "codex-switchbridge.enableAutoSwitch" &&
      item.when ===
        "view == codexSwitchBridgeAccounts && !codexSwitchBridge.autoSwitchEnabled"
  );
  const disabledItem = titleMenus.find(
    (item) =>
      item.command === "codex-switchbridge.disableAutoSwitch" &&
      item.when ===
        "view == codexSwitchBridgeAccounts && codexSwitchBridge.autoSwitchEnabled"
  );
  const settingsItem = titleMenus.find(
    (item) =>
      item.command === "codex-switchbridge.configureAutoSwitch" &&
      item.when === "view == codexSwitchBridgeAccounts"
  );
  const switchModeItem = titleMenus.find(
    (item) =>
      item.command === "codex-switchbridge.switchMode" &&
      item.when === "view == codexSwitchBridgeAccounts"
  );

  assert.equal(enabledItem?.group, "navigation@8");
  assert.equal(disabledItem?.group, "navigation@8");
  assert.equal(settingsItem, undefined);
  assert.equal(switchModeItem, undefined);
});

test("providers view hides switch mode title and welcome entrypoints", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const providerSwitchModeItem = titleMenus.find(
    (item) =>
      item.command === "codex-switchbridge.switchMode" &&
      item.when === "view == codexSwitchBridgeProviders"
  );
  const providerWelcome = manifest.contributes.viewsWelcome.find(
    (item) => item.view === "codexSwitchBridgeProviders"
  );

  assert.equal(providerSwitchModeItem, undefined);
  assert.equal(providerWelcome?.contents.includes("Switch mode"), false);
});

test("locked cloud accounts expose unlock in the context menu", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const unlockMenuItem = contextMenus.find(
    (item) =>
      item.command === "codex-switchbridge.unlockStorage" &&
      item.when ===
        "view == codexSwitchBridgeAccounts && viewItem == accountCloudLocked"
  );

  assert.equal(unlockMenuItem?.group, "context@1");
});

test("account email copy command is contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];

  assert.equal(
    byId.get("codex-switchbridge.copyAccountField")?.title,
    "Copy Account Value"
  );
  assert.equal(
    contextMenus.find(
      (item) =>
        item.command === "codex-switchbridge.copyAccountField" &&
        item.when ===
          "view == codexSwitchBridgeAccounts && viewItem == accountCopyableField"
    )?.group,
    "context@1"
  );
});
