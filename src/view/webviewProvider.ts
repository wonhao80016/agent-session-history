import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { HostMessage, parseWebviewMessage, ViewState, WebviewMessage } from '../protocol';

export class SessionWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private state: ViewState | undefined;
  private pendingFocusSearch = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: WebviewMessage) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message) {
        return;
      }
      // The page is rebuilt each time the view is shown again, so every load announces itself and needs the state.
      if (message.type === 'ready') {
        this.ready = true;
        this.flush();
      }
      this.onMessage(message);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  update(state: ViewState): void {
    this.state = state;
    this.flush();
  }

  focusSearch(): void {
    this.pendingFocusSearch = true;
    this.flush();
  }

  private flush(): void {
    if (!this.view || !this.ready) {
      return;
    }
    if (this.state) {
      this.post({ type: 'state', state: this.state });
    }
    if (this.pendingFocusSearch) {
      this.pendingFocusSearch = false;
      this.post({ type: 'focusSearch' });
    }
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Agent Session History</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
