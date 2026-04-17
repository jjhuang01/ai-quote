# Account Search and Sync Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix account search input instability and account persistence/sync regressions so typing is uninterrupted, search controls stay on one row, deleted accounts stay deleted after restart, and stale windows cannot overwrite newer account state.

**Architecture:** Keep the existing Quote account flow intact while tightening the persistence contract and reducing UI blast radius. `WindsurfAccountManager` becomes the authority for version-gated saves and file-change-driven reloads; `QuoteSidebarProvider` continues posting `accountsSync`; `media/main.ts` stops full-app rerenders for account search/list updates and instead patches the account tab locally.

**Tech Stack:** TypeScript, VS Code extension APIs, Vitest, DOM-based webview UI, atomic JSON persistence via `safeWriteJson`

---

## File map

- `src/core/windsurf-account.ts`
  - Add explicit stale-write detection and a file watcher that reloads the account file when another window writes it.
  - Keep persisted `revision`/`updatedAt` as the cross-window contract.
- `src/webview/provider.ts`
  - Keep `accountsSync` as the delivery mechanism.
  - Adjust only where needed so account revalidation and account-change events still drive the webview correctly.
- `media/main.ts`
  - Extract account-tab patch helpers so search/list updates do not replace `#app`.
  - Preserve search query, focus, scroll position, and selected IDs across `accountsSync`.
- `media/main.css`
  - Lock the account search row to a single line with stable flex behavior.
- `tests/unit/windsurf-account.test.ts`
  - Cover revision-gated persistence, reload-before-reject behavior, and watcher-triggered reload.
- `tests/unit/provider-handler.test.ts`
  - Cover provider delivery after account changes and revalidation.
- `tests/unit/account-webview-state.test.ts`
  - New pure-helper tests for account filtering/list patch behavior.

---

### Task 1: Harden account persistence against stale-window overwrite

**Files:**
- Modify: `src/core/windsurf-account.ts`
- Test: `tests/unit/windsurf-account.test.ts`

- [ ] **Step 1: Write the failing persistence tests**

Add these tests to `tests/unit/windsurf-account.test.ts`:

```ts
it('reloads newer disk state and rejects stale write before save', async () => {
  await manager.initialize();
  await manager.add('fresh@test.com', 'p');

  const diskPayload = {
    revision: 5,
    updatedAt: '2026-04-14T00:00:00.000Z',
    currentId: 'ws_disk',
    autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
    accounts: [{
      id: 'ws_disk',
      email: 'disk@test.com',
      password: 'p',
      plan: 'Free',
      creditsUsed: 0,
      creditsTotal: 0,
      quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
      expiresAt: '',
      isActive: true,
      addedAt: '2026-04-14T00:00:00.000Z'
    }]
  };

  (fs.readFile as any)
    .mockResolvedValueOnce(JSON.stringify(diskPayload))
    .mockResolvedValue(JSON.stringify(diskPayload));

  await expect(manager.delete('ws_missing')).resolves.toBe(false);
  expect(manager.getAll().map((a) => a.email)).toEqual(['disk@test.com']);
  expect(fs.writeFile).not.toHaveBeenCalledWith(
    expect.stringContaining('windsurf-accounts.json.tmp'),
    expect.stringContaining('fresh@test.com'),
    'utf8'
  );
});

it('increments revision from disk state on successful save', async () => {
  const diskPayload = {
    revision: 7,
    updatedAt: '2026-04-14T00:00:00.000Z',
    currentId: undefined,
    autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
    accounts: []
  };

  (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));

  await manager.initialize();
  await manager.add('next@test.com', 'p');

  const writeCall = (fs.writeFile as any).mock.calls.find(
    ([filePath]: [string]) => filePath.endsWith('windsurf-accounts.json.tmp')
  );
  const [, rawJson] = writeCall;
  expect(JSON.parse(rawJson).revision).toBe(8);
});
```

- [ ] **Step 2: Run the persistence tests to verify failure**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: FAIL because the current manager only calls `reloadFromDisk()` opportunistically and does not have an explicit stale-write rejection path the tests can assert against.

- [ ] **Step 3: Implement explicit stale-write detection in `src/core/windsurf-account.ts`**

Add a private guard and use it before every mutating save path:

```ts
private async reloadIfDiskIsNewer(): Promise<boolean> {
  const data = await this.readPersistedState();
  const diskRevision = data?.revision ?? 0;
  if (diskRevision <= this.revision) {
    return false;
  }

  this.applyPersistedState(data);
  this.onDidChangeAccountsEmitter.fire();
  this.logger.info('Reloaded newer account state from disk.', {
    diskRevision,
    previousRevision: this.revision,
  });
  return true;
}

private async ensureFreshBeforeWrite(): Promise<boolean> {
  return this.reloadIfDiskIsNewer();
}
```

Update each mutating entry point to gate its write path:

```ts
public async delete(id: string): Promise<boolean> {
  await this.ensureFreshBeforeWrite();
  const idx = this.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return false;

  this.accounts.splice(idx, 1);
  if (this.currentAccountId === id) {
    this.currentAccountId = this.accounts[0]?.id;
    this.accounts = this.accounts.map((a, i) => ({ ...a, isActive: a.id === this.currentAccountId && i === 0 }));
  }

  await this.save();
  this.logger.info('WindsurfAccount deleted.', { id });
  return true;
}
```

Use the same `await this.ensureFreshBeforeWrite();` pattern in:
- `add`
- `importBatch`
- `update`
- `deleteBatch`
- `clear`
- `switchTo`
- `updateAutoSwitch`
- quota/prompt methods that persist account state

Keep `save()` responsible for `revision += 1` and `updatedAt = new Date().toISOString()` before calling `safeWriteJson(...)`.

- [ ] **Step 4: Run the persistence tests to verify pass**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: PASS with the new revision behavior and stale-write protection.

- [ ] **Step 5: Commit the persistence hardening**

```bash
git add tests/unit/windsurf-account.test.ts src/core/windsurf-account.ts
git commit -m "fix: prevent stale account writes across windows"
```

---

### Task 2: Add file-change-driven reload for cross-window sync

**Files:**
- Modify: `src/core/windsurf-account.ts`
- Test: `tests/unit/windsurf-account.test.ts`

- [ ] **Step 1: Write the failing watcher test**

Add this test to `tests/unit/windsurf-account.test.ts`:

```ts
it('starts a file watcher that reloads accounts on external changes', async () => {
  const watcher = {
    onDidChange: vi.fn((fn: () => void) => {
      watcher.changeHandler = fn;
      return { dispose: vi.fn() };
    }),
    onDidCreate: vi.fn((fn: () => void) => {
      watcher.createHandler = fn;
      return { dispose: vi.fn() };
    }),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    changeHandler: undefined as undefined | (() => void),
    createHandler: undefined as undefined | (() => void),
  };

  (vscode.workspace.createFileSystemWatcher as any).mockReturnValueOnce(watcher);

  const diskPayload = {
    revision: 2,
    updatedAt: '2026-04-14T00:00:00.000Z',
    currentId: 'ws_ext',
    autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
    accounts: [{
      id: 'ws_ext',
      email: 'external@test.com',
      password: 'p',
      plan: 'Free',
      creditsUsed: 0,
      creditsTotal: 0,
      quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
      expiresAt: '',
      isActive: true,
      addedAt: '2026-04-14T00:00:00.000Z'
    }]
  };

  await manager.initialize();
  manager.startWatching();

  (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
  await watcher.changeHandler?.();
  await Promise.resolve();

  expect(manager.getAll().map((a) => a.email)).toEqual(['external@test.com']);
});
```

- [ ] **Step 2: Run the watcher test to verify failure**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts -t "file watcher"
```

Expected: FAIL because `startWatching()` currently uses `setInterval` polling instead of a file watcher.

- [ ] **Step 3: Replace polling with VS Code file watching in `src/core/windsurf-account.ts`**

Refactor the watcher fields and setup:

```ts
private accountsWatcher?: vscode.FileSystemWatcher;
private watcherDisposables: vscode.Disposable[] = [];
```

Use the persistence file path to create the watcher:

```ts
public startWatching(): void {
  if (this.accountsWatcher) return;

  const pattern = new vscode.RelativePattern(
    path.dirname(this.filePath),
    path.basename(this.filePath),
  );
  this.accountsWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  const reload = async (): Promise<void> => {
    try {
      await this.reloadFromDisk();
    } catch (error) {
      this.logger.warn('Account sync reload failed.', { error: String(error) });
    }
  };

  this.watcherDisposables = [
    this.accountsWatcher.onDidChange(() => void reload()),
    this.accountsWatcher.onDidCreate(() => void reload()),
  ];
}

public stopWatching(): void {
  this.watcherDisposables.forEach((d) => d.dispose());
  this.watcherDisposables = [];
  this.accountsWatcher?.dispose();
  this.accountsWatcher = undefined;
}
```

Keep `dispose()` calling `stopWatching()`.

- [ ] **Step 4: Run the watcher tests to verify pass**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: PASS including the watcher-driven reload test.

- [ ] **Step 5: Commit the watcher work**

```bash
git add tests/unit/windsurf-account.test.ts src/core/windsurf-account.ts
git commit -m "fix: reload account state on file changes"
```

---

### Task 3: Keep provider delivery stable while account sync gets stricter

**Files:**
- Modify: `src/webview/provider.ts`
- Test: `tests/unit/provider-handler.test.ts`

- [ ] **Step 1: Write the failing provider tests**

Add or tighten tests in `tests/unit/provider-handler.test.ts`:

```ts
it('revalidateAccounts posts accountsSync after disk reload', async () => {
  ctx.dataManager.windsurfAccounts.reloadFromDisk.mockResolvedValueOnce(true);
  ctx.postMessage.mockClear();

  ctx.visibilityHandlers[0]?.();
  await Promise.resolve();
  await Promise.resolve();

  const messages = ctx.postMessage.mock.calls.map((call: any) => call[0]);
  expect(messages.some((m: any) => m.type === 'accountsSync')).toBe(true);
});

it('accountDelete still refreshes the webview with accountsSync', async () => {
  await ctx.send({ type: 'accountDelete', value: 'ws_1' });

  const messages = ctx.postMessage.mock.calls.map((call: any) => call[0]);
  expect(messages.some((m: any) => m.type === 'accountsSync')).toBe(true);
});
```

- [ ] **Step 2: Run the provider tests to verify current behavior**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: If failures appear after the persistence changes, they will most likely be timing-related around visibility revalidation or account delete refresh.

- [ ] **Step 3: Make the minimal provider adjustments in `src/webview/provider.ts`**

Keep `accountsSync` as the incremental account-tab delivery path. If needed, make the account handlers explicitly post sync after mutations:

```ts
private async revalidateAccounts(): Promise<void> {
  const changed = await this.dataManager.windsurfAccounts.reloadFromDisk();
  if (changed) {
    await this.postAccountsSync();
  }
}
```

For account actions, preserve the current pattern of refreshing account state without forcing a full bootstrap when only account data changed:

```ts
case 'accountDelete': {
  if (typeof value !== 'string') return true;
  await this.dataManager.windsurfAccounts.delete(value);
  await this.postAccountsSync();
  return true;
}
```

Apply the same idea where account mutations currently rely on broader refreshes than necessary.

- [ ] **Step 4: Run the provider tests to verify pass**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: PASS with `accountsSync` still being the observable contract for account changes.

- [ ] **Step 5: Commit the provider compatibility fix**

```bash
git add tests/unit/provider-handler.test.ts src/webview/provider.ts
git commit -m "fix: keep account sync delivery stable"
```

---

### Task 4: Stop full-app rerenders during account search

**Files:**
- Modify: `media/main.ts`
- Create: `tests/unit/account-webview-state.test.ts`

- [ ] **Step 1: Write failing helper tests for account-tab patch behavior**

Create `tests/unit/account-webview-state.test.ts` with pure helper coverage:

```ts
import { describe, expect, it } from 'vitest';
import {
  filterAccountsForQuery,
  normalizeAccountSelection,
  clampAccountScrollTop,
} from '../../media/account-webview-state';

describe('account-webview-state', () => {
  it('filters by email and plan', () => {
    const accounts = [
      { id: '1', email: 'alpha@test.com', plan: 'Pro', addedAt: '2026-04-14T00:00:00.000Z' },
      { id: '2', email: 'beta@test.com', plan: 'Teams', addedAt: '2026-04-14T00:00:00.000Z' },
    ];

    expect(filterAccountsForQuery(accounts as any, 'alp').map((a) => a.id)).toEqual(['1']);
    expect(filterAccountsForQuery(accounts as any, 'teams').map((a) => a.id)).toEqual(['2']);
  });

  it('prunes selected ids that no longer exist', () => {
    const next = normalizeAccountSelection(new Set(['a', 'missing']), ['a', 'b']);
    expect([...next]).toEqual(['a']);
  });

  it('clamps scroll after account count shrinks', () => {
    expect(clampAccountScrollTop({ scrollTop: 400, itemCount: 2, itemHeight: 96, viewportHeight: 240 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run the new helper test to verify failure**

Run:

```bash
npm run test:unit -- tests/unit/account-webview-state.test.ts
```

Expected: FAIL because `media/account-webview-state.ts` does not exist yet.

- [ ] **Step 3: Add webview-state helpers and account-tab patching in `media/main.ts`**

Create `media/account-webview-state.ts`:

```ts
export interface SearchableAccountLike {
  id: string;
  email: string;
  plan?: string;
}

export function filterAccountsForQuery<T extends SearchableAccountLike>(accounts: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return accounts;
  return accounts.filter((account) => {
    const email = account.email.toLowerCase();
    const plan = (account.plan ?? '').toLowerCase();
    return email.includes(q) || plan.includes(q);
  });
}

export function normalizeAccountSelection(current: Set<string>, existingIds: string[]): Set<string> {
  const allowed = new Set(existingIds);
  return new Set([...current].filter((id) => allowed.has(id)));
}

export function clampAccountScrollTop(input: { scrollTop: number; itemCount: number; itemHeight: number; viewportHeight: number }): number {
  const totalHeight = Math.max(0, input.itemCount * input.itemHeight);
  const maxScrollTop = Math.max(0, totalHeight - Math.max(0, input.viewportHeight));
  return Math.min(Math.max(0, input.scrollTop), maxScrollTop);
}
```

Import and use those helpers from `media/main.ts`. Then split the account rendering into reusable pieces so account search can patch only the tab content:

```ts
function getAccountTabElements(): {
  listShell: HTMLDivElement | null;
  statsLabel: HTMLElement | null;
  searchInput: HTMLInputElement | null;
  searchClear: HTMLButtonElement | null;
} {
  return {
    listShell: document.getElementById('accountListShell') as HTMLDivElement | null,
    statsLabel: document.getElementById('accountCountLabel'),
    searchInput: document.getElementById('accountSearch') as HTMLInputElement | null,
    searchClear: document.querySelector('[data-action="accountSearchClear"]'),
  };
}

function patchAccountTab(): void {
  if (state.activeTab !== 'account') return;
  const bs = window.__QUOTE_BOOTSTRAP__;
  if (!bs) return;

  const snapshotMap = buildSnapshotMap(bs.quotaSnapshots);
  const sorted = sortAccountsByUiState(bs.accounts, bs.currentAccountId, snapshotMap);
  const filtered = filterAccountsForQuery(sorted, state.accountSearchQuery);

  const els = getAccountTabElements();
  if (els.statsLabel) {
    els.statsLabel.textContent = `${getAvailableAccountCount(bs.accounts, bs.currentAccountId, snapshotMap)}/${bs.accounts.length}`;
  }
  if (els.listShell) {
    els.listShell.innerHTML = renderAccountListHtml(filtered, bs, snapshotMap);
  }
  if (els.searchInput && els.searchInput.value !== state.accountSearchQuery) {
    els.searchInput.value = state.accountSearchQuery;
  }
  bindAccountTabEvents();
}
```

Change the account search input handler from global render to patch-only:

```ts
accountSearch?.addEventListener('input', () => {
  state.accountSearchQuery = accountSearch.value;
  state.accountScrollTop = 0;
  patchAccountTab();
});
```

Change the account viewport scroll handler so it patches only the list rows:

```ts
accountViewport.addEventListener('scroll', () => {
  if (rafId) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = 0;
    state.accountScrollTop = accountViewport.scrollTop;
    patchAccountTab();
  });
});
```

In the `accountsSync` message handler, replace the full `render()` call with account-tab patching when possible:

```ts
if (msg.type === 'accountsSync') {
  bootstrap = { ...bootstrap, ...value };
  window.__QUOTE_BOOTSTRAP__ = bootstrap;

  state.selectedAccountIds = normalizeAccountSelection(
    state.selectedAccountIds,
    value.accounts.map((account) => account.id),
  );
  state.accountScrollTop = clampAccountScrollTop({
    scrollTop: state.accountScrollTop,
    itemCount: value.accounts.length,
    itemHeight: ACCOUNT_ROW_HEIGHT,
    viewportHeight: state.accountViewportHeight,
  });

  if (state.activeTab === 'account') {
    patchAccountTab();
  } else {
    render();
  }
  return;
}
```

- [ ] **Step 4: Run the helper tests and targeted account UI tests**

Run:

```bash
npm run test:unit -- tests/unit/account-webview-state.test.ts tests/unit/account-ui-state.test.ts
```

Expected: PASS with the new helper module and no regressions in the existing account UI state helpers.

- [ ] **Step 5: Commit the account search rendering fix**

```bash
git add tests/unit/account-webview-state.test.ts media/account-webview-state.ts media/main.ts
git commit -m "fix: preserve account search input during filtering"
```

---

### Task 5: Keep the search input and clear button on one row

**Files:**
- Modify: `media/main.css`
- Modify: `media/main.ts`

- [ ] **Step 1: Write the failing layout assertion in webview markup tests or inline snapshot**

If this repo has no existing DOM snapshot test for the webview, add a focused assertion in the account webview helper test that the markup still renders the dedicated row structure:

```ts
it('renders account search row with separate input wrap and clear action', () => {
  const html = renderAccountSearchRow('alpha');
  expect(html).toContain('class="account-search-row"');
  expect(html).toContain('class="search-input-wrap"');
  expect(html).toContain('data-action="accountSearchClear"');
});
```

If the row renderer does not exist yet, create it as part of the implementation in Step 3.

- [ ] **Step 2: Run the layout-focused test to verify failure**

Run:

```bash
npm run test:unit -- tests/unit/account-webview-state.test.ts
```

Expected: FAIL until the search-row renderer/helper exists.

- [ ] **Step 3: Implement a stable search row in `media/main.ts` and `media/main.css`**

Render the row with fixed structure:

```ts
function renderAccountSearchRow(): string {
  return `
    <div class="account-search-row">
      <div class="search-input-wrap">
        ${icon('search')}
        <input class="text-input" id="accountSearch" type="text" placeholder="搜索邮箱或套餐" value="${escapeHtml(state.accountSearchQuery)}">
      </div>
      <button class="btn-xs btn-icon${state.accountSearchQuery ? '' : ' is-hidden'}" data-action="accountSearchClear" type="button">清空</button>
    </div>
  `;
}
```

Add CSS in `media/main.css`:

```css
.account-search-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: nowrap;
  min-width: 0;
}

.account-search-row .search-input-wrap {
  flex: 1 1 auto;
  min-width: 0;
}

.account-search-row .btn-xs {
  flex: 0 0 auto;
  white-space: nowrap;
}

.account-search-row .btn-xs.is-hidden {
  visibility: hidden;
}
```

Use `visibility: hidden` instead of conditionally removing the button so the input width stays stable and the row does not reflow.

- [ ] **Step 4: Run the layout-focused tests and build**

Run:

```bash
npm run test:unit -- tests/unit/account-webview-state.test.ts && npm run build
```

Expected: PASS and successful build output.

- [ ] **Step 5: Commit the layout fix**

```bash
git add tests/unit/account-webview-state.test.ts media/main.ts media/main.css
git commit -m "fix: stabilize account search row layout"
```

---

### Task 6: Run full verification and manual regression

**Files:**
- Modify: `tests/unit/windsurf-account.test.ts`
- Modify: `tests/unit/provider-handler.test.ts`
- Create: `tests/unit/account-webview-state.test.ts`
- Modify: `src/core/windsurf-account.ts`
- Modify: `src/webview/provider.ts`
- Modify: `media/main.ts`
- Modify: `media/main.css`

- [ ] **Step 1: Run the targeted unit suite**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts tests/unit/provider-handler.test.ts tests/unit/account-webview-state.test.ts tests/unit/account-ui-state.test.ts
```

Expected: PASS for persistence, provider, search helpers, and existing account UI state coverage.

- [ ] **Step 2: Run the full unit suite**

Run:

```bash
npm run test:unit
```

Expected: PASS across the repo.

- [ ] **Step 3: Run types and build**

Run:

```bash
npm run check-types && npm run build
```

Expected: both commands succeed with no new type or bundling errors.

- [ ] **Step 4: Manually verify the account flows in the extension host**

Run the extension in development and verify all of the following:

```text
1. Open the account tab.
2. Type 5+ characters into account search continuously.
3. Confirm focus/caret stay in the input and results update normally.
4. Click clear and confirm the input remains focused and the row does not wrap.
5. Open a second Windsurf/VS Code window for the same workspace.
6. Delete an account in window A.
7. Confirm window B refreshes without reopening the extension.
8. Restart the extension host or reopen the window.
9. Confirm the deleted account does not return.
10. Trigger another account mutation from a stale window and confirm old state is not written back.
```

Expected: all checks pass with no account resurrection and no broken account-tab interaction.

- [ ] **Step 5: Commit the verified feature set**

```bash
git add tests/unit/windsurf-account.test.ts tests/unit/provider-handler.test.ts tests/unit/account-webview-state.test.ts src/core/windsurf-account.ts src/webview/provider.ts media/main.ts media/main.css media/account-webview-state.ts
git commit -m "fix: restore reliable account search and sync"
```

---

## Self-review checklist

### Spec coverage

- Search input focus/caret stability: covered in Task 4 and Task 6.
- Search row single-line layout: covered in Task 5 and Task 6.
- Deleted account survives restart correctly (stays deleted): covered in Task 1 and Task 6.
- Cross-window sync via file-change-driven reload: covered in Task 2 and Task 6.
- Provider remains `accountsSync`-based: covered in Task 3.
- Preserve selection/scroll/search state through sync: covered in Task 4.

### Placeholder scan

- No `TBD`, `TODO`, or “similar to Task N” placeholders remain.
- Each code-changing step includes concrete code blocks.
- Each verification step includes exact commands.

### Type consistency

- Persistence helper names use `reloadIfDiskIsNewer` / `ensureFreshBeforeWrite` consistently.
- Webview helper names use `filterAccountsForQuery`, `normalizeAccountSelection`, and `clampAccountScrollTop` consistently.
- Provider contract remains `postAccountsSync()` / `accountsSync` consistently.
