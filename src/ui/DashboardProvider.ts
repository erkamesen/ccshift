import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { AccountView } from './viewModel';

// Sidebar webview. Strict CSP, nonce script, textContent only, messages validated.

export interface DashboardState {
  accounts: AccountView[];
  notices: { level: 'info' | 'warning'; text: string }[];
  workspaceName?: string;
}

const ACTIONS = [
  'switch',
  'refresh',
  'refreshAll',
  'add',
  'rename',
  'reauth',
  'remove',
  'setDefault',
  'setWorkspace',
  'diagnose',
  'collector',
] as const;
type Action = (typeof ACTIONS)[number];

export type DashboardHandler = (action: Action, profileId: string | undefined) => void;

export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'ccshift.dashboard';
  private view?: vscode.WebviewView;
  private state?: DashboardState;
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly buildState: () => DashboardState,
    private readonly handler: DashboardHandler,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg)),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.refresh();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );
    // Keep countdowns and "updated ... ago" current while visible.
    this.timer = setInterval(() => {
      if (this.view?.visible) {
        this.refresh();
      }
    }, 30_000);
    this.refresh();
  }

  refresh(): void {
    if (!this.view) {
      return;
    }
    this.state = this.buildState();
    void this.view.webview.postMessage({ type: 'state', state: this.state });
  }

  private onMessage(msg: unknown): void {
    if (msg === null || typeof msg !== 'object') {
      return;
    }
    const m = msg as { type?: unknown; action?: unknown; id?: unknown };
    if (m.type === 'ready') {
      this.refresh();
      return;
    }
    if (m.type !== 'action' || typeof m.action !== 'string' || !(ACTIONS as readonly string[]).includes(m.action)) {
      return;
    }
    let id: string | undefined;
    if (m.id !== undefined) {
      if (typeof m.id !== 'string' || !this.state?.accounts.some((a) => a.id === m.id)) {
        return;
      }
      id = m.id;
    }
    this.handler(m.action as Action, id);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "img-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>ccshift</title>
</head>
<body>
<div id="notices" role="status"></div>
<div id="accounts" aria-live="polite"></div>
<div id="empty" hidden>Loading accounts…</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
