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
    assert.match(contents, /marketplace\.visualstudio\.com\/items\?itemName=baoshichao001-dev\.codex-switchbridge/);
    assert.match(contents, /assets\/screenshots\/dashboard-en-dark\.png/);
    assert.match(contents, /assets\/screenshots\/dashboard-zh-light\.png/);
    assert.match(contents, /docs\/shared-history\.md/);
    assert.match(contents, /\.\/LICENSE/);
    assert.match(contents, /codex-switchbridge\.shareHistoryAcrossProviders/);
  }
});
