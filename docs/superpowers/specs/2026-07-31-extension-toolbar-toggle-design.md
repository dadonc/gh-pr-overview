# Extension Toolbar Toggle Design

Date: 2026-07-31

## Context

GitHub PR Overview currently runs whenever its path-scoped GitHub content script
matches. It has packaged extension icons, but no toolbar action, background
service worker, stored preferences, or extension permissions. Its content
runtime already owns the reconciliation and cleanup needed to add and remove PR
overview cards while restoring GitHub's native comment counters.

Users need a one-click way to disable and re-enable the extension globally. The
choice must persist across browser restarts and extension updates, apply
immediately to every open matching GitHub tab, and be visible from the toolbar
icon.

## Goals

- Add a popup-free toolbar action that directly toggles the extension.
- Default to enabled when no preference has been stored.
- Persist one global enabled/disabled preference in local extension storage.
- Apply a preference change immediately in every open matching GitHub tab.
- Restore GitHub's native UI and cancel in-flight work when disabled.
- Recreate the overview UI without a page reload when re-enabled.
- Show the existing full-color icon while enabled and the same artwork dimmed
  and grayscale while disabled.
- Keep GitHub access path-scoped, same-origin, read-only, and free of new host
  permissions.

## Non-goals

- A popup, options page, badge, confirmation dialog, or keyboard shortcut.
- Per-tab, per-repository, per-account, or incognito-specific settings.
- Synchronizing the preference across Chrome profiles or devices.
- Dynamically registering or unregistering the content script.
- Reloading GitHub tabs as part of a normal toggle.
- Adding analytics or storing GitHub data.

## State Model

The extension has one boolean setting named `enabled` in
`chrome.storage.local`.

- A missing value means enabled.
- `true` means enabled.
- `false` means disabled.
- An unreadable or malformed value is treated as missing and therefore enabled.

The stored value is the source of truth for both content behavior and toolbar
presentation. Local storage is used instead of sync storage because the
requirement is persistence within the current browser profile, not cross-device
synchronization.

The extension requests only the `storage` extension permission for this
setting. The setting contains no repository, pull-request, comment, or account
data.

## Architecture

### Shared preference module

A focused shared module owns:

- The storage key.
- Defaulting and validation of stored values.
- Reading and writing the effective enabled state.
- The active `icon/{size}.png` and inactive
  `icon/disabled/{size}.png` path maps.

Both the background and content entrypoints depend on this module so state
semantics and asset paths cannot drift.

### Toolbar background service worker

WXT will generate the Manifest V3 service worker from
`entrypoints/background.ts`. The service worker will register its browser API
listeners only inside the WXT `main` function.

The worker will:

1. Read the effective state whenever it starts and apply the corresponding
   toolbar icon and title.
2. Handle `browser.action.onClicked` by reading the current state, writing its
   inverse, and then applying the matching icon and title.
3. Observe storage changes so external changes, tests, and future settings
   surfaces cannot leave the toolbar presentation stale.

Toolbar click transitions are serialized. Rapid clicks cannot interleave
read-modify-write operations and lose a transition.

The title is `Disable GitHub PR Overview` while enabled and
`Enable GitHub PR Overview` while disabled. The action has no popup, so a click
always reaches the toggle handler.

### Reversible content runtime

The content entrypoint will read the effective state before starting the page
reconciler and subscribe to changes in the shared storage key.

`startContentRuntime` will own one reversible activation boundary:

- Activating creates a fresh page reconciler and runs its initial
  reconciliation.
- Deactivating cleans up the current reconciler and drops it.
- Re-activating creates a new reconciler rather than attempting to reuse a
  stopped instance.
- The WXT location-change and invalidation listeners are registered once for
  the lifetime of the content script.
- Storage listeners are removed when WXT invalidates the content script.

Cleaning up a reconciler aborts in-flight GitHub requests, disconnects mutation
and intersection observers, removes mount anchors and cards, and restores every
native attribute changed by the extension. No tab reload is required.

Navigation events are ignored while disabled. When re-enabled on a matching
route, a fresh reconciliation uses the current document and URL.

### Immediate propagation

Every matching content script observes `chrome.storage.onChanged`. A successful
toolbar click updates local storage once; Chrome then delivers that change to
all open extension contexts. Each open GitHub PR-list tab activates or
deactivates independently from the same global value.

Newly opened or refreshed matching tabs read the stored value before mounting,
so disabled mode does not briefly render overview cards.

## Icon Assets

The existing full-color PNGs remain the enabled icons. A build-time asset
generation step is unnecessary; dimmed grayscale PNGs will be checked in next
to the existing sizes so the service worker can pass static path maps to
`browser.action.setIcon`.

Inactive icons preserve the exact geometry and transparency of the current
artwork, convert color channels to grayscale, and reduce visual intensity.
They do not add text, badges, slashes, or new symbols. All packaged icon sizes
used by the manifest and action—16, 32, 48, 96, and 128 pixels—are covered.

The default manifest action icon is the enabled icon. The background worker
corrects it from stored state when its execution context starts.

## Failure Behavior

- If a content script cannot read storage, it defaults to enabled so the
  extension preserves its existing behavior.
- If a toolbar click cannot read the prior state, it treats the state as
  enabled and attempts to disable it.
- The toolbar icon and title change only after the new value is stored
  successfully.
- If a storage write fails, the previous effective state and toolbar
  presentation remain in place.
- Failure to update the icon or title does not alter the stored preference;
  the content scripts still follow the stored state, and the next service
  worker start or storage event retries presentation synchronization.
- One content-script listener failure cannot prevent other tabs from reacting
  to the global storage event.

Expected storage or icon failures are contained within their extension context
and do not produce unhandled promise rejections.

## Manifest and Permission Constraints

The generated Manifest V3 file may add only:

- An `action` with the exact packaged enabled icon paths.
- One module background service worker generated by WXT.
- The `storage` permission.

The existing single content script and exact
`https://github.com/*/*/pulls*` match remain unchanged. The manifest must
continue to contain no `host_permissions`, `optional_permissions`,
`optional_host_permissions`, web-accessible resources, popup, or broader
content-script match.

The manifest verifier will encode these exact allowances rather than relaxing
its field checks generically.

## Testing and Verification

### Unit and integration tests

- State parsing defaults missing, unreadable, and malformed values to enabled.
- State reads and writes use only the expected local-storage key.
- Background startup applies the icon and title for both states.
- A toolbar click writes the inverse state and updates presentation only after
  a successful write.
- Rapid toolbar clicks are serialized.
- Storage changes synchronize toolbar presentation.
- A content runtime that starts disabled does not reconcile or fetch.
- Disabling removes cards, restores native counters, disconnects observers, and
  aborts in-flight requests.
- Re-enabling creates one fresh reconciler and renders without reload.
- Repeated off/on cycles do not duplicate mutation, navigation, storage, or
  invalidation listeners.
- Navigation while disabled does no work; enabling uses the current route.

### Manifest and bundle verification

- The manifest verifier accepts only the expected action, module service worker,
  and `storage` permission additions.
- It continues rejecting broader permissions, host access, popup fields, extra
  content scripts, and unexpected manifest fields.
- Bundle verification confirms that active and inactive PNGs exist at every
  declared size and no unexpected executable entrypoints are packaged.

### Browser verification

- A fixture-backed browser test changes the stored preference and verifies that
  two open GitHub PR-list tabs immediately remove and restore their cards and
  native counters without reload.
- A disabled preference present before navigation prevents initial card
  rendering.
- Existing browser diagnostics continue to require no unexpected network
  requests, request failures, page errors, or console errors.
- A manual Chrome Stable check pins the action, clicks it in both directions,
  and verifies the full-color and dimmed grayscale icons, tooltip text,
  persistence across restart, and immediate multi-tab behavior.

## Documentation

The README will:

- Explain the toolbar toggle and its global, persistent behavior.
- State that the extension stores one local enabled/disabled preference.
- Update the privacy and permissions section to disclose the `storage`
  permission.
- Update manifest verification documentation to describe the allowed action and
  background service worker.
- Add toolbar toggling and icon state to the manual release checklist.
