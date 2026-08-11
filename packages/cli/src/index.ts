#!/usr/bin/env node

import { Command } from "commander";
import { setDiagnosticLogOptions, setNamedAuthDir, setSavedAuthPassphrase } from "@codex-switchbridge/core";
import {
  cmdList,
  cmdAdd,
  cmdRemove,
  cmdUse,
  cmdQuota,
  cmdCurrent,
  cmdRefresh,
  cmdExport,
  cmdImport,
  cmdMode,
} from "./commands";
import { initializeCliDiagnosticLogging } from "./log";

const program = new Command();

initializeCliDiagnosticLogging();

program
  .name("codex-switchbridge")
  .description(
    "Seamlessly switch between Codex accounts and Responses API providers with shared local conversation history"
  )
  .version("0.2.0");

program
  .option("--auth-dir <path>", "Directory for saving and loading auth_{name}.json files; defaults to the Codex config directory")
  .option("--password <password>", "Password to decrypt encrypted saved accounts; can also be set via CODEX_SWITCHBRIDGE_PASSWORD env var")
  .option("--debug", "Write diagnostic performance logs to the Codex SwitchBridge CLI log file", false);

program.hook("preAction", () => {
  const opts = program.opts<{ authDir?: string; password?: string; debug?: boolean }>();
  setNamedAuthDir(opts.authDir);
  setDiagnosticLogOptions({ detailedPerformanceLogging: opts.debug === true });
  const password = opts.password || process.env.CODEX_SWITCHBRIDGE_PASSWORD;
  if (password) {
    setSavedAuthPassphrase(password);
  }
});

program
  .command("list")
  .aliases(["ls"])
  .description("List all saved accounts")
  .action(() => cmdList());

program
  .command("add <name>")
  .description("Run codex login and save the account")
  .option("--device-auth", "Use codex login --device-auth. Requires enabling device code authorization in ChatGPT Security Settings.", false)
  .action(async (name: string, opts?: { deviceAuth?: boolean }) => cmdAdd(name, opts));

program
  .command("remove <name>")
  .aliases(["rm", "del"])
  .description("Remove a saved account")
  .action((name: string) => cmdRemove(name));

program
  .command("use <name>")
  .aliases(["switch"])
  .description("Switch to a saved Codex account")
  .action((name: string) => cmdUse(name));

program
  .command("mode [name]")
  .description("Show or switch between Codex account and API provider modes")
  .option(
    "--separate-history",
    "Use a separate local conversation history for this provider instead of the shared account/API history",
    false
  )
  .action(async (name?: string, opts?: { separateHistory?: boolean }) => cmdMode(name, opts));

program
  .command("quota [name]")
  .aliases(["info", "status"])
  .description("Show account quota usage")
  .action(async (name?: string) => cmdQuota(name));

program
  .command("current")
  .description("Show the current active account or mode")
  .action(() => cmdCurrent());

program
  .command("refresh [name]")
  .description("Refresh the account access token")
  .action(async (name?: string) => cmdRefresh(name));

program
  .command("export [file]")
  .description("Export accounts to a JSON file")
  .option("-n, --names <names...>", "Export only the specified accounts")
  .action((file?: string, opts?: { names?: string[] }) => cmdExport(file, opts?.names));

program
  .command("import <file>")
  .description("Import accounts from a JSON file")
  .option("--overwrite", "Overwrite existing accounts with the same name", false)
  .action(async (file: string, opts?: { overwrite?: boolean }) => cmdImport(file, opts?.overwrite));

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
