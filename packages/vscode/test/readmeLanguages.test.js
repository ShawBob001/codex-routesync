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
const marketplaceSearch = /marketplace\.visualstudio\.com\/search\?sortBy=Relevance&term=Codex%20SwitchBridge&target=VSCode/;
const extensionPublisher = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "packages/vscode/package.json"), "utf8"),
).publisher;
const privatePublisherAlias = new RegExp(extensionPublisher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
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
    assert.match(contents, marketplaceSearch);
    assert.doesNotMatch(contents, privatePublisherAlias);
    assert.match(contents, /assets\/screenshots\/dashboard-en-dark\.png/);
    assert.match(contents, /assets\/screenshots\/dashboard-zh-light\.png/);
    assert.match(contents, /docs\/shared-history\.md/);
    assert.match(contents, /\.\/LICENSE/);
    assert.match(contents, /codex-switchbridge\.shareHistoryAcrossProviders/);
  }
});

test("public documentation and licenses omit the extension publisher ID and private workspace paths", () => {
  for (const absolutePath of publicMarkdownAndLicenses(repositoryRoot)) {
    const relativePath = path.relative(repositoryRoot, absolutePath);
    const contents = fs.readFileSync(absolutePath, "utf8");
    assert.doesNotMatch(contents, privatePublisherAlias, `${relativePath} exposes the publisher alias`);
    assert.doesNotMatch(contents, privateAbsoluteWorkspacePath, `${relativePath} exposes a private workspace path`);
  }

  assert.match(
    fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8"),
    marketplaceSearch,
  );
  assert.match(
    fs.readFileSync(path.join(repositoryRoot, "packages/vscode/README.md"), "utf8"),
    marketplaceSearch,
  );
});
