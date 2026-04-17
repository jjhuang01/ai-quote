# 2026-04-13 Quote account search and multi-window sync design

## Summary

This design adds two user-facing capabilities to the Quote extension:

1. Account search in the Quote account tab.
2. Reliable multi-window synchronization for Quote-owned account data and account UI state derived from persisted account data.

The scope is intentionally limited to **Quote’s own account library and UI state derived from it**. It does **not** attempt to strongly synchronize Windsurf native login/session state across windows.

The recommended architecture keeps the persisted account file as the source of truth, adds revision-based invalidation, reload-before-write protection, file-driven cross-window revalidation, and local-only search filtering in the webview.

## Problem statement

Today, Quote persists Windsurf account data to a JSON file under extension global storage:

- `src/core/windsurf-account.ts`

Each extension window loads that file into its own in-memory state during initialization, then serves the sidebar webview from that local memory. Account CRUD operations mutate local memory and write the file, but other windows do not have a reliable mechanism to observe or revalidate against those writes.

As a result:

- Account search is not implemented as a complete user feature.
- Multi-window account views can drift stale.
- A write from one window can be based on stale in-memory state in another window unless the second window reloads first.

## Goals

- Add fast account search in the Quote account tab.
- Keep Quote-owned account data synchronized across multiple open IDE windows.
- Preserve local UI continuity during sync: search input, current tab, selection mode, and scroll position should not be unnecessarily reset.
- Avoid interrupting user operations.
- Make concurrent multi-window writes stable enough for normal usage.
- Fit within VS Code/Windsurf extension API realities rather than assuming unsupported reactive storage semantics.

## Non-goals

- Strong synchronization of Windsurf native login/session state.
- Cross-device synchronization.
- Synchronizing ephemeral UI state like active tab, search query, select mode, or scroll position across windows.
- Replacing the existing file-backed account persistence model with a database or a separate IPC service.

## Current-state findings

### Local code findings

- Quote persists Windsurf accounts to `windsurf-accounts.json` in global storage: `src/core/windsurf-account.ts:50-55`.
- Account data is loaded once during initialization: `src/core/windsurf-account.ts:68-70`, `src/core/windsurf-account.ts:844-860`.
- Account writes directly mutate in-memory arrays and save the file: `src/core/windsurf-account.ts:112-132`, `src/core/windsurf-account.ts:230-253`, `src/core/windsurf-account.ts:451-456`, `src/core/windsurf-account.ts:862-871`.
- The sidebar bootstrap sends a full account list to the webview and sorts it, but does not implement account search: `src/webview/provider.ts:130-186`.
- There is a `searchQuery` field in `WebviewState`, but no complete account-search implementation was found in current account rendering paths: `src/core/contracts.ts:330-335`.
- The webview is built from `media/main.ts` via esbuild, not from source files under `src/webview`: `esbuild.mjs:45-58`.

### Extension API findings

Based on current VS Code extension API behavior and doc-backed agent research:

- `globalState` / `workspaceState` are persistent key-value stores, not reliable cross-window reactive state channels.
- Desktop windows typically share persisted storage on disk but keep separate extension-host memory.
- `SecretStorage` has change events, but it is not a suitable primary synchronization channel for non-secret account-list state.
- Reliable multi-window synchronization requires explicit revalidation and UI refresh logic.

## User experience principles

1. **Persistence sync and view state are separate concerns.**
   - Persisted account data should sync across windows.
   - Search text and other local UI affordances should remain local.

2. **No disruptive full resets when only account data changed.**
   - Sync should not bounce the user to another tab or clear the search field.

3. **Correctness at write boundaries matters more than speculative real-time behavior.**
   - Before writing, a window must ensure it is not writing on top of stale state.

4. **Graceful degradation is acceptable.**
   - If filesystem watch behavior is imperfect on a platform, focus/reveal revalidation must still keep the experience reliable.

## Proposed architecture

### Source of truth

Continue using the existing file under extension global storage as the source of truth for Quote-owned account data.

Persist the following payload shape conceptually:

```ts
interface PersistedWindsurfAccounts {
  revision: number;
  updatedAt: string;
  currentId?: string;
  autoSwitch: AutoSwitchConfig;
  pendingSwitchId?: string;
  accounts: WindsurfAccount[];
}
```

`revision` is a monotonic integer incremented on every successful persisted write.
`updatedAt` records the wall-clock timestamp of the latest successful write.

### State model

#### Cross-window synchronized state

- `accounts`
- `currentAccountId`
- `autoSwitch`
- `pendingSwitchId` if still required by current flows
- Derived account presentation data recomputed from synchronized data:
  - sorted account list
  - quota snapshots
  - current-account marker

#### Window-local state

- account search query
- active tab
- selection mode and selected IDs
- scroll position
- loading spinners related only to current-window UI affordances

### Synchronization strategy

Use a layered approach.

#### Layer 1: write-through local refresh

When the current window performs an account write:

1. Revalidate persisted state.
2. Apply the mutation in memory.
3. Persist the updated payload with incremented revision.
4. Immediately refresh the current window’s account UI.

This guarantees the acting window feels instant.

#### Layer 2: file-driven cross-window change detection

Each window will watch the persisted account file for changes.

On file change notification:

1. Debounce for a short interval.
2. Read persisted metadata.
3. If persisted `revision` is greater than local `revision`, reload the account state.
4. Notify the UI layer that synchronized account data changed.

Watch behavior must tolerate:

- self-triggered events
- duplicate events
- replace/rename patterns during atomic writes
- missed events on some environments

#### Layer 3: focus/reveal revalidation fallback

To cover environments where filesystem watch semantics are weak or inconsistent:

- Revalidate when the webview becomes visible.
- Revalidate when the IDE window regains focus.
- Revalidate when switching to the account tab.
- Revalidate immediately before executing any account write operation.

This ensures stale windows converge even if a watch event is missed.

## Concurrency and conflict handling

Use **reload-before-write + last-write-wins**.

### Rule

Every persisted account write must begin with a lightweight revalidation against disk.

If the persisted revision is newer than the local revision:

1. Reload the latest persisted account payload into memory.
2. Re-run the requested mutation against the latest snapshot.
3. Persist a new revision.

### Why this works

This does not provide distributed strong consistency, but it does prevent the most harmful stale overwrite pattern:

- Window 1 deletes account A.
- Window 2, still stale, deletes account B.
- Without revalidation, window 2 could accidentally write back account A.
- With revalidation, window 2 first reloads the snapshot where A is already gone, then deletes B, and writes the next revision.

This is sufficient for the target UX and product scope.

## Backend implementation design

### `src/core/windsurf-account.ts`

Extend `WindsurfAccountManager` with synchronization-aware persistence.

#### New persisted metadata

Add in-memory fields:

- `revision: number`
- `updatedAt: string`
- `watcher` handle
- `syncDebounceTimer`

#### New methods

- `reloadFromDisk(): Promise<boolean>`
  - Read persisted payload.
  - Compare revisions.
  - Replace in-memory synchronized state if disk is newer.
  - Return whether a reload happened.

- `revalidateBeforeWrite(): Promise<void>`
  - Lightweight metadata read.
  - If disk revision is newer, reload before mutating.

- `persist(): Promise<void>`
  - Increment revision.
  - Update `updatedAt`.
  - Write the complete payload.

- `startWatching(): void`
  - Start file watching for the account file / parent directory as needed.

- `stopWatching(): void`
  - Cleanly dispose watch resources.

- `onDidChangeAccounts`
  - Event emitter that fires when synchronized account state changed due to local write or external reload.

#### Existing methods to route through revalidation-aware persistence

At minimum:

- `add`
- `importBatch`
- `update`
- `delete`
- `deleteBatch`
- `clear`
- `updateAutoSwitch`
- any quota/account mutation path that persists `windsurf-accounts.json`

All of these must follow the same pattern:

1. `await revalidateBeforeWrite()`
2. mutate in-memory state
3. `await persist()`
4. emit account-change event

### `src/core/data-manager.ts`

During initialization:

- after `windsurfAccounts.initialize()` completes, start account watch support
- expose lifecycle disposal through VS Code subscriptions if needed by the final wiring

The goal is for account sync infrastructure to exist independently of whether the sidebar is currently visible.

### `src/webview/provider.ts`

Avoid full webview rebuilds for account sync.

#### New behavior

Subscribe to the account-change event from `WindsurfAccountManager`.

When account state changes:

- recompute the account payload currently derived in `buildBootstrapAsync()`:
  - masked accounts
  - sorted order
  - current account id
  - quota snapshots
  - quota-fetching state
  - auto-switch config
- send a targeted webview message instead of a full HTML rebuild

Suggested message:

```ts
{
  type: 'accountsSync',
  value: {
    accounts,
    currentAccountId,
    autoSwitch,
    quotaSnapshots,
    quotaFetching
  }
}
```

#### Why not full bootstrap on every sync

A targeted sync message avoids collateral resets to:

- local search input
- current tab
- scroll position
- in-progress selection mode

It also reduces render churn.

## Frontend implementation design

### Search feature

The webview frontend is bundled from `media/main.ts`.

Implement account search entirely in the frontend state layer.

#### Search behavior

- Add a search input in the account tab header area.
- Match against:
  - email
  - optionally plan label
- Matching is case-insensitive substring match.
- Empty query shows all accounts.
- No writes are triggered by search.

#### Search state rules

- Search query is local to the current window.
- Search query is preserved when synchronized account data arrives.
- If a synchronized change removes a currently visible account, the filtered result list updates naturally.
- If no accounts match, show an explicit empty state with a clear-search affordance.

### Webview sync handling

On `accountsSync`:

1. Replace only synchronized account data in the frontend store.
2. Preserve local-only view state.
3. Recompute filtered account list using the existing local search query.
4. Re-render account UI without switching tabs.

## Error handling

### File-watch instability

If file watch cannot be established or behaves inconsistently:

- log a warning
- continue using focus/reveal revalidation fallback
- do not block the feature

### Corrupt or partial file reads

If the persisted account file cannot be parsed during sync:

- keep current in-memory state
- log the parse error
- surface a non-blocking error only if the user initiates an operation that depends on the corrupt file

### Missing file after watch event

If the file is temporarily absent during an atomic write sequence:

- retry after debounce/revalidation cycle
- do not immediately clear in-memory accounts

### Concurrent writes

If revalidation shows a newer disk revision before write:

- reload latest state
- apply mutation against latest state
- proceed with new persisted revision

## Performance considerations

- Account lists are expected to remain small enough for full in-memory filtering in the webview.
- Revision checks should be lightweight and happen before writes and on key visibility boundaries.
- File-change handling must be debounced to avoid repeated render bursts.
- Targeted `accountsSync` messages are preferred over full webview rerendering.

## Testing strategy

### Unit tests

Add tests for `WindsurfAccountManager` that cover:

1. Revision increments on persisted writes.
2. `reloadFromDisk()` only updates state when disk revision is newer.
3. `revalidateBeforeWrite()` prevents stale overwrite.
4. Two manager instances sharing one temp storage file:
   - manager A deletes account A
   - manager B deletes account B after revalidation
   - final file contains neither account
5. Local write emits change events.

### Integration-style tests

Simulate two windows using two manager/provider instances pointing to the same temp global storage path.

Verify:

- account changes in one instance become visible in the second instance after watch-triggered or explicit revalidation
- the second instance does not need full reinitialization

### Manual verification

In two live IDE windows:

1. Add account in window 1 → window 2 updates.
2. Delete account in window 1 → window 2 updates.
3. Search in window 2 while window 1 changes accounts → search query remains intact.
4. Switch tabs in window 2 while sync happens → active tab remains intact.
5. Rapid sequential account writes in both windows do not resurrect deleted accounts.
6. Empty search result UX is clear and recoverable.

## Rollout notes

This design is backward-compatible with the current high-level storage location, but it changes the JSON payload shape by adding metadata fields. The loader must tolerate older files without `revision` or `updatedAt` by defaulting them safely.

Migration rule:

- old file without metadata loads as revision `0`
- first successful write upgrades it to the new shape

## Alternatives considered

### 1. Refresh-only weak sync

Rejected as the primary design because it leaves stale windows visible too long and does not meet the target “best UX” bar.

### 2. IPC / central sync bus

Rejected because it introduces unnecessary complexity and operational fragility for a problem already well-served by file-backed state plus explicit revalidation.

### 3. globalState as the sync mechanism

Rejected because VS Code Memento storage does not provide the reliable cross-window reactive behavior needed here.

## Final recommendation

Implement:

- revision-aware file persistence in `WindsurfAccountManager`
- file-watch + focus/reveal revalidation for cross-window convergence
- reload-before-write protection for safe concurrent edits
- targeted `accountsSync` webview updates
- account search in `media/main.ts` as local-only filtering

This is the highest-confidence design for delivering a reliable, non-disruptive user experience within current Quote architecture and VS Code/Windsurf extension constraints.
