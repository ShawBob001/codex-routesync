import * as vscode from "vscode";

export class DashboardLauncher implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly item: vscode.TreeItem;

  constructor() {
    this.item = new vscode.TreeItem("Open Dashboard", vscode.TreeItemCollapsibleState.None);
    this.item.iconPath = new vscode.ThemeIcon("open-preview");
    this.item.command = {
      command: "codex-switchbridge.openDashboard",
      title: "Open Dashboard",
    };
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    return item ? [] : [this.item];
  }
}
