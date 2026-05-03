import { describe, expect, it } from 'vitest';
import {
  clampAccountScrollTop,
  filterAccountsForQuery,
  getFilteredAccountIds,
  normalizeAccountSelection,
  reconcileQuotaFetchingIds,
} from '../../media/account-webview-state';

describe('account-webview-state', () => {
  it('filters by email and plan', () => {
    const accounts = [
      { id: '1', email: 'alpha@test.com', plan: 'Pro' },
      { id: '2', email: 'beta@test.com', plan: 'Teams' },
    ];

    expect(filterAccountsForQuery(accounts, 'alp').map((a) => a.id)).toEqual(['1']);
    expect(filterAccountsForQuery(accounts, 'teams').map((a) => a.id)).toEqual(['2']);
  });

  it('prunes selected ids that no longer exist', () => {
    const next = normalizeAccountSelection(new Set(['a', 'missing']), ['a', 'b']);
    expect([...next]).toEqual(['a']);
  });

  it('returns only filtered account ids for select-all flows', () => {
    const accounts = [
      { id: '1', email: 'alpha@test.com', plan: 'Pro' },
      { id: '2', email: 'beta@test.com', plan: 'Teams' },
      { id: '3', email: 'gamma@test.com', plan: 'Free' },
    ];

    expect(getFilteredAccountIds(accounts, 'teams')).toEqual(['2']);
    expect(getFilteredAccountIds(accounts, '')).toEqual(['1', '2', '3']);
  });


  it('reconciles local quota fetching ids with provider ids and existing accounts', () => {
    const next = reconcileQuotaFetchingIds({
      localIds: new Set(['ws_1', 'ws_stale', 'ws_deleted']),
      providerIds: ['ws_2', 'ws_deleted'],
      existingAccountIds: ['ws_1', 'ws_2'],
    });

    expect([...next]).toEqual(['ws_2']);
  });

  it('clamps scroll after account count shrinks', () => {
    expect(
      clampAccountScrollTop({ scrollTop: 400, itemCount: 2, itemHeight: 96, viewportHeight: 240 }),
    ).toBe(0);
  });
});
