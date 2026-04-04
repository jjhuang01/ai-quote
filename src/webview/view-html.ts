import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { WebviewBootstrap } from '../core/contracts';

export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bootstrap: WebviewBootstrap,
  logPath: string
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.css'));
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Quote</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      window.__QUOTE_BOOTSTRAP__ = ${safeJsonForScript({ ...bootstrap, logPath })};
    </script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  return randomBytes(16).toString('hex');
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
