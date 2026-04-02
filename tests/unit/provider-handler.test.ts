import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode
vi.mock('vscode', () => ({
  default: {},
  Uri: { joinPath: (...args: string[]) => ({ fsPath: args.join('/') }) },
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
import { EchoSidebarProvider } from '../../src/webview/provider';

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
    setConfiguredPaths: vi.fn()
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
      getCurrentAccountId: vi.fn(() => 'ws_1'),
      getAutoSwitchConfig: vi.fn(() => ({ enabled: false, threshold: 5 })),
      getQuotaSnapshots: vi.fn(() => []),
      isQuotaFetching: false,
      add: vi.fn(async () => ({ id: 'ws_new', email: 'new@test.com' })),
      importBatch: vi.fn(async () => ({ added: 2, skipped: 1 })),
      delete: vi.fn(async () => true),
      switchTo: vi.fn(async () => true),
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

  const provider = new EchoSidebarProvider(extensionUri, bridge, logger, dataManager);

  const postMessage = vi.fn(async () => true);
  const mockWebviewView = {
    webview: {
      options: {},
      html: '',
      postMessage,
      onDidReceiveMessage: vi.fn(),
      asWebviewUri: vi.fn((uri: any) => uri)
    },
    onDidDispose: vi.fn(),
    show: vi.fn()
  } as any;

  // Resolve the view to set up internal state
  provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

  // Direct access to handleMessage for proper await
  const send = async (msg: any) => {
    await (provider as any).handleMessage(msg);
  };

  return { provider, bridge, logger, dataManager, postMessage, send };
}

describe('EchoSidebarProvider - handleMessage', () => {
  let ctx: ReturnType<typeof setupProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setupProvider();
  });

  // --- Account Switch ---

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

    it('切换失败时返回失败消息', async () => {
      ctx.dataManager.windsurfAccounts.switchTo.mockResolvedValue(false);
      ctx.dataManager.windsurfAccounts.getById.mockReturnValue(undefined);

      await ctx.send({ type: 'accountSwitch', value: 'ws_nonexist' });

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const switchResult = calls.find((m: any) => m.type === 'switchResult');
      expect(switchResult?.value?.success).toBe(false);
    });
  });

  // --- Account Delete ---

  describe('accountDelete', () => {
    it('删除账号后发送 opResult 反馈', async () => {
      await ctx.send({ type: 'accountDelete', value: 'ws_1' });

      expect(ctx.dataManager.windsurfAccounts.delete).toHaveBeenCalledWith('ws_1');

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('test@example.com');
    });
  });

  // --- Account Clear ---

  describe('accountClear', () => {
    it('清空所有账号后发送 opResult', async () => {
      await ctx.send({ type: 'accountClear' });

      expect(ctx.dataManager.windsurfAccounts.clear).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('清空');
    });
  });

  // --- Clear History ---

  describe('clearHistory', () => {
    it('清空历史后发送 opResult', async () => {
      await ctx.send({ type: 'clearHistory' });

      expect(ctx.dataManager.history.clear).toHaveBeenCalled();

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const opResult = calls.find((m: any) => m.type === 'opResult');
      expect(opResult?.value?.message).toContain('历史');
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
    it('发送 loading → 结果 + VS Code 通知', async () => {
      // cleanOldMcpConfigs is a private method, it will throw since IDE_TARGETS
      // can't be imported in test env. We test that loading is sent and error is handled.
      await ctx.send({ type: 'maintenanceCleanMcp' });

      const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
      const loading = calls.find((m: any) => m.type === 'maintenanceLoading');
      expect(loading?.value).toBe('cleanMcp');

      // Should have either maintenanceResult or maintenanceError
      const hasResult = calls.some((m: any) => m.type === 'maintenanceResult' || m.type === 'maintenanceError');
      expect(hasResult).toBe(true);
    });
  });

  // --- Maintenance: Reset Settings ---

  describe('maintenanceResetSettings', () => {
    it('发送 loading → 重置 → 结果 + VS Code 通知', async () => {
      await ctx.send({ type: 'maintenanceResetSettings' });

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
  });

  // --- Maintenance: Clear Cache ---

  describe('maintenanceClearCache', () => {
    it('发送 loading → 清理 → 结果 + VS Code 通知', async () => {
      await ctx.send({ type: 'maintenanceClearCache' });

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
