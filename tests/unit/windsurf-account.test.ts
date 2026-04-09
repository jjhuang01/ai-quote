import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock vscode
vi.mock('vscode', () => ({
  default: {},
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
    registerUser = vi.fn(async () => ({ apiKey: 'mock-api-key' }));
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
      void a1;
      const result = await manager.switchTo(a2.id);
      expect(result.success).toBe(true);
      expect(manager.getCurrentAccountId()).toBe(a2.id);
    });

    it('切换到不存在的账号返回 false', async () => {
      await manager.initialize();
      await manager.add('a@test.com', 'p');
      const result = await manager.switchTo('nonexistent');
      expect(result.success).toBe(false);
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
  });

  describe('resetMachineId', () => {
    it('未找到 machineId 文件时返回 success:false', async () => {
      // In test env machineId files don't exist → should return failure
      (fs.access as any).mockRejectedValue(new Error('ENOENT'));
      await manager.initialize();
      const result = await manager.resetMachineId();
      expect(result.success).toBe(false);
      expect(result.message).toContain('未找到');
    });

    it('找到 machineId 文件时重置并返回 success:true', async () => {
      // Mock access to succeed for the first candidate path
      (fs.access as any).mockResolvedValueOnce(undefined);
      (fs.writeFile as any).mockResolvedValueOnce(undefined);
      await manager.initialize();
      const result = await manager.resetMachineId();
      expect(result.success).toBe(true);
      expect(result.message).toContain('已重置');
      // Verify writeFile was called with a 64-char hex string
      const writeCall = (fs.writeFile as any).mock.calls.find(
        (c: any[]) => typeof c[1] === 'string' && /^[0-9a-f]{64}$/.test(c[1])
      );
      expect(writeCall).toBeTruthy();
    });
  });
});
