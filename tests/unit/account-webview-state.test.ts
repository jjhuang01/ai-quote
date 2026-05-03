import { readFileSync } from 'node:fs';
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

  it('uses full render after selecting an account card in select mode', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const selectModeCardClickBranch = source.match(
      /if \(state\.selectMode\) \{[\s\S]*?return;\n\s*\}/,
    );

    expect(selectModeCardClickBranch?.[0]).toContain('render();');
    expect(selectModeCardClickBranch?.[0]).not.toContain('patchAccountTab();');
  });

  it("delegates patched account action buttons before account card click handling", () => {
    const source = readFileSync("media/main.ts", "utf8");
    const viewportClickHandler = source.match(
      /accountViewport\.addEventListener\("click", \(e\) => \{[\s\S]*?vscode\.postMessage\(\{ type: "accountSwitch", value: id \}\);\n\s*\}\);/,
    );

    const handlerSource = viewportClickHandler?.[0] ?? "";
    const checkboxReturnIndex = handlerSource.indexOf("target.closest(\".ac-checkbox\")");
    const actionLookupIndex = handlerSource.indexOf("target.closest<HTMLElement>(\"[data-action]\")");
    const handleActionIndex = handlerSource.indexOf("handleAction(actionEl);");
    const cardLookupIndex = handlerSource.indexOf("target.closest<HTMLElement>(\".ac-card[data-id]\")");

    expect(viewportClickHandler).not.toBeNull();
    expect(checkboxReturnIndex).toBeGreaterThan(-1);
    expect(actionLookupIndex).toBeGreaterThan(checkboxReturnIndex);
    expect(handleActionIndex).toBeGreaterThan(actionLookupIndex);
    expect(cardLookupIndex).toBeGreaterThan(handleActionIndex);
    expect(handlerSource).toContain("accountViewport.contains(actionEl)");
  });

});
