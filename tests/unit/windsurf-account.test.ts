import * as vscode from 'vscode';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WindsurfPatchService } from '../../src/adapters/windsurf-patch';
import type { RealQuotaInfo } from '../../src/core/contracts';

// Mock vscode
vi.mock('vscode', () => ({
  default: {},
  env: {
    appName: 'Windsurf',
  },
  workspace: {
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  window: {
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  RelativePattern: class {
    constructor(public base: string, public pattern: string) {}
  },
  EventEmitter: class<T = void> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire(value: T): void { this.listeners.forEach((listener) => listener(value)); }
    dispose(): void { this.listeners = []; }
  },
  Uri: { joinPath: (...args: string[]) => ({ fsPath: args.join('/') }) },
  commands: {
    getCommands: vi.fn(async () => [
      'windsurf.provideAuthTokenToAuthProvider',
      'windsurf.provideAuthTokenToAuthProviderWithShit',
    ]),
    executeCommand: vi.fn(async () => undefined)
  }
}));

// Mock WindsurfAuth so signIn/registerUser don't hit network
vi.mock('../../src/adapters/windsurf-auth', () => ({
  WindsurfAuth: class {
    signIn = vi.fn(async () => ({ idToken: 'mock-token' }));
    registerUser = vi.fn(async () => ({
      apiKey: 'mock-api-key',
      name: 'Mock User',
      apiServerUrl: 'https://server.codeium.com',
    }));
    resolveAuth1Token = vi.fn(async () => ({
      sessionToken: 'mock-session-token',
      apiKey: 'mock-api-key',
      name: 'Mock User',
      email: 'mock@email.com',
      accountId: 'mock-account-id',
    }));
    isTransientNetworkError = vi.fn(() => false);
    setApiKey = vi.fn();
  }
}));

// Mock WindsurfPatchService so patch check succeeds in test env
vi.mock('../../src/adapters/windsurf-patch', () => ({
  WindsurfPatchService: {
    checkAndApply: vi.fn(async () => ({ success: true, needsRestart: false })),
    isPatchApplied: vi.fn(async () => ({ applied: true, extensionPath: '/mock/extension.js' })),
    applyPatch: vi.fn(async () => ({ success: true, needsRestart: false })),
    findExtensionPath: vi.fn(() => '/mock/extension.js'),
    getPermissionHint: vi.fn(() => '')
  }
}));

// Mock fs (safeWriteJson uses rename + copyFile for atomic writes)
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  unlink: vi.fn()
}));

import { WindsurfAccountManager } from '../../src/core/windsurf-account';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

const mockContext = {
  globalStorageUri: { fsPath: '/tmp/test-storage' }
} as any;

type TestQuotaFetcher = {
  fetchCurrentRuntimeUserFromAuthStatus: ReturnType<typeof vi.fn>;
  fetchQuota: ReturnType<typeof vi.fn>;
};

function makeRealQuota(overrides: Partial<RealQuotaInfo> = {}): RealQuotaInfo {
  return {
    planName: 'Pro',
    billingStrategy: 'quota',
    dailyRemainingPercent: 100,
    weeklyRemainingPercent: 100,
    dailyResetAtUnix: 0,
    weeklyResetAtUnix: 0,
    messages: 500,
    usedMessages: 0,
    remainingMessages: 500,
    flowActions: 0,
    usedFlowActions: 0,
    remainingFlowActions: 0,
    overageBalanceMicros: 0,
    fetchedAt: new Date().toISOString(),
    source: 'api',
    ...overrides,
  };
}

function pastResetAtUnix(): number {
  return Math.floor(Date.now() / 1000) - 3600;
}

function replaceQuotaProtoFetcher(manager: WindsurfAccountManager, fetchFromLocalProto: unknown): void {
  const quotaFetcher = Reflect.get(manager, 'quotaFetcher');
  if (typeof quotaFetcher === 'object' && quotaFetcher !== null) {
    Reflect.set(quotaFetcher, 'fetchFromLocalProto', fetchFromLocalProto);
  }
}

describe('WindsurfAccountManager', () => {
  let manager: WindsurfAccountManager;

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.commands.getCommands as any).mockResolvedValue([
      'windsurf.provideAuthTokenToAuthProvider',
      'windsurf.provideAuthTokenToAuthProviderWithShit',
    ]);
    (WindsurfPatchService.isPatchApplied as any).mockResolvedValue({
      applied: true,
      extensionPath: '/mock/extension.js',
    });
    (WindsurfPatchService.checkAndApply as any).mockResolvedValue({
      success: true,
      needsRestart: false,
    });
    (fs.readFile as any).mockRejectedValue(new Error('ENOENT'));
    (fs.writeFile as any).mockResolvedValue(undefined);
    (fs.mkdir as any).mockResolvedValue(undefined);
    manager = new WindsurfAccountManager(mockContext, mockLogger);
    (manager as any).quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus = vi.fn(async () => ({
      success: false,
      source: 'authstatus',
      error: 'windsurfAuthStatus 未返回当前登录邮箱',
      fetchedAt: new Date().toISOString(),
    }));
    (manager as any).quotaFetcher.fetchFromLocalApiKey = vi.fn(async () => ({
      success: false,
      source: 'apikey',
      error: 'GetUserStatus 返回空数据',
      fetchedAt: new Date().toISOString(),
    }));
  });

  describe('initialize + CRUD', () => {
    it('初始化空状态', async () => {
      await manager.initialize();
      expect(manager.getAll()).toEqual([]);
      expect(manager.getCurrentAccount()).toBeUndefined();
    });

    it('添加账号 — 第一个自动激活', async () => {
      await manager.initialize();
      const account = await manager.add('test@example.com', 'pass123');
      expect(account.email).toBe('test@example.com');
      expect(account.isActive).toBe(true);
      expect(account.quota.dailyUsed).toBe(0);
      expect(account.quota.weeklyUsed).toBe(0);
      expect(manager.getCurrentAccount()?.id).toBe(account.id);
    });

    it('首次写入后持久化 revision 和 updatedAt', async () => {
      await manager.initialize();
      await manager.add('rev@test.com', 'p');

      const writeCall = (fs.writeFile as any).mock.calls.find(
        ([filePath]: [string]) => filePath.endsWith('windsurf-accounts.json.tmp')
      );

      expect(writeCall).toBeTruthy();
      const [, rawJson] = writeCall;
      const payload = JSON.parse(rawJson);

      expect(payload.revision).toBe(1);
      expect(typeof payload.updatedAt).toBe('string');
      expect(payload.accounts).toHaveLength(1);
      expect(payload.currentId).toBe(payload.accounts[0].id);
    });

    it('reloadFromDisk 在磁盘 revision 更新时刷新内存', async () => {
      await manager.initialize();
      await manager.add('first@test.com', 'p');

      const diskPayload = {
        revision: 99,
        updatedAt: '2026-04-13T00:00:00.000Z',
        currentId: 'ws_disk',
        autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
        accounts: [{
          id: 'ws_disk',
          email: 'disk@test.com',
          password: 'p',
          plan: 'Free',
          creditsUsed: 0,
          creditsTotal: 0,
          quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
          expiresAt: '',
          isActive: true,
          addedAt: '2026-04-13T00:00:00.000Z'
        }]
      };

      (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
      const changed = await manager.reloadFromDisk();

      expect(changed).toBe(true);
      expect(manager.getAll().map((a) => a.email)).toEqual(['disk@test.com']);
      expect(manager.getCurrentAccountId()).toBe('ws_disk');
    });

    it('delete 在写入前先重载较新的磁盘快照，避免旧数据回写', async () => {
      const staleManager = new WindsurfAccountManager(mockContext, mockLogger);
      await staleManager.initialize();

      const diskPayload = {
        revision: 3,
        updatedAt: '2026-04-13T00:00:00.000Z',
        currentId: 'ws_b',
        autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
        accounts: [
          {
            id: 'ws_b',
            email: 'b@test.com',
            password: 'p',
            plan: 'Free',
            creditsUsed: 0,
            creditsTotal: 0,
            quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
            expiresAt: '',
            isActive: true,
            addedAt: '2026-04-13T00:00:00.000Z'
          }
        ]
      };

      (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
      const deleted = await staleManager.delete('ws_b');

      expect(deleted).toBe(true);

      const writeCall = (fs.writeFile as any).mock.calls.find(
        ([filePath]: [string]) => filePath.endsWith('windsurf-accounts.json.tmp')
      );
      const [, rawJson] = writeCall;
      const payload = JSON.parse(rawJson);
      expect(payload.accounts).toEqual([]);
      expect(payload.revision).toBe(4);
    });

    it('本地写入后触发 onDidChangeAccounts', async () => {
      await manager.initialize();
      const listener = vi.fn();
      const disposable = manager.onDidChangeAccounts(listener);

      await manager.add('listener@test.com', 'p');

      expect(listener).toHaveBeenCalledTimes(1);
      disposable.dispose();
    });

    it('检测到更高 revision 的外部变更时触发 onDidChangeAccounts', async () => {
      await manager.initialize();
      const listener = vi.fn();
      const disposable = manager.onDidChangeAccounts(listener);

      const diskPayload = {
        revision: 10,
        updatedAt: '2026-04-13T00:00:00.000Z',
        currentId: 'ws_ext',
        autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
        accounts: [{
          id: 'ws_ext',
          email: 'external@test.com',
          password: 'p',
          plan: 'Free',
          creditsUsed: 0,
          creditsTotal: 0,
          quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
          expiresAt: '',
          isActive: true,
          addedAt: '2026-04-13T00:00:00.000Z'
        }]
      };

      (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
      await manager.reloadFromDisk();

      expect(listener).toHaveBeenCalledTimes(1);
      disposable.dispose();
    });

    it('starts a file watcher that reloads accounts on external changes', async () => {
      const watcher = {
        onDidChange: vi.fn((fn: () => void) => {
          (watcher as any).changeHandler = fn;
          return { dispose: vi.fn() };
        }),
        onDidCreate: vi.fn((fn: () => void) => {
          (watcher as any).createHandler = fn;
          return { dispose: vi.fn() };
        }),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      };

      (vscode.workspace.createFileSystemWatcher as any).mockReturnValueOnce(watcher);

      await manager.initialize();
      manager.startWatching();

      const diskPayload = {
        revision: 2,
        updatedAt: '2026-04-14T00:00:00.000Z',
        currentId: 'ws_ext',
        autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
        accounts: [{
          id: 'ws_ext',
          email: 'external@test.com',
          password: 'p',
          plan: 'Free',
          creditsUsed: 0,
          creditsTotal: 0,
          quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
          expiresAt: '',
          isActive: true,
          addedAt: '2026-04-14T00:00:00.000Z'
        }]
      };

      (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
      await (watcher as any).changeHandler?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(manager.getAll().map((a) => a.email)).toEqual(['external@test.com']);
    });

    it('loads legacy persisted data without revision as revision 0', async () => {
      const legacyPayload = {
        updatedAt: '2026-04-14T00:00:00.000Z',
        currentId: 'ws_legacy',
        accounts: [{
          id: 'ws_legacy',
          email: 'legacy@test.com',
          password: 'p',
          plan: 'Free',
          creditsUsed: 0,
          creditsTotal: 0,
          quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
          expiresAt: '',
          isActive: true,
          addedAt: '2026-04-14T00:00:00.000Z'
        }]
      };

      (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(legacyPayload));
      await manager.initialize();

      expect(manager.getAll().map((a) => a.email)).toEqual(['legacy@test.com']);
      expect(manager.getCurrentAccountId()).toBe('ws_legacy');
    });

    it('uses current disk revision when saving after initialize', async () => {
      const diskPayload = {
        revision: 7,
        updatedAt: '2026-04-14T00:00:00.000Z',
        currentId: undefined,
        autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
        accounts: []
      };

      (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));

      await manager.initialize();
      await manager.add('next@test.com', 'p');

      const writeCall = (fs.writeFile as any).mock.calls.find(
        ([filePath]: [string]) => filePath.endsWith('windsurf-accounts.json.tmp')
      );
      const [, rawJson] = writeCall;
      expect(JSON.parse(rawJson).revision).toBe(8);
    });

    it('删除当前账号 — 自动切换到下一个', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p1');
      const a2 = await manager.add('a2@test.com', 'p2');
      expect(manager.getCurrentAccountId()).toBe(a1.id);
      await manager.delete(a1.id);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('删除不存在的账号返回 false', async () => {
      await manager.initialize();
      expect(await manager.delete('nonexistent')).toBe(false);
    });

    it('清空所有账号', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      await manager.add('b@test.com', 'p');
      await manager.clear();
      expect(manager.getAll()).toEqual([]);
    });
  });

  describe('批量导入', () => {
    it('正常导入 email----password 格式', async () => {
      await manager.initialize();
      const result = await manager.importBatch('a@test.com----pass1\nb@test.com----pass2');
      expect(result.added).toBe(2);
      expect(result.skipped).toBe(0);
      expect(manager.getAll()).toHaveLength(2);
    });

    it('跳过重复邮箱', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'pass');
      const result = await manager.importBatch('a@test.com----pass1\nb@test.com----pass2');
      expect(result.added).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('跳过格式错误的行', async () => {
      await manager.initialize();
      const result = await manager.importBatch('invalid-line\n\na@test.com----pass1');
      expect(result.added).toBe(1);
      // 格式错误的行被 skipped
      expect(result.skipped).toBe(1);
    });
  });

  describe('配额追踪', () => {
    it('recordPrompt 递增日/周/总额度', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      await manager.setQuotaLimits(account.id, 50, 200);
      await manager.recordPrompt();

      const updated = manager.getAll()[0];
      expect(updated.quota.dailyUsed).toBe(1);
      expect(updated.quota.weeklyUsed).toBe(1);
      expect(updated.creditsUsed).toBe(1);
    });

    it('setQuotaLimits 设置日/周上限并初始化重置时间', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      const ok = await manager.setQuotaLimits(account.id, 30, 150);
      expect(ok).toBe(true);

      const updated = manager.getAll()[0];
      expect(updated.quota.dailyLimit).toBe(30);
      expect(updated.quota.weeklyLimit).toBe(150);
      expect(updated.quota.dailyResetAt).toBeTruthy();
      expect(updated.quota.weeklyResetAt).toBeTruthy();
    });

    it('setQuotaLimits 不存在的账号返回 false', async () => {
      await manager.initialize();
      expect(await manager.setQuotaLimits('nonexistent', 10, 50)).toBe(false);
    });

    it('recordPrompt 无当前账号时不报错', async () => {
      await manager.initialize();
      await expect(manager.recordPrompt()).resolves.not.toThrow();
    });

    it('recordPrompt 默认记到 runtime 实际账号而不是陈旧 currentAccountId', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p1');
      const a2 = await manager.add('a2@test.com', 'p2');
      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));

      await manager.recordPrompt();

      const updatedA1 = manager.getById(a1.id)!;
      const updatedA2 = manager.getById(a2.id)!;
      expect(updatedA1.quota.dailyUsed).toBe(0);
      expect(updatedA2.quota.dailyUsed).toBe(1);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('getRealCurrentAccountId 优先使用 authstatus，避免被滞后 proto 误导', async () => {
      await manager.initialize();
      await manager.add('a1@test.com', 'p1');
      const a2 = await manager.add('a2@test.com', 'p2');
      (manager as any).quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus = vi.fn(async () => ({
        success: true,
        source: 'authstatus',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a1@test.com',
        fetchedAt: new Date().toISOString(),
      }));

      await expect(manager.getRealCurrentAccountId()).resolves.toBe(a2.id);
    });
  });

  describe('配额快照', () => {
    it('生成正确的快照数据', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      await manager.setQuotaLimits(account.id, 50, 200);
      await manager.recordPrompt();
      await manager.recordPrompt();

      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].dailyUsed).toBe(2);
      expect(snapshots[0].dailyRemaining).toBe(48);
      expect(snapshots[0].weeklyRemaining).toBe(198);
      expect(snapshots[0].warningLevel).toBe('ok');
    });

    it('配额用尽时 warningLevel 为 critical', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      await manager.setQuotaLimits(account.id, 2, 200);
      await manager.recordPrompt();
      await manager.recordPrompt();

      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots[0].warningLevel).toBe('critical');
      expect(snapshots[0].dailyRemaining).toBe(0);
    });

    it('无配额限制时 warningLevel 为 ok', async () => {
      await manager.initialize();
      await manager.add('test@test.com', 'p');
      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots[0].warningLevel).toBe('ok');
    });
  });

  describe('自动切换', () => {
    it('未启用时不切换', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      expect(await manager.autoSwitchIfNeeded()).toBe(false);
    });

    it('日配额触顶时自动切换到有余量的账号', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p');
      const a2 = await manager.add('a2@test.com', 'p');
      const fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      fetchFromLocalProto.mockImplementationOnce(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a1@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      replaceQuotaProtoFetcher(manager, fetchFromLocalProto);
      await manager.setQuotaLimits(a1.id, 5, 100);
      await manager.setQuotaLimits(a2.id, 50, 200);
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });

      // 消耗 a1 的日配额至阈值
      for (let i = 0; i < 5; i++) await manager.recordPrompt(a1.id);

      const switched = await manager.autoSwitchIfNeeded();
      expect(switched).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('无可用账号时不切换', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p');
      await manager.setQuotaLimits(a1.id, 5, 100);
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });

      for (let i = 0; i < 5; i++) await manager.recordPrompt(a1.id);

      const switched = await manager.autoSwitchIfNeeded();
      expect(switched).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Auto-switch: no available account with sufficient quota.'
      );
    });
  });

  describe('数据迁移 (旧数据无 quota 字段)', () => {
    it('load 时自动补充 quota 默认值', async () => {
      const oldData = {
        accounts: [{
          id: 'old_1',
          email: 'old@test.com',
          password: 'p',
          plan: 'Pro',
          creditsUsed: 10,
          creditsTotal: 500,
          expiresAt: '',
          isActive: true,
          addedAt: '2025-01-01T00:00:00.000Z'
        }],
        currentId: 'old_1'
      };
      (fs.readFile as any).mockResolvedValue(JSON.stringify(oldData));

      await manager.initialize();
      const accounts = manager.getAll();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].quota).toBeDefined();
      expect(accounts[0].quota.dailyUsed).toBe(0);
      expect(accounts[0].quota.dailyLimit).toBe(0);
    });
  });

  describe('账号切换', () => {
    it('切换到存在的账号', async () => {
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');
      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'b@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      void a1;
      const result = await manager.switchTo(a2.id);
      expect(result.success).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
    });

    it('已安装无感补丁时优先走 patched command 直接注入 apiKey session', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');
      (manager as any).quotaFetcher.fetchFromLocalProto = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          source: 'proto',
          userEmail: 'a@test.com',
          fetchedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          success: true,
          source: 'proto',
          userEmail: 'b@test.com',
          fetchedAt: new Date().toISOString(),
        });

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(true);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'windsurf.provideAuthTokenToAuthProviderWithShit',
        {
          apiKey: 'mock-api-key',
          name: 'Mock User',
          apiServerUrl: 'https://server.codeium.com',
        },
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'windsurf.provideAuthTokenToAuthProvider',
        'mock-token',
      );
    });

    it('未安装无感补丁且自动写入成功时要求重启后再切号', async () => {
      (vscode.commands.getCommands as any).mockResolvedValue([
        'windsurf.provideAuthTokenToAuthProvider',
      ]);
      (WindsurfPatchService.isPatchApplied as any).mockResolvedValue({
        applied: false,
        extensionPath: '/mock/extension.js',
      });
      (WindsurfPatchService.checkAndApply as any).mockResolvedValue({
        success: true,
        needsRestart: true,
      });

      await manager.initialize();
      await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请重启 Windsurf');
      expect(WindsurfPatchService.checkAndApply).toHaveBeenCalled();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('切换到不存在的账号返回 false', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      const result = await manager.switchTo('nonexistent');
      expect(result.success).toBe(false);
    });

    it('切换后若本地运行时仍是旧账号，则返回失败且不污染 currentAccountId', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');

      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a@test.com',
        fetchedAt: new Date().toISOString(),
      }));

      const resultPromise = manager.switchTo(a2.id);
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.pendingRuntimeVerification).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a1.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Windsurf runtime account verification pending after switch.',
        expect.objectContaining({
          expectedEmail: 'b@test.com',
          source: 'proto',
          observedEmail: 'a@test.com',
          attempts: expect.arrayContaining([
            expect.objectContaining({ source: 'authstatus', verified: false }),
            expect.objectContaining({ source: 'proto', verified: false, observedEmail: 'a@test.com' }),
            expect.objectContaining({ source: 'apikey', verified: false }),
          ]),
        }),
      );
    });

    it('切换后若 proto 仍是旧账号但 apikey 已切到目标账号，则按真实运行时判定为成功', async () => {
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');

      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchFromLocalApiKey = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          source: 'apikey',
          userEmail: 'a@test.com',
          fetchedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          success: true,
          source: 'apikey',
          userEmail: 'b@test.com',
          fetchedAt: new Date().toISOString(),
        });

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(manager.getById(a1.id)?.isActive).toBe(false);
      expect(manager.getById(a2.id)?.isActive).toBe(true);
    });

    it('切换后若 proto 仍是旧账号但 authstatus 已切到目标账号，则按当前认证态判定为成功', async () => {
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');

      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus = vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          source: 'authstatus',
          userEmail: 'a@test.com',
          error: '当前 Windsurf 登录用户 (a@test.com) 与目标账号 (b@test.com) 不匹配',
          fetchedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          success: true,
          source: 'authstatus',
          userEmail: 'b@test.com',
          fetchedAt: new Date().toISOString(),
        });

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(manager.getById(a1.id)?.isActive).toBe(false);
      expect(manager.getById(a2.id)?.isActive).toBe(true);
    });

    it('注入成功但运行时信号仍是旧账号时标记 pending，不误报失败', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');

      (manager as any).quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus = vi.fn(async () => ({
        success: false,
        source: 'authstatus',
        userEmail: 'a@test.com',
        error: '当前 Windsurf 登录用户 (a@test.com) 与目标账号 (b@test.com) 不匹配',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'legacy@test.com',
        fetchedAt: new Date().toISOString(),
      }));

      const resultPromise = manager.switchTo(a2.id);
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.pendingRuntimeVerification).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a1.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Windsurf runtime account verification pending after switch.',
        expect.objectContaining({
          source: 'authstatus',
          observedEmail: 'a@test.com',
          attempts: expect.arrayContaining([
            expect.objectContaining({ source: 'authstatus', observedEmail: 'a@test.com' }),
            expect.objectContaining({ source: 'proto', observedEmail: 'legacy@test.com' }),
          ]),
        }),
      );
    });

    it('Firebase 设备限流时提示可尝试重置机器 ID', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');
      (manager as any).auth.signIn.mockRejectedValueOnce(
        new Error('Firebase 登录失败: TOO_MANY_ATTEMPTS_TRY_LATER'),
      );

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('重置机器 ID');
      expect(result.error).toContain('Firebase 登录限流');
    });

    it('账号密码错误时不给出重置机器 ID 建议', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');
      (manager as any).auth.signIn.mockRejectedValueOnce(
        new Error('Firebase 登录失败: INVALID_LOGIN_CREDENTIALS'),
      );

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('账号或密码可能不正确');
      expect(result.error).not.toContain('重置机器 ID');
    });

    it('上游登录报错但运行时已是目标账号时，按真实运行时判定为切换成功', async () => {
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');
      (manager as any).auth.signIn.mockRejectedValueOnce(
        new Error('Firebase 登录失败: INVALID_LOGIN_CREDENTIALS'),
      );
      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'b@test.com',
        fetchedAt: new Date().toISOString(),
      }));

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(manager.getById(a1.id)?.isActive).toBe(false);
      expect(manager.getById(a2.id)?.isActive).toBe(true);
    });

    it('注入命令返回错误但运行时已切到目标账号时，按真实运行时判定为成功', async () => {
      await manager.initialize();
      const a1 = await manager.add('a@test.com', 'p');
      const a2 = await manager.add('b@test.com', 'p');
      (vscode.commands.getCommands as any).mockResolvedValue([
        'windsurf.provideAuthTokenToAuthProvider',
      ]);
      (vscode.commands.executeCommand as any).mockResolvedValueOnce({
        error: { message: 'native failed' },
      });
      (manager as any).quotaFetcher.fetchFromLocalProto = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          source: 'proto',
          userEmail: 'a@test.com',
          fetchedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          success: true,
          source: 'proto',
          userEmail: 'b@test.com',
          fetchedAt: new Date().toISOString(),
        });

      const result = await manager.switchTo(a2.id);

      expect(result.success).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(manager.getById(a1.id)?.isActive).toBe(false);
      expect(manager.getById(a2.id)?.isActive).toBe(true);
    });

    it('fetchRealQuota 拒绝把 proto 额度写到不匹配的目标账号', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p1');
      const a2 = await manager.add('a2@test.com', 'p2');

      (manager as any).quotaFetcher.fetchQuota = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a1@test.com',
        fetchedAt: new Date().toISOString(),
        planInfo: {
          planName: 'Pro',
          billingStrategy: 'quota',
          startTimestamp: 0,
          endTimestamp: 0,
          usage: {
            duration: 0,
            messages: 100,
            flowActions: 0,
            flexCredits: 0,
            usedMessages: 10,
            usedFlowActions: 0,
            usedFlexCredits: 0,
            remainingMessages: 90,
            remainingFlowActions: 0,
            remainingFlexCredits: 0,
          },
          hasBillingWritePermissions: false,
          gracePeriodStatus: 0,
          quotaUsage: {
            dailyRemainingPercent: 90,
            weeklyRemainingPercent: 90,
            overageBalanceMicros: 0,
            dailyResetAtUnix: 0,
            weeklyResetAtUnix: 0,
          },
        },
      }));

      const result = await manager.fetchRealQuota(a2.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('目标账号是 a2@test.com');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Rejected quota write for mismatched account.',
        expect.objectContaining({
          operation: 'quota.refresh',
          phase: 'write-guard',
          traceId: expect.stringMatching(/^quota_/),
          accountId: a2.id,
        }),
      );
      expect(manager.getById(a2.id)?.realQuota).toBeUndefined();
      expect(manager.getById(a1.id)?.realQuota).toBeUndefined();
    });

    it('fetchRealQuota 当前账号陈旧时按真实运行时账号刷新并收敛 currentAccountId', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p1');
      const a2 = await manager.add('a2@test.com', 'p2');
      (manager as any).quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus = vi.fn(async () => ({
        success: true,
        source: 'authstatus',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchQuota = vi.fn(async (_id: string, email: string) => ({
        success: true,
        source: 'proto',
        userEmail: email,
        fetchedAt: new Date().toISOString(),
        planInfo: {
          planName: 'Trial',
          billingStrategy: 'quota',
          startTimestamp: 0,
          endTimestamp: 0,
          usage: {
            duration: 0,
            messages: 100,
            flowActions: 0,
            flexCredits: 0,
            usedMessages: 80,
            usedFlowActions: 0,
            usedFlexCredits: 0,
            remainingMessages: 20,
            remainingFlowActions: 0,
            remainingFlexCredits: 0,
          },
          hasBillingWritePermissions: false,
          gracePeriodStatus: 0,
          quotaUsage: {
            dailyRemainingPercent: 20,
            weeklyRemainingPercent: 70,
            overageBalanceMicros: 0,
            dailyResetAtUnix: 0,
            weeklyResetAtUnix: 0,
          },
        },
      }));

      const result = await manager.fetchRealQuota(a1.id);

      expect(result.success).toBe(true);
      expect((manager as any).quotaFetcher.fetchQuota).toHaveBeenCalledWith(
        a2.id,
        'a2@test.com',
        'p2',
        {
          forceRefresh: true,
          preferLocal: true,
          currentRuntimeEmail: 'a2@test.com',
        },
      );
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getById(a2.id)?.realQuota?.dailyRemainingPercent).toBe(20);
      expect(manager.getById(a1.id)?.realQuota).toBeUndefined();
    });

    it('fetchRealQuota 手动刷新选中账号时不被当前运行时账号重定向', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p1');
      const a2 = await manager.add('a2@test.com', 'p2');
      Reflect.set(manager, 'currentAccountId', a2.id);
      a1.isActive = false;
      a2.isActive = true;
      const quotaFetcher = Reflect.get(manager, 'quotaFetcher') as unknown as TestQuotaFetcher;
      quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus = vi.fn(async () => ({
        success: true,
        source: 'authstatus',
        userEmail: 'a1@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      quotaFetcher.fetchQuota = vi.fn(async (_id: string, email: string) => ({
        success: true,
        source: 'api',
        userEmail: email,
        fetchedAt: new Date().toISOString(),
        planInfo: {
          planName: 'Pro',
          billingStrategy: 'quota',
          startTimestamp: 0,
          endTimestamp: 0,
          usage: {
            duration: 0,
            messages: 100,
            flowActions: 0,
            flexCredits: 0,
            usedMessages: 20,
            usedFlowActions: 0,
            usedFlexCredits: 0,
            remainingMessages: 80,
            remainingFlowActions: 0,
            remainingFlexCredits: 0,
          },
          hasBillingWritePermissions: false,
          gracePeriodStatus: 0,
          quotaUsage: {
            dailyRemainingPercent: 80,
            weeklyRemainingPercent: 60,
            overageBalanceMicros: 0,
            dailyResetAtUnix: 0,
            weeklyResetAtUnix: 0,
          },
        },
      }));

      const result = await manager.fetchRealQuota(a2.id, { mode: 'manual' });

      expect(result.success).toBe(true);
      expect(quotaFetcher.fetchQuota).toHaveBeenCalledWith(
        a2.id,
        'a2@test.com',
        'p2',
        {
          forceRefresh: true,
          preferLocal: false,
          currentRuntimeEmail: 'a1@test.com',
        },
      );
      expect(manager.getCurrentAccountId()).toBe(a2.id);
      expect(manager.getById(a2.id)?.realQuota?.dailyRemainingPercent).toBe(80);
      expect(manager.getById(a1.id)?.realQuota).toBeUndefined();
    });

    it('批量刷新遇到登录限流时停止后续账号请求', async () => {
      await manager.initialize();
      await manager.add('a1@test.com', 'p1');
      await manager.add('a2@test.com', 'p2');

      const fetchFromGetPlanStatus = vi.fn(async () => ({
        success: false,
        source: 'api',
        error: 'Firebase 登录失败: 请求失败: TOO_MANY_ATTEMPTS_TRY_LATER',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchFromGetPlanStatus = fetchFromGetPlanStatus;
      (manager as any).quotaFetcher.fetchQuota = vi.fn(async () => ({
        success: false,
        source: 'proto',
        error: 'skipped',
        fetchedAt: new Date().toISOString(),
      }));

      const result = await manager.fetchAllRealQuotas();

      expect(fetchFromGetPlanStatus).toHaveBeenCalledTimes(1);
      expect(result.failed).toBeGreaterThan(0);
      expect(result.errors.join('\n')).toContain('已停止后续账号');
    });
  });

  describe('importBatch 边缘 case', () => {
    it('已有账号时导入不改变 currentAccountId', async () => {
      await manager.initialize();
      const existing = await manager.add('existing@test.com', 'p');
      const result = await manager.importBatch('new1@test.com----p1\nnew2@test.com----p2');
      expect(result.added).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Batch import done.',
        expect.objectContaining({
          operation: 'account.import',
          traceId: expect.stringMatching(/^import_/),
          entryCount: 2,
          added: 2,
          durationMs: expect.any(Number),
        }),
      );
      expect(manager.getCurrentAccountId()).toBe(existing.id);
      // 新导入的不应 isActive
      const newAccounts = manager.getAll().filter(a => a.id !== existing.id);
      expect(newAccounts.every(a => !a.isActive)).toBe(true);
    });

    it('空列表导入时第一个设为 active', async () => {
      await manager.initialize();
      await manager.importBatch('a@test.com----p1\nb@test.com----p2');
      const all = manager.getAll();
      expect(all[0].isActive).toBe(true);
      expect(all[1].isActive).toBe(false);
      expect(manager.getCurrentAccountId()).toBe(all[0].id);
    });

    it('导入支持冒号分隔符', async () => {
      await manager.initialize();
      const result = await manager.importBatch('user@mail.com:mypass');
      expect(result.added).toBe(1);
      expect(manager.getAll()[0].email).toBe('user@mail.com');
    });

    it('7个连字符分隔符正确解析密码（不残留前缀）', async () => {
      await manager.initialize();
      const result = await manager.importBatch('user@test.com-------Aa263646');
      expect(result.added).toBe(1);
      const acc = manager.getAll()[0];
      expect(acc.email).toBe('user@test.com');
      expect(acc.password).toBe('Aa263646');
    });

    it('5个连字符分隔符也正确解析', async () => {
      await manager.initialize();
      const result = await manager.importBatch('user@test.com-----mypass');
      expect(result.added).toBe(1);
      expect(manager.getAll()[0].password).toBe('mypass');
    });

    it('批量导入内部去重（同批次重复邮箱）', async () => {
      await manager.initialize();
      const result = await manager.importBatch('a@test.com----p1\na@test.com----p2');
      expect(result.added).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons.duplicate).toBe(1);
    });

    it('导入0条有效数据不触发 save', async () => {
      await manager.initialize();
      (fs.writeFile as any).mockClear();
      await manager.importBatch('invalid-line\n\n');
      // importBatch 内只在 added > 0 时 save；无有效数据不调用
      // 注: initialize 和 importBatch 内的 save 逻辑
      const writeCalls = (fs.writeFile as any).mock.calls;
      // 初始化后无额外 writeFile 调用（importBatch 跳过 save）
      expect(writeCalls.length).toBe(0);
    });

    it('导入会跳过说明文字和无效邮箱，并记录原因', async () => {
      await manager.initialize();
      const result = await manager.importBatch([
        '以下是可导入账号',
        'not-an-email----pass',
        'valid@test.com----pass',
      ].join('\n'));

      expect(result.added).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.skippedReasons.invalidFormat).toBe(1);
      expect(result.skippedReasons.invalidEmail).toBe(1);
      expect(manager.getAll()[0].email).toBe('valid@test.com');
    });

    it('导入支持较宽松但合法的邮箱格式', async () => {
      await manager.initialize();
      const result = await manager.importBatch(
        "very.unusual+tag/box.o'hara@example.travel----pass",
      );

      expect(result.added).toBe(1);
      expect(result.skipped).toBe(0);
      expect(manager.getAll()[0].email).toBe("very.unusual+tag/box.o'hara@example.travel");
    });
  });

  describe('importBatch auth1Token 批量', () => {
    it('纯 auth1 token 批量导入，解析真实邮箱并创建账号', async () => {
      await manager.initialize();
      const result = await manager.importBatch([
        'auth1_token001----已绑卡',
        'auth1_token002----新卡',
      ].join('\n'));

      // mock resolveAuth1Token 返回相同 apiKey，第二个 token 触发更新
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      const accounts = manager.getAll();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].email).toBe('mock@email.com');
      expect(accounts[0].password).toBe('auth1_token002'); // 被更新为第二个 token
      expect(accounts[0].notes).toBe('新卡'); // notes 也更新
      expect(accounts[0].apiKey).toBe('mock-api-key');
    });

    it('混合导入 auth1 token + 邮箱密码', async () => {
      await manager.initialize();
      const result = await manager.importBatch([
        'auth1_token001----已绑卡',
        'user@test.com----pass123',
        'auth1_token002',
      ].join('\n'));

      // auth1_token001 新建, user@test.com 新建, auth1_token002 同 apiKey 更新
      expect(result.added).toBe(2);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
      const accounts = manager.getAll();
      expect(accounts).toHaveLength(2);
      // 邮箱密码账号
      const emailAccount = accounts.find((a) => a.email === 'user@test.com');
      expect(emailAccount).toBeDefined();
      expect(emailAccount!.password).toBe('pass123');
      // token 账号
      const tokenAccount = accounts.find((a) => a.password.startsWith('auth1_'));
      expect(tokenAccount).toBeDefined();
    });

    it('auth1 token 按 apiKey 去重，重复导入更新已有账号', async () => {
      await manager.initialize();
      // 第一次导入
      const r1 = await manager.importBatch('auth1_token001----标签A\n');
      expect(r1.added).toBe(1);
      const firstId = manager.getAll()[0].id;

      // 第二次导入相同 apiKey 的 token（mock 返回相同 apiKey: 'mock-api-key'）
      const r2 = await manager.importBatch('auth1_token_new----标签B\n');
      expect(r2.added).toBe(0);
      expect(r2.updated).toBe(1);
      // 应该更新已有账号而非新建
      expect(manager.getAll()).toHaveLength(1);
      expect(manager.getAll()[0].id).toBe(firstId);
      expect(manager.getAll()[0].password).toBe('auth1_token_new');
      expect(manager.getAll()[0].notes).toBe('标签B');
    });

    it('auth1 token 解析失败时记录失败，不影响同批次其他 token', async () => {
      await manager.initialize();
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      spy
        .mockResolvedValueOnce({
          sessionToken: 's1', apiKey: 'key1', name: 'n1',
          email: 'a@test.com', accountId: 'acc1',
        })
        .mockRejectedValueOnce(new Error('Token 已过期'))
        .mockResolvedValueOnce({
          sessionToken: 's3', apiKey: 'key3', name: 'n3',
          email: 'c@test.com', accountId: 'acc3',
        });

      const result = await manager.importBatch([
        'auth1_good1',
        'auth1_bad',
        'auth1_good2',
      ].join('\n'));

      expect(result.added).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain('[#2]');
      expect(result.failures[0]).toContain('Token 已过期');
      expect(manager.getAll()).toHaveLength(2);
    });

    it('auth1 token 无分隔符时 notes 为空', async () => {
      await manager.initialize();
      await manager.importBatch('auth1_token001\n');
      expect(manager.getAll()[0].notes).toBeUndefined();
    });

    it('importBatchResult 包含 updated、failed、failures 字段', async () => {
      await manager.initialize();
      const result = await manager.importBatch('user@test.com----pass\n');
      // email/password 导入也应返回完整字段
      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('failures');
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.failures).toEqual([]);
    });

    it('瞬态网络错误重试成功', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      // isTransientNetworkError → true，触发重试
      (manager as any).auth.isTransientNetworkError = vi.fn(() => true);
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      spy
        .mockRejectedValueOnce(new Error('TLS 连接断开'))
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          sessionToken: 's1', apiKey: 'key1', name: 'n1',
          email: 'retry@test.com', accountId: 'acc1',
        });

      const promise = manager.importBatch('auth1_token_retry\n');
      // 第一次失败 → 等待 1s → 第二次失败 → 等待 2s → 第三次成功
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.added).toBe(1);
      expect(result.failed).toBe(0);
      expect(spy).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('瞬态错误重试 3 次耗尽后计入失败', async () => {
      vi.useFakeTimers();
      await manager.initialize();
      (manager as any).auth.isTransientNetworkError = vi.fn(() => true);
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      spy.mockRejectedValue(new Error('TLS 连接断开'));

      const promise = manager.importBatch('auth1_token_fail\n');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.added).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.failures[0]).toContain('TLS 连接断开');
      expect(spy).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('非瞬态错误不重试，直接计入失败', async () => {
      await manager.initialize();
      // isTransientNetworkError → false（默认）
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      spy.mockRejectedValue(new Error('Token 已过期'));

      const result = await manager.importBatch('auth1_token_expired\n');
      expect(result.failed).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1); // 不重试
    });

    it('email 回退永不用原始 token，用 accountId 或随机 ID', async () => {
      await manager.initialize();
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      // GetCurrentUser 和 RegisterUser 都失败，且无 accountId
      spy.mockResolvedValueOnce({
        sessionToken: 's1', apiKey: 'key-1', name: '',
        email: '', accountId: undefined,
      });

      await manager.importBatch('auth1_secret_token_12345----test\n');
      const email = manager.getAll()[0].email;
      // 不应包含原始 token
      expect(email).not.toContain('secret');
      expect(email).not.toContain('auth1_');
      // 应该是 @windsurf.auth1 格式
      expect(email).toContain('@windsurf.auth1');
    });

    it('按 email 去重（apiKey 为空时回退）', async () => {
      await manager.initialize();
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      // 第一个 token: 无 apiKey，有 email
      spy.mockResolvedValueOnce({
        sessionToken: 's1', apiKey: '', name: 'n1',
        email: 'same@test.com', accountId: 'acc1',
      });
      // 第二个 token: 无 apiKey，相同 email
      spy.mockResolvedValueOnce({
        sessionToken: 's2', apiKey: '', name: 'n2',
        email: 'same@test.com', accountId: 'acc2',
      });

      const result = await manager.importBatch('auth1_t1\nauth1_t2\n');
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(manager.getAll()).toHaveLength(1);
    });

    it('按 accountId 去重（apiKey 和 email 均为空时回退）', async () => {
      await manager.initialize();
      const spy = vi.spyOn((manager as any).auth, 'resolveAuth1Token');
      spy.mockResolvedValueOnce({
        sessionToken: 's1', apiKey: '', name: '',
        email: '', accountId: 'same-acc',
      });
      spy.mockResolvedValueOnce({
        sessionToken: 's2', apiKey: '', name: '',
        email: '', accountId: 'same-acc',
      });

      const result = await manager.importBatch('auth1_t1\nauth1_t2\n');
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(manager.getAll()).toHaveLength(1);
    });

    it('onProgress 回调正确传递进度', async () => {
      await manager.initialize();
      const progressCalls: Array<{ current: number; total: number }> = [];
      const onProgress = (current: number, total: number) => {
        progressCalls.push({ current, total });
      };

      await manager.importBatch([
        'auth1_t1',  // 成功
        'auth1_t2',  // 成功（同 apiKey 更新）
      ].join('\n'), onProgress);

      expect(progressCalls).toHaveLength(2);
      expect(progressCalls[0]).toEqual({ current: 1, total: 2 });
      expect(progressCalls[1]).toEqual({ current: 2, total: 2 });
    });
  });

  describe('importAuth1Token', () => {
    let switchToSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      switchToSpy = vi.spyOn(WindsurfAccountManager.prototype, 'switchTo')
        .mockImplementation(async () => ({ success: true }));
    });

    afterEach(() => {
      switchToSpy.mockRestore();
    });

    it('拒绝非 auth1_ 前缀的 token', async () => {
      await manager.initialize();
      const result = await manager.importAuth1Token('invalid-token');
      expect(result.success).toBe(false);
      expect(result.error).toContain('auth1_');
    });

    it('成功导入 auth1Token 并创建账号', async () => {
      await manager.initialize();
      const result = await manager.importAuth1Token('auth1_uslny66zeboixyinxgly3tzzc5ja7mkg45meyqi4iv27j4lo5jsa');

      expect(result.success).toBe(true);
      expect(result.account).toBeDefined();
      expect(result.account!.email).toBe('mock@email.com');
      expect(result.account!.apiKey).toBe('mock-api-key');
      // 存储原始 auth1Token（长期凭证），非短期 sessionToken
      expect(result.account!.password).toBe('auth1_uslny66zeboixyinxgly3tzzc5ja7mkg45meyqi4iv27j4lo5jsa');
      expect(result.switchResult).toBeDefined();
    });

    it('重复导入相同 apiKey 的 token 会更新已有账号', async () => {
      await manager.initialize();
      // First import
      const first = await manager.importAuth1Token('auth1_test_token_1');
      expect(first.success).toBe(true);
      const firstAccountId = first.account!.id;

      // Second import with same apiKey (mock returns same apiKey)
      const second = await manager.importAuth1Token('auth1_test_token_2');
      expect(second.success).toBe(true);
      // Should update the existing account, not create a new one
      expect(second.account!.id).toBe(firstAccountId);
    });
  });

  describe('warningLevel 边缘 (realQuota)', () => {
    it('dailyRemainingPercent = -1 (无数据) 不触发 critical', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      // 模拟 realQuota: -1 = API 未返回百分比
      (account as any).realQuota = {
        planName: 'Free', billingStrategy: 'quota',
        dailyRemainingPercent: -1, weeklyRemainingPercent: -1,
        dailyResetAtUnix: 0, weeklyResetAtUnix: 0,
        messages: 0, usedMessages: 0, remainingMessages: 0,
        flowActions: 0, usedFlowActions: 0, remainingFlowActions: 0,
        overageBalanceMicros: 0, fetchedAt: new Date().toISOString(), source: 'proto'
      };
      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots[0].warningLevel).toBe('ok');
    });

    it('past daily resetAt with missing percent does not trigger critical', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      account.realQuota = makeRealQuota({
        dailyRemainingPercent: -1,
        weeklyRemainingPercent: 50,
        dailyResetAtUnix: pastResetAtUnix(),
        remainingMessages: 0,
      });

      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots[0].warningLevel).toBe('ok');
    });

    it('dailyRemainingPercent = 0 触发 critical', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      (account as any).realQuota = {
        planName: 'Pro', billingStrategy: 'quota',
        dailyRemainingPercent: 0, weeklyRemainingPercent: 50,
        dailyResetAtUnix: 0, weeklyResetAtUnix: 0,
        messages: 500, usedMessages: 500, remainingMessages: 0,
        flowActions: 0, usedFlowActions: 0, remainingFlowActions: 0,
        overageBalanceMicros: 0, fetchedAt: new Date().toISOString(), source: 'api'
      };
      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots[0].warningLevel).toBe('critical');
    });

    it('dailyRemainingPercent = 100 (Free 新号满额) 不触发 warning', async () => {
      await manager.initialize();
      const account = await manager.add('test@test.com', 'p');
      (account as any).realQuota = {
        planName: 'Free', billingStrategy: 'quota',
        dailyRemainingPercent: 100, weeklyRemainingPercent: 100,
        dailyResetAtUnix: 0, weeklyResetAtUnix: 0,
        messages: 0, usedMessages: 0, remainingMessages: 0,
        flowActions: 0, usedFlowActions: 0, remainingFlowActions: 0,
        overageBalanceMicros: 0, fetchedAt: new Date().toISOString(), source: 'api'
      };
      const snapshots = manager.getQuotaSnapshots();
      expect(snapshots[0].warningLevel).toBe('ok');
    });
  });

  describe('自动切号 realQuota 百分比优先', () => {
    it('Free 新号 remainingMessages=0 但 dailyRemainingPercent=100 不触发切号', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p');
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });
      // 模拟 Free 新号: remainingMessages=0 但百分比满额
      (a1 as any).realQuota = {
        planName: 'Free', billingStrategy: 'quota',
        dailyRemainingPercent: 100, weeklyRemainingPercent: 100,
        dailyResetAtUnix: 0, weeklyResetAtUnix: 0,
        messages: 0, usedMessages: 0, remainingMessages: 0,
        flowActions: 0, usedFlowActions: 0, remainingFlowActions: 0,
        overageBalanceMicros: 0, fetchedAt: new Date().toISOString(), source: 'api'
      };
      const switched = await manager.autoSwitchIfNeeded();
      expect(switched).toBe(false);
    });

    it('Pro 日配额耗尽 (dailyRemainingPercent=0) 触发切号', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p');
      const a2 = await manager.add('a2@test.com', 'p');
      const fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      fetchFromLocalProto.mockImplementationOnce(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a1@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchFromLocalProto = fetchFromLocalProto;
      await manager.setQuotaLimits(a2.id, 50, 200);
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });
      (a1 as any).realQuota = {
        planName: 'Pro', billingStrategy: 'quota',
        dailyRemainingPercent: 0, weeklyRemainingPercent: 50,
        dailyResetAtUnix: 0, weeklyResetAtUnix: 0,
        messages: 500, usedMessages: 500, remainingMessages: 0,
        flowActions: 0, usedFlowActions: 0, remainingFlowActions: 0,
        overageBalanceMicros: 0, fetchedAt: new Date().toISOString(), source: 'api'
      };
      const switched = await manager.autoSwitchIfNeeded();
      expect(switched).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('pending switch 存在时，autoSwitch 不会被旧 realId 打回原账号', async () => {
      await manager.initialize();
      await manager.add('a1@test.com', 'p');
      const a2 = await manager.add('a2@test.com', 'p');
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });

      const fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      replaceQuotaProtoFetcher(manager, fetchFromLocalProto);

      const switchResult = await manager.switchTo(a2.id);
      expect(switchResult.success).toBe(true);

      (a2 as any).realQuota = {
        planName: 'Pro', billingStrategy: 'quota',
        dailyRemainingPercent: 80, weeklyRemainingPercent: 90,
        dailyResetAtUnix: 0, weeklyResetAtUnix: 0,
        messages: 500, usedMessages: 100, remainingMessages: 400,
        flowActions: 0, usedFlowActions: 0, remainingFlowActions: 0,
        overageBalanceMicros: 0, fetchedAt: new Date().toISOString(), source: 'api'
      };

      const switched = await manager.autoSwitchIfNeeded();
      expect(switched).toBe(false);
      expect(manager.getImmediateCurrentAccountId()).toBe(a2.id);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('past daily resetAt with missing percent does not reject auto-switch candidate', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p');
      const a2 = await manager.add('a2@test.com', 'p');
      const fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      fetchFromLocalProto.mockImplementationOnce(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a1@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      replaceQuotaProtoFetcher(manager, fetchFromLocalProto);
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });
      a1.realQuota = makeRealQuota({
        dailyRemainingPercent: 0,
        weeklyRemainingPercent: 50,
        remainingMessages: 0,
      });
      a2.realQuota = makeRealQuota({
        dailyRemainingPercent: -1,
        weeklyRemainingPercent: 80,
        dailyResetAtUnix: pastResetAtUnix(),
        remainingMessages: 0,
      });

      const switched = await manager.autoSwitchIfNeeded();

      expect(switched).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });
  });

  describe('resetMachineId', () => {
    it('优先重置 storage.json telemetry 机器标识', async () => {
      const storagePath = path.join(
        '/Users/os/Library/Application Support/Cursor/User/globalStorage',
        'storage.json',
      );
      (fs.access as any).mockImplementation(async (target: string) => {
        if (target === storagePath) return undefined;
        throw new Error('ENOENT');
      });
      (fs.readFile as any).mockImplementation(async (target: string) => {
        if (target === storagePath) {
          return JSON.stringify({
            telemetry: {
              machineId: 'old-1',
              macMachineId: 'old-2',
              sqmId: 'old-3',
              devDeviceId: 'old-4',
            },
          });
        }
        throw new Error('ENOENT');
      });
      await manager.initialize();
      const result = await manager.resetMachineId();
      expect(result.success).toBe(true);
      expect(result.message).toContain('telemetry');
      expect((fs.writeFile as any).mock.calls.some(
        ([filePath, content]: [string, string]) => filePath === storagePath && content.includes('old-1') === false
      )).toBe(true);
    });

    it('同时存在 Windsurf 和 Cursor telemetry 时，优先当前 IDE 并全部更新', async () => {
      const windsurfPath = path.join(
        '/Users/os/Library/Application Support/Windsurf/User/globalStorage',
        'storage.json',
      );
      const cursorPath = path.join(
        '/Users/os/Library/Application Support/Cursor/User/globalStorage',
        'storage.json',
      );
      (fs.access as any).mockImplementation(async (target: string) => {
        if (target === windsurfPath || target === cursorPath) return undefined;
        throw new Error('ENOENT');
      });
      (fs.readFile as any).mockImplementation(async (target: string) => {
        if (target === windsurfPath || target === cursorPath) {
          return JSON.stringify({
            telemetry: {
              machineId: 'old-machine',
              macMachineId: 'old-mac',
              sqmId: 'old-sqm',
              devDeviceId: 'old-device',
            },
          });
        }
        throw new Error('ENOENT');
      });

      await manager.initialize();
      const result = await manager.resetMachineId();

      expect(result.success).toBe(true);
      const storageWrites = (fs.writeFile as any).mock.calls
        .filter(([filePath]: [string]) => filePath === windsurfPath || filePath === cursorPath)
        .map(([filePath]: [string]) => filePath);
      expect(storageWrites).toEqual([windsurfPath, cursorPath]);
    });

    it('找到 machineId 文件时重置并返回 success:true', async () => {
      const fallbackPath = path.join('/Users/os', '.windsurf', 'machineid');
      (fs.access as any).mockImplementation(async (target: string) => {
        if (target === fallbackPath) return undefined;
        throw new Error('ENOENT');
      });
      await manager.initialize();
      const result = await manager.resetMachineId();
      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置');
      expect((fs.writeFile as any).mock.calls.some(
        ([filePath, content]: [string, string]) => filePath === fallbackPath && /^[0-9a-f]{32}$/.test(content)
      )).toBe(true);
    });
  });
});
