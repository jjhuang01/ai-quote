import { describe, expect, it } from 'vitest';
import {
  clampAccountScrollTop,
  filterAccountsForQuery,
  normalizeAccountSelection,
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

  it('clamps scroll after account count shrinks', () => {
    expect(
      clampAccountScrollTop({ scrollTop: 400, itemCount: 2, itemHeight: 96, viewportHeight: 240 }),
    ).toBe(0);
  });
});
