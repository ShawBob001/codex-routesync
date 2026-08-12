import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const distDir = path.join(packageDir, "dist");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    extension: path.join(packageDir, "src", "extension.ts"),
    dashboardI18n: path.join(packageDir, "src", "dashboardI18n.ts"),
    dashboardModel: path.join(packageDir, "src", "dashboardModel.ts"),
    dashboardProtocol: path.join(packageDir, "src", "dashboardProtocol.ts"),
    dashboardViewProvider: path.join(packageDir, "src", "dashboardViewProvider.ts"),
    historyReconciliation: path.join(packageDir, "src", "historyReconciliation.ts"),
    providerProfile: path.join(packageDir, "src", "providerProfile.ts"),
    quotaStore: path.join(packageDir, "src", "quotaStore.ts"),
    tokenUsage: path.join(packageDir, "src", "tokenUsage.ts"),
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outdir: distDir,
  external: ["vscode"],
  sourcemap: watch,
  logLevel: "info",
};

const webviewDir = path.join(distDir, "webview");
const webviewOptions = {
  entryPoints: [path.join(packageDir, "webview", "dashboard.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: path.join(webviewDir, "dashboard.js"),
  sourcemap: watch,
  minify: !watch,
  logLevel: "info",
};

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(webviewDir, { recursive: true });
copyFileSync(
  path.join(packageDir, "webview", "dashboard.css"),
  path.join(webviewDir, "dashboard.css"),
);
const scriptsDir = path.join(distDir, "scripts");
mkdirSync(scriptsDir, { recursive: true });
copyFileSync(
  path.resolve(packageDir, "..", "..", "scripts", "migrate-history-provider.py"),
  path.join(scriptsDir, "migrate-history-provider.py"),
);

if (watch) {
  const [ctx, webviewCtx] = await Promise.all([context(options), context(webviewOptions)]);
  await Promise.all([ctx.watch(), webviewCtx.watch()]);
  console.log("Watching extension bundle...");
} else {
  await Promise.all([build(options), build(webviewOptions)]);
}
