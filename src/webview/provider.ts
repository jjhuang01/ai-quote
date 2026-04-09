import * as vscode from 'vscode';
import type { QuoteBridge } from '../core/bridge';
import type { QuoteLogger } from '../core/logger';
import type { DataManager } from '../core/data-manager';
import type { WebviewBootstrap } from '../core/contracts';
import { buildWebviewHtml } from './view-html';
import { QuoteDialogPanel } from './dialog-panel';
import { WindsurfPatchService } from '../adapters/windsurf-patch';

export class QuoteSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'quoteView';
  private view?: vscode.WebviewView;
  private responseQueue: string[] = [];
  private bootstrapTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: QuoteBridge,
    private readonly logger: QuoteLogger,
    private readonly dataManager: DataManager,
    private readonly context: vscode.ExtensionContext
  ) {
    // Restore persisted queue
    this.responseQueue = this.context.globalState.get<string[]>('responseQueue', []);
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
        void this.postBootstrap();
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
    // 过滤密码字段，不发送到 webview
    const accounts = this.dataManager.windsurfAccounts.getAll().map(a => ({
      ...a,
      password: '***'
    }));

    const wa = this.dataManager.windsurfAccounts as unknown as {
      getRealCurrentAccountId?: () => Promise<string | undefined>;
      getCurrentAccountId?: () => string | undefined;
    };
    const realCurrentAccountId = wa.getRealCurrentAccountId
      ? await wa.getRealCurrentAccountId()
      : wa.getCurrentAccountId?.();

    // 排序: 当前账号置顶 → 有配额优先 → 按剩余配额降序 → addedAt 稳定排序
    // 注: quota 制下 remainingMessages 不可靠（Free plan availablePromptCredits=0 但 dailyRemainingPercent=100）
    //     必须以 dailyRemainingPercent 为准
    const getRemain = (acc: typeof accounts[number]): number => {
      const rq = acc.realQuota;
      if (rq) {
        // -1 = API 未返回百分比字段；用 dailyRemainingPercent 排序（0=耗尽, 100=满额）
        if (rq.dailyRemainingPercent >= 0) return rq.dailyRemainingPercent;
        // 无百分比但有 remainingMessages（credits 制 Enterprise）
        if (rq.remainingMessages > 0) return 50 + Math.min(50, rq.remainingMessages);
        // 有 realQuota 但无任何有效数据
        return 50;
      }
      // 未获取过配额: 给中性分值 (50)，排在有余量之后、耗尽之前
      if (!acc.quota || acc.quota.dailyLimit === 0) return 50;
      // 本地计数器 fallback: 转换为 0-100 等效分值
      const used = acc.quota.dailyUsed;
      const limit = acc.quota.dailyLimit;
      return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
    };
    accounts.sort((a, b) => {
      if (a.id === realCurrentAccountId) return -1;
      if (b.id === realCurrentAccountId) return 1;
      const diff = getRemain(b) - getRemain(a);
      if (diff !== 0) return diff;
      return (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
    });

    return {
      status: this.bridge.getStatus(),
      history: this.dataManager.history.getAll(),
      accounts,
      shortcuts: this.dataManager.shortcuts.getAll(),
      templates: this.dataManager.templates.getAll(),
      settings: this.dataManager.settings.get(),
      usageStats: this.dataManager.usageStats.get(),
      autoSwitch: this.dataManager.windsurfAccounts.getAutoSwitchConfig(),
      currentAccountId: realCurrentAccountId,
      quotaSnapshots: this.dataManager.windsurfAccounts.getQuotaSnapshots(),
      quotaFetching: this.dataManager.windsurfAccounts.isQuotaFetching,
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
        const { rotateToolName } = await import('../utils/tool-name');
        const { detectCurrentIde, writeMcpConfig } = await import('../adapters/mcp-config');
        const storagePath = this.dataManager.globalStoragePath;
        const newName = await rotateToolName(storagePath);
        this.bridge.updateToolName(newName);

        // Re-write MCP config and rules so the AI finds the new tool name
        const currentIde = detectCurrentIde();
        const sseUrl = this.bridge.getSseUrl();
        try {
          await writeMcpConfig(currentIde, newName, sseUrl);
          this.logger.info('MCP config re-written after rotation.', { newName });
        } catch (err) {
          this.logger.warn('Failed to re-write MCP config after rotation.', { error: String(err) });
        }
        try {
          await this.rewriteRules();
        } catch (err) {
          this.logger.warn('Failed to re-write rules after rotation.', { error: String(err) });
        }
        // 清理旧 .mdc 规则文件（与 extension.ts quote.rotateName 对齐）
        try {
          const { cleanupStaleRules } = await import('../adapters/rules');
          const removed = await cleanupStaleRules(newName);
          if (removed.length > 0) {
            this.logger.info('Stale rule files cleaned up after webview rotation.', { removed });
          }
        } catch (err) {
          this.logger.warn('cleanupStaleRules after webview rotation failed (non-fatal).', { error: String(err) });
        }

        this.postBootstrap();
        void this.view?.webview.postMessage({ type: 'opResult', value: { message: `工具名已旋转为: ${newName}` } });
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
            this.postBootstrap();
          }
        }
        return true;
      case 'accountImport':
        if (typeof value === 'string') {
          const result = await this.dataManager.windsurfAccounts.importBatch(value);
          void this.view?.webview.postMessage({ type: 'importResult', value: result });
          this.postBootstrap();
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
            this.postBootstrap();
            void this.view?.webview.postMessage({ type: 'opResult', value: { message: account ? `已删除 ${account.email}` : '账号已删除' } });
          }
        }
        return true;
      case 'accountSwitch':
        if (typeof value === 'string') {
          void this.view?.webview.postMessage({ type: 'switchLoading', value: true });
          const account = this.dataManager.windsurfAccounts.getById(value);
          const switchResult = await this.dataManager.windsurfAccounts.switchTo(value);
          void this.view?.webview.postMessage({ type: 'switchLoading', value: false });

          if (switchResult.success && account) {
            // 立即刷新 UI（显示新 currentAccountId + 已有数据）
            this.postBootstrap();
            const msg = `已切换到 ${account.email}`;
            void this.view?.webview.postMessage({ type: 'switchResult', value: { success: true, message: msg } });
            vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
            // 后台异步获取新账号配额，完成后再次刷新 UI
            void this.dataManager.windsurfAccounts.fetchRealQuota(value).then(() => {
              this.postBootstrap();
            });
          } else {
            const errMsg = switchResult.error ?? '切换失败：未知错误';
            void this.view?.webview.postMessage({ type: 'switchResult', value: { success: false, message: errMsg } });
            vscode.window.showErrorMessage(`切换失败: ${errMsg}`);
          }
        }
        return true;
      case 'accountDeleteBatch': {
        const ids = value as string[];
        if (Array.isArray(ids) && ids.length > 0) {
          const choice = await vscode.window.showWarningMessage(
            `确定要删除选中的 ${ids.length} 个账号吗？`, { modal: true }, '删除'
          );
          if (choice === '删除') {
            const removed = await this.dataManager.windsurfAccounts.deleteBatch(ids);
            this.postBootstrap();
            void this.view?.webview.postMessage({ type: 'opResult', value: { message: `已删除 ${removed} 个账号` } });
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
          this.postBootstrap();
          void this.view?.webview.postMessage({ type: 'opResult', value: { message: '所有账号已清空' } });
        }
        return true;
      }
      case 'autoSwitchUpdate':
        if (payload && typeof payload === 'object') {
          await this.dataManager.windsurfAccounts.updateAutoSwitch(payload as Record<string, unknown>);
          this.postBootstrap();
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
            this.postBootstrap();
          }
        }
        return true;
      case 'recordPrompt':
        await this.dataManager.windsurfAccounts.recordPrompt(
          typeof value === 'string' ? value : undefined
        );
        this.postBootstrap();
        return true;
      case 'fetchQuota': {
        const id = typeof value === 'string' ? value : undefined;
        this.postBootstrap();
        const result = await this.dataManager.windsurfAccounts.fetchRealQuota(id);
        void this.view?.webview.postMessage({ type: 'quotaFetchResult', value: result });
        this.postBootstrap();
        return true;
      }
      case 'fetchAllQuotas': {
        this.postBootstrap();
        const result = await this.dataManager.windsurfAccounts.fetchAllRealQuotas();
        void this.view?.webview.postMessage({ type: 'quotaFetchAllResult', value: result });
        this.postBootstrap();
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
          if (updated.firebaseApiKey) {
            this.dataManager.windsurfAccounts.setFirebaseApiKey(updated.firebaseApiKey);
          }
          this.postBootstrap();
        }
        return true;
      case 'settingsReset':
        await this.dataManager.settings.reset();
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
        void this.view?.webview.postMessage({ type: 'maintenanceLoading', value: 'cleanMcp' });
        try {
          const whitelist = this.dataManager.settings.get().mcpWhitelist ?? [];
          const result = await this.cleanOldMcpConfigs(whitelist);
          void this.view?.webview.postMessage({ type: 'maintenanceResult', value: { ...result, action: 'cleanMcp' } });
          vscode.window.showInformationMessage(`已清理 ${result.cleaned} 条旧MCP配置`);
        } catch (err) {
          void this.view?.webview.postMessage({ type: 'maintenanceError', value: { action: 'cleanMcp', error: String(err) } });
          vscode.window.showErrorMessage(`清理旧MCP配置失败: ${String(err)}`);
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
          this.logger.getRecentLogs(200),
          WindsurfPatchService.isPatchApplied()
        ]);
        void this.view?.webview.postMessage({
          type: 'debugInfo',
          value: {
            logPath: this.logger.getLogFilePath(),
            logContent,
            patchApplied: patchStatus.applied,
            patchExtensionPath: patchStatus.extensionPath ?? null,
            patchError: patchStatus.error ?? null
          }
        });
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

  private async cleanOldMcpConfigs(whitelist: string[] = []): Promise<{ cleaned: number; details: string[] }> {
    const { IDE_TARGETS } = await import('../adapters/mcp-config');
    const fs = await import('node:fs/promises');
    let cleaned = 0;
    const details: string[] = [];

    for (const target of IDE_TARGETS) {
      try {
        const raw = await fs.readFile(target.configPath, 'utf8');
        const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        if (!config.mcpServers) continue;

        const currentToolName = this.bridge.getStatus().toolName;
        const keysToRemove = Object.keys(config.mcpServers).filter(k =>
          k !== currentToolName &&
          !whitelist.includes(k) && (
            k.startsWith('windsurf_endless_') ||
            k.startsWith('echo_') ||
            k.startsWith('infinite_') ||
            k.startsWith('ai-echo') ||
            /^[a-z]{4}_[a-f0-9]{8}$/.test(k)
          )
        );

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

    this.logger.info('Old MCP configs cleaned.', { cleaned, details });
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
