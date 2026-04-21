export interface WindsurfAccountLike {
  id: string;
  email: string;
  addedAt: string;
}

export interface RealQuotaInfoLike {
  dailyRemainingPercent: number;
  weeklyRemainingPercent: number;
  dailyResetAtUnix?: number;
  weeklyResetAtUnix?: number;
  planEndTimestamp?: number;
}

export interface QuotaSnapshotLike {
  accountId: string;
  real?: RealQuotaInfoLike;
}

export type AccountSortBucket = 'current' | 'healthy' | 'unknown' | 'unavailable' | 'expired';

export interface AccountUiState {
  id: string;
  isCurrent: boolean;
  isExpired: boolean;
  isUnavailable: boolean;
  availabilityLabel?: '不可用' | '已过期';
  sortBucket: AccountSortBucket;
  dailyRemainingPercent?: number;
  weeklyRemainingPercent?: number;
}

export interface VirtualWindowInput {
  itemCount: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan: number;
}

export interface VirtualWindowResult {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
}

const SORT_BUCKET_WEIGHT: Record<AccountSortBucket, number> = {
  current: 0,
  healthy: 1,
  unknown: 2,
  unavailable: 3,
  expired: 4,
};

function getSafeRemaining(value: number | undefined): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined;
}

function getScoreValue(ui: AccountUiState): number {
  const weekly = ui.weeklyRemainingPercent ?? -1;
  const daily = ui.dailyRemainingPercent ?? -1;
  return weekly * 1000 + daily;
}

export function deriveAccountUiState(
  account: WindsurfAccountLike,
  currentAccountId: string | undefined,
  snapshot?: QuotaSnapshotLike,
): AccountUiState {
  const rq = snapshot?.real;
  const isCurrent = account.id === currentAccountId;
  const isExpired = !!rq?.planEndTimestamp && rq.planEndTimestamp > 0 && rq.planEndTimestamp < Date.now();
  const weeklyRemainingPercent = getSafeRemaining(rq?.weeklyRemainingPercent);
  const dailyRemainingPercent = getSafeRemaining(rq?.dailyRemainingPercent);
  // -1 with reset time = API didn't return %, but quota IS tracked → treat as exhausted
  const dailyExhaustedNoData = (rq?.dailyRemainingPercent ?? 0) < 0 && (rq?.dailyResetAtUnix ?? 0) > 0;
  const weeklyExhaustedNoData = (rq?.weeklyRemainingPercent ?? 0) < 0 && (rq?.weeklyResetAtUnix ?? 0) > 0;
  const isUnavailable = !isExpired && (
    dailyExhaustedNoData ||
    weeklyExhaustedNoData ||
    (typeof weeklyRemainingPercent === 'number' && weeklyRemainingPercent <= 0) ||
    (typeof dailyRemainingPercent === 'number' && dailyRemainingPercent <= 0)
  );

  let sortBucket: AccountSortBucket = 'unknown';
  let availabilityLabel: '不可用' | '已过期' | undefined;

  if (isCurrent) {
    sortBucket = 'current';
  } else if (isExpired) {
    sortBucket = 'expired';
    availabilityLabel = '已过期';
  } else if (isUnavailable) {
    sortBucket = 'unavailable';
    availabilityLabel = '不可用';
  } else if (typeof weeklyRemainingPercent === 'number' || typeof dailyRemainingPercent === 'number') {
    sortBucket = 'healthy';
  }

  if (isCurrent && isExpired) {
    availabilityLabel = '已过期';
  } else if (isCurrent && isUnavailable) {
    availabilityLabel = '不可用';
  }

  return {
    id: account.id,
    isCurrent,
    isExpired,
    isUnavailable,
    availabilityLabel,
    sortBucket,
    dailyRemainingPercent,
    weeklyRemainingPercent,
  };
}

export function compareAccountsByUiState<T extends WindsurfAccountLike>(
  a: T,
  b: T,
  currentAccountId: string | undefined,
  snapshotMap: Map<string, QuotaSnapshotLike>,
): number {
  const uiA = deriveAccountUiState(a, currentAccountId, snapshotMap.get(a.id));
  const uiB = deriveAccountUiState(b, currentAccountId, snapshotMap.get(b.id));
  const bucketDiff = SORT_BUCKET_WEIGHT[uiA.sortBucket] - SORT_BUCKET_WEIGHT[uiB.sortBucket];
  if (bucketDiff !== 0) return bucketDiff;

  const scoreDiff = getScoreValue(uiB) - getScoreValue(uiA);
  if (scoreDiff !== 0) return scoreDiff;

  return (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
}

export function getAvailableAccountCount<T extends WindsurfAccountLike>(
  accounts: T[],
  currentAccountId: string | undefined,
  snapshotMap: Map<string, QuotaSnapshotLike>,
): number {
  return accounts.filter((account) => {
    const ui = deriveAccountUiState(account, currentAccountId, snapshotMap.get(account.id));
    return !ui.isExpired && !ui.isUnavailable;
  }).length;
}

export function getVirtualWindow(input: VirtualWindowInput): VirtualWindowResult {
  const itemCount = Math.max(0, input.itemCount);
  const itemHeight = Math.max(1, input.itemHeight);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const totalHeight = itemCount * itemHeight;

  if (itemCount === 0) {
    return { startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0 };
  }

  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const clampedScrollTop = Math.min(Math.max(0, input.scrollTop), maxScrollTop);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / itemHeight));
  const startIndex = Math.max(0, Math.floor(clampedScrollTop / itemHeight) - input.overscan);
  const endIndex = Math.min(
    itemCount - 1,
    Math.floor(clampedScrollTop / itemHeight) + visibleCount + input.overscan - 1,
  );

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * itemHeight,
    totalHeight,
  };
}
