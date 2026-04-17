# Account Search and Cross-Window Sync Reliability Design

## Context

The account tab currently has two classes of regressions:

1. **Search UI instability**
   - Typing in the account search field can lose focus after one or two characters.
   - The search input and clear button can wrap onto separate lines.
   - The likely root cause is that the search `input` event updates local state and calls the global `render()`, which replaces `#app.innerHTML` and recreates the input node.

2. **Account persistence and multi-window sync instability**
   - Accounts deleted in one Windsurf window can reappear after restart.
   - Multiple Windsurf windows do not reliably reflect account deletion/modification from each other.
   - The likely root cause is stale in-memory snapshots: each extension host can load the account file, keep its own copy, and later save a full old snapshot back to disk.

The design goal is to ship a reliable account-module fix without broad product rewrites.

## Goals

- Account search must allow continuous typing without losing focus, caret, or IME state.
- Search input and clear button must stay on one row in the account tab.
- Deleting an account must persist across restart.
- A stale window must not be able to rewrite a deleted account back to disk.
- Other open Windsurf windows should refresh account state automatically after the account file changes.
- Existing provider/webview contracts should remain recognizable: provider sends `accountsSync`; webview keeps local UI state such as search query, selection, and scroll.

## Non-goals

- Do not introduce multi-process locking or an external database.
- Do not build a large account-store/event-bus rewrite in this iteration.
- Do not implement automatic semantic merge for simultaneous conflicting edits.
- Do not change Windsurf native login/session behavior.
- Do not redesign account cards beyond the search row and sync correctness fixes.

## Proposed approach

Use a targeted reliability upgrade:

1. **Versioned persistence contract**
   - Treat `windsurf-accounts.json` as the cross-window source of truth.
   - Persist a monotonically increasing `revision` with the account state.
   - Keep the manager's in-memory revision aligned with the last loaded/saved file revision.
   - Before saving, read the file and compare revisions.
   - If disk revision is newer than memory revision, reload and reject the stale write path instead of saving the old snapshot.

2. **File-change-driven reload**
   - Add a file watcher or equivalent file-change mechanism for the account persistence file.
   - When the file changes externally, reload from disk.
   - On successful reload, fire `onDidChangeAccounts`.
   - Keep visible-webview revalidation as a fallback.

3. **Provider remains a state delivery layer**
   - `AccountViewProvider` continues listening to `onDidChangeAccounts`.
   - It continues sending `accountsSync` with account data, current account id, auto-switch config, quota snapshots, and quota fetching state.
   - It should not own conflict detection or persistence merging.

4. **Local account-list rendering for search**
   - Account search input events must not call the global `render()` that replaces the full app shell.
   - Search changes should update local state, reset account-list scroll, and patch only the account list/count/empty-state area.
   - The search input DOM node should remain stable while typing.
   - Clearing search should restore the list and focus the input.

5. **Stable search row layout**
   - The account search row should use a no-wrap flex layout.
   - The input wrapper should be flexible with `min-width: 0`.
   - The clear button should be fixed-size/fixed-shrink and remain on the same row.

## Persistence design

### Persisted state

The persisted state should include:

```ts
interface PersistedWindsurfAccounts {
  revision: number;
  updatedAt: string;
  accounts: WindsurfAccount[];
  currentId?: string;
  autoSwitch?: AutoSwitchConfig;
  pendingSwitchId?: string;
}
```

If an old file has no `revision`, load it as revision `0`. The next successful save writes revision `1` or higher.

### Save contract

Every write path that mutates accounts or related account state should follow the same contract:

1. Read the current persisted file.
2. Determine `diskRevision`.
3. If `diskRevision > this.revision`:
   - apply the disk state to memory,
   - fire account-change events if memory changed,
   - abort the current stale write,
   - let the caller surface a reload/retry message where appropriate.
4. If disk is not newer:
   - mutate memory,
   - increment revision,
   - write the complete state atomically,
   - fire `onDidChangeAccounts`.

This prevents stale full-snapshot writes from resurrecting deleted accounts.

### Conflict behavior

The chosen policy is version-gated last-write-wins:

- A write based on the latest revision can succeed.
- A write based on an older revision is rejected after reload.
- No hidden automatic merge is attempted in this iteration.

Example:

1. Window A and Window B both load revision 8.
2. Window A deletes account `x` and saves revision 9.
3. Window B tries to save a change based on revision 8.
4. Window B reads disk, sees revision 9, reloads, and refuses to write revision-8 state.
5. Account `x` is not restored.

## Cross-window sync design

### Reload triggers

The account manager should reload from disk when:

- the extension starts,
- the account persistence file changes,
- the webview becomes visible and calls revalidate,
- a stale write is detected before save.

The file-change trigger is the primary cross-window mechanism. Visibility revalidation is a safety net.

### Event propagation

Flow:

```text
Window A writes windsurf-accounts.json revision N+1
  -> Window B file watcher notices change
  -> Window B account manager reloads revision N+1
  -> Window B fires onDidChangeAccounts
  -> Window B provider sends accountsSync
  -> Window B webview patches account list without losing local search state
```

Provider behavior remains simple and testable.

## Webview search design

### Current failure mode

The current full render pattern is dangerous for interactive inputs:

```text
input event
  -> state.accountSearchQuery = value
  -> render()
  -> #app.innerHTML = ...
  -> old input node destroyed
  -> focus/caret/IME may be lost
```

### New behavior

Account search should use a stable input node:

```text
input event
  -> state.accountSearchQuery = value
  -> state.accountScrollTop = 0
  -> patch account list/count/empty state only
  -> preserve input focus and caret
```

The account tab can still be globally rendered for tab switches and bootstrap state, but not for every search keystroke.

### Accounts sync interaction

When `accountsSync` arrives:

- update bootstrap account data,
- prune selected account ids that no longer exist,
- clamp account scroll,
- patch the account list if the account tab is active,
- preserve `state.accountSearchQuery`, input focus, and caret when possible.

## CSS/layout design

The account search row should be stable:

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
```

The exact selectors should match existing markup, but the layout contract is fixed: no wrapping between search input and clear button in the account tab.

## Testing strategy

### Unit tests: persistence

Add/extend tests around `WindsurfAccountManager`:

- deleting an account persists a file without that account,
- stale manager cannot save over a newer disk revision,
- stale write triggers reload before refusing save,
- revision increments on successful save,
- old files without revision load safely as revision `0`.

### Unit tests: provider sync

Add/extend provider tests:

- `onDidChangeAccounts` still sends `accountsSync`,
- visibility revalidation still sends `accountsSync`,
- sync payload remains compatible with the webview account tab.

### Unit tests: webview helpers

Where possible, extract pure helpers for account filtering/window computation so tests can verify:

- search query filters by email/plan,
- search reset clamps scroll to the top,
- accounts sync prunes deleted selected ids,
- local search query survives account sync.

### Manual regression

Before completion, manually verify in a built extension or equivalent development host:

- type a multi-character account search continuously,
- clear search and continue typing,
- confirm input and clear button remain one line,
- delete an account and restart the extension/window,
- open two Windsurf windows and confirm deletion in one window updates the other,
- try a stale-window write after another window deletes an account and confirm the deleted account does not return.

## Acceptance criteria

- Search input never loses focus during normal typing.
- Search clear button stays on the same row as the input.
- Deleted accounts do not return after restart.
- A stale window cannot overwrite a newer account file with old account data.
- Cross-window account changes propagate through account manager events and `accountsSync`.
- Existing account sorting, unavailable styling, available count, quota display, batch delete, current account, and auto-switch behavior remain intact.
