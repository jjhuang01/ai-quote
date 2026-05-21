import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    clampAccountScrollTop,
    filterAccountsForQuery,
    getFilteredAccountIds,
    normalizeAccountSelection,
    reconcileQuotaFetchingIds,
    requestQuotaSelfHealOnce,
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

  it('posts single-account self-heal requests only once per account', () => {
    const requestedIds = new Set<string>();
    const messages: Array<{ type: string; value: string }> = [];
    const postMessage = (message: { type: string; value: string }) => {
      messages.push(message);
    };

    expect(requestQuotaSelfHealOnce('ws_1', requestedIds, postMessage)).toBe(true);
    expect(requestQuotaSelfHealOnce('ws_1', requestedIds, postMessage)).toBe(false);
    expect(requestQuotaSelfHealOnce('', requestedIds, postMessage)).toBe(false);

    expect(messages).toEqual([{ type: 'selfHealQuota', value: 'ws_1' }]);
    expect(messages.some((message) => message.type === 'fetchAllQuotas')).toBe(false);
  });

  it('wires stale quota self-heal without using fetchAllQuotas in webview source', () => {
    const source = readFileSync('media/main.ts', 'utf8');

    expect(source).toContain('requestQuotaSelfHealOnce');
    expect(source).toContain('shouldRequestQuotaSelfHeal');
    expect(source).toContain('selfHealQuota');
    expect(source).not.toContain('type: "fetchAllQuotas"');
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

  it('places reset machine id action in settings instead of account tab', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const accountTab = source.match(/function renderAccountTab[\s\S]*?function renderAccountItem/)?.[0] ?? '';
    const settingsTab = source.match(/function renderSettingsTab[\s\S]*?function renderMaintenanceBtn/)?.[0] ?? '';

    expect(accountTab).not.toContain('data-action="resetMachineId"');
    expect(settingsTab).toContain('data-action="resetMachineId"');
  });

  it('exposes quota auto-continue as an account-tab switch setting', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const accountTab = source.match(/function renderAccountTab[\s\S]*?function renderAccountItem/)?.[0] ?? '';
    const autoSwitchSave = source.match(/case "autoSwitchSave": \{[\s\S]*?break;\n\s*\}/)?.[0] ?? '';

    expect(accountTab).toContain('id="quotaAutoContinueEnabled"');
    expect(accountTab).toContain('额度耗尽切号后自动继续');
    expect(accountTab).toContain('需要同时启用自动切换');
    expect(autoSwitchSave).toContain('type: "settingsUpdate"');
    expect(autoSwitchSave).toContain('quotaAutoContinueEnabled');
  });
});
