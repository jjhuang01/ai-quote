import * as vscode from 'vscode';
import type { QuoteBridge } from '../core/bridge';
import type { QuoteLogger } from '../core/logger';
import {
  getSwitchWarmupMode,
  getSwitchWarmupSuccessMessage,
  isSwitchWarmupEnabled,
} from '../core/config';
import type { DataManager } from '../core/data-manager';
import type { WebviewBootstrap } from '../core/contracts';
import { buildWebviewHtml } from './view-html';
import { QuoteDialogPanel } from './dialog-panel';
import { WindsurfPatchService } from '../adapters/windsurf-patch';

export type RotateMcpNameCallback = () => Promise<{ newName: string } | undefined>;

type AccountDeleteBatchResult =
  | { success: true; removed: number; message: string }
  | { success: false; canceled: true; message: string }
  | { success: false; message: string };


export class QuoteSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'quoteView';
  private view?: vscode.WebviewView;
  private responseQueue: string[] = [];
  private bootstrapTimer?: ReturnType<typeof setTimeout>;
  private rotateMcpName?: RotateMcpNameCallback;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: QuoteBridge,
    private readonly logger: QuoteLogger,
    private readonly dataManager: DataManager,
    private readonly context: vscode.ExtensionContext
  ) {
    // Restore persisted queue
    this.responseQueue = this.context.globalState.get<string[]>('responseQueue', []);
    this.dataManager.windsurfAccounts.onDidChangeAccounts(() => {
      void this.postAccountsSync();
    });
  }

  public setRotateMcpNameCallback(cb: RotateMcpNameCallback): void {
    this.rotateMcpName = cb;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };

    void this.renderAsync().catch(err => {
      this.logger.error('Failed to render webview.', { error: String(err) });
      webviewView.webview.html = `<!DOCTYPE html><html><body><p>加载失败，请点击刷新按钮重试。</p></body></html>`;
    });

    const msgDisposable = webviewView.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      msgDisposable.dispose();
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.focusAccountTab();
        void this.revalidateAccounts();
      }
    });
  }

  public refresh(): void {
    void this.renderAsync();
  }

  public reveal(): void {
    this.view?.show?.(true);
  }

  public isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  private focusAccountTab(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'selectTab', value: 'account' });
  }

  public postPendingDialog(req: import('../core/contracts').McpDialogRequest): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'mcpDialog', value: req });
  }

  public getQueueCount(): number {
    return this.responseQueue.length;
  }

  /** Get a copy of current queue items. */
  public getQueueItems(): string[] {
    return [...this.responseQueue];
  }

  /** Add items to the queue from external sources (e.g. dialog panel). */
  public addToQueue(items: string[]): void {
    this.responseQueue.push(...items);
    this.persistAndNotifyQueue();
  }

  /** Replace entire queue (from dialog panel CRUD operations). */
  public replaceQueue(items: string[]): void {
    this.responseQueue.length = 0;
    this.responseQueue.push(...items);
    this.persistAndNotifyQueue();
  }

  private persistAndNotifyQueue(): void {
    void this.context.globalState.update('responseQueue', this.responseQueue);
    if (this.view) {
      void this.view.webview.postMessage({ type: 'queueUpdated', value: this.responseQueue });
    }
  }

  public postBootstrap(): void {
    if (!this.view) return;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = undefined;
      void this._doPostBootstrap();
    }, 150);
  }

  private async revalidateAccounts(): Promise<void> {
    const changed = await this.dataManager.windsurfAccounts.reloadFromDisk();
    if (changed) {
      await this.postAccountsSync();
    }
  }

  private async buildAccountsPayload(options?: { preferFastCurrentId?: boolean }): Promise<Pick<WebviewBootstrap, 'accounts' | 'currentAccountId' | 'autoSwitch' | 'quotaSnapshots' | 'quotaFetching' | 'quotaFetchingAll' | 'quotaFetchingIds' | 'lastAutoSwitchResult'>> {
    const accounts = this.dataManager.windsurfAccounts.getAll().map(a => ({
      ...a,
      password: '***'
    }));

    const wa = this.dataManager.windsurfAccounts as unknown as {
      getDisplayCurrentAccountId?: () => Promise<string | undefined>;
      getImmediateCurrentAccountId?: () => string | undefined;
      getRealCurrentAccountId?: () => Promise<string | undefined>;
      getCurrentAccountId?: () => string | undefined;
    };
    const currentAccountId = options?.preferFastCurrentId
      ? wa.getImmediateCurrentAccountId?.() ?? wa.getCurrentAccountId?.()
      : wa.getDisplayCurrentAccountId
        ? await wa.getDisplayCurrentAccountId()
        : wa.getRealCurrentAccountId
        ? await wa.getRealCurrentAccountId()
        : wa.getCurrentAccountId?.();

    const getRemain = (acc: typeof accounts[number]): number => {
      const rq = acc.realQuota;
      if (rq) {
        if (rq.dailyRemainingPercent >= 0) return rq.dailyRemainingPercent;
        if (rq.remainingMessages > 0) return 50 + Math.min(50, rq.remainingMessages);
        return 50;
      }
      if (!acc.quota || acc.quota.dailyLimit === 0) return 50;
      const used = acc.quota.dailyUsed;
      const limit = acc.quota.dailyLimit;
      return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
    };

    accounts.sort((a, b) => {
      if (a.id === currentAccountId) return -1;
      if (b.id === currentAccountId) return 1;
      const diff = getRemain(b) - getRemain(a);
      if (diff !== 0) return diff;
      return (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
    });

    return {
      accounts,
      autoSwitch: this.dataManager.windsurfAccounts.getAutoSwitchConfig(),
      currentAccountId,
      quotaSnapshots: this.dataManager.windsurfAccounts.getQuotaSnapshots(),
      quotaFetching: this.dataManager.windsurfAccounts.isQuotaFetching,
      quotaFetchingAll: this.dataManager.windsurfAccounts.isQuotaFetchingAll,
      quotaFetchingIds: this.dataManager.windsurfAccounts.getQuotaFetchingAccountIds?.() ?? [],
      lastAutoSwitchResult: this.dataManager.windsurfAccounts.getLastAutoSwitchResult?.(),
    };
  }

  private runQuotaFetchInBackground(options: {
    accountId?: string;
    reason: 'manual-refresh' | 'switch-warmup';
  }): void {
    const { accountId, reason } = options;
    const requestedAt = Date.now();
    const account = accountId
      ? this.dataManager.windsurfAccounts.getById(accountId)
      : undefined;
    this.logger.info('Quota refresh requested.', {
      operation: 'quota.refresh.request',
      accountId,
      email: account?.email,
      reason,
    });
    if (accountId) {
      void this.view?.webview.postMessage({
        type: 'quotaFetchStarted',
        value: { accountId, reason },
      });
    } else {
      const accountIds = this.dataManager.windsurfAccounts
        .getAll()
        .map((account) => account.id);
      void this.view?.webview.postMessage({
        type: 'quotaFetchAllStarted',
        value: { accountIds, reason },
      });
    }

    void this.postAccountsSync({ preferFastCurrentId: true });

    const task = accountId
      ? this.dataManager.windsurfAccounts.fetchRealQuota(accountId)
      : this.dataManager.windsurfAccounts.fetchAllRealQuotas();

    void Promise.resolve(task)
      .then(async (result) => {
        await this.postAccountsSync({ preferFastCurrentId: true });
        this.logger.info('Quota refresh request finished.', {
          operation: 'quota.refresh.request',
          accountId,
          email: account?.email,
          reason,
          result,
          durationMs: Date.now() - requestedAt,
        });
        if (accountId) {
          void this.view?.webview.postMessage({
            type: 'quotaFetchResult',
            value: { ...result, accountId, reason },
          });
          return;
        }
        void this.view?.webview.postMessage({
          type: 'quotaFetchAllResult',
          value: { ...result, reason },
        });
      })
      .catch(async (err) => {
        await this.postAccountsSync({ preferFastCurrentId: true });
        this.logger.warn('Quota refresh request failed.', {
          operation: 'quota.refresh.request',
          accountId,
          email: account?.email,
          reason,
          error: String(err),
          durationMs: Date.now() - requestedAt,
        });
        if (accountId) {
          void this.view?.webview.postMessage({
            type: 'quotaFetchResult',
            value: {
              success: false,
              error: String(err),
              accountId,
              reason,
            },
          });
          return;
        }
        void this.view?.webview.postMessage({
          type: 'quotaFetchAllResult',
          value: {
            success: 0,
            failed: this.dataManager.windsurfAccounts.getAll().length,
            errors: [String(err)],
            reason,
          },
        });
      });
  }

  private async postAccountsSync(options?: { preferFastCurrentId?: boolean }): Promise<void> {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'accountsSync',
      value: await this.buildAccountsPayload(options),
    });
  }

  private async _doPostBootstrap(): Promise<void> {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'bootstrap',
      value: await this.buildBootstrapAsync()
    });
  }

  public postState(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'status',
      value: this.bridge.getStatus()
    });
  }

  private async buildBootstrapAsync(): Promise<WebviewBootstrap> {
    const accountPayload = await this.buildAccountsPayload();

    return {
      status: this.bridge.getStatus(),
      history: this.dataManager.history.getAll(),
      ...accountPayload,
      shortcuts: this.dataManager.shortcuts.getAll(),
      templates: this.dataManager.templates.getAll(),
      settings: this.dataManager.settings.get(),
      usageStats: this.dataManager.usageStats.get(),
      responseQueue: this.responseQueue
    };
  }

  private async renderAsync(): Promise<void> {
    if (!this.view) return;
    try {
      this.view.webview.html = buildWebviewHtml(
        this.view.webview,
        this.extensionUri,
        await this.buildBootstrapAsync(),
        this.logger.getLogFilePath()
      );
    } catch (err) {
      this.logger.error('Failed to build webview HTML.', { error: String(err) });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;

    const action = Reflect.get(message, 'type') as string | undefined;
    const value = Reflect.get(message, 'value');
    const payload = Reflect.get(message, 'payload');

    if (!action) return;

    if (await this.handleGeneral(action, value, payload)) return;
    if (await this.handleAccount(action, value, payload)) return;
    if (await this.handleTools(action, value, payload)) return;
    if (await this.handleSettings(action, payload)) return;
    if (await this.handleMaintenance(action)) return;

    this.logger.debug('Unhandled webview message.', { action });
  }

  // --- General & Session & History ---

  private async handleGeneral(action: string, value?: unknown, _payload?: unknown): Promise<boolean> {
    switch (action) {
      case 'refresh':
        void this.renderAsync();
        return true;
      case 'testFeedback':
        await this.bridge.injectTestFeedback();
        this.postState();
        return true;
      case 'testDialog': {
        const { createId } = await import('../utils/tool-name');
        const sessionId = createId('test');
        const req: import('../core/contracts').McpDialogRequest = {
          id: createId('test'),
          sessionId,
          summary: '## 对话框测试\n\n这是来自**调试面板**的测试请求。\n\n请选择一个选项或输入自定义回复：',
          options: ['✅ 确认', '❌ 取消', '🔄 重试'],
          isMarkdown: true,
          receivedAt: new Date().toISOString(),
        };
        this.bridge.injectTestDialogRequest(req, (response) => {
          this.logger.info('TestDialog (debug panel): user responded.', { response });
          void this.view?.webview.postMessage({
            type: 'opResult',
            value: { message: `测试对话框回复: "${response}"` }
          });
          this.postBootstrap();
        });
        // Sidebar receives dialog via dialogHandler → postPendingDialog; no need to duplicate
        return true;
      }
      case 'queueSync': {
        const queue = Array.isArray(value) ? value as string[] : [];
        this.responseQueue = queue;
        void this.context.globalState.update('responseQueue', queue);
        return true;
      }
      case 'mcpDialogSubmit': {
        const submitVal = value as Record<string, unknown> | undefined;
        const sessionId = submitVal?.['sessionId'] as string | undefined;
        const userResponse = submitVal?.['response'] as string | undefined;
        const submitImages = submitVal?.['images'] as import('../core/contracts').ImageAttachment[] | undefined;
        if (sessionId && userResponse !== undefined) {
          this.bridge.resolvePendingDialog(sessionId, userResponse, submitImages);
          // Mark editor tab panel as submitted and show sent state (user closes manually)
          QuoteDialogPanel.markSubmitted();
          QuoteDialogPanel.showSentState();
          this.logger.info('MCP dialog submitted from sidebar.', { sessionId });
          this.postBootstrap();
        }
        return true;
      }
      case 'rotateName': {
        if (!this.rotateMcpName) {
          void this.view?.webview.postMessage({ type: 'opResult', value: { message: '旋转功能未就绪，请使用命令面板 quote.rotateName' } });
          return true;
        }
        const result = await this.rotateMcpName();
        if (!result) {
          void this.view?.webview.postMessage({ type: 'opResult', value: { message: '当前窗口不是持久项目窗口，无法旋转工具名' } });
          return true;
        }
        this.postBootstrap();
        void this.view?.webview.postMessage({ type: 'opResult', value: { message: `工具名已旋转为: ${result.newName}` } });
        return true;
      }
      case 'clearHistory': {
        const clearChoice = await vscode.window.showWarningMessage('确定要清空所有历史记录吗？', { modal: true }, '清空');
        if (clearChoice === '清空') {
          await this.dataManager.history.clear();
          this.postBootstrap();
          void this.view?.webview.postMessage({ type: 'opResult', value: { message: '历史记录已清空' } });
        }
        return true;
      }
      case 'sessionContinue':
        this.dataManager.incrementSessionMessageCount();
        await this.dataManager.usageStats.recordContinue();
        this.postBootstrap();
        return true;
      case 'sessionEnd':
        this.dataManager.endSession();
        this.dataManager.startSession();
        await this.dataManager.usageStats.recordEnd();
        this.postBootstrap();
        return true;
      default:
        return false;
    }
  }

  // --- Account ---

  private async handleAccount(action: string, value: unknown, payload: unknown): Promise<boolean> {
    switch (action) {
      case 'deleteHistory':
        if (typeof value === 'string') {
          await this.dataManager.history.delete(value);
          this.postBootstrap();
        }
        return true;
      case 'accountAdd':
        if (payload && typeof payload === 'object') {
          const email = Reflect.get(payload, 'email') as string;
          const password = Reflect.get(payload, 'password') as string;
          if (email && password) {
            await this.dataManager.windsurfAccounts.add(email, password);
            await this.postAccountsSync({ preferFastCurrentId: true });
          }
        }
        return true;
      case 'accountImport':
        if (typeof value === 'string') {
          const result = await this.dataManager.windsurfAccounts.importBatch(value);
          void this.view?.webview.postMessage({ type: 'importResult', value: result });
          await this.postAccountsSync({ preferFastCurrentId: true });
        }
        return true;
      case 'accountDelete':
        if (typeof value === 'string') {
          const account = this.dataManager.windsurfAccounts.getById(value);
          const delChoice = await vscode.window.showWarningMessage(
            `确定要删除账号 ${account?.email ?? value} 吗？`, { modal: true }, '删除'
          );
          if (delChoice === '删除') {
            await this.dataManager.windsurfAccounts.delete(value);
            await this.postAccountsSync({ preferFastCurrentId: true });
            void this.view?.webview.postMessage({ type: 'opResult', value: { message: account ? `已删除 ${account.email}` : '账号已删除' } });
          }
        }
        return true;
      case 'accountSwitch':
        if (typeof value === 'string') {
          void this.view?.webview.postMessage({ type: 'switchLoading', value: true });
          const account = this.dataManager.windsurfAccounts.getById(value);
          const switchResult = await this.dataManager.windsurfAccounts.switchTo(value);

          if (switchResult.success && account) {
            void this.view?.webview.postMessage({ type: 'switchLoading', value: false });
            // 切号成功后立刻同步 currentAccountId；真实配额后台完成后再二次同步。
            await this.postAccountsSync({ preferFastCurrentId: true });
            const warmupMode = getSwitchWarmupMode();
            const msg = switchResult.pendingRuntimeVerification
              ? `已发起切换到 ${account.email}，正在等待 Windsurf 运行时同步并预热配额`
              : getSwitchWarmupSuccessMessage(account.email, warmupMode);
            void this.view?.webview.postMessage({ type: 'switchResult', value: { success: true, message: msg } });
            vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
            if (isSwitchWarmupEnabled(warmupMode)) {
              this.runQuotaFetchInBackground({
                accountId: value,
                reason: 'switch-warmup',
              });
            }
          } else {
            void this.view?.webview.postMessage({ type: 'switchLoading', value: false });
            await this.postAccountsSync({ preferFastCurrentId: false });
            const errMsg = switchResult.error ?? '切换失败：未知错误';
            void this.view?.webview.postMessage({ type: 'switchResult', value: { success: false, message: errMsg } });
            vscode.window.showErrorMessage(`切换失败: ${errMsg}`);
          }
        }
        return true;
      case 'accountDeleteBatch': {
        const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
        if (ids.length > 0) {
          const choice = await vscode.window.showWarningMessage(
            `确定要删除选中的 ${ids.length} 个账号吗？`, { modal: true }, '删除'
          );
          if (choice !== '删除') {
            const result: AccountDeleteBatchResult = { success: false, canceled: true, message: '已取消删除' };
            void this.view?.webview.postMessage({ type: 'accountDeleteBatchResult', value: result });
            return true;
          }

          try {
            const removed = await this.dataManager.windsurfAccounts.deleteBatch(ids);
            await this.postAccountsSync({ preferFastCurrentId: true });
            const message = `已删除 ${removed} 个账号`;
            const result: AccountDeleteBatchResult = { success: true, removed, message };
            void this.view?.webview.postMessage({ type: 'opResult', value: { message } });
            void this.view?.webview.postMessage({ type: 'accountDeleteBatchResult', value: result });
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const result: AccountDeleteBatchResult = { success: false, message: `批量删除失败: ${errorMessage}` };
            this.logger.error('Failed to delete selected accounts.', { error: errorMessage, count: ids.length });
            void this.view?.webview.postMessage({ type: 'accountDeleteBatchResult', value: result });
          }
        }
        return true;
      }
      case 'accountClear': {
        const clearAccChoice = await vscode.window.showWarningMessage(
          '确定要清空所有账号吗？此操作不可撤销。', { modal: true }, '清空'
        );
        if (clearAccChoice === '清空') {
          await this.dataManager.windsurfAccounts.clear();
          await this.postAccountsSync({ preferFastCurrentId: true });
          void this.view?.webview.postMessage({ type: 'opResult', value: { message: '所有账号已清空' } });
        }
        return true;
      }
      case 'autoSwitchUpdate':
        if (payload && typeof payload === 'object') {
          await this.dataManager.windsurfAccounts.updateAutoSwitch(payload as Record<string, unknown>);
          await this.postAccountsSync();
        }
        return true;
      case 'resetMachineId': {
        const result = await this.dataManager.windsurfAccounts.resetMachineId();
        void this.view?.webview.postMessage({ type: 'machineIdResult', value: result });
        return true;
      }
      case 'quotaSetLimits':
        if (payload && typeof payload === 'object') {
          const id = Reflect.get(payload, 'id') as string;
          const dailyLimit = Reflect.get(payload, 'dailyLimit') as number;
          const weeklyLimit = Reflect.get(payload, 'weeklyLimit') as number;
          if (id && typeof dailyLimit === 'number' && typeof weeklyLimit === 'number') {
            await this.dataManager.windsurfAccounts.setQuotaLimits(id, dailyLimit, weeklyLimit);
            await this.postAccountsSync();
          }
        }
        return true;
      case 'recordPrompt':
        await this.dataManager.windsurfAccounts.recordPrompt(
          typeof value === 'string' ? value : undefined
        );
        await this.postAccountsSync();
        return true;
      case 'fetchQuota': {
        const id = typeof value === 'string' ? value : undefined;
        if (id) {
          this.runQuotaFetchInBackground({
            accountId: id,
            reason: 'manual-refresh',
          });
        }
        return true;
      }
      case 'fetchAllQuotas': {
        this.logger.warn('Ignored deprecated fetchAllQuotas request to avoid batch login risk.');
        void this.view?.webview.postMessage({
          type: 'opResult',
          value: { message: '已停止批量刷新配额；请使用单个账号的刷新按钮' },
        });
        return true;
      }
      default:
        return false;
    }
  }

  // --- Shortcuts & Templates ---

  private async handleTools(action: string, value: unknown, payload: unknown): Promise<boolean> {
    switch (action) {
      case 'shortcutAdd':
        if (typeof value === 'string') {
          await this.dataManager.shortcuts.add(value);
          this.postBootstrap();
        }
        return true;
      case 'shortcutUpdate':
        if (payload && typeof payload === 'object') {
          const id = Reflect.get(payload, 'id') as string;
          const content = Reflect.get(payload, 'content') as string;
          if (id && content) {
            await this.dataManager.shortcuts.update(id, content);
            this.postBootstrap();
          }
        }
        return true;
      case 'shortcutDelete':
        if (typeof value === 'string') {
          await this.dataManager.shortcuts.delete(value);
          this.postBootstrap();
        }
        return true;
      case 'templateAdd':
        if (payload && typeof payload === 'object') {
          const name = Reflect.get(payload, 'name') as string;
          const content = Reflect.get(payload, 'content') as string;
          if (name && content) {
            await this.dataManager.templates.add(name, content);
            this.postBootstrap();
          }
        }
        return true;
      case 'templateUpdate':
        if (payload && typeof payload === 'object') {
          const id = Reflect.get(payload, 'id') as string;
          const name = Reflect.get(payload, 'name') as string;
          const content = Reflect.get(payload, 'content') as string;
          if (id && name && content) {
            await this.dataManager.templates.update(id, name, content);
            this.postBootstrap();
          }
        }
        return true;
      case 'templateDelete':
        if (typeof value === 'string') {
          await this.dataManager.templates.delete(value);
          this.postBootstrap();
        }
        return true;
      default:
        return false;
    }
  }

  // --- Settings ---

  private async handleSettings(action: string, payload: unknown): Promise<boolean> {
    switch (action) {
      case 'settingsUpdate':
        if (payload && typeof payload === 'object') {
          const updated = await this.dataManager.settings.update(payload as Record<string, unknown>);
          if (updated.firebaseApiKey !== undefined) {
            this.dataManager.windsurfAccounts.setFirebaseApiKey(updated.firebaseApiKey);
          }
          this.dataManager.windsurfAccounts.setDebugRawResponses?.(
            Boolean(updated.debugRawResponses),
          );
          this.postBootstrap();
        }
        return true;
      case 'settingsReset':
        {
          const reset = await this.dataManager.settings.reset();
          this.dataManager.windsurfAccounts.setFirebaseApiKey(
            reset.firebaseApiKey,
          );
          this.dataManager.windsurfAccounts.setDebugRawResponses?.(
            Boolean(reset.debugRawResponses),
          );
        }
        this.postBootstrap();
        void this.view?.webview.postMessage({ type: 'opResult', value: { message: '设置已恢复默认' } });
        return true;
      default:
        return false;
    }
  }

  // --- Maintenance ---

  private async handleMaintenance(action: string): Promise<boolean> {
    switch (action) {
      case 'maintenanceClearHistory': {
        const mchChoice = await vscode.window.showWarningMessage('确定要清空历史记录吗？', { modal: true }, '清空');
        if (mchChoice === '清空') {
          await this.dataManager.history.clear();
          this.postBootstrap();
        }
        return true;
      }
      case 'maintenanceResetStats':
        await this.dataManager.usageStats.reset();
        this.postBootstrap();
        return true;
      case 'maintenanceCleanMcp':
        {
          const candidates = this.getOwnedMcpCleanupCandidates();
          if (candidates.length === 0) {
            vscode.window.showInformationMessage('没有可清理的 Quote 旧 MCP 配置');
            return true;
          }
          const choice = await vscode.window.showWarningMessage(
            `将只删除 Quote 记录过且当前未使用的 MCP 配置：${candidates.join(', ')}。不会按名称模式扫描其他 MCP。`,
            { modal: true },
            '清理'
          );
          if (choice !== '清理') {
            return true;
          }
          void this.view?.webview.postMessage({ type: 'maintenanceLoading', value: 'cleanMcp' });
          try {
            const result = await this.cleanOldMcpConfigs(candidates);
            void this.view?.webview.postMessage({ type: 'maintenanceResult', value: { ...result, action: 'cleanMcp' } });
            vscode.window.showInformationMessage(`已清理 ${result.cleaned} 条 Quote 旧 MCP 配置`);
          } catch (err) {
            void this.view?.webview.postMessage({ type: 'maintenanceError', value: { action: 'cleanMcp', error: String(err) } });
            vscode.window.showErrorMessage(`清理 Quote 旧 MCP 配置失败: ${String(err)}`);
          }
        }
        return true;
      case 'maintenanceResetSettings': {
        const mrsChoice = await vscode.window.showWarningMessage(
          '确定要重置所有设置吗？快捷短语和模板也会被清空。', { modal: true }, '重置'
        );
        if (mrsChoice === '重置') {
          void this.view?.webview.postMessage({ type: 'maintenanceLoading', value: 'resetSettings' });
          try {
            await this.dataManager.settings.reset();
            await this.dataManager.shortcuts.clear();
            await this.dataManager.templates.clear();
            this.postBootstrap();
            void this.view?.webview.postMessage({ type: 'maintenanceResult', value: { action: 'resetSettings' } });
            vscode.window.showInformationMessage('所有设置已恢复默认');
          } catch (err) {
            void this.view?.webview.postMessage({ type: 'maintenanceError', value: { action: 'resetSettings', error: String(err) } });
            vscode.window.showErrorMessage(`重置设置失败: ${String(err)}`);
          }
        }
        return true;
      }
      case 'maintenanceRewriteRules':
        void this.view?.webview.postMessage({ type: 'maintenanceLoading', value: 'rewriteRules' });
        try {
          const result = await this.rewriteRules();
          void this.view?.webview.postMessage({ type: 'maintenanceResult', value: { ...result, action: 'rewriteRules' } });
          if (result.failed.length > 0) {
            vscode.window.showWarningMessage(`规则写入: ${result.written.length} 成功, ${result.failed.length} 失败`);
          } else {
            vscode.window.showInformationMessage(`规则文件已重新写入 (${result.written.length} 个文件)`);
          }
        } catch (err) {
          void this.view?.webview.postMessage({ type: 'maintenanceError', value: { action: 'rewriteRules', error: String(err) } });
          vscode.window.showErrorMessage(`重写规则文件失败: ${String(err)}`);
        }
        return true;
      case 'maintenanceClearCache': {
        const mccChoice = await vscode.window.showWarningMessage(
          '确定要清理插件缓存吗？历史记录和统计数据将被清除。', { modal: true }, '清理'
        );
        if (mccChoice === '清理') {
          void this.view?.webview.postMessage({ type: 'maintenanceLoading', value: 'clearCache' });
          try {
            await this.dataManager.history.clear();
            await this.dataManager.usageStats.reset();
            this.logger.info('Plugin cache cleared.');
            this.postBootstrap();
            void this.view?.webview.postMessage({ type: 'maintenanceResult', value: { action: 'clearCache' } });
            vscode.window.showInformationMessage('插件缓存已清理');
          } catch (err) {
            void this.view?.webview.postMessage({ type: 'maintenanceError', value: { action: 'clearCache', error: String(err) } });
            vscode.window.showErrorMessage(`清理缓存失败: ${String(err)}`);
          }
        }
        return true;
      }
      case 'getDebugInfo': {
        const [logContent, patchStatus] = await Promise.all([
          this.logger.getRecentLogs(500),
          WindsurfPatchService.isPatchApplied()
        ]);
        const currentAccountId = this.dataManager.windsurfAccounts.getImmediateCurrentAccountId();
        const currentAccount = currentAccountId
          ? this.dataManager.windsurfAccounts.getById(currentAccountId)
          : undefined;
        const accounts = this.dataManager.windsurfAccounts.getAll();
        void this.view?.webview.postMessage({
          type: 'debugInfo',
          value: {
            logPath: this.logger.getLogFilePath(),
            logContent,
            accountSummary: {
              total: accounts.length,
              currentAccountId,
              currentEmail: currentAccount?.email ?? null,
              quotaFetching: this.dataManager.windsurfAccounts.isQuotaFetching,
              quotaFetchingAll: this.dataManager.windsurfAccounts.isQuotaFetchingAll,
              quotaFetchingIds: this.dataManager.windsurfAccounts.getQuotaFetchingAccountIds?.() ?? [],
              lastAutoSwitchResult: this.dataManager.windsurfAccounts.getLastAutoSwitchResult?.() ?? null,
            },
            patchApplied: patchStatus.applied,
            patchExtensionPath: patchStatus.extensionPath ?? null,
            patchError: patchStatus.error ?? null
          }
        });
        return true;
      }
      case 'applyWindsurfPatch': {
        void this.view?.webview.postMessage({ type: 'patchApplyResult', value: { loading: true } });
        try {
          const result = await WindsurfPatchService.checkAndApply(this.logger);
          const patchStatus = await WindsurfPatchService.isPatchApplied();
          const logContent = await this.logger.getRecentLogs(500);
          const currentAccountId = this.dataManager.windsurfAccounts.getImmediateCurrentAccountId();
          const currentAccount = currentAccountId
            ? this.dataManager.windsurfAccounts.getById(currentAccountId)
            : undefined;
          const accounts = this.dataManager.windsurfAccounts.getAll();
          void this.view?.webview.postMessage({
            type: 'patchApplyResult',
            value: result,
          });
          void this.view?.webview.postMessage({
            type: 'debugInfo',
            value: {
              logPath: this.logger.getLogFilePath(),
              logContent,
              accountSummary: {
                total: accounts.length,
                currentAccountId,
                currentEmail: currentAccount?.email ?? null,
                quotaFetching: this.dataManager.windsurfAccounts.isQuotaFetching,
                quotaFetchingAll: this.dataManager.windsurfAccounts.isQuotaFetchingAll,
                quotaFetchingIds: this.dataManager.windsurfAccounts.getQuotaFetchingAccountIds?.() ?? [],
                lastAutoSwitchResult: this.dataManager.windsurfAccounts.getLastAutoSwitchResult?.() ?? null,
              },
              patchApplied: patchStatus.applied,
              patchExtensionPath: patchStatus.extensionPath ?? null,
              patchError: patchStatus.error ?? null
            }
          });
          if (result.success) {
            const msg = result.needsRestart
              ? '无感补丁已写入，请重启 Windsurf 后生效'
              : '无感补丁已启用';
            vscode.window.showInformationMessage(msg);
          } else {
            const msg = result.permissionHint
              ? `${result.error ?? '补丁应用失败'}\n${result.permissionHint}`
              : result.error ?? '补丁应用失败';
            vscode.window.showErrorMessage(msg);
          }
        } catch (err) {
          const error = String(err);
          void this.view?.webview.postMessage({ type: 'patchApplyResult', value: { success: false, error } });
          vscode.window.showErrorMessage(`补丁应用失败: ${error}`);
        }
        return true;
      }
      case 'maintenanceDiagnose':
        void this.view?.webview.postMessage({ type: 'maintenanceLoading', value: 'diagnose' });
        try {
          const result = await this.runDiagnose();
          void this.view?.webview.postMessage({ type: 'diagnoseResult', value: result });
          const ok = result.checks.filter(c => c.ok).length;
          const fail = result.checks.filter(c => !c.ok).length;
          const repairText = result.repaired ? `，已修复 ${result.repaired} 项` : '';
          const summary = `诊断完成: ${ok} 通过, ${fail} 异常${repairText}`;
          if (fail > 0) {
            const detail = result.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join('; ');
            vscode.window.showWarningMessage(`${summary} — ${detail}`, '查看详情').then(choice => {
              if (choice === '查看详情') this.reveal();
            });
          } else {
            vscode.window.showInformationMessage(summary);
          }
        } catch (err) {
          void this.view?.webview.postMessage({ type: 'maintenanceError', value: { action: 'diagnose', error: String(err) } });
          vscode.window.showErrorMessage(`诊断失败: ${String(err)}`);
        }
        return true;
      default:
        return false;
    }
  }

  // --- Maintenance helpers ---

  private getOwnedMcpCleanupCandidates(): string[] {
    const owned = this.context.globalState.get<string[]>('ownedMcpNames', []);
    const currentToolName = this.bridge.getStatus().toolName;
    return [...new Set(Array.isArray(owned) ? owned : [])]
      .filter((name) => typeof name === 'string' && name.length > 0 && name !== currentToolName);
  }

  private async cleanOldMcpConfigs(candidates: string[]): Promise<{ cleaned: number; details: string[] }> {
    const { IDE_TARGETS } = await import('../adapters/mcp-config');
    const fs = await import('node:fs/promises');
    let cleaned = 0;
    const details: string[] = [];

    for (const target of IDE_TARGETS) {
      try {
        const raw = await fs.readFile(target.configPath, 'utf8');
        const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        if (!config.mcpServers) continue;

        const keysToRemove = candidates.filter(k => config.mcpServers?.[k]);

        if (keysToRemove.length === 0) continue;

        for (const key of keysToRemove) {
          delete config.mcpServers[key];
          cleaned++;
          details.push(`${target.name}: 删除 ${key}`);
        }

        await fs.writeFile(target.configPath, JSON.stringify(config, null, 2), 'utf8');
      } catch {
        // 文件不存在或无法读取，跳过
      }
    }

    this.logger.info('Old MCP configs cleaned.', { cleaned, details, candidates });
    return { cleaned, details };
  }

  private async rewriteRules(): Promise<{ written: string[]; failed: string[] }> {
    const { configureGlobalRules } = await import('../adapters/rules');
    const toolName = this.bridge.getStatus().toolName;
    const results = await configureGlobalRules(toolName);
    const written = results.filter(r => r.written).map(r => r.path);
    const failed = results.filter(r => !r.written).map(r => `${r.path}: ${r.reason}`);
    this.logger.info('Rules rewritten.', { written, failed });
    return { written, failed };
  }

  private async runDiagnose(): Promise<{ checks: Array<{ name: string; ok: boolean; detail: string }>; repaired: number }> {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    let repaired = 0;

    // 1. Bridge 状态
    const status = this.bridge.getStatus();
    checks.push({
      name: '服务器状态',
      ok: status.running,
      detail: status.running ? `端口 ${status.port} 运行中` : '服务器未启动'
    });

    // 2. MCP 配置检查（只读，不自动写入）
    const { IDE_TARGETS } = await import('../adapters/mcp-config');
    const currentIde = IDE_TARGETS.find(t => t.name === status.currentIde) ?? IDE_TARGETS[4];
    let mcpOk = false;
    try {
      const raw = await fs.readFile(currentIde.configPath, 'utf8');
      const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      mcpOk = !!(config.mcpServers && status.toolName in config.mcpServers);
    } catch {
      mcpOk = false;
    }
    checks.push({
      name: 'MCP 配置',
      ok: mcpOk,
      detail: mcpOk ? `${currentIde.name}: ${status.toolName} 已配置` : `${currentIde.configPath} 中未找到 ${status.toolName}`
    });

    // 3. 账号数据
    const accounts = this.dataManager.windsurfAccounts.getAll();
    const withPassword = accounts.filter(a => a.password && a.password !== '***');
    checks.push({
      name: '账号数据',
      ok: accounts.length > 0,
      detail: `${accounts.length} 个账号, ${withPassword.length} 个有密码`
    });

    // 4. 规则文件检查（只读，不自动写入）
    const workspaceFolder = (await import('vscode')).workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const rulePath = pathMod.join(workspaceFolder.uri.fsPath, 'AI_FEEDBACK_RULES.md');
      let ruleExists = false;
      try { await fs.access(rulePath); ruleExists = true; } catch { /* */ }
      checks.push({ name: '规则文件', ok: ruleExists, detail: ruleExists ? '已存在' : '未找到 AI_FEEDBACK_RULES.md' });
    } else {
      checks.push({ name: '规则文件', ok: false, detail: '无打开的工作区' });
    }

    // 5. globalStorage 目录
    const storagePath = this.dataManager.globalStoragePath;
    let storageOk = false;
    try { await fs.access(storagePath); storageOk = true; } catch { /* */ }
    checks.push({
      name: '存储目录',
      ok: storageOk,
      detail: storageOk ? storagePath : '不存在'
    });

    this.logger.info('Diagnose completed.', { checks, repaired });
    return { checks, repaired };
  }
}
