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

  it('keeps add and sorting visible while moving destructive account actions into more menu', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const toolbar = source.match(/function renderAccountToolbar[\s\S]*?function getAccountTabData/)?.[0] ?? '';

    expect(toolbar).toContain('data-action="toggleImportAccount"');
    expect(toolbar).toContain('添加');
    expect(toolbar).toContain('id="accountSortMode"');
    expect(toolbar).toContain('金额 ↓');
    expect(toolbar).toContain('天数 ↑');
    expect(toolbar).toContain('data-action="toggleAccountMore"');
    expect(toolbar).toContain('data-action="batchRefreshQuota"');
    expect(toolbar).toContain('刷新</button>');
    expect(toolbar).toContain('data-action="accountExport"');
    expect(toolbar).toContain('data-action="accountClear"');
    expect(toolbar).not.toContain('批量添加');
    expect(toolbar).not.toContain('批量刷新');
  });

  it('wires account email copy as an account action without switching cards', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const accountItem = source.match(/function renderAccountItem[\s\S]*?function renderHistoryTab/)?.[0] ?? '';
    const copyCase = source.match(/case "accountCopyEmail": \{[\s\S]*?break;\n\s*\}/)?.[0] ?? '';

    expect(accountItem).toContain('data-action="accountCopyEmail"');
    expect(accountItem).toContain('class="ac-copy-btn"');
    expect(copyCase).toContain('navigator.clipboard.writeText(email)');
    expect(copyCase).toContain('账号已复制');
  });

  it('sorts account list through selected account sort mode before filtering', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const tabData = source.match(/function getAccountTabData[\s\S]*?function renderAccountListContent/)?.[0] ?? '';
    const sortEvents = source.match(/const accountSortMode[\s\S]*?accountViewport/)?.[0] ?? '';

    expect(tabData).toContain('const sorted = sortAccounts(');
    expect(sortEvents).toContain('state.accountSortMode = accountSortMode.value as AccountSortMode');
    expect(sortEvents).toContain('patchAccountTab();');
  });

  it('keeps the current account first before applying manual account sorting metrics', () => {
    const source = readFileSync('media/main.ts', 'utf8');
    const sortAccounts = source.match(/function sortAccounts\([\s\S]*?function filterAccounts/)?.[0] ?? '';
    const currentFirstIndex = sortAccounts.indexOf('if (a.id === currentAccountId) return -1;');
    const metricDiffIndex = sortAccounts.indexOf('const metricDiff = compareOptionalNumber');

    expect(currentFirstIndex).toBeGreaterThan(-1);
    expect(sortAccounts).toContain('if (b.id === currentAccountId) return 1;');
    expect(metricDiffIndex).toBeGreaterThan(currentFirstIndex);
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
