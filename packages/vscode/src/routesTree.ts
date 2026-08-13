import * as vscode from "vscode";
import {
  AccountDetailItem,
  AccountTreeItem,
  AccountTreeProvider,
} from "./accountTree";
import {
  ProviderDetailItem,
  ProviderTreeItem,
  ProviderTreeProvider,
} from "./providerTree";

export type RoutesTreeNode = AccountTreeItem | AccountDetailItem | ProviderTreeItem | ProviderDetailItem;
export type RoutesTreeLocale = "en" | "zh-cn";

function isAccountNode(element: RoutesTreeNode): element is AccountTreeItem | AccountDetailItem {
  return element instanceof AccountTreeItem || element instanceof AccountDetailItem;
}

function isProviderNode(element: RoutesTreeNode): element is ProviderTreeItem | ProviderDetailItem {
  return element instanceof ProviderTreeItem || element instanceof ProviderDetailItem;
}

export class RoutesTreeProvider
implements vscode.TreeDataProvider<RoutesTreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RoutesTreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly delegateSubscriptions: vscode.Disposable[];

  constructor(
    private readonly accountTree: AccountTreeProvider,
    private readonly providerTree: ProviderTreeProvider,
    _getLocale: () => RoutesTreeLocale,
  ) {
    this.delegateSubscriptions = [
      this.accountTree.onDidChangeTreeData(() => this.onDidChangeTreeDataEmitter.fire(undefined)),
      this.providerTree.onDidChangeTreeData(() => this.onDidChangeTreeDataEmitter.fire(undefined)),
    ];
  }

  refreshLocale(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: RoutesTreeNode): vscode.TreeItem {
    if (isAccountNode(element)) return this.accountTree.getTreeItem(element);
    return this.providerTree.getTreeItem(element);
  }

  getChildren(element?: RoutesTreeNode): RoutesTreeNode[] {
    if (!element) {
      const accounts = this.accountTree.getRootItems().flatMap((group) => group.children);
      const providers = this.providerTree.getRootItems();
      return [...accounts, ...providers];
    }
    if (isAccountNode(element)) return this.accountTree.getChildren(element);
    if (isProviderNode(element)) return this.providerTree.getChildren(element);
    return [];
  }

  getParent(element: RoutesTreeNode): RoutesTreeNode | undefined {
    if (element instanceof AccountDetailItem) {
      return this.accountTree.getParent(element) as AccountTreeItem | undefined;
    }
    if (element instanceof ProviderDetailItem) {
      return this.providerTree.getParent(element) as ProviderTreeItem | undefined;
    }
    return undefined;
  }

  dispose(): void {
    for (const subscription of this.delegateSubscriptions) subscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}
