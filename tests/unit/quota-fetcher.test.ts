import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindsurfPlanInfo } from '../../src/adapters/quota-fetcher';
import { WindsurfQuotaFetcher } from '../../src/adapters/quota-fetcher';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createPlanInfo(planName: string): WindsurfPlanInfo {
  return {
    planName,
    startTimestamp: 0,
    endTimestamp: 0,
    usage: {
      duration: 0,
      messages: 100,
      flowActions: 20,
      flexCredits: 0,
      usedMessages: 10,
      usedFlowActions: 2,
      usedFlexCredits: 0,
      remainingMessages: 90,
      remainingFlowActions: 18,
      remainingFlexCredits: 0,
    },
    hasBillingWritePermissions: false,
    gracePeriodStatus: 0,
    billingStrategy: 'quota',
    quotaUsage: {
      dailyRemainingPercent: 90,
      weeklyRemainingPercent: 80,
      overageBalanceMicros: 0,
      dailyResetAtUnix: 0,
      weeklyResetAtUnix: 0,
    },
  };
}

describe('WindsurfQuotaFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GetPlanStatus 查询保留认证适配器默认 provider 选择', async () => {
    const auth = {
      signIn: vi.fn(async () => ({ idToken: 'devin-session-token' })),
    } as any;
    const fetcher = new WindsurfQuotaFetcher(auth, mockLogger);
    vi.spyOn(fetcher as any, 'callGetPlanStatus').mockResolvedValue(createPlanInfo('Pro'));

    const result = await fetcher.fetchFromGetPlanStatus('acc_1', 'a@test.com', 'password');

    expect(auth.signIn).toHaveBeenCalledWith('a@test.com', 'password', 'acc_1');
    expect(result.success).toBe(true);
    expect(result.source).toBe('api');
    expect(result.planInfo?.planName).toBe('Pro');
  });

  it('目标账号刷新时不会被缺少 userEmail 的 proto 结果提前短路', async () => {
    const auth = {
      signIn: vi.fn(),
    } as any;
    const fetcher = new WindsurfQuotaFetcher(auth, mockLogger);
    const protoSpy = vi.spyOn(fetcher as any, 'fetchFromLocalProto').mockResolvedValue({
      success: true,
      source: 'proto',
      planInfo: createPlanInfo('Proto'),
      fetchedAt: new Date().toISOString(),
    });
    const apikeySpy = vi.spyOn(fetcher as any, 'fetchFromLocalApiKey').mockResolvedValue({
      success: false,
      source: 'apikey',
      error: 'no api key',
      fetchedAt: new Date().toISOString(),
    });
    const localSpy = vi.spyOn(fetcher as any, 'fetchFromLocal').mockResolvedValue({
      success: true,
      source: 'local',
      planInfo: createPlanInfo('Local'),
      fetchedAt: new Date().toISOString(),
    });
    const apiSpy = vi.spyOn(fetcher as any, 'fetchFromGetPlanStatus').mockResolvedValue({
      success: false,
      source: 'api',
      error: 'should not reach api',
      fetchedAt: new Date().toISOString(),
    });

    const result = await fetcher.fetchQuota('acc_1', 'a@test.com', 'password', {
      forceRefresh: true,
    });

    expect(protoSpy).toHaveBeenCalledWith('a@test.com');
    expect(apikeySpy).toHaveBeenCalledWith('a@test.com');
    expect(localSpy).toHaveBeenCalledWith('a@test.com');
    expect(apiSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.source).toBe('local');
    expect(result.planInfo?.planName).toBe('Local');
  });

  it('开启 debugRawResponses 后记录脱敏后的 quota raw payload', async () => {
    const auth = {
      signIn: vi.fn(async () => ({ idToken: 'secret-token-123456' })),
      setDebugRawResponses: vi.fn(),
    } as any;
    const fetcher = new WindsurfQuotaFetcher(auth, mockLogger);
    fetcher.setDebugRawResponses(true);
    vi.spyOn(fetcher as any, 'callGetPlanStatus').mockResolvedValue(createPlanInfo('Pro'));

    await fetcher.fetchFromGetPlanStatus('acc_1', 'a@test.com', 'password');

    expect(auth.setDebugRawResponses).toHaveBeenCalledWith(true);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Quota raw response via GetPlanStatus.',
      expect.objectContaining({
        payload: expect.objectContaining({
          source: 'api',
          email: 'a@test.com',
          planInfo: expect.objectContaining({
            planName: 'Pro',
          }),
        }),
      }),
    );
  });
});
