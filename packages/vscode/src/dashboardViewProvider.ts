import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DashboardModel } from "./dashboardModel";
import {
  DashboardAction,
  DashboardActionMessage,
  parseDashboardClientMessage,
} from "./dashboardProtocol";
import type { DashboardLocaleEnvelope, LanguagePreference } from "./dashboardI18n";

type MaybePromise = void | PromiseLike<void>;

export interface DashboardActionHandlers {
  refreshDashboard(): MaybePromise;
  switchMode(): MaybePromise;
  setAutoSwitch(enabled: boolean): MaybePromise;
  configureAutoSwitch(): MaybePromise;
  addAccount(): MaybePromise;
  addProvider(): MaybePromise;
  useRateLimitReset(): MaybePromise;
  reloginAccount(targetId: string): MaybePromise;
  unlockStorage(targetId: string): MaybePromise;
  reloadWindow(): MaybePromise;
}

export interface DashboardViewProviderOptions<Model extends object = DashboardModel> {
  extensionUri: vscode.Uri;
  getModel(): Model;
  getLocale(): DashboardLocaleEnvelope;
  setLanguagePreference(preference: LanguagePreference): MaybePromise;
  subscribe(listener: () => void): vscode.Disposable;
  getTargetIds(model: Model): readonly string[];
  getFreshTargetIds(): readonly string[];
  handlers: DashboardActionHandlers;
  onActionError?: (action: DashboardAction) => void;
  onLocaleError?: () => void;
  onModelError?: () => void;
  shouldRefreshVisibleModel?: (model: Model) => boolean;
  requestVisibleRefresh?: () => MaybePromise;
}

export interface DashboardHostMessage<Model extends object = DashboardModel> {
  type: "dashboard.state";
  revision: number;
  state: Model;
  locale: DashboardLocaleEnvelope;
}

export class DashboardViewProvider<Model extends object = DashboardModel>
implements vscode.Disposable {
  private readonly sourceSubscription: vscode.Disposable;
  private panel: vscode.WebviewPanel | null = null;
  private panelSubscriptions: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private dirty = true;
  private postQueued = false;
  private deliveryRetryUsed = false;
  private visibleRefreshRequested = false;
  private revision = 0;

  constructor(private readonly options: DashboardViewProviderOptions<Model>) {
    this.sourceSubscription = options.subscribe(() => this.invalidate());
  }

  show(): void {
    if (this.disposed) return;
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const resourceRoot = vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "codexSwitchBridge.dashboard",
      "Codex SwitchBridge",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        localResourceRoots: [resourceRoot],
        enableFindWidget: true,
        retainContextWhenHidden: false,
      },
    );
    this.panel = panel;
    this.ready = false;
    this.dirty = true;
    this.deliveryRetryUsed = false;
    this.visibleRefreshRequested = false;
    this.panelSubscriptions = [
      panel.webview.onDidReceiveMessage((value) => this.receive(value)),
      panel.onDidChangeViewState(() => {
        if (panel !== this.panel || panel.visible) return;
        this.ready = false;
        this.dirty = true;
        this.deliveryRetryUsed = false;
        this.visibleRefreshRequested = false;
      }),
      panel.onDidDispose(() => {
        if (panel === this.panel) this.releasePanel();
      }),
    ];
    panel.webview.html = renderHtml(panel.webview, resourceRoot);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.deliveryRetryUsed = false;
    if (this.ready && this.panel?.visible) this.queuePost();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sourceSubscription.dispose();
    const panel = this.panel;
    this.releasePanel();
    panel?.dispose();
  }

  private receive(value: unknown): void {
    if (this.disposed || !this.panel) return;
    const message = parseDashboardClientMessage(value);
    if (!message) return;
    if (message.type === "dashboard.ready") {
      this.ready = true;
      this.dirty = true;
      this.deliveryRetryUsed = false;
      if (this.panel.visible) this.queuePost();
      return;
    }
    if (message.type === "dashboard.locale.set") {
      this.setLanguagePreference(message.preference);
      return;
    }
    if (message.type === "dashboard.action") this.dispatch(message);
  }

  private setLanguagePreference(preference: LanguagePreference): void {
    try {
      Promise.resolve(this.options.setLanguagePreference(preference)).then(
        () => this.invalidate(),
        () => this.options.onLocaleError?.(),
      );
    } catch {
      this.options.onLocaleError?.();
    }
  }

  private dispatch(message: DashboardActionMessage): void {
    const { handlers } = this.options;
    try {
      let result: MaybePromise;
      switch (message.action) {
        case "setAutoSwitch":
          result = handlers.setAutoSwitch(message.enabled);
          break;
        case "reloginAccount":
        case "unlockStorage": {
          const allowedTargets = new Set(this.options.getTargetIds(this.options.getModel()));
          const freshTargets = new Set(this.options.getFreshTargetIds());
          if (!allowedTargets.has(message.targetId) || !freshTargets.has(message.targetId)) return;
          result = message.action === "reloginAccount"
            ? handlers.reloginAccount(message.targetId)
            : handlers.unlockStorage(message.targetId);
          break;
        }
        case "refreshDashboard": result = handlers.refreshDashboard(); break;
        case "switchMode": result = handlers.switchMode(); break;
        case "configureAutoSwitch": result = handlers.configureAutoSwitch(); break;
        case "addAccount": result = handlers.addAccount(); break;
        case "addProvider": result = handlers.addProvider(); break;
        case "useRateLimitReset": result = handlers.useRateLimitReset(); break;
        case "reloadWindow": result = handlers.reloadWindow(); break;
      }
      Promise.resolve(result).catch(() => this.handleActionFailure(message.action));
    } catch {
      this.handleActionFailure(message.action);
    }
  }

  private queuePost(): void {
    if (this.postQueued) return;
    this.postQueued = true;
    queueMicrotask(() => {
      this.postQueued = false;
      if (this.disposed || !this.ready || !this.panel?.visible || !this.dirty) return;
      let state: Model;
      let locale: DashboardLocaleEnvelope;
      try {
        state = this.options.getModel();
      } catch {
        this.dirty = true;
        this.options.onModelError?.();
        return;
      }
      try {
        locale = this.options.getLocale();
      } catch {
        this.dirty = true;
        this.options.onLocaleError?.();
        return;
      }
      this.dirty = false;
      const message: DashboardHostMessage<Model> = {
        type: "dashboard.state",
        revision: ++this.revision,
        state,
        locale,
      };
      const targetPanel = this.panel;
      Promise.resolve(targetPanel.webview.postMessage(message)).then(
        (delivered) => this.handleDelivery(targetPanel, delivered),
        () => this.handleDelivery(targetPanel, false),
      );
      this.maybeRequestVisibleRefresh(state);
    });
  }

  private handleDelivery(panel: vscode.WebviewPanel, delivered: boolean): void {
    if (this.disposed || panel !== this.panel) return;
    if (delivered) {
      this.deliveryRetryUsed = false;
      if (this.dirty && panel.visible) this.queuePost();
      return;
    }
    this.dirty = true;
    if (!this.deliveryRetryUsed && this.ready && panel.visible) {
      this.deliveryRetryUsed = true;
      this.queuePost();
    }
  }

  private handleActionFailure(action: DashboardAction): void {
    this.options.onActionError?.(action);
    this.invalidate();
  }

  private maybeRequestVisibleRefresh(model: Model): void {
    const shouldRefresh = this.options.shouldRefreshVisibleModel?.(model) ?? false;
    if (!shouldRefresh) {
      this.visibleRefreshRequested = false;
      return;
    }
    if (this.visibleRefreshRequested || !this.options.requestVisibleRefresh) return;
    this.visibleRefreshRequested = true;
    try {
      Promise.resolve(this.options.requestVisibleRefresh()).catch(() => {
        this.visibleRefreshRequested = false;
      });
    } catch {
      this.visibleRefreshRequested = false;
    }
  }

  private releasePanel(): void {
    for (const subscription of this.panelSubscriptions.splice(0)) subscription.dispose();
    this.panel = null;
    this.ready = false;
    this.dirty = true;
    this.deliveryRetryUsed = false;
    this.visibleRefreshRequested = false;
  }
}

function renderHtml(webview: vscode.Webview, resourceRoot: vscode.Uri): string {
  const nonce = randomBytes(18).toString("base64url");
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, "dashboard.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, "dashboard.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${cssUri}">
  <title>Codex SwitchBridge</title>
</head>
<body>
  <a class="skip-link" href="#app">Skip to dashboard</a>
  <main id="app" tabindex="-1"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
