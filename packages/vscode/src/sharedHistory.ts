import * as vscode from "vscode";
import { SharedHistorySwitchOptions } from "@codex-switchbridge/core";

export function shareHistoryAcrossProviders(): boolean {
  return vscode.workspace
    .getConfiguration("codex-switchbridge")
    .get<boolean>("shareHistoryAcrossProviders", true);
}

export function providerSwitchOptions(source: string, target: string): SharedHistorySwitchOptions {
  return {
    shareHistoryAcrossProviders: shareHistoryAcrossProviders(),
    source,
    target,
  };
}
