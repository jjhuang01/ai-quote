import { describe, expect, it } from 'vitest';
import {
  compareAccountsByUiState,
  deriveAccountUiState,
  getAvailableAccountCount,
  getVirtualWindow,
} from '../../media/account-ui-state';

type RealQuotaInfo = {
  dailyRemainingPercent: number;
  weeklyRemainingPercent: number;
  dailyResetAtUnix?: number;
  weeklyResetAtUnix?: number;
  planEndTimestamp?: number;
};

type QuotaSnapshot = {
  accountId: string;
  warningLevel: 'ok' | 'warn' | 'critical';
  real?: RealQuotaInfo;
};

type WindsurfAccount = {
  id: string;
  email: string;
  plan: 'Trial' | 'Pro' | 'Enterprise' | 'Free' | 'Max' | 'Teams';
  creditsUsed: number;
  creditsTotal: number;
  quota: {
    dailyUsed: number;
    dailyLimit: number;
    dailyResetAt: string;
    weeklyUsed: number;
    weeklyLimit: number;
    weeklyResetAt: string;
  };
  expiresAt: string;
  isActive: boolean;
  addedAt: string;
};

function makeAccount(id: string, email: string): WindsurfAccount {
  return {
    id,
    email,
    plan: 'Pro',
    creditsUsed: 0,
    creditsTotal: 0,
    quota: {
      dailyUsed: 0,
      dailyLimit: 0,
      dailyResetAt: '',
      weeklyUsed: 0,
      weeklyLimit: 0,
      weeklyResetAt: '',
    },
    expiresAt: '',
    isActive: true,
    addedAt: '2026-04-14T00:00:00.000Z',
  };
}

function makeSnapshot(accountId: string, real?: Partial<RealQuotaInfo>): QuotaSnapshot {
  return {
    accountId,
    warningLevel: 'ok',
    real: real
      ? {
          dailyRemainingPercent: -1,
          weeklyRemainingPercent: -1,
          ...real,
        }
      : undefined,
  };
}

describe('deriveAccountUiState', () => {
  it('marks account unavailable when weekly remaining is exhausted', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { weeklyRemainingPercent: 0, dailyRemainingPercent: 60 })
    );

    expect(ui.isUnavailable).toBe(true);
    expect(ui.availabilityLabel).toBe('不可用');
    expect(ui.sortBucket).toBe('unavailable');
  });

  it('marks account unavailable when daily remaining is exhausted', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { dailyRemainingPercent: 0, weeklyRemainingPercent: 80 })
    );

    expect(ui.isUnavailable).toBe(true);
    expect(ui.availabilityLabel).toBe('不可用');
  });

  it('keeps low but remaining quota as available', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { dailyRemainingPercent: 5, weeklyRemainingPercent: 5 })
    );

    expect(ui.isUnavailable).toBe(false);
    expect(ui.sortBucket).toBe('healthy');
  });

  it('keeps unknown quota as switchable unknown state', () => {
    const ui = deriveAccountUiState(makeAccount('a', 'a@test.com'), undefined, makeSnapshot('a'));

    expect(ui.isUnavailable).toBe(false);
    expect(ui.isExpired).toBe(false);
    expect(ui.sortBucket).toBe('unknown');
  });

  it('marks daily exhausted-no-data (negative% + reset time) as unavailable', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', {
        dailyRemainingPercent: -1,
        weeklyRemainingPercent: 40,
        dailyResetAtUnix: Math.floor(Date.now() / 1000) + 3600,
      })
    );

    expect(ui.isUnavailable).toBe(true);
    expect(ui.availabilityLabel).toBe('\u4e0d\u53ef\u7528');
  });

  it('does NOT mark exhausted-no-data when no reset time', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', {
        dailyRemainingPercent: -1,
        weeklyRemainingPercent: 40,
        dailyResetAtUnix: 0,
      })
    );

    expect(ui.isUnavailable).toBe(false);
    expect(ui.sortBucket).toBe('healthy');
  });

  it('treats expired state as stronger than unavailable', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', {
        dailyRemainingPercent: 1,
        weeklyRemainingPercent: 1,
        planEndTimestamp: Date.now() - 1000,
      })
    );

    expect(ui.isExpired).toBe(true);
    expect(ui.isUnavailable).toBe(false);
    expect(ui.availabilityLabel).toBe('已过期');
    expect(ui.sortBucket).toBe('expired');
  });

  it('keeps current account in current bucket even when unavailable', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      'a',
      makeSnapshot('a', { dailyRemainingPercent: 0, weeklyRemainingPercent: 50 })
    );

    expect(ui.isCurrent).toBe(true);
    expect(ui.isUnavailable).toBe(true);
    expect(ui.sortBucket).toBe('current');
  });
});

describe('compareAccountsByUiState', () => {
  it('sorts current before healthy before unknown before unavailable before expired', () => {
    const current = makeAccount('current', 'current@test.com');
    const healthy = makeAccount('healthy', 'healthy@test.com');
    const unknown = makeAccount('unknown', 'unknown@test.com');
    const unavailable = makeAccount('unavailable', 'unavailable@test.com');
    const expired = makeAccount('expired', 'expired@test.com');

    const snapshotMap = new Map<string, QuotaSnapshot>([
      ['healthy', makeSnapshot('healthy', { dailyRemainingPercent: 80, weeklyRemainingPercent: 90 })],
      ['unknown', makeSnapshot('unknown')],
      ['unavailable', makeSnapshot('unavailable', { dailyRemainingPercent: 0, weeklyRemainingPercent: 50 })],
      ['expired', makeSnapshot('expired', { dailyRemainingPercent: 5, weeklyRemainingPercent: 5, planEndTimestamp: Date.now() - 1000 })],
    ]);

    const sorted = [expired, unknown, unavailable, healthy, current].sort((a, b) =>
      compareAccountsByUiState(a, b, 'current', snapshotMap)
    );

    expect(sorted.map((item) => item.id)).toEqual([
      'current',
      'healthy',
      'unknown',
      'unavailable',
      'expired',
    ]);
  });
});

describe('getAvailableAccountCount', () => {
  it('excludes unavailable and expired accounts but includes unknown accounts', () => {
    const accounts = [
      makeAccount('healthy', 'healthy@test.com'),
      makeAccount('unknown', 'unknown@test.com'),
      makeAccount('unavailable', 'unavailable@test.com'),
      makeAccount('expired', 'expired@test.com'),
    ];

    const snapshotMap = new Map<string, QuotaSnapshot>([
      ['healthy', makeSnapshot('healthy', { dailyRemainingPercent: 70, weeklyRemainingPercent: 80 })],
      ['unknown', makeSnapshot('unknown')],
      ['unavailable', makeSnapshot('unavailable', { weeklyRemainingPercent: 0, dailyRemainingPercent: 50 })],
      ['expired', makeSnapshot('expired', { planEndTimestamp: Date.now() - 1000, dailyRemainingPercent: 50, weeklyRemainingPercent: 50 })],
    ]);

    expect(getAvailableAccountCount(accounts, undefined, snapshotMap)).toBe(2);
  });
});

describe('ui-state integration helpers', () => {
  it('keeps current unavailable account count excluded from available total', () => {
    const accounts = [
      makeAccount('current', 'current@test.com'),
      makeAccount('healthy', 'healthy@test.com'),
    ];

    const snapshotMap = new Map<string, QuotaSnapshot>([
      ['current', makeSnapshot('current', { dailyRemainingPercent: 5, weeklyRemainingPercent: 50 })],
      ['healthy', makeSnapshot('healthy', { dailyRemainingPercent: 90, weeklyRemainingPercent: 90 })],
    ]);

    expect(getAvailableAccountCount(accounts, 'current', snapshotMap)).toBe(2);
  });

  it('keeps current low-quota account switchable without unavailable label', () => {
    const ui = deriveAccountUiState(
      makeAccount('current', 'current@test.com'),
      'current',
      makeSnapshot('current', { dailyRemainingPercent: 5, weeklyRemainingPercent: 50 })
    );

    expect(ui.sortBucket).toBe('current');
    expect(ui.isUnavailable).toBe(false);
    expect(ui.availabilityLabel).toBeUndefined();
  });
});

describe('getVirtualWindow', () => {
  it('computes visible slice with overscan', () => {
    expect(
      getVirtualWindow({
        itemCount: 100,
        itemHeight: 72,
        viewportHeight: 240,
        scrollTop: 144,
        overscan: 2,
      })
    ).toEqual({
      startIndex: 0,
      endIndex: 7,
      offsetTop: 0,
      totalHeight: 7200,
    });
  });

  it('clamps when scroll is past the end of a shrinking list', () => {
    expect(
      getVirtualWindow({
        itemCount: 3,
        itemHeight: 72,
        viewportHeight: 240,
        scrollTop: 1000,
        overscan: 2,
      })
    ).toEqual({
      startIndex: 0,
      endIndex: 2,
      offsetTop: 0,
      totalHeight: 216,
    });
  });
});

describe('semantic and virtual window coverage', () => {
  it('marks exhausted quota as unavailable in unified ui state', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { dailyRemainingPercent: 0, weeklyRemainingPercent: 50 })
    );

    expect(ui.availabilityLabel).toBe('不可用');
    expect(ui.availabilityLabel).not.toBe('已耗尽');
  });

  it('renders later rows when scrolled down', () => {
    expect(
      getVirtualWindow({
        itemCount: 100,
        itemHeight: 96,
        viewportHeight: 288,
        scrollTop: 960,
        overscan: 4,
      })
    ).toEqual({
      startIndex: 6,
      endIndex: 16,
      offsetTop: 576,
      totalHeight: 9600,
    });
  });

  it('returns empty range for zero items', () => {
    expect(
      getVirtualWindow({
        itemCount: 0,
        itemHeight: 96,
        viewportHeight: 288,
        scrollTop: 0,
        overscan: 4,
      })
    ).toEqual({
      startIndex: 0,
      endIndex: -1,
      offsetTop: 0,
      totalHeight: 0,
    });
  });
});
