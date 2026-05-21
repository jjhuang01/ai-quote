import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QuotaPoller } from '../../src/core/quota-poller';

// Mock vscode
vi.mock('vscode', () => {
  const onDidChangeWindowStateEmitter = {
    event: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  };
  return {
    window: {
      state: { focused: true },
      onDidChangeWindowState: onDidChangeWindowStateEmitter.event,
    },
    Disposable: class {
      dispose() {}
    },
  };
});

describe('QuotaPoller', () => {
  let mockDataManager: any;
  let mockLogger: any;
  let onUpdateSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDataManager = {
      windsurfAccounts: {
        isQuotaFetching: false,
        getCurrentAccountId: vi.fn().mockReturnValue('acc123'),
        fetchRealQuota: vi.fn().mockResolvedValue({ success: true }),
      },
    };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    onUpdateSpy = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls the quota and calls onUpdate if success', async () => {
    const poller = new QuotaPoller(mockDataManager, mockLogger, onUpdateSpy);
    poller.start();

    // Fast-forward to the first poll
    await vi.runOnlyPendingTimersAsync();

    expect(mockDataManager.windsurfAccounts.getCurrentAccountId).toHaveBeenCalled();
    expect(mockDataManager.windsurfAccounts.fetchRealQuota).toHaveBeenCalledWith('acc123', { mode: 'auto' });
    expect(onUpdateSpy).toHaveBeenCalled();
    
    poller.dispose();
  });

  it('does not poll if window is not focused', async () => {
    (vscode.window.state as any).focused = false;
    
    const poller = new QuotaPoller(mockDataManager, mockLogger, onUpdateSpy);
    poller.start();

    await vi.runOnlyPendingTimersAsync();

    expect(mockDataManager.windsurfAccounts.getCurrentAccountId).not.toHaveBeenCalled();
    expect(mockDataManager.windsurfAccounts.fetchRealQuota).not.toHaveBeenCalled();
    
    poller.dispose();
    (vscode.window.state as any).focused = true;
  });

  it('skips polling if already fetching quota', async () => {
    mockDataManager.windsurfAccounts.isQuotaFetching = true;

    const poller = new QuotaPoller(mockDataManager, mockLogger, onUpdateSpy);
    poller.start();

    await vi.runOnlyPendingTimersAsync();

    expect(mockDataManager.windsurfAccounts.getCurrentAccountId).not.toHaveBeenCalled();
    
    poller.dispose();
  });
});
