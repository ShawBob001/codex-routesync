const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");
const readmes = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
  "README.es.md",
  "README.fr.md",
  "README.de.md",
];
const installReadmes = [...readmes, "packages/vscode/README.md"];
const marketplaceItemUrl = "https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync";
const oldMarketplaceSearch = /marketplace\.visualstudio\.com\/search\?sortBy=Relevance&term=Codex%20RouteSync&target=VSCode/;
const vsixInstallCommand = "code --install-extension codex-routesync-VERSION.vsix";
const oldVsixInstallCommands = [
  "code --install-extension codex-switchbridge-vscode-VERSION.vsix",
  "code --install-extension codex-switchbridge-VERSION.vsix",
];
const migrationHeadings = {
  "README.md": "#### Move from the previous Marketplace listing",
  "README.zh-CN.md": "#### 从之前的 Marketplace 版本迁移",
  "README.ja.md": "#### 以前の Marketplace 版から移行する",
  "README.ko.md": "#### 이전 Marketplace 버전에서 이전하기",
  "README.es.md": "#### Migrar desde la publicación anterior de Marketplace",
  "README.fr.md": "#### Migrer depuis la publication Marketplace précédente",
  "README.de.md": "#### Von der vorherigen Marketplace-Version migrieren",
  "packages/vscode/README.md": "#### Move from the previous Marketplace listing",
};
const migrationActionPatterns = {
  "README.md": [
    /move every synced or cloud account and API provider to \*\*Local\*\*/,
    /Disable or uninstall the previous installation, then run \*\*Developer: Reload Window\*\*/,
    /Install Codex RouteSync from the link above and re-enter your storage password/,
  ],
  "README.zh-CN.md": [
    /将所有同步或云端账号和 API 提供商移动到 \*\*Local\*\*/,
    /禁用或卸载之前的安装，运行 \*\*Developer: Reload Window\*\*/,
    /从上方链接安装 Codex RouteSync，并重新输入存储密码/,
  ],
  "README.ja.md": [
    /すべてのアカウントと API プロバイダーを \*\*Local\*\* に移動/,
    /以前のインストールを無効化またはアンインストールし、\*\*Developer: Reload Window\*\* を実行/,
    /上記のリンクで Codex RouteSync をインストールし、ストレージパスワードを再入力/,
  ],
  "README.ko.md": [
    /모든 계정과 API 제공자를 \*\*Local\*\*로 이동/,
    /이전 설치를 비활성화하거나 제거하고 \*\*Developer: Reload Window\*\*를 실행/,
    /위 링크에서 Codex RouteSync를 설치하고 저장소 암호를 다시 입력/,
  ],
  "README.es.md": [
    /todas las cuentas y proveedores de API sincronizados o guardados en la nube/,
    /desactiva o desinstala esa instalación, ejecuta \*\*Developer: Reload Window\*\*/,
    /instala Codex RouteSync desde el enlace anterior y vuelve a introducir la contraseña de almacenamiento/,
  ],
  "README.fr.md": [
    /tous les comptes et fournisseurs d'API synchronisés ou stockés dans le cloud/,
    /Désactivez ou désinstallez ensuite cette installation, exécutez \*\*Developer: Reload Window\*\*/,
    /installez Codex RouteSync depuis le lien ci-dessus et saisissez à nouveau le mot de passe de stockage/,
  ],
  "README.de.md": [
    /alle synchronisierten oder in der Cloud gespeicherten Konten und API-Anbieter nach \*\*Local\*\*/,
    /Deaktiviere oder deinstalliere danach diese Installation, führe \*\*Developer: Reload Window\*\* aus/,
    /installiere Codex RouteSync über den obigen Link und gib das Speicherpasswort erneut ein/,
  ],
  "packages/vscode/README.md": [
    /move every synced or cloud account and API provider to \*\*Local\*\*/,
    /Disable or uninstall the previous installation, then run \*\*Developer: Reload Window\*\*/,
    /Install Codex RouteSync from the link above and re-enter your storage password/,
  ],
};
const extensionSource = fs.readFileSync(
  path.join(repositoryRoot, "packages/vscode/src/extension.ts"),
  "utf8",
);
const legacyExtensionId = /const LEGACY_EXTENSION_IDS = \[\s*"([^"]+)"/.exec(extensionSource)?.[1];
assert.ok(legacyExtensionId, "extension.ts must expose the guarded legacy extension ID");
const legacyPublisher = legacyExtensionId.split(".", 1)[0];
const privatePublisherAlias = new RegExp(legacyPublisher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const privateAbsoluteWorkspacePath = /(?:\/mnt\/pfs\/|[A-Za-z]:\\Users\\)/;

function publicMarkdownAndLicenses(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if ([".git", ".worktrees", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...publicMarkdownAndLicenses(absolutePath));
    } else if (entry.name.endsWith(".md") || entry.name === "LICENSE") {
      results.push(absolutePath);
    }
  }
  return results;
}

const languageNavigation = "[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)";

test("every advertised README language exists and shares the same navigation", () => {
  for (const relativePath of readmes) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    assert.equal(fs.existsSync(absolutePath), true, `${relativePath} is missing`);
    const contents = fs.readFileSync(absolutePath, "utf8");
    assert.equal(contents.split(/\r?\n/, 1)[0], languageNavigation, `${relativePath} language navigation differs`);
  }
});

test("translated READMEs retain install, safety, screenshots, and license links", () => {
  for (const relativePath of readmes.slice(1)) {
    const contents = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    assert.match(contents, /assets\/screenshots\/dashboard-en-dark\.png/);
    assert.match(contents, /assets\/screenshots\/dashboard-zh-light\.png/);
    assert.match(contents, /docs\/shared-history\.md/);
    assert.match(contents, /\.\/LICENSE/);
    assert.match(contents, /codex-switchbridge\.shareHistoryAcrossProviders/);
  }
});

test("installation READMEs use the replacement listing, VSIX name, and migration contract", () => {
  for (const relativePath of installReadmes) {
    const contents = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    const migrationHeading = migrationHeadings[relativePath];

    assert.ok(contents.includes(marketplaceItemUrl), `${relativePath}: direct Marketplace URL missing`);
    assert.doesNotMatch(contents, oldMarketplaceSearch, `${relativePath}: stale Marketplace search URL found`);
    assert.ok(contents.includes(vsixInstallCommand), `${relativePath}: new VSIX install command missing`);
    for (const oldVsixInstallCommand of oldVsixInstallCommands) {
      assert.ok(!contents.includes(oldVsixInstallCommand), `${relativePath}: old VSIX install command found`);
    }
    assert.ok(contents.includes(migrationHeading), `${relativePath}: migration heading missing`);

    const migrationStart = contents.indexOf(migrationHeading);
    const followingHeading = contents.slice(migrationStart + migrationHeading.length).search(/\n#{2,4} /);
    const migrationEnd = followingHeading === -1
      ? contents.length
      : migrationStart + migrationHeading.length + followingHeading;
    const migration = contents.slice(migrationStart, migrationEnd);
    for (const actionPattern of migrationActionPatterns[relativePath]) {
      assert.match(migration, actionPattern, `${relativePath}: migration action missing`);
    }
    for (const requiredTerm of ["Local", "CODEX_HOME", "globalState", "SecretStorage"]) {
      assert.ok(migration.includes(requiredTerm), `${relativePath}: migration omits ${requiredTerm}`);
    }
  }
});

test("public documentation and licenses omit the legacy publisher alias and private workspace paths", () => {
  for (const absolutePath of publicMarkdownAndLicenses(repositoryRoot)) {
    const relativePath = path.relative(repositoryRoot, absolutePath);
    const contents = fs.readFileSync(absolutePath, "utf8");
    assert.doesNotMatch(contents, privatePublisherAlias, `${relativePath} exposes the legacy publisher alias`);
    assert.doesNotMatch(contents, privateAbsoluteWorkspacePath, `${relativePath} exposes a private workspace path`);
  }
});
