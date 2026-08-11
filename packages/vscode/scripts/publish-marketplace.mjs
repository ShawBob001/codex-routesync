import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  readFileSync(path.join(packageDir, "package.json"), "utf8"),
);
const vsixName = `${packageJson.name}-${packageJson.version}.vsix`;
const vsixPath = path.join(packageDir, vsixName);

if (!existsSync(vsixPath)) {
  throw new Error(`Expected packaged extension at ${vsixPath}`);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npx,
  [
    "--yes",
    "@vscode/vsce@3.9.2",
    "publish",
    "--packagePath",
    vsixPath,
  ],
  {
    cwd: packageDir,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
