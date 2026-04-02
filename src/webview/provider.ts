import * as vscode from 'vscode';
import { EchoBridgeServer } from '../core/bridge';
import { EchoLogger } from '../core/logger';
import type { DataManager } from '../core/data-manager';
import type { WebviewBootstrap } from '../core/contracts';
import { buildWebviewHtml } from './view-html';

export class EchoSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'infiniteDialogView';
  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: EchoBridgeServer,
    private readonly logger: EchoLogger,
    private readonly dataManager: DataManager
  ) {}

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

    try {
      this.render();
    } catch (err) {
      this.logger.error('Failed to render webview.', { error: String(err) });
      webviewView.webview.html = `<!DOCTYPE html><html><body><p>加载失败，请点击刷新按钮重试。</p></body></html>`;
    }

    webviewView.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  public refresh(): void {
    this.render();
  }

  public reveal(): void {
    this.view?.show?.(true);
  }

  public postBootstrap(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'bootstrap',
      value: this.buildBootstrap()
    });
  }

  public postState(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'status',
      value: this.bridge.getStatus()
    });
  }

  private buildBootstrap(): WebviewBootstrap {
    // 过滤密码字段，不发送到 webview
    const accounts = this.dataManager.windsurfAccounts.getAll().map(a => ({
      ...a,
      password: '***'
    }));

    return {
      status: this.bridge.getStatus(),
      history: this.dataManager.history.getAll(),
      accounts,
      shortcuts: this.dataManager.shortcuts.getAll(),
      templates: this.dataManager.templates.getAll(),
      settings: this.dataManager.settings.get(),
      usageStats: this.dataManager.usageStats.get(),
      autoSwitch: this.dataManager.windsurfAccounts.getAutoSwitchConfig(),
      currentAccountId: this.dataManager.windsurfAccounts.getCurrentAccountId(),
      quotaSnapshots: this.dataManager.windsurfAccounts.getQuotaSnapshots(),
      quotaFetching: this.dataManager.windsurfAccounts.isQuotaFetching
    };
  }

  private render(): void {
    if (!this.view) return;
    try {
      this.view.webview.html = buildWebviewHtml(
        this.view.webview,
        this.extensionUri,
        this.buildBootstrap(),
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

    // --- General ---
    if (action === 'refresh') {
      this.render();
      return;
    }

    if (action === 'testFeedback') {
      await this.bridge.injectTestFeedback();
      this.postState();
      return;
    }

    // --- History ---
    if (action === 'clearHistory') {
      await this.dataManager.history.clear();
      this.postBootstrap();
      return;
    }

    if (action === 'deleteHistory') {
      if (typeof value === 'string') {
        await this.dataManager.history.delete(value);
        this.postBootstrap();
      }
      return;
    }

    // --- Session control ---
    if (action === 'sessionContinue') {
      this.dataManager.incrementSessionMessageCount();
      await this.dataManager.usageStats.recordContinue();
      this.postBootstrap();
      return;
    }

    if (action === 'sessionEnd') {
      this.dataManager.endSession();
      this.dataManager.startSession();
      await this.dataManager.usageStats.recordEnd();
      this.postBootstrap();
      return;
    }

    // --- Windsurf Accounts ---
    if (action === 'accountAdd') {
      if (payload && typeof payload === 'object') {
        const email = Reflect.get(payload, 'email') as string;
        const password = Reflect.get(payload, 'password') as string;
        if (email && password) {
          await this.dataManager.windsurfAccounts.add(email, password);
          this.postBootstrap();
        }
      }
      return;
    }

    if (action === 'accountImport') {
      if (typeof value === 'string') {
        const result = await this.dataManager.windsurfAccounts.importBatch(value);
        void this.view?.webview.postMessage({ type: 'importResult', value: result });
        this.postBootstrap();
      }
      return;
    }

    if (action === 'accountDelete') {
      if (typeof value === 'string') {
        await this.dataManager.windsurfAccounts.delete(value);
        this.postBootstrap();
      }
      return;
    }

    if (action === 'accountSwitch') {
      if (typeof value === 'string') {
        await this.dataManager.windsurfAccounts.switchTo(value);
        this.postBootstrap();
      }
      return;
    }

    if (action === 'accountClear') {
      await this.dataManager.windsurfAccounts.clear();
      this.postBootstrap();
      return;
    }

    if (action === 'autoSwitchUpdate') {
      if (payload && typeof payload === 'object') {
        await this.dataManager.windsurfAccounts.updateAutoSwitch(payload as Record<string, unknown>);
        this.postBootstrap();
      }
      return;
    }

    if (action === 'resetMachineId') {
      const result = await this.dataManager.windsurfAccounts.resetMachineId();
      void this.view?.webview.postMessage({ type: 'machineIdResult', value: result });
      return;
    }

    if (action === 'quotaSetLimits') {
      if (payload && typeof payload === 'object') {
        const id = Reflect.get(payload, 'id') as string;
        const dailyLimit = Reflect.get(payload, 'dailyLimit') as number;
        const weeklyLimit = Reflect.get(payload, 'weeklyLimit') as number;
        if (id && typeof dailyLimit === 'number' && typeof weeklyLimit === 'number') {
          await this.dataManager.windsurfAccounts.setQuotaLimits(id, dailyLimit, weeklyLimit);
          this.postBootstrap();
        }
      }
      return;
    }

    if (action === 'recordPrompt') {
      await this.dataManager.windsurfAccounts.recordPrompt(
        typeof value === 'string' ? value : undefined
      );
      this.postBootstrap();
      return;
    }

    if (action === 'fetchQuota') {
      const id = typeof value === 'string' ? value : undefined;
      this.postBootstrap(); // 先发送 fetching 状态
      const result = await this.dataManager.windsurfAccounts.fetchRealQuota(id);
      void this.view?.webview.postMessage({ type: 'quotaFetchResult', value: result });
      this.postBootstrap();
      return;
    }

    if (action === 'fetchAllQuotas') {
      this.postBootstrap(); // 先发送 fetching 状态
      const result = await this.dataManager.windsurfAccounts.fetchAllRealQuotas();
      void this.view?.webview.postMessage({ type: 'quotaFetchAllResult', value: result });
      this.postBootstrap();
      return;
    }

    // --- Shortcuts ---
    if (action === 'shortcutAdd') {
      if (typeof value === 'string') {
        await this.dataManager.shortcuts.add(value);
        this.postBootstrap();
      }
      return;
    }

    if (action === 'shortcutUpdate') {
      if (payload && typeof payload === 'object') {
        const id = Reflect.get(payload, 'id') as string;
        const content = Reflect.get(payload, 'content') as string;
        if (id && content) {
          await this.dataManager.shortcuts.update(id, content);
          this.postBootstrap();
        }
      }
      return;
    }

    if (action === 'shortcutDelete') {
      if (typeof value === 'string') {
        await this.dataManager.shortcuts.delete(value);
        this.postBootstrap();
      }
      return;
    }

    // --- Templates ---
    if (action === 'templateAdd') {
      if (payload && typeof payload === 'object') {
        const name = Reflect.get(payload, 'name') as string;
        const content = Reflect.get(payload, 'content') as string;
        if (name && content) {
          await this.dataManager.templates.add(name, content);
          this.postBootstrap();
        }
      }
      return;
    }

    if (action === 'templateUpdate') {
      if (payload && typeof payload === 'object') {
        const id = Reflect.get(payload, 'id') as string;
        const name = Reflect.get(payload, 'name') as string;
        const content = Reflect.get(payload, 'content') as string;
        if (id && name && content) {
          await this.dataManager.templates.update(id, name, content);
          this.postBootstrap();
        }
      }
      return;
    }

    if (action === 'templateDelete') {
      if (typeof value === 'string') {
        await this.dataManager.templates.delete(value);
        this.postBootstrap();
      }
      return;
    }

    // --- Settings ---
    if (action === 'settingsUpdate') {
      if (payload && typeof payload === 'object') {
        const updated = await this.dataManager.settings.update(payload as Record<string, unknown>);
        if (updated.firebaseApiKey) {
          this.dataManager.windsurfAccounts.setFirebaseApiKey(updated.firebaseApiKey);
        }
        this.postBootstrap();
      }
      return;
    }

    if (action === 'settingsReset') {
      await this.dataManager.settings.reset();
      this.postBootstrap();
      return;
    }

    // --- Maintenance ---
    if (action === 'maintenanceClearHistory') {
      await this.dataManager.history.clear();
      this.postBootstrap();
      return;
    }

    if (action === 'maintenanceResetStats') {
      await this.dataManager.usageStats.reset();
      this.postBootstrap();
      return;
    }

    if (action === 'maintenanceCleanMcp') {
      const result = await this.cleanOldMcpConfigs();
      void this.view?.webview.postMessage({ type: 'maintenanceResult', value: result });
      return;
    }

    if (action === 'maintenanceResetSettings') {
      await this.dataManager.settings.reset();
      await this.dataManager.shortcuts.clear();
      await this.dataManager.templates.clear();
      this.postBootstrap();
      return;
    }

    if (action === 'maintenanceRewriteRules') {
      const result = await this.rewriteRules();
      void this.view?.webview.postMessage({ type: 'maintenanceResult', value: result });
      return;
    }

    if (action === 'maintenanceClearCache') {
      await this.dataManager.history.clear();
      await this.dataManager.usageStats.reset();
      this.logger.info('Plugin cache cleared.');
      this.postBootstrap();
      return;
    }

    if (action === 'maintenanceDiagnose') {
      const result = await this.runDiagnose();
      void this.view?.webview.postMessage({ type: 'diagnoseResult', value: result });
      return;
    }

    this.logger.debug('Unhandled webview message.', { action });
  }

  // --- Maintenance helpers ---

  private async cleanOldMcpConfigs(): Promise<{ cleaned: number; details: string[] }> {
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
          k !== currentToolName && (k.startsWith('echo_') || k.startsWith('infinite_') || k.startsWith('ai-echo'))
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

    // 2. MCP 配置检查 + 自动修复
    const { IDE_TARGETS, writeMcpConfig } = await import('../adapters/mcp-config');
    const currentIde = IDE_TARGETS.find(t => t.name === status.currentIde) ?? IDE_TARGETS[4];
    let mcpOk = false;
    try {
      const raw = await fs.readFile(currentIde.configPath, 'utf8');
      const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      mcpOk = !!(config.mcpServers && status.toolName in config.mcpServers);
    } catch {
      mcpOk = false;
    }

    if (!mcpOk && status.running) {
      // 自动修复: 写入 MCP 配置
      try {
        const sseUrl = `http://127.0.0.1:${status.port}/sse`;
        await writeMcpConfig(currentIde, status.toolName, sseUrl);
        mcpOk = true;
        repaired++;
        checks.push({ name: 'MCP 配置', ok: true, detail: `${currentIde.name}: 已自动修复` });
      } catch (err) {
        checks.push({ name: 'MCP 配置', ok: false, detail: `自动修复失败: ${String(err)}` });
      }
    } else {
      checks.push({
        name: 'MCP 配置',
        ok: mcpOk,
        detail: mcpOk ? `${currentIde.name}: ${status.toolName} 已配置` : `${currentIde.configPath} 中未找到 ${status.toolName}`
      });
    }

    // 3. 账号数据
    const accounts = this.dataManager.windsurfAccounts.getAll();
    const withPassword = accounts.filter(a => a.password && a.password !== '***');
    checks.push({
      name: '账号数据',
      ok: accounts.length > 0,
      detail: `${accounts.length} 个账号, ${withPassword.length} 个有密码`
    });

    // 4. 规则文件检查 + 自动修复
    const workspaceFolder = (await import('vscode')).workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const rulePath = pathMod.join(workspaceFolder.uri.fsPath, 'AI_FEEDBACK_RULES.md');
      let ruleExists = false;
      try { await fs.access(rulePath); ruleExists = true; } catch { /* */ }

      if (!ruleExists) {
        try {
          const { configureGlobalRules } = await import('../adapters/rules');
          await configureGlobalRules(status.toolName);
          ruleExists = true;
          repaired++;
          checks.push({ name: '规则文件', ok: true, detail: '已自动写入 AI_FEEDBACK_RULES.md' });
        } catch (err) {
          checks.push({ name: '规则文件', ok: false, detail: `自动修复失败: ${String(err)}` });
        }
      } else {
        checks.push({ name: '规则文件', ok: true, detail: '已存在' });
      }
    } else {
      checks.push({ name: '规则文件', ok: false, detail: '无打开的工作区' });
    }

    // 5. globalStorage 目录
    const storagePath = pathMod.join(osMod.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'opensource.ai-echo');
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
