import { describe, expect, it, vi } from 'vitest';
import {
    handleAutoContinueDialog,
    pickAutoContinueReply,
} from '../../src/core/auto-continue';
import type { McpDialogRequest } from '../../src/core/contracts';

function request(summary: string, options?: string[]): McpDialogRequest {
  return {
    id: 'test',
    sessionId: 'session-1',
    summary,
    options,
    receivedAt: new Date().toISOString(),
  };
}

describe('auto continue', () => {
  it('prefers continue-like options over the default reply', () => {
    expect(pickAutoContinueReply(request('quota exhausted', ['取消', '继续任务']))).toBe('继续任务');
    expect(pickAutoContinueReply(request('quota exhausted', ['Cancel', 'Continue']))).toBe('Continue');
    expect(pickAutoContinueReply(request('quota exhausted'))).toBeUndefined();
  });

  it('auto continues only after a deterministic account switch succeeds', async () => {
    const calls: string[] = [];
    const refreshCurrentQuotaBeforeSwitch = vi.fn(async () => {
      calls.push('refresh-current-quota');
      return { success: true };
    });
    const autoSwitchIfNeeded = vi.fn(async () => true);
    autoSwitchIfNeeded.mockImplementation(async () => {
      calls.push('auto-switch');
      return true;
    });
    const getCurrentAccountId = vi.fn(async () => 'account-2');
    const refreshQuotaAfterSwitch = vi.fn(async () => undefined);
    const resolveDialog = vi.fn();

    const result = await handleAutoContinueDialog(
      request('quota exhausted', ['Cancel', 'Continue']),
      {
        refreshCurrentQuotaBeforeSwitch,
        autoSwitchIfNeeded,
        getCurrentAccountId,
        refreshQuotaAfterSwitch,
        resolveDialog,
      },
    );

    expect(result.handled).toBe(true);
    expect(calls).toEqual(['refresh-current-quota', 'auto-switch']);
    expect(autoSwitchIfNeeded).toHaveBeenCalledOnce();
    expect(refreshQuotaAfterSwitch).toHaveBeenCalledWith('account-2', 'auto-continue');
    expect(resolveDialog).toHaveBeenCalledWith('session-1', 'Continue');
  });

  it('falls back to manual dialog when no account switch happens', async () => {
    const refreshCurrentQuotaBeforeSwitch = vi.fn(async () => ({ success: true }));
    const autoSwitchIfNeeded = vi.fn(async () => false);
    const getCurrentAccountId = vi.fn(async () => 'account-1');
    const refreshQuotaAfterSwitch = vi.fn(async () => undefined);
    const resolveDialog = vi.fn();

    const result = await handleAutoContinueDialog(
      request('quota exhausted', ['Cancel', 'Continue']),
      {
        refreshCurrentQuotaBeforeSwitch,
        autoSwitchIfNeeded,
        getCurrentAccountId,
        refreshQuotaAfterSwitch,
        resolveDialog,
      },
    );

    expect(result.handled).toBe(false);
    expect(getCurrentAccountId).not.toHaveBeenCalled();
    expect(refreshQuotaAfterSwitch).not.toHaveBeenCalled();
    expect(resolveDialog).not.toHaveBeenCalled();
  });

  it('falls back to manual dialog when current quota cannot be refreshed', async () => {
    const refreshCurrentQuotaBeforeSwitch = vi.fn(async () => ({ success: false, error: 'rate limited' }));
    const autoSwitchIfNeeded = vi.fn(async () => true);
    const getCurrentAccountId = vi.fn(async () => 'account-2');
    const refreshQuotaAfterSwitch = vi.fn(async () => undefined);
    const resolveDialog = vi.fn();

    const result = await handleAutoContinueDialog(
      request('quota exhausted', ['Cancel', 'Continue']),
      {
        refreshCurrentQuotaBeforeSwitch,
        autoSwitchIfNeeded,
        getCurrentAccountId,
        refreshQuotaAfterSwitch,
        resolveDialog,
      },
    );

    expect(result.handled).toBe(false);
    expect(autoSwitchIfNeeded).not.toHaveBeenCalled();
    expect(getCurrentAccountId).not.toHaveBeenCalled();
    expect(refreshQuotaAfterSwitch).not.toHaveBeenCalled();
    expect(resolveDialog).not.toHaveBeenCalled();
  });

  it('does not refresh quota or switch when no explicit continue option exists', async () => {
    const refreshCurrentQuotaBeforeSwitch = vi.fn(async () => ({ success: true }));
    const autoSwitchIfNeeded = vi.fn(async () => true);
    const getCurrentAccountId = vi.fn(async () => 'account-2');
    const refreshQuotaAfterSwitch = vi.fn(async () => undefined);
    const resolveDialog = vi.fn();

    const result = await handleAutoContinueDialog(
      request('Please choose a refactor strategy', ['Extract function', 'Inline variable']),
      {
        refreshCurrentQuotaBeforeSwitch,
        autoSwitchIfNeeded,
        getCurrentAccountId,
        refreshQuotaAfterSwitch,
        resolveDialog,
      },
    );

    expect(result.handled).toBe(false);
    expect(refreshCurrentQuotaBeforeSwitch).not.toHaveBeenCalled();
    expect(autoSwitchIfNeeded).not.toHaveBeenCalled();
    expect(getCurrentAccountId).not.toHaveBeenCalled();
    expect(refreshQuotaAfterSwitch).not.toHaveBeenCalled();
    expect(resolveDialog).not.toHaveBeenCalled();
  });
});
