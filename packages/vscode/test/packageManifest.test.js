const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");
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

  const referencedKeys = new Set(localizedValues.map(([, value]) => nlsKey(value)));
  assert.deepEqual(
    Object.keys(english).sort(),
    [...referencedKeys].sort(),
    "package.nls.json must not retain keys for removed manifest contributions",
  );
});

test("extension identity is Codex RouteSync 0.8.1", () => {
  assert.equal(manifest.name, "codex-routesync");
  assert.equal(manifest.displayName, "Codex RouteSync");
  assert.equal(manifest.publisher, "ShawBob001");
  assert.equal(manifest.version, "0.8.1");
  assert.match(manifest.description, /accounts and API providers/i);
  assert.match(manifest.description, /shared local conversation history/i);
  assert.match(manifest.description, /token usage/i);
  assert.ok(manifest.keywords.includes("api-provider"));
  assert.ok(manifest.keywords.includes("conversation-history"));
  assert.ok(manifest.keywords.includes("responses-api"));
});

test("workspace release metadata bumps only the root and VS Code package to 0.8.1", () => {
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf-8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf-8"),
  );
  const coreManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "packages", "core", "package.json"), "utf-8"),
  );
  const cliManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "packages", "cli", "package.json"), "utf-8"),
  );

  assert.equal(rootManifest.name, "codex-routesync-monorepo");
  assert.equal(rootManifest.version, "0.8.1");
  assert.equal(lock.name, rootManifest.name);
  assert.equal(lock.version, rootManifest.version);
  assert.equal(lock.packages[""].name, rootManifest.name);
  assert.equal(lock.packages[""].version, rootManifest.version);
  assert.equal(lock.packages["packages/vscode"].name, manifest.name);
  assert.equal(lock.packages["packages/vscode"].version, manifest.version);
  assert.equal(coreManifest.version, "0.3.0");
  assert.equal(cliManifest.version, "0.3.0");
  assert.equal(lock.packages["packages/core"].version, coreManifest.version);
  assert.equal(lock.packages["packages/cli"].version, cliManifest.version);
});

test("RouteSync brand assets are self-contained and Marketplace-ready", () => {
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

test("activity view contributes one native bilingual routes tree", () => {
  const views = manifest.contributes.views["codex-routesync"] ?? [];
  assert.deepEqual(
    views.map((view) => view.id),
    ["codexRouteSyncRoutes"],
  );

  const routes = views[0];
  assert.equal(routes.name, "Accounts & API Routes");
  assert.equal(routes.type, undefined);
  assert.equal(routes.showCollapseAll, true);

  const routesTitleCommands = (manifest.contributes.menus["view/title"] ?? [])
    .filter((item) => item.when === "view == codexRouteSyncRoutes")
    .filter((item) => item.group?.startsWith("navigation@"))
    .sort((left, right) => left.group.localeCompare(right.group))
    .map((item) => item.command);
  assert.deepEqual(
    routesTitleCommands,
    [
      "codex-routesync.openDashboard",
      "codex-routesync.refresh",
      "codex-routesync.addAccount",
      "codex-routesync.addProvider",
    ],
  );

  const serializedMenus = JSON.stringify({
    viewsWelcome: rawManifest.contributes.viewsWelcome ?? [],
    title: rawManifest.contributes.menus["view/title"] ?? [],
    context: rawManifest.contributes.menus["view/item/context"] ?? [],
  });
  assert.doesNotMatch(
    serializedMenus,
    /codexRouteSync(?:Overview|Accounts|Providers)/,
  );

  const english = readCatalogIfPresent(englishNlsPath);
  const chinese = readCatalogIfPresent(chineseNlsPath);
  assert.equal(english["view.routes.name"], "Accounts & API Routes");
  assert.equal(chinese["view.routes.name"], "账号与 API 路由");

  const openDashboard = commands.find(
    (command) => command.command === "codex-routesync.openDashboard",
  );
  assert.equal(openDashboard?.title, "Open Dashboard");
  assert.equal(openDashboard?.category, "Codex RouteSync");
  assert.equal(openDashboard?.icon, "$(open-preview)");
});

test("contribution IDs are collision-free while the configuration namespace stays stable", () => {
  const activityContainers = manifest.contributes.viewsContainers.activitybar ?? [];
  assert.deepEqual(
    activityContainers.map((container) => container.id),
    ["codex-routesync"],
  );

  const commandIds = commands.map((command) => command.command);
  assert.ok(commandIds.length > 0);
  assert.ok(commandIds.every((command) => command.startsWith("codex-routesync.")));

  const configurationKeys = Object.keys(manifest.contributes.configuration.properties ?? {});
  assert.ok(configurationKeys.length > 0);
  assert.ok(configurationKeys.every((key) => key.startsWith("codex-switchbridge.")));
  assert.ok(configurationKeys.every((key) => !key.startsWith("codex-routesync.")));

  const serializedMenus = JSON.stringify(manifest.contributes.menus ?? {});
  assert.doesNotMatch(serializedMenus, /codex-switchbridge\.(?!vscode\.)/);
  assert.doesNotMatch(serializedMenus, /codexSwitchBridgeVscodeRoutes/);
  assert.doesNotMatch(serializedMenus, /codexSwitchBridgeVscode\.autoSwitchEnabled/);
  assert.match(serializedMenus, /codexRouteSyncRoutes/);
  assert.match(serializedMenus, /codexRouteSync\.autoSwitchEnabled/);
});

test("production build includes dashboard browser assets and excludes raw webview sources", () => {
  const packageRoot = path.join(__dirname, "..");
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "webview", "dashboard.js")), true);
  assert.equal(fs.existsSync(path.join(packageRoot, "dist", "webview", "dashboard.css")), true);

  const ignored = fs.readFileSync(path.join(packageRoot, ".vscodeignore"), "utf-8");
  assert.match(ignored, /^webview\/\*\*$/m);
  assert.doesNotMatch(ignored, /^dist\/webview\/\*\*$/m);
});

test("Marketplace README uses stable repository paths for dashboard screenshots", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf-8");
  const expectedBase = "https://raw.githubusercontent.com/ShawBob001/codex-routesync/main/packages/vscode/images/";
  assert.match(readme, new RegExp(`${expectedBase}dashboard-en-dark\\.png`));
  assert.match(readme, new RegExp(`${expectedBase}dashboard-zh-light\\.png`));
  assert.doesNotMatch(readme, /\]\(images\//);
});

test("workspace tests use cross-platform file discovery compatible with Node 20", () => {
  const runnerPath = path.join(repositoryRoot, "scripts", "run-node-tests.mjs");
  assert.equal(fs.existsSync(runnerPath), true, "shared Node test runner is missing");

  for (const workspace of ["core", "cli", "vscode"]) {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, "packages", workspace, "package.json"),
      "utf8",
    ));
    assert.match(manifest.scripts.test, /run-node-tests\.mjs test/);
    assert.doesNotMatch(manifest.scripts.test, /\*\*/);
  }
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
    command.command.startsWith("codex-routesync.")
  );

  assert.ok(extensionCommands.length > 0);

  for (const command of extensionCommands) {
    assert.equal(command.category, "Codex RouteSync");
    assert.match(command.title, /^(?!Codex RouteSync: ).+/);
  }
});

test("account item context actions keep concise titles", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-routesync.reloginAccount")?.title,
    "Re-login Account"
  );
  assert.equal(
    byId.get("codex-routesync.renameAccount")?.title,
    "Rename Account"
  );
  assert.equal(
    byId.get("codex-routesync.removeAccount")?.title,
    "Remove Account"
  );
  assert.equal(
    byId.get("codex-routesync.refreshToken")?.title,
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

test("quota proxy setting is machine scoped, excluded from sync, and defaults to automatic resolution", () => {
  const setting = manifest.contributes.configuration.properties[
    "codex-switchbridge.proxy"
  ];

  assert.equal(setting?.type, "string");
  assert.equal(setting?.default, "");
  assert.equal(setting?.scope, "machine");
  assert.equal(setting?.ignoreSync, true);
  assert.match(setting?.description ?? "", /quota.*token refresh/i);
  assert.match(setting?.description ?? "", /VS Code.*environment/i);
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
    byId.get("codex-routesync.unlockStorage")?.title,
    "Unlock Storage"
  );
  assert.equal(
    byId.get("codex-routesync.setStoragePassword")?.title,
    "Set Storage Password"
  );
  assert.equal(
    byId.get("codex-routesync.changeStoragePassword")?.title,
    "Change Storage Password"
  );
  assert.equal(
    byId.get("codex-routesync.forgetStoragePassword")?.title,
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
    (command) => command.command === "codex-routesync.repairSharedHistory"
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
    byId.get("codex-routesync.moveAccountToCloud")?.title,
    "Move Account To Cloud"
  );
  assert.equal(
    byId.get("codex-routesync.restoreCloudAccountPayload")?.title,
    "Restore Cloud Payload From Protected Backup"
  );
  assert.equal(
    byId.get("codex-routesync.moveAccountToLocal")?.title,
    "Move Account To Local"
  );
  assert.equal(
    byId.get("codex-routesync.moveProviderToCloud")?.title,
    "Move API Provider To Cloud"
  );
  assert.equal(
    byId.get("codex-routesync.moveProviderToLocal")?.title,
    "Move API Provider To Local"
  );
  assert.equal(
    byId.get("codex-routesync.removeProvider")?.title,
    "Remove API Provider"
  );
  assert.equal(
    byId.get("codex-routesync.enableAutoSwitch")?.title,
    "Enable Auto-Switch"
  );
  assert.equal(
    byId.get("codex-routesync.disableAutoSwitch")?.title,
    "Disable Auto-Switch"
  );
  assert.equal(
    byId.get("codex-routesync.configureAutoSwitch")?.title,
    "Auto-Switch Settings"
  );
});

test("account inline actions do not include remove", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const inlineAccountActions = contextMenus.filter(
    (item) =>
      item.when ===
        "view == codexRouteSyncRoutes && (viewItem == accountLocal || viewItem == accountCloud)" &&
      typeof item.group === "string" &&
      item.group.startsWith("inline@")
  );

  assert.deepEqual(
    inlineAccountActions.map((item) => item.command).sort(),
    ["codex-routesync.useAccount"]
  );
});

test("refreshable account item context menu exposes refresh actions", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const refreshAccountActions = contextMenus.filter((item) =>
    typeof item.when === "string"
    && item.when.includes("view == codexRouteSyncRoutes")
    && item.when.includes("accountLocal")
    && item.when.includes("accountCloud")
    && typeof item.group === "string"
    && item.group.startsWith("refresh@")
  );

  assert.deepEqual(
    refreshAccountActions.map((item) => item.command).sort(),
    [
      "codex-routesync.refreshList",
      "codex-routesync.refreshQuota",
      "codex-routesync.refreshToken",
    ]
  );
});

test("cloud account context menu exposes refresh token", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const refreshAccountActions = contextMenus.filter(
    (item) =>
      item.when ===
        "view == codexRouteSyncRoutes && (viewItem == accountLocal || viewItem == accountCloud)" &&
      typeof item.group === "string" &&
      item.group.startsWith("refresh@")
  );

  assert.deepEqual(
    refreshAccountActions.map((item) => item.command).sort(),
    [
      "codex-routesync.refreshList",
      "codex-routesync.refreshQuota",
      "codex-routesync.refreshToken",
    ]
  );
});

test("cloud account context menu exposes move account to local", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const moveAccountToLocal = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.moveAccountToLocal"
      && item.when === "view == codexRouteSyncRoutes && viewItem == accountCloud"
  );

  assert.equal(moveAccountToLocal?.group, "context@4");
});

test("recoverable cloud account context menu exposes explicit restore", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const restore = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.restoreCloudAccountPayload"
      && item.when === "view == codexRouteSyncRoutes && viewItem == accountCloudRecoverable"
  );
  const remove = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.removeAccount"
      && item.when ===
        "view == codexRouteSyncRoutes && (viewItem == accountLocal || viewItem == accountCloud || viewItem == accountCloudRecoverable)"
  );

  assert.equal(restore?.group, "context@1");
  assert.equal(remove?.group, "context@3");
});

test("flat routes tree does not contribute unreachable account group actions", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const localGroupRefresh = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.refreshQuota"
      && item.when ===
        "view == codexRouteSyncRoutes && viewItem == accountGroupLocal"
  );
  const cloudGroupRefresh = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.refreshQuota"
      && item.when ===
        "view == codexRouteSyncRoutes && viewItem == accountGroupCloud"
  );

  assert.equal(localGroupRefresh, undefined);
  assert.equal(cloudGroupRefresh, undefined);
});

test("provider context menu exposes remove for local and cloud providers", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const removeProvider = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.removeProvider" &&
      item.when ===
        "view == codexRouteSyncRoutes && (viewItem == providerLocal || viewItem == providerCloud)"
  );

  assert.equal(removeProvider?.group, "context@3");
});

test("provider context menu exposes switch provider inline action", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const switchProvider = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.switchProvider" &&
      item.when ===
        "view == codexRouteSyncRoutes && (viewItem == providerLocal || viewItem == providerCloud)"
  );

  assert.equal(
    byId.get("codex-routesync.switchProvider")?.title,
    "Switch API Provider"
  );
  assert.equal(switchProvider?.group, "inline@1");
});

test("routes view title menu exposes add provider without a welcome fragment", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const addProvider = titleMenus.find(
    (item) =>
      item.command === "codex-routesync.addProvider" &&
      item.when === "view == codexRouteSyncRoutes"
  );
  assert.equal(
    byId.get("codex-routesync.addProvider")?.title,
    "Add API Provider"
  );
  assert.equal(addProvider?.group, "navigation@4");
  assert.equal(manifest.contributes.viewsWelcome, undefined);
});

test("routes view exposes a single primary refresh entrypoint", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const accountViewCommands = titleMenus
    .filter((item) => item.when === "view == codexRouteSyncRoutes")
    .filter((item) => item.group?.startsWith("navigation@"))
    .map((item) => item.command);

  const manualRefreshCommands = [
    "codex-routesync.refresh",
    "codex-routesync.refreshList",
    "codex-routesync.refreshQuota",
    "codex-routesync.refreshToken",
  ];
  const present = manualRefreshCommands.filter((command) =>
    accountViewCommands.includes(command)
  );

  assert.deepEqual(present, ["codex-routesync.refresh"]);
});

test("routes view keeps four primary actions in navigation and moves low-frequency actions to overflow", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const routeTitleItems = titleMenus.filter(
    (item) => item.when?.startsWith("view == codexRouteSyncRoutes"),
  );
  const primary = routeTitleItems
    .filter((item) => item.group?.startsWith("navigation@"))
    .sort((left, right) => left.group.localeCompare(right.group));

  assert.deepEqual(
    primary.map((item) => item.command),
    [
      "codex-routesync.openDashboard",
      "codex-routesync.refresh",
      "codex-routesync.addAccount",
      "codex-routesync.addProvider",
    ]
  );
  const overflowCommands = routeTitleItems
    .filter((item) => !item.group?.startsWith("navigation@"))
    .map((item) => item.command);
  for (const command of [
    "codex-routesync.expandAllAccounts",
    "codex-routesync.importAccounts",
    "codex-routesync.reloadWindow",
    "codex-routesync.refreshList",
    "codex-routesync.repairSharedHistory",
  ]) assert.ok(overflowCommands.includes(command));
});

test("accounts view title menu hides switch mode and auto-switch settings", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const enabledItem = titleMenus.find(
    (item) =>
      item.command === "codex-routesync.enableAutoSwitch" &&
      item.when ===
        "view == codexRouteSyncRoutes && !codexRouteSync.autoSwitchEnabled"
  );
  const disabledItem = titleMenus.find(
    (item) =>
      item.command === "codex-routesync.disableAutoSwitch" &&
      item.when ===
        "view == codexRouteSyncRoutes && codexRouteSync.autoSwitchEnabled"
  );
  const settingsItem = titleMenus.find(
    (item) =>
      item.command === "codex-routesync.configureAutoSwitch" &&
      item.when === "view == codexRouteSyncRoutes"
  );
  const switchModeItem = titleMenus.find(
    (item) =>
      item.command === "codex-routesync.switchMode" &&
      item.when === "view == codexRouteSyncRoutes"
  );

  assert.equal(enabledItem?.group, "2_switching@1");
  assert.equal(disabledItem?.group, "2_switching@1");
  assert.equal(settingsItem, undefined);
  assert.equal(switchModeItem, undefined);
});

test("routes view hides switch mode title and has no welcome fragments", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const providerSwitchModeItem = titleMenus.find(
    (item) =>
      item.command === "codex-routesync.switchMode" &&
      item.when === "view == codexRouteSyncRoutes"
  );
  assert.equal(providerSwitchModeItem, undefined);
  assert.equal(manifest.contributes.viewsWelcome, undefined);
});

test("locked cloud accounts expose unlock in the context menu", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const unlockMenuItem = contextMenus.find(
    (item) =>
      item.command === "codex-routesync.unlockStorage" &&
      item.when ===
        "view == codexRouteSyncRoutes && viewItem == accountCloudLocked"
  );

  assert.equal(unlockMenuItem?.group, "context@1");
});

test("account email copy command is contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];

  assert.equal(
    byId.get("codex-routesync.copyAccountField")?.title,
    "Copy Account Value"
  );
  assert.equal(
    contextMenus.find(
      (item) =>
        item.command === "codex-routesync.copyAccountField" &&
        item.when ===
          "view == codexRouteSyncRoutes && viewItem == accountCopyableField"
    )?.group,
    "context@1"
  );
});
