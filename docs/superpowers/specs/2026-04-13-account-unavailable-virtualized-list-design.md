# 2026-04-13 Quote account unavailable-state and virtualized-list design

## Summary

This design extends Quote’s account-availability logic so an account is treated as unavailable when **either** daily remaining quota **or** weekly remaining quota falls below 10%, and keeps that behavior consistent across sorting, disabled-click handling, ghost styling, badge text, and available-count calculations.

It also redesigns the account list rendering in the webview to use a dedicated scroll container plus windowed rendering, so large or rapidly updating account lists remain visually stable and responsive without blank gaps during scroll.

The goal is a product experience that feels obvious and trustworthy: users should immediately see which accounts are actually usable, the current account should still be identifiable, and the account list should scroll smoothly even when search, sync, and quota refreshes are happening.

## Problem statement

Today, Quote already has shared logic for account sorting and disabled-state handling in the account tab UI, but the definition of “unavailable” is split across related concepts:

- `media/main.ts` uses `isAccountDisabled()` for ghosting, disabling, and available-count logic.
- `accountSortScore()` also depends on the same disabled-state helper.
- `src/core/windsurf-account.ts` derives `warningLevel` using quota thresholds, but that warning model is not the same thing as the webview’s unavailable-state model.

The current unavailable rule is too narrow for the intended UX:

- weekly remaining `<= 10%` is treated as exhausted/unavailable
- daily remaining only triggers unavailability in a fallback branch when weekly data is missing and daily is `<= 0`

That means an account with weekly quota available but daily quota almost exhausted can still appear usable even though it is not a good account to switch into.

Separately, the account list currently renders as a normal DOM list inside a page that scrolls at the `body` level. As the list grows or rerenders during sync/search/quota updates, users can see temporary blank regions or delayed account visibility while scrolling. This creates a perception of lag and instability.

## Goals

- Treat an account as unavailable when daily remaining `< 10%` **or** weekly remaining `< 10%`.
- Keep unavailable-state behavior consistent across:
  - account sorting
  - account card ghost styling
  - disabled click handling
  - available account counts
  - badge text
- Preserve the distinction between:
  - unavailable account UI state in the webview
  - quota warning metadata used elsewhere
- Replace the current full-list rendering path with a dedicated-scroll, virtualized/windowed account list.
- Preserve local UX state through list updates:
  - active tab
  - search query
  - selection mode / selected IDs
  - scroll position
- Keep compatibility with existing account search, accountsSync, multi-window sync, quota refresh, and current-account highlighting.

## Non-goals

- Changing server-side or persisted account data formats.
- Changing the meaning of `warningLevel` in `QuotaSnapshot`.
- Synchronizing scroll position or search query across windows.
- Rebuilding the entire webview architecture around a general-purpose state framework.
- Introducing extension-host-driven virtualization logic.

## Current-state findings

### Availability logic

Current disabled/unavailable behavior is centered in `media/main.ts`.

`isAccountDisabled(rq)` currently returns:

- `expired = true` when `planEndTimestamp` is in the past
- `exhausted = true` when:
  - weekly remaining is between `0` and `10`, or
  - daily remaining is `<= 0` only when weekly data is absent, or
  - weekly data is absent but reset timing indicates an exhausted weekly state

This logic is then reused for:

- account availability counts
- account sorting
- ghost styling / class names
- disabling switch clicks

That reuse is good, but the rule itself no longer matches the desired product behavior.

### Sorting behavior

`accountSortScore()` in `media/main.ts` currently behaves roughly as:

1. current account first
2. healthy accounts next
3. no-quota-data accounts in the middle
4. expired/unavailable accounts later

This overall ordering is still correct for the new feature. The change needed is not a new sort model; it is a more accurate shared availability input into the existing model.

### Quota warning behavior

`src/core/windsurf-account.ts` derives `QuotaSnapshot.warningLevel` using daily/weekly thresholds.

That warning-level field is useful for quota messaging, but it should **not** become the source of truth for card disablement because:

- it is a different abstraction
- it may evolve for warning UX independently of switchability UX
- the webview needs a stable, explicit availability-state model for rendering and interaction

### Scroll/render behavior

`media/main.css` currently allows page-level scrolling via `body { overflow-y: auto; }`.

The account list itself is not isolated as a dedicated scroll surface, and normal list rendering means every visible account card exists in the DOM at once. That is acceptable for small lists, but it is fragile when the list rerenders frequently or when the DOM work spikes during scrolling.

Based on VS Code/Windsurf webview capabilities, browser-native primitives such as `requestAnimationFrame` and `ResizeObserver` are available and suitable for a local virtualized list implementation inside the webview. The right place for scroll math is the webview itself, not the extension host.

## User experience principles

1. **Usability beats raw quota detail.**
   - If an account is functionally a bad switch target because daily or weekly quota is nearly gone, it should look unavailable.

2. **One meaning of unavailable in the account tab.**
   - Sorting, badges, ghosting, and clickability must agree.

3. **Current account should stay understandable.**
   - If the current account becomes unavailable, it should still be visually marked as current while also showing unavailable styling.

4. **Unknown is not unavailable.**
   - Missing quota data should not be treated as exhausted.

5. **Scrolling should feel anchored.**
   - The list should have its own scroll surface and should not flash blank regions during normal use.

6. **Search and sync should compose cleanly.**
   - Incoming `accountsSync` updates should refresh data without resetting search or destabilizing scroll unnecessarily.

## Proposed architecture

### 1. Unified account presentation state in the webview

Add a single derived UI-state layer in `media/main.ts` for the account tab.

Conceptually:

```ts
interface AccountUiState {
  id: string;
  isCurrent: boolean;
  isExpired: boolean;
  isUnavailable: boolean;
  availabilityLabel?: '不可用' | '已过期';
  sortBucket: 'current' | 'healthy' | 'unknown' | 'unavailable' | 'expired';
}
```

This structure does not need to be exported from the extension side. It is a local webview derivation built from:

- account record
- current account id
- `QuotaSnapshot`
- `RealQuotaInfo`

### Availability rule

Derive unavailability with this rule:

- `expired = true` if `planEndTimestamp` is in the past
- `unavailable = true` if **not expired** and at least one known quota threshold is below 10%

More explicitly:

```ts
const weeklyLow = rq.weeklyRemainingPercent >= 0 && rq.weeklyRemainingPercent < 10;
const dailyLow = rq.dailyRemainingPercent >= 0 && rq.dailyRemainingPercent < 10;
const isUnavailable = !isExpired && (weeklyLow || dailyLow);
```

Rules:

- `< 10` is the threshold, not `<= 10`
- unknown values (`< 0` in current data model) do not count as low
- an account with no quota snapshot is not unavailable by default
- expired stays a separate top-priority state

### Why a dedicated UI-state layer

This keeps one local source of truth for rendering decisions without coupling card behavior to raw snapshot fields scattered throughout the render path.

The derived state should be consumed by:

- available-count calculation
- sorting
- badge text
- CSS class selection
- click-guard logic
- any future filtering such as “show unavailable only” if ever added later

### 2. Sorting model

Keep the current high-level sorting behavior, but route it through the unified state.

Recommended order:

1. current account
2. healthy usable accounts
3. unknown-data accounts
4. unavailable accounts
5. expired accounts

Within healthy and unavailable groups, continue using remaining quota percentages to rank better candidates higher.

This preserves the existing product intuition:

- the current account stays visible at the top
- clearly usable accounts remain easiest to access
- unknown data is not unfairly punished
- users are steered away from poor switch targets

### 3. Badge and card-state rules

### Badge wording

Use unified badge text:

- expired → `已过期`
- unavailable (daily or weekly below threshold) → `不可用`

Do not expose separate “daily exhausted” vs “weekly exhausted” badges in the card chrome. The goal is decisive, low-cognitive-load guidance.

### Card styling

Retain the existing “ghostify / disabled” visual language, but apply it to the unified unavailable state rather than the old exhausted rule.

State combinations:

- current + healthy
- current + unavailable
- current + expired
- non-current + healthy
- non-current + unavailable
- non-current + expired

The current marker must remain visible even when the card is ghosted.

### Click handling

Unavailable and expired cards stay non-switchable.

That means the click guard must use the same derived state as badge/styling/sort. No secondary rule path.

### 4. Dedicated scroll container + virtualized list

Move the account tab from page-level scrolling to a dedicated list viewport.

### Layout model

Recommended structure in `media/main.ts` + `media/main.css`:

- account tab shell
  - header / toolbar area
    - counts
    - search input
    - bulk actions if applicable
  - list viewport container
    - fixed-height or flexed scroll region
    - inner spacer element sized to total virtual content height
    - absolutely positioned visible rows within the spacer

Conceptually:

```html
<section class="account-tab">
  <div class="account-toolbar">...</div>
  <div class="account-list-viewport">
    <div class="account-list-spacer">
      <!-- only visible rows rendered -->
    </div>
  </div>
</section>
```

### Rendering model

Use windowed rendering with overscan.

Inputs:

- `scrollTop`
- viewport height
- row height
- filtered/sorted accounts length

Derived values:

- `startIndex`
- `endIndex`
- top offset for first rendered row
- total content height

Rules:

- render only visible rows plus overscan above/below
- use `requestAnimationFrame` to batch scroll-driven render updates
- use `ResizeObserver` to recompute viewport-dependent math
- preserve a stable row-height contract as much as possible

### Row-height strategy

Use a near-fixed row height for v1.

Reason:

- simpler math
- fewer visual jumps
- lower implementation risk in a webview
- enough to fix the current perceived scroll instability

If minor row-height variations exist because of badges or metadata lines, normalize the card structure/CSS so the effective height remains stable.

### Why not full dynamic-height virtualization

Dynamic row measurement adds complexity and synchronization overhead that is unnecessary for this feature. The user’s problem is smoothness and predictability, not arbitrary heterogeneous content.

### 5. Local state persistence rules

The webview already carries local UI state. Extend that model so virtualization does not regress UX.

Preserve locally:

- `activeTab`
- account search query
- selection mode / selected IDs
- account-list scroll position

When `accountsSync` arrives:

- replace synchronized account data
- keep local search query unchanged
- re-run filter + sort + virtual window math
- preserve scroll position if the current filtered list still supports it
- clamp scroll position if the list shrinks below the previous offset

This prevents sync from feeling like a reset.

## Data flow

### Input pipeline

1. Provider sends synchronized account payload to webview.
2. Webview stores raw account data and quota snapshots.
3. Webview derives `AccountUiState` per account.
4. Webview applies search filter.
5. Webview sorts filtered accounts using the unified state.
6. Virtual-list math derives visible slice.
7. Render visible rows only.

### Trigger sources

The same pipeline runs on:

- initial bootstrap
- `accountsSync`
- search input changes
- current account changes
- quota refresh completion
- scroll changes
- viewport resize

Not every trigger needs to recompute everything with equal cost:

- scroll should only recompute visible slice
- search/sync/quota updates should recompute filter/sort/state, then reset or clamp the virtual window as appropriate

## File-level design

### `media/main.ts`

Primary feature work lives here.

Add or refactor toward these responsibilities:

- derive unified account UI state from snapshots
- replace `isAccountDisabled()` usage with explicit unavailable-state helpers or a richer derivation layer
- update available-count logic to use unified state
- update sorting to use unified state
- update card rendering to use unified state and unified badge wording
- add virtual-list state and scroll math
- separate account-list viewport rendering from overall page render flow
- preserve local search/scroll state through `accountsSync`

### `media/main.css`

Add layout/styling support for:

- account tab vertical layout
- dedicated list viewport
- spacer/row positioning for virtualization
- stable card heights
- unavailable-state styling mapped from the new class names

Also remove dependency on body-level scrolling for the account list path.

### `src/webview/provider.ts`

No architectural rewrite needed.

Provider should continue to send synchronized account payloads through existing `accountsSync` behavior. The important constraint is that virtualization stays frontend-local.

Only minimal changes are needed if payload shape or message timing must be adjusted to support smoother account-tab refreshes.

### `src/core/windsurf-account.ts`

No semantic change to persistence is required for this feature.

Do **not** redefine `QuotaSnapshot.warningLevel` to mean “unavailable”. If desired, warning-level thresholds may stay as-is unless there is a separate product decision later.

The only acceptable changes here are narrowly scoped ones if the frontend needs slightly clearer quota snapshot data that already exists conceptually.

## Error handling and edge cases

### Missing quota data

If an account has no snapshot or missing daily/weekly percentages:

- do not mark it unavailable solely due to missing data
- place it in the unknown-data bucket
- keep it switchable unless another rule blocks it

### Current account becomes unavailable

If the active account drops below threshold:

- keep it visually current
- also show unavailable styling/badge
- do not auto-switch merely because of rendering state

This screen communicates status; it should not silently change account selection behavior.

### Search + shrinking list

If search or sync reduces the filtered list length:

- recompute total virtual height
- clamp scroll position to valid range
- avoid rendering an empty gap caused by stale scroll offset

### Selection mode + virtualization

Selected IDs must be ID-based, not DOM-node-based.

That ensures rows can mount/unmount safely as the user scrolls.

### AccountsSync while scrolling

Incoming sync should not reset the viewport to top unless the filtered dataset becomes materially incompatible with the current offset. Prefer clamp-over-reset.

## Performance considerations

- Virtualization logic must stay entirely in the webview.
- Scroll handlers should avoid synchronous heavy work on every event.
- Use `requestAnimationFrame` to coalesce visual updates.
- Use a low-cost derived-state pipeline so search and sync remain instant at expected list sizes.
- Avoid extension-host roundtrips for scroll position.
- Prefer stable keys by account ID so DOM reuse remains predictable.

## Testing strategy

### Unit tests

#### `tests/unit/dialog-changes.test.ts`

No changes required for this feature.

#### Add or extend webview-focused tests

Recommended coverage:

1. unified availability rule
   - weekly `9.9` → unavailable
   - daily `9.9` → unavailable
   - weekly `10` and daily `10` → available
   - unknown daily/weekly values do not force unavailable
   - expired overrides unavailable

2. sorting buckets
   - current account stays first even if unavailable
   - healthy ranks above unknown
   - unknown ranks above unavailable
   - unavailable ranks above expired

3. badge text mapping
   - unavailable badge is `不可用`
   - expired badge is `已过期`

4. available-count calculation
   - excludes unavailable and expired
   - includes unknown-data accounts

5. virtual window math
   - correct start/end indices for representative scroll offsets
   - overscan expands visible range correctly
   - shrinking list clamps scroll offset

6. accountsSync preservation
   - search query remains intact after sync
   - active tab remains intact after sync
   - scroll state is preserved or clamped, not blindly reset

If current test structure makes direct webview logic hard to test, extract pure helpers from `media/main.ts` into a small shared module only if that extraction is minimal and clearly justified by testability.

### Manual verification

1. Open account tab with mixed healthy / unknown / unavailable / expired accounts.
2. Confirm daily `< 10%` alone makes a card ghosted, disabled, and labeled `不可用`.
3. Confirm weekly `< 10%` alone does the same.
4. Confirm exactly `10%` does **not** become unavailable.
5. Confirm missing quota data does not ghost the account.
6. Confirm current unavailable account still shows as current.
7. Type a search query, then trigger account sync from another window; search remains intact.
8. Scroll deep in the account list, then trigger sync/quota refresh; viewport remains stable without blank gaps.
9. Use selection mode while scrolling; selections persist correctly.
10. Verify available/total header count matches the new unavailable semantics.

## Alternatives considered

### 1. Minimal rule tweak only

Rejected as the final design because it would fix the quota threshold semantics but leave the scroll/render instability unresolved.

### 2. Recommended: unified availability state + local virtualized list

Chosen because it solves both product issues with the least architectural disruption:

- one clear meaning of unavailable
- one local rendering pipeline
- no new persistence complexity
- best UX payoff for the change size

### 3. Full frontend state-management rewrite

Rejected because it is unnecessary for the scope and would create more migration risk than product value.

## Final recommendation

Implement the feature as two tightly related webview improvements:

1. **Define one explicit unavailable rule** in the account tab UI: daily remaining `< 10%` or weekly remaining `< 10%`, with expired remaining a separate stronger state.
2. **Render the account list through a dedicated virtualized viewport** so search, sync, and quota refresh can happen without unstable scrolling or blank visible regions.

This keeps the architecture simple, preserves current extension-side contracts, and delivers the most noticeable user-facing quality improvement with the lowest risk.
