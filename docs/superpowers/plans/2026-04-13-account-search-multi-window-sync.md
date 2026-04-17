# Quote Account Search + Multi-Window Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build account search in the Quote account tab and reliable multi-window synchronization for Quote-owned account data without syncing Windsurf native login/session state.

**Architecture:** Keep `windsurf-accounts.json` as the source of truth, add revision-aware persistence plus reload-before-write protection in `WindsurfAccountManager`, and propagate account-only refreshes to the webview through a targeted `accountsSync` message. The webview keeps search state local and reapplies filtering when synchronized account data changes so sync never resets the user’s local UI context.

**Tech Stack:** VS Code extension API, TypeScript, Vitest, esbuild, file-backed JSON persistence via `safeReadJson` / `safeWriteJson`

---

## File map

### Files to modify

- `src/core/windsurf-account.ts`
  - Add revision metadata, reload-before-write protection, external reload support, and account change events.
- `src/core/data-manager.ts`
  - Start/stop account watching as part of manager lifecycle.
- `src/webview/provider.ts`
  - Replace account-related `postBootstrap()` usage with a targeted `accountsSync` push and hook provider refresh to account-change events.
- `media/main.ts`
  - Add account search UI/state, handle `accountsSync`, preserve local state across sync, and filter account rendering locally.
- `tests/unit/windsurf-account.test.ts`
  - Add revision, reload, concurrent-write, and event-emission coverage.
- `tests/unit/provider-handler.test.ts`
  - Add coverage for targeted account sync pushes and removal of unnecessary full bootstrap refreshes.

### Files to inspect while implementing

- `src/utils/safe-json.ts`
  - Persistence semantics (`.tmp` + rename + `.bak`) affect how watch/retry logic must behave.
- `esbuild.mjs`
  - Confirms that webview UI source lives in `media/main.ts`.

### Files not in scope

- `src/adapters/windsurf-patch.ts`
- Windsurf native session/login synchronization paths
- Non-account webview tabs except where account sync handling is shared by the top-level message loop

---

### Task 1: Add revision-aware persisted account metadata

**Files:**
- Modify: `src/core/windsurf-account.ts:39-58`
- Modify: `src/core/windsurf-account.ts:844-872`
- Test: `tests/unit/windsurf-account.test.ts`

- [ ] **Step 1: Write the failing persistence metadata test**

Add this test block to `tests/unit/windsurf-account.test.ts` near the existing migration tests:

```ts
it('首次写入后持久化 revision 和 updatedAt', async () => {
  await manager.initialize();
  await manager.add('rev@test.com', 'p');

  const writeCall = (fs.writeFile as any).mock.calls.find(
    ([filePath]: [string]) => filePath.endsWith('windsurf-accounts.json.tmp')
  );

  expect(writeCall).toBeTruthy();
  const [, rawJson] = writeCall;
  const payload = JSON.parse(rawJson);

  expect(payload.revision).toBe(1);
  expect(typeof payload.updatedAt).toBe('string');
  expect(payload.accounts).toHaveLength(1);
  expect(payload.currentId).toBe(payload.accounts[0].id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: FAIL because the persisted payload does not yet include `revision` or `updatedAt`.

- [ ] **Step 3: Add persisted payload metadata to `WindsurfAccountManager`**

In `src/core/windsurf-account.ts`, add persisted payload typing and in-memory fields near the class header:

```ts
interface PersistedWindsurfAccounts {
  revision?: number;
  updatedAt?: string;
  accounts: WindsurfAccount[];
  currentId?: string;
  autoSwitch?: AutoSwitchConfig;
  pendingSwitchId?: string;
}

export class WindsurfAccountManager {
  private readonly filePath: string;
  private accounts: WindsurfAccount[] = [];
  private currentAccountId?: string;
  private pendingSwitchId?: string;
  private autoSwitch: AutoSwitchConfig = { ...DEFAULT_AUTO_SWITCH };
  private revision = 0;
  private updatedAt = '';
  private readonly logger: LoggerLike;
  // ...existing fields
```

Update `load()` and `save()` to round-trip the metadata:

```ts
private async load(): Promise<void> {
  const data = await safeReadJson<PersistedWindsurfAccounts>(this.filePath);
  this.accounts = (data?.accounts ?? []).map((a) => ({
    ...a,
    quota: a.quota
      ? { ...DEFAULT_QUOTA, ...a.quota }
      : { ...DEFAULT_QUOTA },
  }));
  this.currentAccountId = data?.currentId;
  this.autoSwitch = { ...DEFAULT_AUTO_SWITCH, ...(data?.autoSwitch ?? {}) };
  this.pendingSwitchId = data?.pendingSwitchId;
  this.revision = data?.revision ?? 0;
  this.updatedAt = data?.updatedAt ?? '';
}

private async save(): Promise<void> {
  this.revision += 1;
  this.updatedAt = new Date().toISOString();

  const payload: PersistedWindsurfAccounts = {
    revision: this.revision,
    updatedAt: this.updatedAt,
    accounts: this.accounts,
    currentId: this.currentAccountId,
    autoSwitch: this.autoSwitch,
  };

  if (this.pendingSwitchId) {
    payload.pendingSwitchId = this.pendingSwitchId;
  }

  await safeWriteJson(this.filePath, payload);
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: PASS for the new revision-metadata test and no regressions in existing `WindsurfAccountManager` tests.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/windsurf-account.test.ts src/core/windsurf-account.ts
git commit -m "feat: persist account revision metadata"
```

---

### Task 2: Add reload-from-disk and stale-write protection

**Files:**
- Modify: `src/core/windsurf-account.ts:72-110`
- Modify: `src/core/windsurf-account.ts:112-260`
- Modify: `src/core/windsurf-account.ts:451-603`
- Test: `tests/unit/windsurf-account.test.ts`

- [ ] **Step 1: Write the failing reload and stale-write tests**

Add these tests to `tests/unit/windsurf-account.test.ts`:

```ts
it('reloadFromDisk 在磁盘 revision 更新时刷新内存', async () => {
  await manager.initialize();
  await manager.add('first@test.com', 'p');

  const diskPayload = {
    revision: 99,
    updatedAt: '2026-04-13T00:00:00.000Z',
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
      addedAt: '2026-04-13T00:00:00.000Z'
    }]
  };

  (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
  const changed = await (manager as any).reloadFromDisk();

  expect(changed).toBe(true);
  expect(manager.getAll().map((a) => a.email)).toEqual(['disk@test.com']);
  expect(manager.getCurrentAccountId()).toBe('ws_disk');
});

it('delete 在写入前先重载较新的磁盘快照，避免旧数据回写', async () => {
  const staleManager = new WindsurfAccountManager(mockContext, mockLogger);
  await staleManager.initialize();

  const diskPayload = {
    revision: 3,
    updatedAt: '2026-04-13T00:00:00.000Z',
    currentId: 'ws_b',
    autoSwitch: { enabled: false, threshold: 5, checkInterval: 60, creditWarning: 3, switchOnDaily: true, switchOnWeekly: true },
    accounts: [
      {
        id: 'ws_b',
        email: 'b@test.com',
        password: 'p',
        plan: 'Free',
        creditsUsed: 0,
        creditsTotal: 0,
        quota: { dailyUsed: 0, dailyLimit: 0, dailyResetAt: '', weeklyUsed: 0, weeklyLimit: 0, weeklyResetAt: '' },
        expiresAt: '',
        isActive: true,
        addedAt: '2026-04-13T00:00:00.000Z'
      }
    ]
  };

  (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
  const deleted = await staleManager.delete('ws_b');

  expect(deleted).toBe(true);

  const writeCall = (fs.writeFile as any).mock.calls.find(
    ([filePath]: [string]) => filePath.endsWith('windsurf-accounts.json.tmp')
  );
  const [, rawJson] = writeCall;
  const payload = JSON.parse(rawJson);
  expect(payload.accounts).toEqual([]);
  expect(payload.revision).toBe(4);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: FAIL because `reloadFromDisk()` and reload-before-write logic do not yet exist.

- [ ] **Step 3: Implement disk reload and revalidate-before-write helpers**

In `src/core/windsurf-account.ts`, add helper methods after the query section:

```ts
private applyPersistedState(data: PersistedWindsurfAccounts | undefined): void {
  this.accounts = (data?.accounts ?? []).map((a) => ({
    ...a,
    quota: a.quota
      ? { ...DEFAULT_QUOTA, ...a.quota }
      : { ...DEFAULT_QUOTA },
  }));
  this.currentAccountId = data?.currentId;
  this.autoSwitch = { ...DEFAULT_AUTO_SWITCH, ...(data?.autoSwitch ?? {}) };
  this.pendingSwitchId = data?.pendingSwitchId;
  this.revision = data?.revision ?? 0;
  this.updatedAt = data?.updatedAt ?? '';
}

private async readPersistedState(): Promise<PersistedWindsurfAccounts | undefined> {
  return safeReadJson<PersistedWindsurfAccounts>(this.filePath);
}

private async reloadFromDisk(): Promise<boolean> {
  const data = await this.readPersistedState();
  const nextRevision = data?.revision ?? 0;
  if (nextRevision <= this.revision) {
    return false;
  }
  this.applyPersistedState(data);
  return true;
}

private async revalidateBeforeWrite(): Promise<void> {
  await this.reloadFromDisk();
}
```

Update `initialize()` and `load()` to use `applyPersistedState`:

```ts
public async initialize(): Promise<void> {
  await this.load();
}

private async load(): Promise<void> {
  const data = await this.readPersistedState();
  this.applyPersistedState(data);
}
```

Then prepend `await this.revalidateBeforeWrite();` to every method that mutates persisted account state, including these methods:

```ts
public async add(email: string, password: string): Promise<WindsurfAccount> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async importBatch(lines: string): Promise<{ added: number; skipped: number }> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async update(...): Promise<boolean> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async delete(id: string): Promise<boolean> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async deleteBatch(ids: string[]): Promise<number> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async clear(): Promise<void> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async updateAutoSwitch(config: Partial<AutoSwitchConfig>): Promise<AutoSwitchConfig> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async recordPrompt(accountId?: string): Promise<void> {
  await this.revalidateBeforeWrite();
  // existing body...
}

public async setQuotaLimits(id: string, dailyLimit: number, weeklyLimit: number): Promise<boolean> {
  await this.revalidateBeforeWrite();
  // existing body...
}
```

- [ ] **Step 4: Run the targeted unit test suite**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: PASS for the new reload/revalidate tests and existing quota/account behavior tests.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/windsurf-account.test.ts src/core/windsurf-account.ts
git commit -m "feat: revalidate account state before writes"
```

---

### Task 3: Emit account-change events and start watch-based revalidation

**Files:**
- Modify: `src/core/windsurf-account.ts:1-18`
- Modify: `src/core/windsurf-account.ts:39-58`
- Modify: `src/core/windsurf-account.ts:844-872`
- Modify: `src/core/data-manager.ts:40-85`
- Test: `tests/unit/windsurf-account.test.ts`

- [ ] **Step 1: Write the failing event-emission and external-reload tests**

Add these tests to `tests/unit/windsurf-account.test.ts`:

```ts
it('本地写入后触发 onDidChangeAccounts', async () => {
  await manager.initialize();
  const listener = vi.fn();
  const disposable = manager.onDidChangeAccounts(listener);

  await manager.add('listener@test.com', 'p');

  expect(listener).toHaveBeenCalledTimes(1);
  disposable.dispose();
});

it('检测到更高 revision 的外部变更时触发 onDidChangeAccounts', async () => {
  await manager.initialize();
  const listener = vi.fn();
  const disposable = manager.onDidChangeAccounts(listener);

  const diskPayload = {
    revision: 10,
    updatedAt: '2026-04-13T00:00:00.000Z',
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
      addedAt: '2026-04-13T00:00:00.000Z'
    }]
  };

  (fs.readFile as any).mockResolvedValueOnce(JSON.stringify(diskPayload));
  await (manager as any).reloadFromDisk();

  expect(listener).toHaveBeenCalledTimes(1);
  disposable.dispose();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: FAIL because there is no account-change event subscription API yet.

- [ ] **Step 3: Add event emitter and watch lifecycle to `WindsurfAccountManager`**

In `src/core/windsurf-account.ts`, import `EventEmitter` from VS Code and add the fields:

```ts
private readonly onDidChangeAccountsEmitter = new vscode.EventEmitter<void>();
private watchInterval: ReturnType<typeof setInterval> | undefined;

public readonly onDidChangeAccounts = this.onDidChangeAccountsEmitter.event;
```

Emit after successful local writes and after external reloads:

```ts
private async save(): Promise<void> {
  this.revision += 1;
  this.updatedAt = new Date().toISOString();
  const payload: PersistedWindsurfAccounts = {
    revision: this.revision,
    updatedAt: this.updatedAt,
    accounts: this.accounts,
    currentId: this.currentAccountId,
    autoSwitch: this.autoSwitch,
  };
  if (this.pendingSwitchId) payload.pendingSwitchId = this.pendingSwitchId;
  await safeWriteJson(this.filePath, payload);
  this.onDidChangeAccountsEmitter.fire();
}

private async reloadFromDisk(): Promise<boolean> {
  const data = await this.readPersistedState();
  const nextRevision = data?.revision ?? 0;
  if (nextRevision <= this.revision) return false;
  this.applyPersistedState(data);
  this.onDidChangeAccountsEmitter.fire();
  return true;
}
```

Add lifecycle methods using polling-based revalidation as the initial stable watch implementation:

```ts
public startWatching(): void {
  if (this.watchInterval) return;
  this.watchInterval = setInterval(() => {
    void this.reloadFromDisk().catch((error) => {
      this.logger.warn('Account sync reload failed.', { error: String(error) });
    });
  }, 1000);
}

public stopWatching(): void {
  if (this.watchInterval) {
    clearInterval(this.watchInterval);
    this.watchInterval = undefined;
  }
}

public dispose(): void {
  this.stopWatching();
  this.onDidChangeAccountsEmitter.dispose();
}
```

In `src/core/data-manager.ts`, start the watch after initialization and expose disposal:

```ts
public async initialize(): Promise<void> {
  await this.history.initialize();
  await this.account.initialize();
  await this.feedback.initialize();
  await this.settings.initialize();
  await this.shortcuts.initialize();
  await this.templates.initialize();
  await this.usageStats.initialize();
  await this.windsurfAccounts.initialize();
  this.windsurfAccounts.startWatching();
  const savedSettings = this.settings.get();
  if (savedSettings.firebaseApiKey) {
    this.windsurfAccounts.setFirebaseApiKey(savedSettings.firebaseApiKey);
  }
  this.startSession();
  this.logger.info('DataManager initialized.');
}

public dispose(): void {
  this.windsurfAccounts.dispose();
}
```

- [ ] **Step 4: Run the targeted unit tests**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts
```

Expected: PASS for the new event tests. No timer leakage warnings.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/windsurf-account.test.ts src/core/windsurf-account.ts src/core/data-manager.ts
git commit -m "feat: watch account storage for cross-window changes"
```

---

### Task 4: Push targeted account sync updates from the provider

**Files:**
- Modify: `src/webview/provider.ts:10-25`
- Modify: `src/webview/provider.ts:130-187`
- Modify: `src/webview/provider.ts:338-466`
- Test: `tests/unit/provider-handler.test.ts`

- [ ] **Step 1: Write the failing provider sync tests**

Add this test to `tests/unit/provider-handler.test.ts`:

```ts
it('账号变更时发送 accountsSync 而不是只依赖全量 bootstrap', async () => {
  const listenerStore: { fn?: () => void } = {};
  ctx.dataManager.windsurfAccounts.onDidChangeAccounts = vi.fn((fn: () => void) => {
    listenerStore.fn = fn;
    return { dispose: vi.fn() };
  });

  ctx = setupProvider();
  listenerStore.fn?.();

  const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
  const syncMsg = calls.find((m: any) => m.type === 'accountsSync');
  expect(syncMsg).toBeTruthy();
  expect(syncMsg.value).toMatchObject({
    accounts: [],
    currentAccountId: 'ws_1',
  });
});
```

Add this second test:

```ts
it('accountAdd 完成后发送 accountsSync', async () => {
  await ctx.send({ type: 'accountAdd', payload: { email: 'new@test.com', password: 'secret' } });

  const calls = ctx.postMessage.mock.calls.map((c: any) => c[0]);
  expect(calls.some((m: any) => m.type === 'accountsSync')).toBe(true);
});
```

- [ ] **Step 2: Run the provider handler tests to verify they fail**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: FAIL because `QuoteSidebarProvider` does not yet post `accountsSync`.

- [ ] **Step 3: Add account-only sync message generation to `QuoteSidebarProvider`**

In `src/webview/provider.ts`, add a helper near `buildBootstrapAsync()`:

```ts
private async buildAccountsPayload(): Promise<Pick<WebviewBootstrap, 'accounts' | 'currentAccountId' | 'autoSwitch' | 'quotaSnapshots' | 'quotaFetching'>> {
  const accounts = this.dataManager.windsurfAccounts.getAll().map(a => ({
    ...a,
    password: '***'
  }));

  const wa = this.dataManager.windsurfAccounts as unknown as {
    getRealCurrentAccountId?: () => Promise<string | undefined>;
    getCurrentAccountId?: () => string | undefined;
  };
  const realCurrentAccountId = wa.getRealCurrentAccountId
    ? await wa.getRealCurrentAccountId()
    : wa.getCurrentAccountId?.();

  const getRemain = (acc: typeof accounts[number]): number => {
    const rq = acc.realQuota;
    if (rq) {
      if (rq.dailyRemainingPercent >= 0) return rq.dailyRemainingPercent;
      if (rq.remainingMessages > 0) return 50 + Math.min(50, rq.remainingMessages);
      return 50;
    }
    if (!acc.quota || acc.quota.dailyLimit === 0) return 50;
    const used = acc.quota.dailyUsed;
    const limit = acc.quota.dailyLimit;
    return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
  };

  accounts.sort((a, b) => {
    if (a.id === realCurrentAccountId) return -1;
    if (b.id === realCurrentAccountId) return 1;
    const diff = getRemain(b) - getRemain(a);
    if (diff !== 0) return diff;
    return (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
  });

  return {
    accounts,
    autoSwitch: this.dataManager.windsurfAccounts.getAutoSwitchConfig(),
    currentAccountId: realCurrentAccountId,
    quotaSnapshots: this.dataManager.windsurfAccounts.getQuotaSnapshots(),
    quotaFetching: this.dataManager.windsurfAccounts.isQuotaFetching,
  };
}

private async postAccountsSync(): Promise<void> {
  if (!this.view) return;
  void this.view.webview.postMessage({
    type: 'accountsSync',
    value: await this.buildAccountsPayload(),
  });
}
```

Refactor `buildBootstrapAsync()` to spread the helper result:

```ts
private async buildBootstrapAsync(): Promise<WebviewBootstrap> {
  const accountPayload = await this.buildAccountsPayload();
  return {
    status: this.bridge.getStatus(),
    history: this.dataManager.history.getAll(),
    ...accountPayload,
    shortcuts: this.dataManager.shortcuts.getAll(),
    templates: this.dataManager.templates.getAll(),
    settings: this.dataManager.settings.get(),
    usageStats: this.dataManager.usageStats.get(),
    responseQueue: this.responseQueue,
  };
}
```

Subscribe to account changes in the constructor or `resolveWebviewView` path:

```ts
private readonly accountSyncDisposable = this.dataManager.windsurfAccounts.onDidChangeAccounts(() => {
  void this.postAccountsSync();
});
```

Dispose it when the view is disposed.

Then, in account-related branches inside `handleAccount`, replace `this.postBootstrap();` with `await this.postAccountsSync();` where only account data changes are needed:

```ts
await this.dataManager.windsurfAccounts.add(email, password);
await this.postAccountsSync();

const result = await this.dataManager.windsurfAccounts.importBatch(value);
void this.view?.webview.postMessage({ type: 'importResult', value: result });
await this.postAccountsSync();

await this.dataManager.windsurfAccounts.delete(value);
await this.postAccountsSync();
```

Apply the same treatment to `accountDeleteBatch`, `accountClear`, `autoSwitchUpdate`, `quotaSetLimits`, `recordPrompt`, `fetchQuota`, and `fetchAllQuotas`.

- [ ] **Step 4: Run provider handler tests**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: PASS with `accountsSync` messages visible in the mock webview calls.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/provider-handler.test.ts src/webview/provider.ts
git commit -m "feat: push account-only sync updates to webview"
```

---

### Task 5: Add local account search and preserve local state across sync

**Files:**
- Modify: `media/main.ts:240-316`
- Modify: `media/main.ts:611-699`
- Modify: `media/main.ts:1958-2063`
- Modify: `media/main.ts:2609-2755`

- [ ] **Step 1: Write the failing UI-state test scaffold inline in code comments**

Because this repo does not yet have focused DOM tests for `media/main.ts`, add a local manual-test harness comment near the account tab section to drive the implementation:

```ts
// Manual acceptance targets for account search + sync:
// 1. typing "abc" filters account cards by email/plan, case-insensitive
// 2. accountsSync preserves accountSearchQuery and selectMode
// 3. accountsSync reapplies filtering without forcing activeTab changes
```

- [ ] **Step 2: Add account search state**

In the top-level `state` object in `media/main.ts`, add:

```ts
accountSearchQuery: "",
```

so the account-specific state block becomes:

```ts
// Account
showAddAccount: false,
showImportAccount: false,
importText: "",
addEmail: "",
addPassword: "",
accountSearchQuery: "",
selectMode: false,
selectedAccountIds: new Set<string>(),
```

- [ ] **Step 3: Add account filtering helper and search UI**

Add this helper above `renderAccountTab`:

```ts
function filterAccounts(accounts: WindsurfAccount[], query: string): WindsurfAccount[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return accounts;
  return accounts.filter((account) => {
    const emailMatch = account.email.toLowerCase().includes(normalized);
    const planMatch = account.plan.toLowerCase().includes(normalized);
    return emailMatch || planMatch;
  });
}
```

Then update `renderAccountTab(bs)`:

```ts
const sorted = [...accounts].sort((a, b) =>
  accountSortScore(a, bs.currentAccountId, snapshotMap) - accountSortScore(b, bs.currentAccountId, snapshotMap)
);
const filtered = filterAccounts(sorted, state.accountSearchQuery);
```

Add the search input below the section header buttons:

```ts
<div class="account-search-row">
  <div class="search-input-wrap">
    ${icon("search")}
    <input
      class="text-input"
      id="accountSearch"
      type="text"
      placeholder="搜索邮箱或套餐"
      value="${escapeHtml(state.accountSearchQuery)}"
    >
  </div>
  ${state.accountSearchQuery
    ? `<button class="btn-xs btn-icon" data-action="accountSearchClear">清空</button>`
    : ""}
</div>
```

Render `filtered` instead of `sorted`:

```ts
$ {
  filtered.length > 0
    ? filtered
        .slice(0, state.accountPageSize)
        .map((a) => renderAccountItem(a, bs.currentAccountId, snapshotMap.get(a.id)))
        .join("") +
      (filtered.length > state.accountPageSize
        ? `<div style="text-align:center;padding:8px"><button class="btn-xs btn-icon" data-action="accountLoadMore">显示更多 (${state.accountPageSize}/${filtered.length})</button></div>`
        : "")
    : `<div class="empty-state">${icon("inbox", "empty-icon")} <p>${state.accountSearchQuery ? "未找到匹配账号" : "暂无账号，点击“添加”或“批量导入”"}</p></div>`
}
```

- [ ] **Step 4: Wire search input and preserve local state on sync**

In the action handler `switch` in `media/main.ts`, add:

```ts
case "accountSearchClear":
  state.accountSearchQuery = "";
  state.accountPageSize = 50;
  render();
  break;
```

Then add a delegated input listener near the existing event wiring:

```ts
document.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!target) return;

  if (target.id === "accountSearch") {
    state.accountSearchQuery = target.value;
    state.accountPageSize = 50;
    render();
  }
});
```

Finally, in the message handler, support `accountsSync` without clobbering local UI state:

```ts
if (msg.type === "accountsSync") {
  const value = msg.value as Pick<Bootstrap, "accounts" | "currentAccountId" | "autoSwitch" | "quotaSnapshots" | "quotaFetching">;
  window.__QUOTE_BOOTSTRAP__ = {
    ...window.__QUOTE_BOOTSTRAP__,
    accounts: value.accounts,
    currentAccountId: value.currentAccountId,
    autoSwitch: value.autoSwitch,
    quotaSnapshots: value.quotaSnapshots,
    quotaFetching: value.quotaFetching,
  };

  const nextIds = new Set(value.accounts.map((account) => account.id));
  state.selectedAccountIds = new Set(
    [...state.selectedAccountIds].filter((id) => nextIds.has(id))
  );

  if (state.accountPageSize < 50) {
    state.accountPageSize = 50;
  }

  render();
  return;
}
```

- [ ] **Step 5: Build the extension and confirm the webview bundle compiles**

Run:

```bash
npm run build
```

Expected: SUCCESS with updated `dist/webview/main.js` and no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add media/main.ts dist/webview
git commit -m "feat: add account search with local sync-safe state"
```

---

### Task 6: Revalidate on view visibility and window focus

**Files:**
- Modify: `src/webview/provider.ts:27-57`
- Modify: `src/webview/provider.ts:105-128`
- Test: `tests/unit/provider-handler.test.ts`

- [ ] **Step 1: Write the failing revalidation test**

Add this test to `tests/unit/provider-handler.test.ts`:

```ts
it('视图重新可见时触发账号同步重载', async () => {
  const reloadFromDisk = vi.fn(async () => true);
  ctx.dataManager.windsurfAccounts.reloadFromDisk = reloadFromDisk;

  const visibleHandler = ctx.provider['view']?.onDidChangeVisibility?.mock.calls?.[0]?.[0];
  if (visibleHandler) {
    await visibleHandler();
  }

  expect(reloadFromDisk).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the provider tests to verify it fails**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: FAIL because the visibility hook only calls `postBootstrap()` today.

- [ ] **Step 3: Add revalidation helper and use it on visibility/focus boundaries**

In `src/webview/provider.ts`, add:

```ts
private async revalidateAccounts(): Promise<void> {
  const manager = this.dataManager.windsurfAccounts as unknown as {
    reloadFromDisk?: () => Promise<boolean>;
  };

  const changed = manager.reloadFromDisk
    ? await manager.reloadFromDisk()
    : false;

  if (changed) {
    await this.postAccountsSync();
  }
}
```

Update the visibility callback:

```ts
webviewView.onDidChangeVisibility(() => {
  if (webviewView.visible) {
    void this.revalidateAccounts().finally(() => {
      void this.postBootstrap();
    });
  }
});
```

If the codebase already has a window-focus callback registration point elsewhere during activation, wire the same helper there. If not, keep this task limited to `WebviewView` visibility because that is the existing boundary exposed in this provider file.

- [ ] **Step 4: Re-run provider tests**

Run:

```bash
npm run test:unit -- tests/unit/provider-handler.test.ts
```

Expected: PASS with visibility-triggered reload coverage.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/provider-handler.test.ts src/webview/provider.ts
git commit -m "feat: revalidate accounts when sidebar becomes visible"
```

---

### Task 7: Run focused tests, full verification, and manual two-window check

**Files:**
- Modify: none
- Test: `tests/unit/windsurf-account.test.ts`
- Test: `tests/unit/provider-handler.test.ts`

- [ ] **Step 1: Run focused unit tests for the touched backend and provider paths**

Run:

```bash
npm run test:unit -- tests/unit/windsurf-account.test.ts tests/unit/provider-handler.test.ts
```

Expected: PASS for all touched tests.

- [ ] **Step 2: Run the full unit suite**

Run:

```bash
npm run test:unit
```

Expected: PASS with no regressions in unrelated tests.

- [ ] **Step 3: Run type-check + build**

Run:

```bash
npm run check-types && npm run build
```

Expected: PASS and fresh webview bundle output.

- [ ] **Step 4: Manually verify in two IDE windows**

Run the extension in development mode:

```bash
npm run dev:debug
```

Manual checklist:

```text
1. Open two extension host windows with Quote sidebar visible.
2. In window 1, add account alpha@test.com. Confirm window 2 updates within ~1s or after sidebar re-focus.
3. In window 2, type "alpha" in the search box. Confirm only matching accounts remain visible.
4. In window 1, add beta@test.com. Confirm window 2 keeps the search query and still filters correctly.
5. In window 1, delete alpha@test.com. Confirm window 2 removes it and keeps the search field unchanged.
6. In window 2, enter select mode and select an account. In window 1, delete that account. Confirm window 2 clears only the now-invalid selected ID and does not switch tabs.
7. Verify no behavior tries to synchronize Windsurf native login state between windows.
```

Expected: account data converges, search stays local, no disruptive UI reset.

- [ ] **Step 5: Commit the verified feature**

```bash
git add src/core/windsurf-account.ts src/core/data-manager.ts src/webview/provider.ts media/main.ts tests/unit/windsurf-account.test.ts tests/unit/provider-handler.test.ts dist/webview
git commit -m "feat: sync account state across windows and add search"
```

---

## Self-review

### Spec coverage check

- Revision-aware persistence: covered in Tasks 1-3.
- Reload-before-write concurrency handling: covered in Task 2.
- Cross-window synchronization via watch/revalidation: covered in Tasks 3 and 6.
- Targeted `accountsSync` provider updates: covered in Task 4.
- Local-only account search and state preservation: covered in Task 5.
- Testing strategy: covered in Task 7 plus focused tests in earlier tasks.
- Out-of-scope Windsurf native session sync: explicitly excluded throughout.

### Placeholder scan

- No `TBD`, `TODO`, or “similar to previous task” placeholders remain.
- Every code-changing step includes concrete code blocks.
- Every verification step includes exact commands and expected outcomes.

### Type consistency check

- Persisted payload type: `PersistedWindsurfAccounts`
- Provider push method: `postAccountsSync()`
- Manager reload method: `reloadFromDisk()`
- Event name: `onDidChangeAccounts`
- Webview message name: `accountsSync`
- Local search state name: `accountSearchQuery`

All later tasks use the same names.
