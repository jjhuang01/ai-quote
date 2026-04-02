import * as vscode from 'vscode';
import type { EchoBridgeStatus, HistoryItem, QueueItem, AccountInfo, FeedbackItem } from '../core/contracts';

export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  status: EchoBridgeStatus,
  logPath: string,
  history: HistoryItem[] = [],
  queue: QueueItem[] = [],
  accounts: AccountInfo[] = [],
  feedback: FeedbackItem[] = []
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.css'));
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>AI Echo</title>
  </head>
  <body data-port="${status.port}" data-ide="${status.currentIde}" data-tool-name="${status.toolName}" data-log-path="${escapeHtml(logPath)}">
    <div id="app"></div>
    <script nonce="${nonce}">
      window.__AI_ECHO_BOOTSTRAP__ = ${JSON.stringify({ status, logPath, history, queue, accounts, feedback })};
    </script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
