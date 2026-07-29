# Row Lifecycle and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reconciliation linear, mount every card in one responsive extension-owned location, preserve changing native counters, avoid pre-commit navigation churn, and announce async status accessibly.

**Architecture:** The row adapter exposes a single-row extractor and the reconciler passes one extraction to each controller per document pass. Controllers own a stable mount marker and manage native counter snapshots separately; WXT location events only reconcile committed destinations.

**Tech Stack:** TypeScript 5.9, MutationObserver, IntersectionObserver, WXT 0.20, React 19, Testing Library, Vitest/jsdom.

## Global Constraints

- This plan starts only after the GitHub Schema Compatibility plan is green.
- Keep React and shadow-root event isolation.
- Hide a native counter only after a successful UI mount and restore its exact attributes on every replacement/cleanup path.
- Never hide a PR title or ambiguous counter.
- Mount outside GitHub's current `hide-sm` comment column when semantic main-row structure is available.
- Keep the global request limiter and 800 px lazy-load margin unchanged.
- Do not add automatic retries.
- Write failing behavior tests before production changes.
- Run the `react-doctor` skill after React changes and before final verification.

---

### Task 1: Add a single-row extractor and linear reconciliation

**Files:**
- Modify: `lib/github-row-dom.ts`
- Modify: `lib/pr-reconciler.ts`
- Test: `lib/github-dom.test.ts`
- Test: `lib/pr-reconciler.test.ts`

**Interfaces:**
- Produces: `extractPullRequestRow(row, viewerLogin?)`.
- Preserves: `extractPullRequestRows(document)` as a thin document mapper.
- Changes internally: `RowController.refresh(extraction)` receives current evidence instead of rescanning the document.

- [ ] **Step 1: Add failing single-row and controller-stability tests**

Add to `lib/github-dom.test.ts`:

```ts
it('extracts one row with a caller-supplied viewer login', () => {
  const document = fixture('pr-list.html');
  const row = document.querySelector<HTMLElement>('#issue_9001')!;
  expect(extractPullRequestRow(row, 'octo-viewer')).toEqual(
    extractPullRequestRows(document)[0],
  );
});
```

Add to `lib/pr-reconciler.test.ts` a 30-row page where one row's counter changes.
Spy on each row's `querySelectorAll` method and assert the changed
reconciliation performs a bounded number of row-local scans rather than
rescanning all 30 rows once per controller:

```ts
expect(
  rows.reduce((total, row) => total + rowQuerySpies.get(row)!.mock.calls.length, 0),
).toBeLessThan(120);
```

Also assert `loadPullRequest` remains called once for the changed row.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
npm test -- lib/github-dom.test.ts lib/pr-reconciler.test.ts -t "single row|bounded|30-row"
```

Expected: FAIL because no single-row extractor exists and reconciliation calls
the document-wide extractor repeatedly.

- [ ] **Step 3: Implement the single-row adapter**

Add:

```ts
export function extractPullRequestRow(
  row: HTMLElement,
  viewerLogin?: string,
): PullRequestRowExtraction | undefined;
```

Move the body of the current `flatMap` callback into this function. Keep
`extractPullRequestRows` as:

```ts
export function extractPullRequestRows(
  document: Document,
): PullRequestRowExtraction[] {
  const viewerLogin =
    document.querySelector('meta[name="user-login"]')
      ?.getAttribute('content')
      ?.trim() || undefined;

  return [...document.querySelectorAll<HTMLElement>(
    '[id^="issue_"].js-issue-row',
  )].flatMap((row) => {
    const extraction = extractPullRequestRow(row, viewerLogin);
    return extraction ? [extraction] : [];
  });
}
```

- [ ] **Step 4: Reconcile from one row/extraction map**

In `createPageReconciler.reconcile`, read the viewer once and create:

```ts
const rows = [...options.document.querySelectorAll<HTMLElement>(
  '[id^="issue_"].js-issue-row',
)];
const extractions = new Map(
  rows.flatMap((row) => {
    const extraction = extractPullRequestRow(row, viewerLogin);
    return extraction ? [[row, extraction] as const] : [];
  }),
);
```

Use `extractions.get(row)` in both controller loops. Change
`RowController.refresh()` to `refresh(extraction)` and use
`extractPullRequestRow(this.row, this.currentExtraction.viewerLogin)` only for
the async post-fetch identity check. Delete `extractionForRow` and
`canonicalIdentity`.

- [ ] **Step 5: Run focused and full reconciler tests**

```bash
npm test -- lib/github-dom.test.ts lib/pr-reconciler.test.ts
npm run compile
```

Expected: PASS.

- [ ] **Step 6: Commit the linear reconciliation**

```bash
git add lib/github-row-dom.ts lib/pr-reconciler.ts lib/github-dom.test.ts lib/pr-reconciler.test.ts
git commit -m "perf: reconcile each pull request row once"
```

### Task 2: Use one responsive mount marker and independent native state

**Files:**
- Create or modify: `test/fixtures/github/current/pr-list.html`
- Modify: `lib/pr-reconciler.ts`
- Modify: `lib/pr-card.tsx`
- Test: `lib/pr-reconciler.test.ts`

**Interfaces:**
- Produces internally: one `<span data-pr-overview-mount-anchor>` per controlled row.
- Produces internally: `NativeCounterState = { element, snapshot }`.
- Preserves: `CardUiFactory.mount(anchor, props)` and `MountedCard`.

- [ ] **Step 1: Add a current responsive row fixture**

Create a reduced zero and nonzero row using current structure:

```html
<div id="issue_42" class="Box-row js-issue-row">
  <div class="d-flex position-relative">
    <div class="flex-auto min-width-0 p-2">
      <a class="Link--primary" href="/octo/demo/pull/42">Current row</a>
      <div class="d-flex mt-1 text-small color-fg-muted">
        <span class="opened-by">
          #42 opened by
          <a data-hovercard-type="user">author</a>
        </span>
      </div>
    </div>
    <div class="flex-shrink-0 d-flex hide-sm">
      <span><a class="Link--muted" aria-label="2 comments"
        href="/octo/demo/pull/42#comments">2</a></span>
    </div>
  </div>
</div>
```

Add a second row with the same main structure and no comment anchor.

- [ ] **Step 2: Add failing mount and counter-transition tests**

Add assertions that:

```ts
const marker = row.querySelector('[data-pr-overview-mount-anchor]')!;
expect(marker.parentElement).toBe(
  row.querySelector('.flex-auto.min-width-0'),
);
expect(marker.closest('.hide-sm')).toBeNull();
expect(row.querySelector('.opened-by')!.contains(marker)).toBe(false);
```

Cover zero-to-one, one-to-zero, malformed-to-ready, and counter node
replacement. Across each transition assert:

```ts
expect(mount).toHaveBeenCalledTimes(1);
expect(client.loadPullRequest).toHaveBeenCalledTimes(1);
```

Capture custom preexisting `hidden`, `aria-hidden`, `tabindex`, and `style`
values on the original and replacement counters. Assert exact restoration on
replacement and cleanup. Add a pending async mount test proving neither the old
nor new counter is hidden until mount resolves.

- [ ] **Step 3: Run the focused tests and verify failure**

```bash
npm test -- lib/pr-reconciler.test.ts -t "mount marker|zero-to-one|one-to-zero|replacement|pending"
```

Expected: FAIL because mounts currently depend on native counter identity and
zero rows append inside `.opened-by`.

- [ ] **Step 4: Implement the stable marker placement**

Always create:

```ts
const marker = document.createElement('span');
marker.setAttribute('data-pr-overview-mount-anchor', '');
marker.setAttribute('aria-hidden', 'true');
```

Place it in this order:

1. Find the semantic title and `.opened-by`.
2. If `.opened-by` has a metadata parent distinct from the row and that parent
   shares the title's main-content ancestor, insert the marker after the
   metadata parent.
3. Otherwise insert it after `.opened-by` as a sibling.
4. Otherwise append it to a recognized row-end container.
5. Otherwise append it to the title parent, then the row as final fallback.

Never place it inside `.opened-by`. Rename every mutation-filter exemption from
`data-pr-overview-zero-anchor` to `data-pr-overview-mount-anchor`.

- [ ] **Step 5: Separate native counter adoption from mounting**

Use:

```ts
interface NativeCounterState {
  element: HTMLAnchorElement;
  snapshot: AttributeSnapshot;
}
```

On each `refresh(extraction)`:

- Resolve the newly recognized counter.
- If it differs, restore the previous state exactly and snapshot the new one.
- Hide the current recognized counter only when `mounted` exists.
- Update total comments without replacing the mount marker.

`matches(extraction)` must require only the same identity and a connected marker
owned by the row. `dispose()` restores the current counter, removes the UI, and
removes the marker.

Remove the controller-local native `MutationObserver`; the existing page
observer already watches the relevant attributes and child changes.

- [ ] **Step 6: Make the shadow host responsive in the main column**

Change only the host rule in `CARD_STYLES`:

```css
:host {
  display: block;
  max-width: 100%;
  margin-top: 4px;
}
```

Keep the card's flex wrapping, focus, dark-mode, and reduced-motion rules.

- [ ] **Step 7: Run all reconciler tests and TypeScript**

```bash
npm test -- lib/pr-reconciler.test.ts
npm run compile
```

Expected: PASS.

- [ ] **Step 8: Commit stable mounting**

```bash
git add test/fixtures/github/current/pr-list.html lib/pr-reconciler.ts lib/pr-card.tsx lib/pr-reconciler.test.ts
git commit -m "fix: mount pull request cards consistently"
```

### Task 3: Reconcile only committed WXT navigations

**Files:**
- Modify: `lib/content-runtime.ts`
- Test: `lib/content-runtime.test.ts`
- Modify: `lib/pr-reconciler.ts`
- Test: `lib/pr-reconciler.test.ts`

**Interfaces:**
- Changes: `ContentScriptLifecycle.addEventListener` receives a structural event with `newUrl: URL`.
- Adds: `ContentScriptLifecycle.requestAnimationFrame(callback)`.
- Removes: public reconciler `reset()`.
- Preserves: `reconcile()` and `cleanup()`.

- [ ] **Step 1: Add a controllable frame queue to runtime tests**

Use a fake lifecycle with:

```ts
const frames: FrameRequestCallback[] = [];
const ctx = {
  addEventListener(_target, type, listener) {
    listeners.set(type, listener);
  },
  onInvalidated(listener) {
    invalidate = listener;
    return () => {};
  },
  requestAnimationFrame(callback) {
    frames.push(callback);
    return frames.length;
  },
};
```

- [ ] **Step 2: Add failing pre-commit, committed, and coalescing tests**

Dispatch a structural event while `document.location` still has the old URL:

```ts
listeners.get('wxt:locationchange')!({
  newUrl: new URL('https://github.com/octo/demo/issues'),
} as Event & { newUrl: URL });
```

Assert no immediate abort/remove/remount. Run the queued frame before changing
history and assert it remains a no-op.

Then repeat, commit the URL with `history.replaceState`, run the frame, and
assert teardown exactly once. Add same-pulls query navigation and two
back-to-back events; only the latest committed URL may reconcile. Invalidate
before a queued frame and prove cleanup prevents later mounting.

- [ ] **Step 3: Run the runtime tests and verify failure**

```bash
npm test -- lib/content-runtime.test.ts
```

Expected: FAIL because the current listener calls `reset()` synchronously and
the lifecycle lacks `requestAnimationFrame`.

- [ ] **Step 4: Implement committed navigation reconciliation**

Define:

```ts
export interface WxtLocationChangeEvent extends Event {
  readonly newUrl: URL;
}
```

Update the lifecycle interface:

```ts
addEventListener(
  target: Window,
  type: 'wxt:locationchange',
  listener: (event: WxtLocationChangeEvent) => void,
): void;
requestAnimationFrame(callback: FrameRequestCallback): number;
```

Coalesce with:

```ts
let pendingUrl: URL | undefined;
let framePending = false;
let invalidated = false;

const scheduleCommittedReconcile = (newUrl: URL) => {
  pendingUrl = newUrl;
  if (framePending) return;
  framePending = true;
  options.ctx.requestAnimationFrame(() => {
    framePending = false;
    const expected = pendingUrl;
    if (!invalidated && expected &&
        document.location.href === expected.href) {
      reconciler.reconcile();
    }
  });
};
```

Set `invalidated = true` before cleanup. Do not clear controllers from the
location event. Delete `reset()` from the reconciler return object.

- [ ] **Step 5: Run runtime, reconciler, and compile checks**

```bash
npm test -- lib/content-runtime.test.ts lib/pr-reconciler.test.ts
npm run compile
```

Expected: PASS.

- [ ] **Step 6: Commit navigation handling**

```bash
git add lib/content-runtime.ts lib/content-runtime.test.ts lib/pr-reconciler.ts lib/pr-reconciler.test.ts
git commit -m "fix: wait for committed GitHub navigation"
```

### Task 4: Remove phantom CSS loading and announce async status

**Files:**
- Modify: `entrypoints/content.tsx`
- Modify: `lib/pr-card.tsx`
- Test: `lib/pr-card.test.tsx`
- Test: `test/content-entrypoint.integration.test.tsx` in the Extension Verification plan

**Interfaces:**
- Preserves: `PullRequestCardProps` and shadow UI creation.
- Removes: `cssInjectionMode: 'ui'`.
- Adds: one stable `role="status"` node and group `aria-busy`.

- [ ] **Step 1: Add failing accessibility tests**

In `lib/pr-card.test.tsx`, render a loading summary and assert:

```ts
expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'true');
expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
expect(screen.getByRole('status')).toHaveTextContent(
  'Loading pull request overview.',
);
```

Rerender with ready sections and assert `aria-busy="false"` plus:

```text
Pull request overview updated.
```

Assert only one status node exists across rerenders.

- [ ] **Step 2: Run the focused card tests and verify failure**

```bash
npm test -- lib/pr-card.test.tsx -t "aria-busy|status"
```

Expected: FAIL because the card has no live status or busy state.

- [ ] **Step 3: Add the stable status node**

Derive:

```ts
const busy = [
  summary.totalComments,
  summary.reviewThreads,
  summary.diff,
  summary.agents,
].some((section) => section.status === 'loading');
```

Set `aria-busy={busy}` on the existing group and add:

```tsx
<span
  className="sr-only"
  role="status"
  aria-live="polite"
  aria-atomic="true"
>
  {busy
    ? 'Loading pull request overview.'
    : 'Pull request overview updated.'}
</span>
```

- [ ] **Step 4: Remove WXT's missing CSS-file mode**

Delete only:

```ts
cssInjectionMode: 'ui',
```

from `entrypoints/content.tsx`. Continue passing `CARD_STYLES` directly to
`createShadowRootUi`. Do not add a CSS asset or web-accessible resource.

- [ ] **Step 5: Run card tests, compile, and build**

```bash
npm test -- lib/pr-card.test.tsx
npm run compile
npm run build
```

Expected: PASS.

- [ ] **Step 6: Run React Doctor**

```bash
npx react-doctor@latest .
```

Expected: no actionable React correctness finding. If the command requires
network approval, use the installed/approved invocation or report the exact
unavailable check without claiming it passed.

- [ ] **Step 7: Commit UI and entrypoint cleanup**

```bash
git add entrypoints/content.tsx lib/pr-card.tsx lib/pr-card.test.tsx
git commit -m "fix: improve card lifecycle accessibility"
```

### Task 5: Review the row lifecycle/UI subproject

**Files:**
- Review: `lib/github-row-dom.ts`
- Review: `lib/pr-reconciler.ts`
- Review: `lib/content-runtime.ts`
- Review: `lib/pr-card.tsx`
- Review: `entrypoints/content.tsx`

**Interfaces:**
- Produces: green runtime/UI behavior for the Extension Verification plan.

- [ ] **Step 1: Run the subproject gate**

```bash
npm test
npm run compile
npm run build
npm run verify:manifest
```

Expected: all commands exit 0.

- [ ] **Step 2: Confirm no phantom CSS reference remains**

```bash
rg -n "content-scripts/content\\.css|cssInjectionMode" entrypoints lib .output/chrome-mv3
```

Expected: no match.

- [ ] **Step 3: Inspect working tree and diff**

```bash
git diff --check HEAD~4..HEAD
git status --short
```

Expected: no whitespace errors and a clean working tree.

- [ ] **Step 4: Request code review**

Use the `requesting-code-review` skill for Tasks 1-4. Resolve lifecycle,
restoration, accessibility, and stale-async findings before starting browser
verification.
