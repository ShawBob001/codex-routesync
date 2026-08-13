import * as vscode from "vscode";
import {
  AccountDetailItem,
  AccountGroupItem,
  AccountTreeItem,
  AccountTreeNode,
  AccountTreeProvider,
} from "./accountTree";
import {
  ProviderDetailItem,
  ProviderTreeItem,
  ProviderTreeNode,
  ProviderTreeProvider,
} from "./providerTree";

export type RoutesGroupKind = "accounts" | "providers";
export type RoutesTreeNode = RoutesGroupItem | AccountTreeNode | ProviderTreeNode;
export type RoutesTreeLocale = "en" | "zh-cn";

interface RoutesGroupPresentation {
  label: string;
  description: string;
  icon: string;
}

const GROUP_PRESENTATION: Record<RoutesTreeLocale, Record<RoutesGroupKind, RoutesGroupPresentation>> = {
  en: {
    accounts: {
      label: "Accounts",
      description: "Codex sign-ins",
      icon: "accounts-view-bar-icon",
    },
    providers: {
      label: "API Providers",
      description: "Responses-compatible APIs",
      icon: "plug",
    },
  },
  "zh-cn": {
    accounts: {
      label: "账号",
      description: "Codex 登录身份",
      icon: "accounts-view-bar-icon",
    },
    providers: {
      label: "API 提供商",
      description: "兼容 Responses 的 API",
      icon: "plug",
    },
  },
};

export class RoutesGroupItem extends vscode.TreeItem {
  constructor(
    public readonly kind: RoutesGroupKind,
    label: string,
    description: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `routesGroup:${kind}`;
    this.contextValue = `routesGroup.${kind}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

function isAccountNode(element: RoutesTreeNode): element is AccountTreeNode {
  return element instanceof AccountGroupItem
    || element instanceof AccountTreeItem
    || element instanceof AccountDetailItem;
}

function isProviderNode(element: RoutesTreeNode): element is ProviderTreeNode {
  return element instanceof ProviderTreeItem || element instanceof ProviderDetailItem;
}

export class RoutesTreeProvider
implements vscode.TreeDataProvider<RoutesTreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RoutesTreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly delegateSubscriptions: vscode.Disposable[];
  private groups: Record<RoutesGroupKind, RoutesGroupItem>;

  constructor(
    private readonly accountTree: AccountTreeProvider,
    private readonly providerTree: ProviderTreeProvider,
    private readonly getLocale: () => RoutesTreeLocale,
  ) {
    this.groups = this.createGroups();
    this.delegateSubscriptions = [
      this.accountTree.onDidChangeTreeData(() => this.onDidChangeTreeDataEmitter.fire(undefined)),
      this.providerTree.onDidChangeTreeData(() => this.onDidChangeTreeDataEmitter.fire(undefined)),
    ];
  }

  refreshLocale(): void {
    this.groups = this.createGroups();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: RoutesTreeNode): vscode.TreeItem {
    if (element instanceof RoutesGroupItem) return element;
    if (isAccountNode(element)) return this.accountTree.getTreeItem(element);
    return this.providerTree.getTreeItem(element);
  }

  getChildren(element?: RoutesTreeNode): RoutesTreeNode[] {
    if (!element) return [this.groups.accounts, this.groups.providers];
    if (element instanceof RoutesGroupItem) {
      return element.kind === "accounts"
        ? this.accountTree.getChildren()
        : this.providerTree.getChildren();
    }
    if (isAccountNode(element)) return this.accountTree.getChildren(element);
    if (isProviderNode(element)) return this.providerTree.getChildren(element);
    return [];
  }

  getParent(element: RoutesTreeNode): RoutesTreeNode | undefined {
    if (element instanceof RoutesGroupItem) return undefined;
    if (isAccountNode(element)) {
      return this.accountTree.getParent(element) ?? this.groups.accounts;
    }
    if (isProviderNode(element)) {
      return this.providerTree.getParent(element) ?? this.groups.providers;
    }
    return undefined;
  }

  dispose(): void {
    for (const subscription of this.delegateSubscriptions) subscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private createGroups(): Record<RoutesGroupKind, RoutesGroupItem> {
    const locale = this.getLocale();
    const create = (kind: RoutesGroupKind) => {
      const presentation = GROUP_PRESENTATION[locale][kind];
      return new RoutesGroupItem(
        kind,
        presentation.label,
        presentation.description,
        presentation.icon,
      );
    };
    return {
      accounts: create("accounts"),
      providers: create("providers"),
    };
  }
}
