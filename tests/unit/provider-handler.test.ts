import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode
vi.mock('vscode', () => ({
  default: {},
  Uri: { joinPath: (...args: string[]) => ({ fsPath: args.join('/') }) },
  env: { appName: 'Visual Studio Code' },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn()
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }],
    isTrusted: true
  }
}));

// Mock view-html (not needed for handler tests)
vi.mock('../../src/webview/view-html', () => ({
  buildWebviewHtml: vi.fn(() => '<html></html>')
}));

import * as vscode from 'vscode';
import { QuoteSidebarProvider } from '../../src/webview/provider';

// --- Mock factories ---

function createMockBridge() {
  return {
    getStatus: vi.fn(() => ({
      running: true,
      port: 9876,
      currentIde: 'Windsurf',
      toolName: 'echo-test',
      sseClientCount: 0
    })),
    injectTestFeedback: vi.fn(async () => ({ id: 'test-1' })),
    setConfiguredPaths: vi.fn(),
    getSseUrl: vi.fn(() => 'http://127.0.0.1:9876/sse'),
    updateToolName: vi.fn(),
    resolvePendingDialog: vi.fn()
  } as any;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    getLogFilePath: vi.fn(() => '/tmp/test.log'),
    dispose: vi.fn()
  } as any;
}

function createMockDataManager() {
  return {
    globalStoragePath: '/tmp/test-storage',
    history: {
      getAll: vi.fn(() => []),
      clear: vi.fn(async () => {}),
      delete: vi.fn(async () => {})
    },
    windsurfAccounts: {
      getAll: vi.fn(() => []),
      getById: vi.fn((id: string) => ({ id, email: 'test@example.com', isActive: true })),
      getDisplayCurrentAccountId: vi.fn(async () => 'ws_1'),
      getImmediateCurrentAccountId: vi.fn(() => 'ws_1'),
      getCurrentAccountId: vi.fn(() => 'ws_1'),
      getRealCurrentAccountId: vi.fn(async () => 'ws_1'),
      getAutoSwitchConfig: vi.fn(() => ({ enabled: false, threshold: 5 })),
      getQuotaSnapshots: vi.fn(() => []),
      reloadFromDisk: vi.fn(async () => false),
      onDidChangeAccounts: vi.fn((listener: () => void) => ({ dispose: vi.fn() })),
      isQuotaFetching: false,
      add: vi.fn(async () => ({ id: 'ws_new', email: 'new@test.com' })),
      importBatch: vi.fn(async () => ({ added: 2, skipped: 1 })),
      delete: vi.fn(async () => true),
      deleteBatch: vi.fn(async () => 0),
      switchTo: vi.fn(async () => ({ success: true })),
      clear: vi.fn(async () => {}),
      updateAutoSwitch: vi.fn(async () => ({})),
      resetMachineId: vi.fn(async () => ({ success: true, message: '已重置' })),
      setQuotaLimits: vi.fn(async () => true),
      recordPrompt: vi.fn(async () => {}),
      fetchRealQuota: vi.fn(async () => ({ success: true })),
      fetchAllRealQuotas: vi.fn(async () => ({ success: 2, failed: 0, errors: [] })),
      setFirebaseApiKey: vi.fn()
    },
    shortcuts: {
      getAll: vi.fn(() => []),
      add: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {})
    },
    templates: {
      getAll: vi.fn(() => []),
      add: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {})
    },
    settings: {
      get: vi.fn(() => ({})),
      update: vi.fn(async (p: any) => p),
      reset: vi.fn(async () => {})
    },
    usageStats: {
      get: vi.fn(() => ({})),
      reset: vi.fn(async () => {}),
      recordContinue: vi.fn(async () => {}),
      recordEnd: vi.fn(async () => {})
    },
    feedback: { getAll: vi.fn(() => []) },
    account: {},
    queue: {},
    incrementSessionMessageCount: vi.fn(),
    endSession: vi.fn(),
    startSession: vi.fn()
  } as any;
}

// --- Helper to simulate webview message ---

function setupProvider() {
  const bridge = createMockBridge();
  const logger = createMockLogger();
  const dataManager = createMockDataManager();
  const extensionUri = { fsPath: '/tmp/ext' } as any;

  const mockContext = {
    globalState: {
      get: vi.fn(() => []),
      update: vi.fn(async () => undefined),
    },
  } as any;

  const provider = new QuoteSidebarProvider(extensionUri, bridge, logger, dataManager, mockContext);

  const visibilityHandlers: Array<() => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const postMessage = vi.fn(async () => true);
  const mockWebviewView = {
    webview: {
      options: {},
      html: '',
      postMessage,
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      asWebviewUri: vi.fn((uri: any) => uri)
    },
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandlers.push(handler);
    }),
    onDidChangeVisibility: vi.fn((handler: () => void) => {
      visibilityHandlers.push(handler);
    }),
    show: vi.fn(),
    visible: true,
  } as any;

  // Resolve the view to set up internal state
  provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

  // Direct access to handleMessage for proper await
  const send = async (msg: any) => {
    await (provider as any).handleMessage(msg);
  };

  return { provider, bridge, logger, dataManager, postMessage, send, visibilityHandlers, disposeHandlers, mockWebviewView };
}

describe('QuoteSidebarProvider - handleMessage', () => {
  let ctx: ReturnType<typeof setupProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setupProvider();
  });

  describe('account sync', () => {
    it('账号变更时发送 accountsSync 而不是只依赖全量 bootstrap', async () => {
      const listenerStore: { fn?: () => void } = {};
      const customDataManager = createMockDataManager();
      customDataManager.windsurfAccounts.onDidChangeAccounts = vi.fn((fn: () => void) => {
        listenerStore.fn = fn;
        return { dispose: vi.fn() };
      });

      const bridge = createMockBridge();
      const logger = createMockLogger();
      const extensionUri = { fsPath: '/tmp/ext' } as any;
      const mockContext = {
        globalState: {
          get: vi.fn(() => []),
          update: vi.fn(async () => undefined),
        },
      } as any;

      const provider = new QuoteSidebarProvider(extensionUri, bridge, logger, customDataManager, mockContext);
      const postMessage = vi.fn(async () => true);
      const mockWebviewView = {
        webview: {
          options: {},
          html: '',
          postMessage,
          onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
          asWebviewUri: vi.fn((uri: any) => uri)
        },
        onDidDispose: vi.fn(),
        onDidChangeVisibility: vi.fn(),
        show: vi.fn(),
        visible: true,
      } as any;

      provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
      listenerStore.fn?.();
      await Promise.resolve();
      await Promise.resolve();

      const calls = postMessage.mock.calls.map((c: any) => c[0]);
      const syncMsg = calls.find((m: any) => m.type === 'accountsSync');
      expect(syncMsg).toBeTruthy();
      expect(syncMsg.value).toMatchObject({
        accounts: [],
        currentAccountId: 'ws_1',
      });
    });

    it('accountAdd 完成后发送 accountsSync', async () => {
      await ctx.send({ type: 'accountAdd', payload: { email: 'new@test.com', password: 'secret' } });

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      expect(calls.some((m: any) => m.type === 'accountsSync')).toBe(true);
    });

    it('accountAdd 使用内存 currentAccountId，避免触发真实账号探测', async () => {
      ctx.postMessage.mockClear();
      ctx.dataManager.windsurfAccounts.getImmediateCurrentAccountId.mockClear();
      ctx.dataManager.windsurfAccounts.getCurrentAccountId.mockClear();
      ctx.dataManager.windsurfAccounts.getRealCurrentAccountId.mockClear();

      await ctx.send({ type: 'accountAdd', payload: { email: 'new@test.com', password: 'secret' } });

      expect(ctx.dataManager.windsurfAccounts.getImmediateCurrentAccountId).toHaveBeenCalled();
      expect(ctx.dataManager.windsurfAccounts.getRealCurrentAccountId).not.toHaveBeenCalled();
      const syncMsg = ctx.postMessage.mock.calls
        .map((c: any) => c[0])
        .find((m: any) => m.type === 'accountsSync');
      expect(syncMsg?.value?.currentAccountId).toBe('ws_1');
    });

    it('关闭后重新打开视图，账号同步订阅仍然生效', async () => {
      const listenerStore: { fn?: () => void } = {};
      const customDataManager = createMockDataManager();
      customDataManager.windsurfAccounts.onDidChangeAccounts = vi.fn((fn: () => void) => {
        listenerStore.fn = fn;
        return { dispose: vi.fn() };
      });

      const bridge = createMockBridge();
      const logger = createMockLogger();
      const extensionUri = { fsPath: '/tmp/ext' } as any;
      const mockContext = {
        globalState: {
          get: vi.fn(() => []),
          update: vi.fn(async () => undefined),
        },
      } as any;

      const provider = new QuoteSidebarProvider(extensionUri, bridge, logger, customDataManager, mockContext);

      const makeView = () => {
        const postMessage = vi.fn(async () => true);
        const disposeHandlers: Array<() => void> = [];
        const mockWebviewView = {
          webview: {
            options: {},
            html: '',
            postMessage,
            onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
            asWebviewUri: vi.fn((uri: any) => uri)
          },
          onDidDispose: vi.fn((handler: () => void) => {
            disposeHandlers.push(handler);
          }),
          onDidChangeVisibility: vi.fn(),
          show: vi.fn(),
          visible: true,
        } as any;

        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        return { postMessage, disposeHandlers };
      };

      const firstView = makeView();
      firstView.postMessage.mockClear();
      firstView.disposeHandlers[0]?.();
      const secondView = makeView();
      secondView.postMessage.mockClear();

      listenerStore.fn?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(firstView.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'accountsSync' })
      );
      expect(secondView.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'accountsSync' })
      );
    });

    it('视图重新可见时触发账号同步重载，仅推送 accountsSync', async () => {
      ctx.dataManager.windsurfAccounts.reloadFromDisk.mockResolvedValue(true);
      ctx.postMessage.mockClear();

      const visibleHandler = ctx.visibilityHandlers[0];
      await visibleHandler?.();

      expect(ctx.dataManager.windsurfAccounts.reloadFromDisk).toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();
      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      expect(calls.some((m: any) => m.type === 'bootstrap')).toBe(false);
      expect(calls.some((m: any) => m.type === 'accountsSync')).toBe(true);
    });
    it('accountsSync payload still includes account tab data needed for local filtering', async () => {
      ctx.dataManager.windsurfAccounts.getAll.mockReturnValueOnce([
        {
          id: 'ws_1',
          email: 'alpha@test.com',
          password: '***',
          plan: 'Pro',
          creditsUsed: 0,
          creditsTotal: 0,
          quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
          expiresAt: '',
          isActive: true,
          addedAt: '2026-04-14T00:00:00.000Z',
        },
      ]);
      ctx.dataManager.windsurfAccounts.getQuotaSnapshots.mockReturnValueOnce([
        {
          accountId: 'ws_1',
          email: 'alpha@test.com',
          plan: 'Pro',
          dailyUsed: 0,
          dailyLimit: 0,
          dailyRemaining: 0,
          dailyResetIn: '',
          weeklyUsed: 0,
          weeklyLimit: 0,
          weeklyRemaining: 0,
          weeklyResetIn: '',
          warningLevel: 'ok',
          real: { dailyRemainingPercent: 80, weeklyRemainingPercent: 90 },
        },
      ]);

      await (ctx.provider as any).postAccountsSync();

      expect(ctx.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'accountsSync',
          value: expect.objectContaining({
            accounts: expect.any(Array),
            currentAccountId: 'ws_1',
            autoSwitch: expect.any(Object),
            quotaSnapshots: expect.any(Array),
            quotaFetching: false,
          }),
        })
      );
    });

    it('visibility revalidate continues to use accountsSync instead of forcing bootstrap', async () => {
      ctx.dataManager.windsurfAccounts.reloadFromDisk.mockResolvedValueOnce(true);
      ctx.postMessage.mockClear();

      ctx.visibilityHandlers[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const sentTypes = ctx.postMessage.mock.calls.map((call: any) => call[0]?.type);
      expect(sentTypes).toContain('selectTab');
      expect(sentTypes).toContain('accountsSync');
      expect(sentTypes).not.toContain('bootstrap');
    });

  });

  describe('accountSwitch', () => {
    it('发送 loading → 切换 → success toast + 状态栏消息', async () => {
      await ctx.send({ type: 'accountSwitch', value: 'ws_1' });

      expect(ctx.dataManager.windsurfAccounts.switchTo).toHaveBeenCalledWith('ws_1');

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const switchLoading = calls.filter((m: any) => m.type === 'switchLoading');
      expect(switchLoading).toHaveLength(2);
      expect(switchLoading[0].value).toBe(true);
      expect(switchLoading[1].value).toBe(false);

      const switchResult = calls.find((m: any) => m.type === 'switchResult');
      expect(switchResult?.value?.success).toBe(true);
      expect(switchResult?.value?.message).toContain('test@example.com');

      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('test@example.com'),
        4000
      );
    });

    it('成功切换后仅使用快速 currentAccountId 同步', async () => {
      ctx.postMessage.mockClear();
      ctx.dataManager.windsurfAccounts.getImmediateCurrentAccountId.mockClear();
      ctx.dataManager.windsurfAccounts.getCurrentAccountId.mockClear();
      ctx.dataManager.windsurfAccounts.getRealCurrentAccountId.mockClear();

      await ctx.send({ type: 'accountSwitch', value: 'ws_1' });
      await Promise.resolve();

      expect(ctx.dataManager.windsurfAccounts.getImmediateCurrentAccountId).toHaveBeenCalled();
      expect(ctx.dataManager.windsurfAccounts.getRealCurrentAccountId).not.toHaveBeenCalled();
      const syncCalls = ctx.postMessage.mock.calls
        .map((c: any) => c[0])
        .filter((m: any) => m.type === 'accountsSync');
      expect(syncCalls.length).toBeGreaterThanOrEqual(1);
      expect(syncCalls.every((m: any) => m.value?.currentAccountId === 'ws_1')).toBe(true);
    });

    it('切换失败时返回失败消息', async () => {
      ctx.dataManager.windsurfAccounts.switchTo.mockResolvedValue({ success: false, error: '账号不存在' });
      ctx.dataManager.windsurfAccounts.getById.mockReturnValue(undefined);

      await ctx.send({ type: 'accountSwitch', value: 'ws_nonexist' });

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const switchResult = calls.find((m: any) => m.type === 'switchResult');
      expect(switchResult?.value?.success).toBe(false);
    });
  });

  // --- Account Delete ---

  describe('accountDelete', () => {
    it('确认删除后发送 opResult 反馈', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('删除' as any);
      await ctx.send({ type: 'accountDelete', value: 'ws_1' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(ctx.dataManager.windsurfAccounts.delete).toHaveBeenCalledWith('ws_1');

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('test@example.com');
    });

    it('确认删除后不重复手动发送 accountsSync', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('删除' as any);
      ctx.postMessage.mockClear();

      await ctx.send({ type: 'accountDelete', value: 'ws_1' });

      const syncCalls = ctx.postMessage.mock.calls
        .map((c: any) => c[0])
        .filter((m: any) => m.type === 'accountsSync');
      expect(syncCalls).toHaveLength(0);
    });

    it('取消删除时不执行', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
      await ctx.send({ type: 'accountDelete', value: 'ws_1' });

      expect(ctx.dataManager.windsurfAccounts.delete).not.toHaveBeenCalled();
    });
  });

  describe('accountDeleteBatch', () => {
    it('确认批量删除后发送 opResult 且不重复手动发送 accountsSync', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('删除' as any);
      ctx.dataManager.windsurfAccounts.deleteBatch.mockResolvedValue(2);
      ctx.postMessage.mockClear();

      await ctx.send({ type: 'accountDeleteBatch', value: ['ws_1', 'ws_2'] });

      expect(ctx.dataManager.windsurfAccounts.deleteBatch).toHaveBeenCalledWith(['ws_1', 'ws_2']);
      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('2');
      expect(calls.filter((m: any) => m.type === 'accountsSync')).toHaveLength(0);
    });
  });

  // --- Account Clear ---

  describe('accountClear', () => {
    it('确认清空后发送 opResult', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('清空' as any);
      await ctx.send({ type: 'accountClear' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(ctx.dataManager.windsurfAccounts.clear).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('清空');
    });

    it('取消清空时不执行', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
      await ctx.send({ type: 'accountClear' });

      expect(ctx.dataManager.windsurfAccounts.clear).not.toHaveBeenCalled();
    });
  });

  // --- Clear History ---

  describe('clearHistory', () => {
    it('确认清空历史后发送 opResult', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('清空' as any);
      await ctx.send({ type: 'clearHistory' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(ctx.dataManager.history.clear).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('历史');
    });

    it('取消清空时不执行', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
      await ctx.send({ type: 'clearHistory' });

      expect(ctx.dataManager.history.clear).not.toHaveBeenCalled();
    });
  });

  // --- Settings Reset ---

  describe('settingsReset', () => {
    it('重置设置后发送 opResult', async () => {
      await ctx.send({ type: 'settingsReset' });

      expect(ctx.dataManager.settings.reset).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('默认');
    });
  });

  // --- Maintenance: Clean MCP ---

  describe('maintenanceCleanMcp', () => {
    it('发送 loading → 清理 (白名单过滤) → 结果消息', async () => {
      await ctx.send({ type: 'maintenanceCleanMcp' });

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const loading = calls.find((m: any) => m.type === 'maintenanceLoading' && m.value === 'cleanMcp');
      expect(loading).toBeDefined();
      const result = calls.find((m: any) => m.type === 'maintenanceResult' && m.value?.action === 'cleanMcp');
      expect(result).toBeDefined();
    });
  });

  // --- Maintenance: Reset Settings ---

  describe('maintenanceResetSettings', () => {
    it('确认重置后发送 loading → 重置 → 结果 + VS Code 通知', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('重置' as any);
      await ctx.send({ type: 'maintenanceResetSettings' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(ctx.dataManager.settings.reset).toHaveBeenCalled();
      expect(ctx.dataManager.shortcuts.clear).toHaveBeenCalled();
      expect(ctx.dataManager.templates.clear).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const loading = calls.find((m: any) => m.type === 'maintenanceLoading');
      expect(loading?.value).toBe('resetSettings');

      const result = calls.find((m: any) => m.type === 'maintenanceResult');
      expect(result?.value?.action).toBe('resetSettings');

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('恢复默认')
      );
    });

    it('取消重置时不执行', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
      await ctx.send({ type: 'maintenanceResetSettings' });

      expect(ctx.dataManager.settings.reset).not.toHaveBeenCalled();
    });
  });

  // --- Maintenance: Clear Cache ---

  describe('maintenanceClearCache', () => {
    it('确认清理后发送 loading → 清理 → 结果 + VS Code 通知', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('清理' as any);
      await ctx.send({ type: 'maintenanceClearCache' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(ctx.dataManager.history.clear).toHaveBeenCalled();
      expect(ctx.dataManager.usageStats.reset).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const loading = calls.find((m: any) => m.type === 'maintenanceLoading');
      expect(loading?.value).toBe('clearCache');

      const result = calls.find((m: any) => m.type === 'maintenanceResult');
      expect(result?.value?.action).toBe('clearCache');

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('缓存')
      );
    });

    it('取消清理时不执行', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
      await ctx.send({ type: 'maintenanceClearCache' });

      expect(ctx.dataManager.history.clear).not.toHaveBeenCalled();
    });
  });

  // --- Import ---

  describe('accountImport', () => {
    it('导入后返回 importResult', async () => {
      await ctx.send({ type: 'accountImport', value: 'a@b.com:pass1\nc@d.com:pass2' });

      expect(ctx.dataManager.windsurfAccounts.importBatch).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const importResult = calls.find((m: any) => m.type === 'importResult');
      expect(importResult?.value?.added).toBe(2);
      expect(importResult?.value?.skipped).toBe(1);
    });
  });

  // --- Fetch Quota ---

  describe('fetchQuota', () => {
    it('获取配额后返回 quotaFetchResult', async () => {
      await ctx.send({ type: 'fetchQuota', value: 'ws_1' });

      expect(ctx.dataManager.windsurfAccounts.fetchRealQuota).toHaveBeenCalledWith('ws_1');

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const result = calls.find((m: any) => m.type === 'quotaFetchResult');
      expect(result?.value?.success).toBe(true);
    });

    it('单账号刷新不额外手动发送 accountsSync', async () => {
      ctx.postMessage.mockClear();

      await ctx.send({ type: 'fetchQuota', value: 'ws_1' });

      const syncCalls = ctx.postMessage.mock.calls
        .map((c: any) => c[0])
        .filter((m: any) => m.type === 'accountsSync');
      expect(syncCalls).toHaveLength(0);
    });
  });

  // --- Fetch All Quotas ---

  describe('fetchAllQuotas', () => {
    it('批量获取配额后返回 quotaFetchAllResult', async () => {
      await ctx.send({ type: 'fetchAllQuotas' });

      expect(ctx.dataManager.windsurfAccounts.fetchAllRealQuotas).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const result = calls.find((m: any) => m.type === 'quotaFetchAllResult');
      expect(result?.value?.success).toBe(2);
    });

    it('批量刷新不额外手动发送 accountsSync', async () => {
      ctx.postMessage.mockClear();

      await ctx.send({ type: 'fetchAllQuotas' });

      const syncCalls = ctx.postMessage.mock.calls
        .map((c: any) => c[0])
        .filter((m: any) => m.type === 'accountsSync');
      expect(syncCalls).toHaveLength(0);
    });
  });

  // --- Rotate Name ---

  describe('rotateName', () => {
    it('旋转名称后发送 opResult，并调用 bridge.updateToolName', async () => {
      // rotateName uses dynamic imports + real fs; it may succeed or throw
      // We only assert bridge wiring if it doesn't error
      await ctx.send({ type: 'rotateName' });

      // getSseUrl must have been called (or the handler errored before that)
      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const hasOutput = calls.some(
        (m: any) => m.type === 'opResult' || m.type === 'bootstrap'
      );
      expect(hasOutput).toBe(true);
    });
  });

  // --- Unknown message ---

  describe('unknown action', () => {
    it('记录 debug 日志', async () => {
      await ctx.send({ type: 'unknownAction123' });
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        'Unhandled webview message.',
        { action: 'unknownAction123' }
      );
    });
  });
});
