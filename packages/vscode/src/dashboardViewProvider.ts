import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DashboardModel } from "./dashboardModel";
import {
  DashboardAction,
  DashboardClientMessage,
  parseDashboardClientMessage,
} from "./dashboardProtocol";

type MaybePromise = void | PromiseLike<void>;

export interface DashboardActionHandlers {
  refreshDashboard(): MaybePromise;
  switchMode(): MaybePromise;
  setAutoSwitch(enabled: boolean): MaybePromise;
  configureAutoSwitch(): MaybePromise;
  addAccount(): MaybePromise;
  addProvider(): MaybePromise;
  reloginAccount(targetId: string): MaybePromise;
  unlockStorage(targetId: string): MaybePromise;
  reloadWindow(): MaybePromise;
}

export interface DashboardViewProviderOptions<Model extends object = DashboardModel> {
  extensionUri: vscode.Uri;
  getModel(): Model;
  subscribe(listener: () => void): vscode.Disposable;
  getTargetIds(model: Model): readonly string[];
  getFreshTargetIds(): readonly string[];
  handlers: DashboardActionHandlers;
  onActionError?: (action: DashboardAction) => void;
}

export interface DashboardHostMessage<Model extends object = DashboardModel> {
  type: "dashboard.state";
  revision: number;
  state: Model;
}

export class DashboardViewProvider<Model extends object = DashboardModel>
implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly sourceSubscription: vscode.Disposable;
  private view: vscode.WebviewView | null = null;
  private viewSubscriptions: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private dirty = true;
  private postQueued = false;
  private revision = 0;

  constructor(private readonly options: DashboardViewProviderOptions<Model>) {
    this.sourceSubscription = options.subscribe(() => this.invalidate());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.releaseView();
    this.view = view;
    this.ready = false;
    this.dirty = true;

    const resourceRoot = vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [resourceRoot],
    };
    view.webview.html = renderHtml(view.webview, resourceRoot);
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage((value) => this.receive(value)),
      view.onDidChangeVisibility(() => {
        if (view === this.view && view.visible && this.ready && this.dirty) {
          this.queuePost();
        }
      }),
      view.onDidDispose(() => {
        if (view === this.view) this.releaseView();
      }),
    ];
  }

  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.ready && this.view?.visible) this.queuePost();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sourceSubscription.dispose();
    this.releaseView();
  }

  private receive(value: unknown): void {
    if (this.disposed || !this.view) return;
    const message = parseDashboardClientMessage(value);
    if (!message) return;
    if (message.type === "dashboard.ready") {
      if (this.ready) return;
      this.ready = true;
      this.dirty = true;
      if (this.view.visible) this.queuePost();
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: Exclude<DashboardClientMessage, { type: "dashboard.ready" }>): void {
    const { handlers } = this.options;
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
      case "reloadWindow": result = handlers.reloadWindow(); break;
    }
    Promise.resolve(result).catch(() => this.options.onActionError?.(message.action));
  }

  private queuePost(): void {
    if (this.postQueued) return;
    this.postQueued = true;
    queueMicrotask(() => {
      this.postQueued = false;
      if (this.disposed || !this.ready || !this.view?.visible || !this.dirty) return;
      this.dirty = false;
      const message: DashboardHostMessage<Model> = {
        type: "dashboard.state",
        revision: ++this.revision,
        state: this.options.getModel(),
      };
      void this.view.webview.postMessage(message);
    });
  }

  private releaseView(): void {
    for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose();
    this.view = null;
    this.ready = false;
    this.dirty = true;
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
