# Quote Account Unavailable State + Virtualized List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Quote treat accounts as unavailable when daily remaining or weekly remaining quota drops below 10%, keep that behavior consistent across sorting and interaction, and replace the current account list with a dedicated virtualized scroll viewport that preserves search and local UI state.

**Architecture:** Keep all persistence and sync semantics unchanged. Implement a frontend-local derived `AccountUiState` layer in `media/main.ts`, route account sorting/counting/badge/click behavior through that shared derivation, and render the account tab through a dedicated scroll container with windowed rows plus overscan. `src/webview/provider.ts` stays mostly unchanged and continues sending `accountsSync`; the virtualized rendering and scroll-state preservation stay entirely inside the webview.

**Tech Stack:** TypeScript, VS Code webview DOM APIs, CSS, Vitest, esbuild

---

## File map

### Files to modify

- `media/main.ts`
  - Replace scattered disabled-state logic with unified account UI state helpers.
  - Replace incremental "load more" account rendering with virtualized/windowed rendering.
  - Preserve search/query/scroll/selection state across `accountsSync`.
- `media/main.css`
  - Add a dedicated account-list viewport layout.
  - Add stable row-height styling for virtual rows.
  - Rename/adjust unavailable visual classes and badge styling.
- `src/webview/provider.ts`
  - Verify that `buildAccountsPayload()` / `postAccountsSync()` still send `accounts`, `currentAccountId`, `autoSwitch`, `quotaSnapshots`, and `quotaFetching` unchanged so the webview can derive filtering, counts, and virtualization locally.
  - Leave provider behavior untouched unless a failing test identifies a specific payload mismatch that blocks the account-tab refactor.
- `tests/unit/provider-handler.test.ts`
  - Add focused regression coverage for provider-side compatibility with the new account-tab rendering assumptions.

### Files to create

- `media/account-ui-state.ts`
  - Pure helper module for account availability derivation, sorting buckets, and virtual-window calculations.
- `tests/unit/account-ui-state.test.ts`
  - Unit tests for unavailable-state logic, sort ranking helpers, and virtual-window math.

### Files to inspect while implementing

- `media/main.ts:591-881`
  - Existing `isAccountDisabled`, `accountSortScore`, `filterAccounts`, `renderAccountTab`, and `renderAccountItem`.
- `media/main.ts:1526-1741`
  - Existing tab, search, and account-card event binding.
- `media/main.css:459-500`
  - Existing search-row styling.
- `media/main.css:1244-1479`
  - Existing account-list/card styling.
- `src/webview/provider.ts:130-180`
  - Existing `buildAccountsPayload()` and `postAccountsSync()` behavior.

### Files not in scope

- `src/core/windsurf-account.ts`
- `src/core/data-manager.ts`
- persistence `revision` / `reloadFromDisk()` / watch semantics
- Windsurf native login/session synchronization

---

### Task 1: Extract and test unified account UI state helpers

**Files:**
- Create: `media/account-ui-state.ts`
- Test: `tests/unit/account-ui-state.test.ts`
- Inspect: `media/main.ts:591-613`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/unit/account-ui-state.test.ts` with this content:

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveAccountUiState,
  compareAccountsByUiState,
  getAvailableAccountCount,
  getVirtualWindow,
} from '../../media/account-ui-state';

type RealQuotaInfo = {
  dailyRemainingPercent: number;
  weeklyRemainingPercent: number;
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
  it('marks account unavailable when weekly remaining is below 10', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { weeklyRemainingPercent: 9.9, dailyRemainingPercent: 60 })
    );

    expect(ui.isUnavailable).toBe(true);
    expect(ui.availabilityLabel).toBe('不可用');
    expect(ui.sortBucket).toBe('unavailable');
  });

  it('marks account unavailable when daily remaining is below 10', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { dailyRemainingPercent: 9.9, weeklyRemainingPercent: 80 })
    );

    expect(ui.isUnavailable).toBe(true);
    expect(ui.availabilityLabel).toBe('不可用');
  });

  it('does not mark account unavailable at exactly 10 percent', () => {
    const ui = deriveAccountUiState(
      makeAccount('a', 'a@test.com'),
      undefined,
      makeSnapshot('a', { dailyRemainingPercent: 10, weeklyRemainingPercent: 10 })
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
      makeSnapshot('a', { dailyRemainingPercent: 1, weeklyRemainingPercent: 50 })
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
      ['unavailable', makeSnapshot('unavailable', { dailyRemainingPercent: 8, weeklyRemainingPercent: 50 })],
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
      ['unavailable', makeSnapshot('unavailable', { weeklyRemainingPercent: 5, dailyRemainingPercent: 50 })],
      ['expired', makeSnapshot('expired', { planEndTimestamp: Date.now() - 1000, dailyRemainingPercent: 50, weeklyRemainingPercent: 50 })],
    ]);

    expect(getAvailableAccountCount(accounts, undefined, snapshotMap)).toBe(2);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts
```

Expected: FAIL because `media/account-ui-state.ts` does not exist yet.

- [ ] **Step 3: Write the helper module**

Create `media/account-ui-state.ts` with this content:

```ts
export interface WindsurfAccountLike {
  id: string;
  email: string;
  addedAt: string;
}

export interface RealQuotaInfoLike {
  dailyRemainingPercent: number;
  weeklyRemainingPercent: number;
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
  const isUnavailable = !isExpired && (
    (typeof weeklyRemainingPercent === 'number' && weeklyRemainingPercent < 10) ||
    (typeof dailyRemainingPercent === 'number' && dailyRemainingPercent < 10)
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/account-ui-state.ts tests/unit/account-ui-state.test.ts
git commit -m "test: add account ui state helpers"
```

---

### Task 2: Route account tab sorting, count, badge, and click behavior through unified UI state

**Files:**
- Modify: `media/main.ts:1-40`
- Modify: `media/main.ts:588-881`
- Test: `tests/unit/account-ui-state.test.ts`

- [ ] **Step 1: Add integration-style helper tests for current-account and badge behavior**

Append these tests to `tests/unit/account-ui-state.test.ts`:

```ts
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

    expect(getAvailableAccountCount(accounts, 'current', snapshotMap)).toBe(1);
  });

  it('derives unavailable label for current unavailable account without changing current bucket', () => {
    const ui = deriveAccountUiState(
      makeAccount('current', 'current@test.com'),
      'current',
      makeSnapshot('current', { dailyRemainingPercent: 5, weeklyRemainingPercent: 50 })
    );

    expect(ui.sortBucket).toBe('current');
    expect(ui.availabilityLabel).toBe('不可用');
  });
});
```

- [ ] **Step 2: Run the tests to verify the baseline still passes**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts
```

Expected: PASS. This confirms the helper module can support the `main.ts` refactor before touching the UI.

- [ ] **Step 3: Refactor `media/main.ts` to use unified UI-state helpers**

At the top of `media/main.ts`, add imports from the helper module:

```ts
import {
  compareAccountsByUiState,
  deriveAccountUiState,
  getAvailableAccountCount,
  getVirtualWindow,
  type AccountUiState,
} from './account-ui-state';
```

Replace the old helper block around `isAccountDisabled()` and `accountSortScore()` with these local helpers:

```ts
const ACCOUNT_ROW_HEIGHT = 96;
const ACCOUNT_OVERSCAN = 4;

function buildSnapshotMap(quotaSnapshots: QuotaSnapshot[]): Map<string, QuotaSnapshot> {
  return new Map(quotaSnapshots.map((snapshot) => [snapshot.accountId, snapshot]));
}

function sortAccountsByUiState(
  accounts: WindsurfAccount[],
  currentAccountId: string | undefined,
  snapshotMap: Map<string, QuotaSnapshot>,
): WindsurfAccount[] {
  return [...accounts].sort((a, b) => compareAccountsByUiState(a, b, currentAccountId, snapshotMap));
}
```

Then update `renderAccountTab()` to compute counts/sort through the shared helpers and replace the old `accountPageSize` / “显示更多” branch entirely with a virtual-window render path:

```ts
function renderAccountTab(bs: Bootstrap): string {
  const { accounts, autoSwitch, quotaSnapshots } = bs;
  const snapshotMap = buildSnapshotMap(quotaSnapshots);
  const isFetching = bs.quotaFetching || state.quotaFetching;
  const availableCount = getAvailableAccountCount(accounts, bs.currentAccountId, snapshotMap);
  const sorted = sortAccountsByUiState(accounts, bs.currentAccountId, snapshotMap);
  const filtered = filterAccounts(sorted, state.accountSearchQuery);

  const viewportHeight = state.accountViewportHeight || ACCOUNT_ROW_HEIGHT * 6;
  const virtualWindow = getVirtualWindow({
    itemCount: filtered.length,
    itemHeight: ACCOUNT_ROW_HEIGHT,
    viewportHeight,
    scrollTop: state.accountScrollTop,
    overscan: ACCOUNT_OVERSCAN,
  });

  const visibleAccounts =
    virtualWindow.endIndex >= virtualWindow.startIndex
      ? filtered.slice(virtualWindow.startIndex, virtualWindow.endIndex + 1)
      : [];

  return `
    <div class="tab-content">
      <section class="card">
        <div class="section-header">
          <h2>账号 (${availableCount}/${accounts.length})</h2>
          <div class="btn-group">
            <button class="btn-xs btn-icon ${isFetching ? 'disabled' : ''}" data-action="fetchAllQuotas" ${isFetching ? 'disabled' : ''} title="刷新全部配额">${isFetching ? `${icon('refresh')} …` : `${icon('refresh')} 配额`}</button>
            <button class="btn-xs btn-icon" data-action="toggleAddAccount">${icon('plus')} 添加</button>
            <button class="btn-xs btn-icon" data-action="toggleImportAccount">${icon('upload')} 批量</button>
            ${accounts.length > 0 ? `<button class="btn-xs btn-icon ${state.selectMode ? 'btn-active' : ''}" data-action="toggleSelectMode" title="多选删除">☑ 选择</button>` : ''}
            ${accounts.length > 0 && !state.selectMode ? `<button class="btn-xs btn-danger-xs" data-action="accountClear">清空</button>` : ''}
          </div>
          ${state.selectMode
            ? `
          <div class="btn-group select-bar">
            <span class="hint" style="margin:0">已选 ${state.selectedAccountIds.size} 个</span>
            <button class="btn-xs btn-icon" data-action="selectAll">全选</button>
            <button class="btn-xs btn-icon" data-action="selectNone">取消</button>
            <button class="btn-xs btn-danger-xs ${state.selectedAccountIds.size === 0 ? 'disabled' : ''}" data-action="accountDeleteBatch" ${state.selectedAccountIds.size === 0 ? 'disabled' : ''}>删除选中</button>
            <button class="btn-xs btn-icon" data-action="toggleSelectMode">退出选择</button>
          </div>`
            : ''}
        </div>

        <div class="account-search-row">
          <div class="search-input-wrap">
            ${icon('search')}
            <input class="text-input" id="accountSearch" type="text" placeholder="搜索邮箱或套餐" value="${escapeHtml(state.accountSearchQuery)}">
          </div>
          ${state.accountSearchQuery ? `<button class="btn-xs btn-icon" data-action="accountSearchClear">清空</button>` : ''}
        </div>

        ${state.showAddAccount
          ? `
          <div class="inline-form">
            <p class="hint">格式: 邮箱 密码（空格分隔）</p>
            <input class="text-input" id="addAccountLine" type="text" placeholder="user@mail.com password123" value="${escapeHtml(state.addEmail)}">
            <div class="btn-group">
              <button class="btn-grad btn-sm" data-action="accountAdd">确认添加</button>
              <button class="btn-secondary btn-sm" data-action="toggleAddAccount">取消</button>
            </div>
          </div>`
          : ''}

        ${state.showImportAccount
          ? `
          <div class="inline-form">
            <p class="hint">${icon('upload')} 批量导入 (每行: 邮箱 密码)</p>
            <textarea class="text-area" id="importText" rows="5" placeholder="user1@mail.com pass123\nuser2@mail.com pass456">${escapeHtml(state.importText)}</textarea>
            <div class="btn-group">
              <button class="btn-grad btn-sm" data-action="accountImport">导入</button>
              <button class="btn-secondary btn-sm" data-action="toggleImportAccount">取消</button>
            </div>
          </div>`
          : ''}

        <div class="account-list-shell">
          <div class="account-list-viewport" id="accountListViewport" data-scroll-top="${state.accountScrollTop}">
            ${filtered.length > 0
              ? `
                <div class="account-list-spacer" style="height:${virtualWindow.totalHeight}px">
                  <div class="account-list-window" style="transform:translateY(${virtualWindow.offsetTop}px)">
                    ${visibleAccounts
                      .map((account, visibleIndex) =>
                        renderAccountItem(
                          account,
                          bs.currentAccountId,
                          snapshotMap.get(account.id),
                          virtualWindow.startIndex + visibleIndex,
                        ),
                      )
                      .join('')}
                  </div>
                </div>`
              : `<div class="empty-state">${icon('inbox', 'empty-icon')} <p>${state.accountSearchQuery ? '未找到匹配账号' : '暂无账号，点击“添加”或“批量导入”'}</p></div>`}
          </div>
        </div>
      </section>

      ${state.editingQuotaAccountId ? renderQuotaEditor(bs) : ''}

      <section class="card">
        <div class="section-header"><h2>自动切换</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">启用自动切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchEnabled" ${autoSwitch.enabled ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">日配额触顶时切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchOnDaily" ${autoSwitch.switchOnDaily ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">周配额触顶时切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchOnWeekly" ${autoSwitch.switchOnWeekly ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">剩余配额阈值</span>
            <input class="num-input" id="autoSwitchThreshold" type="number" value="${autoSwitch.threshold}" min="0" max="999">
          </div>
          <div class="setting-row">
            <span class="setting-label">配额预警值</span>
            <input class="num-input" id="autoSwitchCreditWarning" type="number" value="${autoSwitch.creditWarning}" min="0" max="999">
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="autoSwitchSave">保存设置</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>高级操作</h2></div>
        <div class="actions">
          <button class="btn-secondary" data-action="resetMachineId">重置机器 ID</button>
        </div>
        <p class="hint">重置 Windsurf 机器标识，用于解除设备绑定限制</p>
      </section>
    </div>`;
}
```

Update `renderAccountItem()` so it derives one `ui` object and uses that for classes and badge text while keeping the existing quota bars and reset-time text intact:

```ts
function renderAccountItem(
  a: WindsurfAccount,
  currentId?: string,
  snapshot?: QuotaSnapshot,
  index = 0,
): string {
  const ui = deriveAccountUiState(a, currentId, snapshot);
  const isDisabled = ui.isExpired || ui.isUnavailable;
  const rowTop = index * ACCOUNT_ROW_HEIGHT;
  const planColors: Record<string, string> = {
    Pro: 'var(--accent)',
    Max: '#8b5cf6',
    Enterprise: '#a855f7',
    Teams: '#06b6d4',
  };
  const planColor = planColors[a.plan] ?? 'var(--muted)';
  const q = snapshot;
  const rq = q?.real;

  let dailyFillPct: number | null = null;
  let weeklyFillPct: number | null = null;
  let dailyText = '';
  let weeklyText = '';
  let dailyResetText = '';
  let weeklyResetText = '';
  let planEndText = '';

  if (rq) {
    dailyFillPct =
      rq.dailyRemainingPercent >= 0
        ? Math.max(0, Math.min(100, 100 - rq.dailyRemainingPercent))
        : null;
    weeklyFillPct =
      rq.weeklyRemainingPercent >= 0
        ? Math.max(0, Math.min(100, 100 - rq.weeklyRemainingPercent))
        : null;
    dailyText = dailyFillPct !== null ? `${Math.round(dailyFillPct)}%` : '';
    weeklyText = weeklyFillPct !== null ? `${Math.round(weeklyFillPct)}%` : '';
    if (rq.dailyResetAtUnix) dailyResetText = formatResetDateTime(rq.dailyResetAtUnix * 1000);
    if (rq.weeklyResetAtUnix) weeklyResetText = formatResetDateTime(rq.weeklyResetAtUnix * 1000);
    if (rq.planEndTimestamp && rq.planEndTimestamp > 0) {
      const endDate = new Date(rq.planEndTimestamp);
      planEndText = endDate.toLocaleDateString('zh-CN', {
        month: 'short',
        day: 'numeric',
      });
    }
  } else if (q && q.dailyLimit > 0) {
    dailyFillPct = pct(q.dailyUsed, q.dailyLimit);
    weeklyFillPct = q.weeklyLimit > 0 ? pct(q.weeklyUsed, q.weeklyLimit) : null;
    dailyText = `${Math.round(dailyFillPct)}%`;
    weeklyText = weeklyFillPct !== null ? `${Math.round(weeklyFillPct)}%` : '';
    dailyResetText = q.dailyResetIn;
    weeklyResetText = q.weeklyResetIn;
  } else if (a.creditsTotal > 0) {
    dailyFillPct = pct(a.creditsUsed, a.creditsTotal);
    dailyText = `${Math.round(dailyFillPct)}%`;
  }

  const fillClass = (usedPct: number | null): string => {
    if (usedPct === null) return '';
    if (usedPct < 50) return 'quota-fill-ok';
    if (usedPct < 80) return 'quota-fill-warn';
    return 'quota-fill-danger';
  };

  return `
    <div class="ac-virtual-row" data-index="${index}" data-id="${a.id}" style="transform:translateY(${rowTop}px)">
      <div class="ac-card ${ui.isCurrent ? 'ac-active' : ''} ${ui.isExpired ? 'ac-expired' : ui.isUnavailable ? 'ac-unavailable' : ''} ${q?.warningLevel === 'critical' && !isDisabled ? 'ac-crit' : q?.warningLevel === 'warn' && !isDisabled ? 'ac-warn' : ''} ${state.selectedAccountIds.has(a.id) ? 'ac-selected' : ''} ${state.switchLoadingId === a.id ? 'ac-switching' : ''}" data-id="${a.id}">
        <div class="ac-head">
          ${state.selectMode ? `<input type="checkbox" class="ac-checkbox" data-action="toggleSelect" data-id="${a.id}" ${state.selectedAccountIds.has(a.id) ? 'checked' : ''}>` : ''}
          <span class="ac-email" title="${escapeHtml(a.email)}">${escapeHtml(a.email)}</span>
          <div class="ac-tags">
            <span class="plan-badge plan-${a.plan.toLowerCase()}" style="--plan-color:${planColor}">${planIcon(a.plan)} ${a.plan}</span>
            ${planEndText ? `<span class="ac-end">${planEndText}</span>` : ''}
            ${ui.isCurrent ? '<span class="badge-active">当前</span>' : ''}
            ${ui.availabilityLabel === '已过期' ? '<span class="badge-expired">已过期</span>' : ui.availabilityLabel === '不可用' ? '<span class="badge-unavailable">不可用</span>' : ''}
          </div>
        </div>
        <div class="ac-bars">
          <div class="ac-bar-row">
            <span class="ac-lbl">周</span>
            <div class="ac-track"><div class="ac-fill ${fillClass(weeklyFillPct)}" style="width:${weeklyFillPct ?? 0}%"></div></div>
            <span class="ac-pct${weeklyFillPct === null ? ' ac-nodata' : ''}">${weeklyText || '—'}</span>
            ${weeklyResetText ? `<span class="ac-rt">${weeklyResetText}</span>` : ''}
          </div>
          <div class="ac-bar-row">
            <span class="ac-lbl">日</span>
            <div class="ac-track"><div class="ac-fill ${fillClass(dailyFillPct)}" style="width:${dailyFillPct ?? 0}%"></div></div>
            <span class="ac-pct${dailyFillPct === null ? ' ac-nodata' : ''}">${dailyText || '—'}</span>
            ${dailyResetText ? `<span class="ac-rt">${dailyResetText}</span>` : ''}
          </div>
        </div>
        ${state.switchLoadingId === a.id ? '<div class="ac-switching-bar"></div>' : ''}
      </div>
    </div>`;
}
```

Update the account-card click guard in `bindEvents()` so it matches the new class name:

```ts
if (
  card.classList.contains('ac-unavailable') ||
  card.classList.contains('ac-expired')
) {
  return;
}
```

- [ ] **Step 4: Run the tests to verify the refactor is green**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts && npm run check-types
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/main.ts tests/unit/account-ui-state.test.ts

git commit -m "feat: unify unavailable account ui state"
```

---

### Task 3: Replace load-more rendering with a dedicated virtualized account viewport

**Files:**
- Modify: `media/main.ts:243-320`
- Modify: `media/main.ts:627-725`
- Modify: `media/main.ts:1526-1741`
- Modify: `media/main.css:1244-1479`
- Test: `tests/unit/account-ui-state.test.ts`

- [ ] **Step 1: Extend the virtual-window test coverage**

Append these tests to `tests/unit/account-ui-state.test.ts`:

```ts
describe('virtual window ranges', () => {
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
```

- [ ] **Step 2: Run the tests to verify they pass before UI wiring**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts
```

Expected: PASS.

- [ ] **Step 3: Implement virtualized list state and DOM structure**

In `media/main.ts`, extend the top-level `state` object with virtual-list state:

```ts
  accountScrollTop: 0,
  accountViewportHeight: 0,
```

Replace the current `accountPageSize` state field entirely. Delete:

```ts
  accountPageSize: 50,
```

Update the search input handler so it preserves query but resets scroll instead of page size:

```ts
accountSearch?.addEventListener('input', () => {
  state.accountSearchQuery = accountSearch.value;
  state.accountScrollTop = 0;
  render();
});
```

Then replace the current list markup in `renderAccountTab()`:

```ts
        <div class="account-list-shell">
          <div class="account-list-viewport" id="accountListViewport" data-scroll-top="${state.accountScrollTop}">
            ${filtered.length > 0
              ? `
                <div class="account-list-spacer" style="height:${virtualWindow.totalHeight}px">
                  <div class="account-list-window" style="transform:translateY(${virtualWindow.offsetTop}px)">
                    ${visibleAccounts
                      .map((account, visibleIndex) =>
                        renderAccountItem(
                          account,
                          bs.currentAccountId,
                          snapshotMap.get(account.id),
                          virtualWindow.startIndex + visibleIndex,
                        ),
                      )
                      .join('')}
                  </div>
                </div>`
              : `<div class="empty-state">${icon('inbox', 'empty-icon')} <p>${state.accountSearchQuery ? '未找到匹配账号' : '暂无账号，点击“添加”或“批量导入”'}</p></div>`}
          </div>
        </div>
```

In `bindEvents()`, wire the dedicated viewport:

```ts
const accountViewport = document.getElementById('accountListViewport') as HTMLDivElement | null;
if (accountViewport) {
  accountViewport.scrollTop = state.accountScrollTop;
  state.accountViewportHeight = accountViewport.clientHeight;

  let rafId = 0;
  accountViewport.addEventListener('scroll', () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      state.accountScrollTop = accountViewport.scrollTop;
      render();
    });
  });

  const resizeObserver = new ResizeObserver(() => {
    const nextHeight = accountViewport.clientHeight;
    if (nextHeight !== state.accountViewportHeight) {
      state.accountViewportHeight = nextHeight;
      render();
    }
  });
  resizeObserver.observe(accountViewport);
}
```

In `media/main.css`, replace the old list spacing block:

```css
.account-list {
  margin-top: var(--sp-3);
}
```

with this viewport layout:

```css
.account-list-shell {
  margin-top: var(--sp-3);
  min-height: 320px;
}

.account-list-viewport {
  position: relative;
  height: min(62vh, 640px);
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: var(--radius-lg);
}

.account-list-spacer {
  position: relative;
  width: 100%;
}

.account-list-window {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

.ac-virtual-row {
  height: 96px;
  padding-bottom: 8px;
}

.ac-card {
  min-height: 88px;
  margin-bottom: 0;
}
```

- [ ] **Step 4: Run the focused checks**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts && npm run check-types
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/main.ts media/main.css tests/unit/account-ui-state.test.ts

git commit -m "feat: virtualize account list rendering"
```

---

### Task 4: Preserve search and scroll state across `accountsSync`

**Files:**
- Modify: `media/main.ts:243-320`
- Modify: `media/main.ts:2100-2260`
- Modify: `src/webview/provider.ts:130-180`
- Test: `tests/unit/provider-handler.test.ts`

- [ ] **Step 1: Add provider compatibility tests for `accountsSync`**

Add these tests to `tests/unit/provider-handler.test.ts`:

```ts
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
      realQuota: { dailyRemainingPercent: 80, weeklyRemainingPercent: 90 },
    },
  ]);

  await (ctx.provider as any).postAccountsSync();

  expect(ctx.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'accountsSync',
      value: expect.objectContaining({
        accounts: expect.any(Array),
        currentAccountId: 'ws_1',
        quotaSnapshots: expect.any(Array),
      }),
    })
  );
});

it('visibility revalidate continues to use accountsSync instead of forcing bootstrap', async () => {
  ctx.dataManager.windsurfAccounts.reloadFromDisk.mockResolvedValueOnce(true);

  ctx.visibilityHandlers[0]?.();
  await Promise.resolve();

  const sentTypes = ctx.postMessage.mock.calls.map((call: any) => call[0]?.type);
  expect(sentTypes).toContain('selectTab');
  expect(sentTypes).toContain('accountsSync');
  expect(sentTypes).not.toContain('bootstrap');
});
```

- [ ] **Step 2: Run the provider tests to verify the baseline**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: PASS. If this command fails, fix only the test fixture mismatch shown in the failure output; do not change provider architecture or message timing for this feature.

- [ ] **Step 3: Update `media/main.ts` message handling to preserve local view state on sync**

In the webview message handler section, update the `accountsSync` branch so it preserves local search and clamps scroll instead of resetting local state. Use this pattern:

```ts
if (msg.type === 'accountsSync') {
  const next = msg.value as Pick<Bootstrap, 'accounts' | 'currentAccountId' | 'autoSwitch' | 'quotaSnapshots' | 'quotaFetching'>;
  const previousAccounts = window.__QUOTE_BOOTSTRAP__.accounts;

  window.__QUOTE_BOOTSTRAP__ = {
    ...window.__QUOTE_BOOTSTRAP__,
    accounts: next.accounts,
    currentAccountId: next.currentAccountId,
    autoSwitch: next.autoSwitch,
    quotaSnapshots: next.quotaSnapshots,
    quotaFetching: next.quotaFetching,
  };

  if (previousAccounts !== next.accounts) {
    const estimatedTotalHeight = next.accounts.length * ACCOUNT_ROW_HEIGHT;
    const viewportHeight = Math.max(0, state.accountViewportHeight);
    const maxScrollTop = Math.max(0, estimatedTotalHeight - viewportHeight);
    state.accountScrollTop = Math.min(state.accountScrollTop, maxScrollTop);
  }

  render();
  return;
}
```

If `window.__QUOTE_BOOTSTRAP__` is currently typed as immutable in this file, first convert local access to a mutable `bootstrap` variable:

```ts
let bootstrap = window.__QUOTE_BOOTSTRAP__;
```

and then replace reads like `const bs = window.__QUOTE_BOOTSTRAP__;` with `const bs = bootstrap;` throughout `media/main.ts`.

In `src/webview/provider.ts`, do not change `postAccountsSync()` if the provider tests and type-check already pass. Only update a field type or helper signature when a failing build points to that exact line as incompatible with the refactor.

- [ ] **Step 4: Run the tests and type-check**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts && npm run check-types
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/main.ts src/webview/provider.ts tests/unit/provider-handler.test.ts

git commit -m "fix: preserve account tab state across sync"
```

---

### Task 5: Polish account-tab layout and unavailable styling semantics

**Files:**
- Modify: `media/main.css:1244-1479`
- Modify: `media/main.ts:777-881`
- Test: `tests/unit/account-ui-state.test.ts`

- [ ] **Step 1: Add final semantic tests for unavailable naming assumptions**

Append this test to `tests/unit/account-ui-state.test.ts`:

```ts
it('never emits legacy exhausted label from unified ui state', () => {
  const ui = deriveAccountUiState(
    makeAccount('a', 'a@test.com'),
    undefined,
    makeSnapshot('a', { dailyRemainingPercent: 5, weeklyRemainingPercent: 50 })
  );

  expect(ui.availabilityLabel).toBe('不可用');
  expect(ui.availabilityLabel).not.toBe('已耗尽');
});
```

- [ ] **Step 2: Run the helper tests to verify the naming contract**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts
```

Expected: PASS.

- [ ] **Step 3: Rename the legacy exhausted styling to unavailable styling**

In `media/main.css`, replace the old exhausted block:

```css
.ac-card.ac-exhausted {
  background: color-mix(in srgb, var(--surface) 22%, var(--bg));
  border-color: color-mix(in srgb, var(--border-glass) 12%, transparent);
  opacity: 0.36;
  filter: saturate(0.15) brightness(0.85);
  cursor: not-allowed;
  transition:
    border-color var(--t-normal),
    background var(--t-normal),
    opacity var(--t-normal),
    filter var(--t-normal);
}
.ac-card.ac-exhausted:hover {
  opacity: 0.52;
  filter: saturate(0.3) brightness(0.92);
  border-color: color-mix(in srgb, var(--border-glass) 25%, transparent);
  background: color-mix(in srgb, var(--surface) 30%, var(--bg));
  transform: none;
  box-shadow: none;
}
.ac-card.ac-exhausted.ac-active {
  opacity: 0.50;
  filter: saturate(0.25) brightness(0.88);
  border-color: color-mix(in srgb, var(--accent) 20%, var(--border-glass));
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 30%, transparent);
}
.badge-exhausted {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--muted) 18%, transparent);
  color: var(--muted);
  flex-shrink: 0;
  line-height: 1.6;
}
```

with:

```css
.ac-card.ac-unavailable {
  background: color-mix(in srgb, var(--surface) 22%, var(--bg));
  border-color: color-mix(in srgb, var(--border-glass) 12%, transparent);
  opacity: 0.36;
  filter: saturate(0.15) brightness(0.85);
  cursor: not-allowed;
  transition:
    border-color var(--t-normal),
    background var(--t-normal),
    opacity var(--t-normal),
    filter var(--t-normal);
}

.ac-card.ac-unavailable:hover {
  opacity: 0.52;
  filter: saturate(0.3) brightness(0.92);
  border-color: color-mix(in srgb, var(--border-glass) 25%, transparent);
  background: color-mix(in srgb, var(--surface) 30%, var(--bg));
  transform: none;
  box-shadow: none;
}

.ac-card.ac-unavailable.ac-active {
  opacity: 0.50;
  filter: saturate(0.25) brightness(0.88);
  border-color: color-mix(in srgb, var(--accent) 20%, var(--border-glass));
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 30%, transparent);
}

.badge-unavailable {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--muted) 18%, transparent);
  color: var(--muted);
  flex-shrink: 0;
  line-height: 1.6;
}
```

Then update any `.ac-exhausted` or `.badge-exhausted` references in `media/main.ts` to `.ac-unavailable` and `.badge-unavailable`.

- [ ] **Step 4: Run the feature checks**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/main.ts media/main.css tests/unit/account-ui-state.test.ts

git commit -m "style: align unavailable account visuals"
```

---

### Task 6: Full verification and manual UX pass

**Files:**
- Modify: none
- Verify: `media/main.ts`
- Verify: `media/main.css`
- Verify: `src/webview/provider.ts`
- Verify: `tests/unit/account-ui-state.test.ts`
- Verify: `tests/unit/provider-handler.test.ts`

- [ ] **Step 1: Run focused automated checks**

Run:

```bash
npm run test:unit -- tests/unit/account-ui-state.test.ts
npm run test:unit -- tests/unit/provider-handler.test.ts
npm run check-types
npm run build
```

Expected: all PASS.

- [ ] **Step 2: Run the full unit suite**

Run:

```bash
npm run test:unit
```

Expected: PASS with no regressions in existing account-sync, dialog, or provider tests.

- [ ] **Step 3: Validate the account tab manually in the extension UI**

Use the extension in a live VS Code / Windsurf dev session and verify all of the following:

```text
1. Daily remaining 9.9% → card shows 不可用, is ghosted, and cannot be clicked.
2. Weekly remaining 9.9% → same behavior.
3. Daily and weekly exactly 10% → still switchable.
4. Missing quota data → card remains switchable and not ghosted.
5. Current account can still show 当前 + 不可用 together.
6. Search query stays intact after an accountsSync-triggering action.
7. Scroll down deep in the list, trigger quota refresh or account sync, and confirm the viewport does not jump to the top.
8. No blank visual gap appears while scrolling.
9. Selection mode still works for rows that scroll in/out of view.
10. Header available/total count matches the new unavailable semantics.
```

Expected: all checks pass.

- [ ] **Step 4: Run two-stage review before shipping**

Review against the approved spec at `docs/superpowers/specs/2026-04-13-account-unavailable-virtualized-list-design.md`.

Stage 1 checklist:

```text
- daily<10 or weekly<10 unavailable rule implemented
- sorting/ghostify/disabled click/available count/badge unified
- dedicated scroll container implemented
- virtualized/windowed rendering implemented
- search/scroll/local state preserved on accountsSync
- no persistence/revision/watch scope creep introduced
```

Stage 2 checklist:

```text
- helper logic covered by unit tests
- provider compatibility tests pass
- no hard-coded DOM assumptions tied to full-list rendering
- class names consistent between main.ts and main.css
- build/typecheck/unit tests all green
```

Expected: no Critical or Important issues remain.

- [ ] **Step 5: Commit the final verification pass**

```bash
git add media/main.ts media/main.css media/account-ui-state.ts tests/unit/account-ui-state.test.ts tests/unit/provider-handler.test.ts
git commit -m "test: verify unavailable account virtualization flow"
```
