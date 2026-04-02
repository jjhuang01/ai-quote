import * as vscode from 'vscode';
import { EchoBridgeServer } from '../core/bridge';
import { EchoLogger } from '../core/logger';
import type { HistoryManager } from '../core/history';
import type { QueueManager } from '../core/queue';
import type { AccountManager } from '../core/account';
import type { FeedbackManager } from '../core/feedback';
import { buildWebviewHtml } from './view-html';

export class EchoSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'infiniteDialogView';
  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: EchoBridgeServer,
    private readonly logger: EchoLogger,
    private readonly historyManager: HistoryManager,
    private readonly queueManager: QueueManager,
    private readonly accountManager: AccountManager,
    private readonly feedbackManager: FeedbackManager
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    this.render();

    webviewView.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });
  }

  public refresh(): void {
    this.render();
  }

  public reveal(): void {
    this.view?.show?.(true);
  }

  public postState(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'status',
      value: this.bridge.getStatus()
    });
  }

  public postHistory(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'history',
      value: this.historyManager.getAll()
    });
  }

  public postQueue(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'queue',
      value: this.queueManager.getAll()
    });
  }

  public postFeedback(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'feedback',
      value: this.feedbackManager.getAll()
    });
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = buildWebviewHtml(
      this.view.webview,
      this.extensionUri,
      this.bridge.getStatus(),
      this.logger.getLogFilePath(),
      this.historyManager.getAll(),
      this.queueManager.getAll(),
      this.accountManager.getAll(),
      this.feedbackManager.getAll()
    );
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    const action = Reflect.get(message, 'type');
    
    if (action === 'refresh') {
      this.refresh();
      this.postState();
      return;
    }

    if (action === 'testFeedback') {
      await this.bridge.injectTestFeedback();
      this.postState();
      return;
    }

    if (action === 'openLogFile') {
      const uri = vscode.Uri.file(this.logger.getLogFilePath());
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }

    if (action === 'clearQueue') {
      await this.queueManager.clearCompleted();
      this.postQueue();
      return;
    }

    if (action === 'clearHistory') {
      await this.historyManager.clear();
      this.postHistory();
      return;
    }

    this.logger.debug('Unhandled webview message.', { message });
  }
}
