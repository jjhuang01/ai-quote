import * as vscode from 'vscode';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WindsurfPatchService } from '../../src/adapters/windsurf-patch';

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
      (manager as any).quotaFetcher.fetchFromLocalProto = fetchFromLocalProto;
      await manager.setQuotaLimits(a1.id, 5, 100);
      await manager.setQuotaLimits(a2.id, 50, 200);
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });

      // 消耗 a1 的日配额至阈值
      for (let i = 0; i < 5; i++) await manager.recordPrompt();

      const switched = await manager.autoSwitchIfNeeded();
      expect(switched).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('无可用账号时不切换', async () => {
      await manager.initialize();
      const a1 = await manager.add('a1@test.com', 'p');
      await manager.setQuotaLimits(a1.id, 5, 100);
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });

      for (let i = 0; i < 5; i++) await manager.recordPrompt();

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
      (manager as any).quotaFetcher.fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'b@test.com',
        fetchedAt: new Date().toISOString(),
      }));

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

      expect(result.success).toBe(false);
      expect(result.error).toContain('切换后校验失败');
      expect(manager.getCurrentAccountId()).toBe(a1.id);
      expect(manager.getImmediateCurrentAccountId()).toBe(a1.id);
    });
  });

  describe('importBatch 边缘 case', () => {
    it('已有账号时导入不改变 currentAccountId', async () => {
      await manager.initialize();
      const existing = await manager.add('existing@test.com', 'p');
      const result = await manager.importBatch('new1@test.com----p1\nnew2@test.com----p2');
      expect(result.added).toBe(2);
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
      const a1 = await manager.add('a1@test.com', 'p');
      const a2 = await manager.add('a2@test.com', 'p');
      await manager.updateAutoSwitch({ enabled: true, switchOnDaily: true, threshold: 5 });

      const fetchFromLocalProto = vi.fn(async () => ({
        success: true,
        source: 'proto',
        userEmail: 'a2@test.com',
        fetchedAt: new Date().toISOString(),
      }));
      (manager as any).quotaFetcher.fetchFromLocalProto = fetchFromLocalProto;

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
