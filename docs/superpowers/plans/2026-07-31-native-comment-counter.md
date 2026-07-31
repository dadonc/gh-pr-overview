# Native Comment Counter Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore GitHub's untouched native right-side comment counter and remove all comment-count presentation and state from the extension-owned overview banner.

**Architecture:** GitHub's DOM adapter continues to parse native comments as part of understanding a pull-request row, but that value no longer crosses into `PullRequestSummary` or React. The row reconciler owns only the extension mount, authored marker, and remote review/diff/agent data; it observes GitHub mutations without snapshotting or mutating the native counter.

**Tech Stack:** TypeScript 5.9, React 19, WXT 0.20, Vitest 4 with React Testing Library/jsdom, Playwright 1.62, Chrome Manifest V3.

## Global Constraints

- GitHub remains the sole owner of comment-count presentation.
- Never synthesize a zero counter when GitHub omits its native counter.
- Never hide, restyle, relink, annotate, or change accessibility attributes on a native comment counter.
- The banner order is unresolved review threads, diff/files, then AI-agent participation, with no leading separator.
- Keep native counter parsing in `lib/github-dom.ts`; its adapter tests remain authoritative for valid, absent, malformed, and ambiguous markup.
- Keep the conversation URL used by unresolved review threads independent of the native counter URL.
- Do not add extension permissions, host permissions, background workers, actions, or web-accessible resources.
- Use red-green-refactor: every production behavior change follows a focused failing test.

---

## File Structure

- `lib/pr-card.tsx`: render only extension-owned overview metrics and compute busy state from those metrics.
- `lib/pr-card.test.tsx`: specify the banner's text order, separators, links, loading/error behavior, and accessibility.
- `lib/domain.ts`: define `PullRequestSummary` without a comment-count section.
- `lib/domain.contract.test.ts`: enforce the extension-owned summary type.
- `lib/pr-reconciler.ts`: mount and refresh the extension UI without owning native counter attributes.
- `lib/pr-reconciler.test.ts`: verify native counters remain untouched through mounting, mutation, malformed markup, zero/one transitions, failure, and cleanup.
- `test/content-entrypoint.integration.test.tsx`: verify the real content entrypoint leaves the native counter visible and unchanged.
- `test/e2e/extension.spec.ts`: verify unpacked-extension banner text, native UI, dynamic rows, and navigation in Chromium.
- `package.json`, `wxt.config.ts`, `scripts/verify-manifest.test.mjs`: align package and generated-manifest descriptions with the restored native counter.
- `README.md`: document the new UI ownership and behavior.

---

### Task 1: Remove Comment Counts from the React Banner

**Files:**
- Modify: `lib/pr-card.test.tsx:8-217`
- Modify: `lib/pr-card.tsx:23-125`

**Interfaces:**
- Consumes: the current `PullRequestSummary` shape, including its temporary `totalComments` field until Task 2 removes that field.
- Produces: `PullRequestCard(props: PullRequestCardProps)` whose visible first child is `ReviewThreads` and whose `aria-busy` value depends only on `reviewThreads`, `diff`, and `agents`.

- [ ] **Step 1: Change the focused component tests to require a comment-free banner**

Keep the existing `ready` fixture temporarily, but change the first test to the following assertions:

```tsx
render(
  <PullRequestCard
    summary={ready}
    conversationHref="/octo/demo/pull/42"
    filesHref="/octo/demo/pull/42/files"
  />,
);

expect(visibleCardText()).toBe(
  '2 unresolved · −81/+340 · 12 files · Codex 3 · Claude 0',
);
expect(screen.queryByText(/comments?$/i)).not.toBeInTheDocument();
expect(screen.queryByRole('link', { name: '23 comments' })).not.toBeInTheDocument();

const unresolved = screen.getByRole('link', {
  name: '2 unresolved review threads',
});
expect(unresolved).toHaveAttribute('href', '/octo/demo/pull/42');
expect(
  screen.getByRole('link', {
    name: '81 deletions, 340 additions, 12 files changed',
  }),
).toHaveAttribute('href', '/octo/demo/pull/42/files');

const separators = screen.getAllByText('·', { selector: '.separator' });
expect(separators).toHaveLength(3);
for (const separator of separators) {
  expect(separator).toHaveAttribute('aria-hidden', 'true');
}
expect(screen.getByTestId('pr-card').firstElementChild).toHaveClass('sr-only');
```

Update the remaining visible-line expectations so their exact prefixes are:

```text
0 unresolved · −81/+340 · 12 files · Gemini 0
2 unresolved · −81/+340 · 12 files · No AI agents
2 unresolved · −81+/+340+ · 12+ files · Loading agents…
1 unresolved · −1/+1 · 1 file · Codex 3 · Claude 0
— unresolved · — files · AI agents unavailable
0 unresolved · −81/+340 · 12 files · No AI agents detected yet
Loading unresolved… · −81/+340 · 12 files · Codex 3 · Claude 0
2 unresolved · Loading files… · Codex 3 · Claude 0
2 unresolved · −81/+340 · 12 files · Loading agents…
```

Delete assertions for `— comments`, `23+ comments`, `Loading comments…`, comment singular/plural grammar, `.comments` typography, and the "total comments" loading-table row. Keep all unresolved, diff, agent, authorship, status-node, and styling assertions.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
npm test -- lib/pr-card.test.tsx
```

Expected: FAIL because the visible line still starts with `23 comments ·`, a comment link still exists, and four top-level separators are rendered.

- [ ] **Step 3: Remove the total-comment component and leading separator**

In `lib/pr-card.tsx`:

1. Delete the `TotalComments` function.
2. Change the busy sections to:

```tsx
const busy = [
  summary.reviewThreads,
  summary.diff,
  summary.agents,
].some((section) => section.status === 'loading');
```

3. Change the visible banner children to:

```tsx
{summary.authoredByViewer && <span className="sr-only">Authored by you</span>}
<ReviewThreads section={summary.reviewThreads} href={conversationHref} />
<Separator />
<Diff section={summary.diff} href={filesHref} />
<Separator />
<Agents section={summary.agents} />
```

Do not add a replacement comment label, screen-reader-only comment copy, or leading separator.

- [ ] **Step 4: Run the component test and verify GREEN**

Run:

```bash
npm test -- lib/pr-card.test.tsx
```

Expected: PASS with no React hook-order warnings and no comment metric in any banner state.

- [ ] **Step 5: Run React Doctor**

Run:

```bash
npx -y react-doctor@latest .
```

Expected: exit 0 with no new issue in `lib/pr-card.tsx`.

- [ ] **Step 6: Commit the component change**

```bash
git add lib/pr-card.test.tsx lib/pr-card.tsx
git commit -m "fix: remove comment count from overview banner"
```

---

### Task 2: Return Native Counter Ownership to GitHub

**Files:**
- Modify: `lib/domain.contract.test.ts:3-74`
- Modify: `lib/domain.ts:1-85`
- Modify: `lib/pr-reconciler.test.ts:1-1575`
- Modify: `lib/pr-reconciler.ts:1-390`
- Modify: `test/content-entrypoint.integration.test.tsx:96-156`
- Modify: `test/e2e/extension.spec.ts:1-230`

**Interfaces:**
- Consumes: `PullRequestRemoteSummary` from `lib/github-client.ts`, which already contains only `agents`, `diff`, and `reviewThreads`.
- Produces:

```ts
export interface PullRequestSummary {
  agents: SectionState<readonly AgentParticipation[]>;
  authoredByViewer: boolean;
  diff: SectionState<DiffSummary>;
  reviewThreads: SectionState<ReviewThreadCounts>;
}
```

- Produces: `RowController.refresh(extraction: PullRequestRowExtraction): void`, which records the latest same-identity extraction but never mutates native comment UI.

- [ ] **Step 1: Change the domain contract test to reject banner-owned comments**

Replace the comment-specific `SectionState<TotalComments>` fixtures in `lib/domain.contract.test.ts` with a generic section-state contract and a comment-free summary:

```ts
const loading: SectionState<string> = { status: 'loading' };
const ready: SectionState<string> = { status: 'ready', data: 'ready' };
const partial: SectionState<string> = {
  status: 'partial',
  data: 'partial',
  reason: 'GitHub returned incomplete data.',
};
const failed: SectionState<string> = {
  status: 'error',
  message: 'GitHub request failed.',
};

const summary: PullRequestSummary = {
  reviewThreads: {
    status: 'partial',
    data: { unresolved: 2, resolvedOrOutdated: 3, total: 5 },
    reason: 'Thread pagination is incomplete.',
  },
  diff: {
    status: 'ready',
    data: { filesChanged: 3, additions: 16, deletions: 4 },
  },
  agents: { status: 'ready', data: [] },
  authoredByViewer: true,
};

expect([loading, ready, partial, failed]).toHaveLength(4);
expect(summary).not.toHaveProperty('totalComments');
```

Remove the `TotalComments` import and its compile-time `href` assertion.

- [ ] **Step 2: Rewrite reconciler tests around non-mutation**

Delete assertions that expect `summary.totalComments`, hidden counters, restored snapshots, or counter-derived error cards. Preserve row-title disambiguation coverage, but assert that every candidate native node keeps its pre-mount attributes.

Replace the primary ownership test with:

```ts
it('leaves the native counter untouched while mounting, loading, and cleaning up', async () => {
  const document = page(row());
  const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
  const rowElement = document.querySelector<HTMLElement>('#issue_42')!;
  rowElement.setAttribute('data-pr-overview-authored', 'github-original');
  native.hidden = false;
  native.setAttribute('aria-hidden', 'false');
  native.setAttribute('tabindex', '0');
  native.setAttribute('style', 'display: inline');
  const expected = snapshotAttributes(native);
  const client = { loadPullRequest: vi.fn(async () => remote) };
  const removed = vi.fn();
  const reconciler = createPageReconciler({
    document,
    client,
    IntersectionObserver: Observer,
    uiFactory: {
      mount() {
        return { isConnected: () => true, remove: removed, update: vi.fn() };
      },
    },
  });

  reconciler.reconcile();
  FakeObserver.instances.at(-1)!.fire(rowElement);
  await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledOnce());

  expectSnapshot(native, expected);
  expect(rowElement.getAttribute('data-pr-overview-authored')).toBe('true');

  reconciler.cleanup();
  expectSnapshot(native, expected);
  expect(rowElement.getAttribute('data-pr-overview-authored')).toBe(
    'github-original',
  );
  expect(removed).toHaveBeenCalledOnce();
});
```

Retain and rename zero/one transition coverage so it proves:

```ts
expect(row.querySelectorAll('.comments-link')).toHaveLength(0);
const expectedCounterSnapshot = snapshotAttributes(counter);
row.querySelector('.comment-area')!.append(counter);
// Allow MutationObserver reconciliation.
expect(counter.hidden).toBe(false);
expectSnapshot(counter, expectedCounterSnapshot);
expect(mount).toHaveBeenCalledOnce();
expect(client.loadPullRequest).toHaveBeenCalledOnce();
```

For one-to-zero, remove the counter and assert no synthetic `.comments-link` appears, with one mount and one load.

For counter replacement, snapshot the original and replacement before inserting them, then assert both snapshots stay exact; do not wait for `aria-hidden="true"`.

For malformed, unsafe, ambiguous, and title-like counter fixtures, retain the mount-anchor and title-selection assertions and change every counter assertion to:

```ts
expect(counter.hidden).toBe(false);
expect(counter).not.toHaveAttribute('aria-hidden', 'true');
expect(initial.props.summary).not.toHaveProperty('totalComments');
```

Replace the pending remote/count-update test's completion condition with:

```ts
await vi.waitFor(() =>
  expect(
    updates.some((entry) => entry.summary.reviewThreads.status === 'ready'),
  ).toBe(true),
);
expect(native.getAttribute('aria-label')).toBe('24 comments');
expect(native.hidden).toBe(false);
expect(client.loadPullRequest).toHaveBeenCalledOnce();
expect(removed).not.toHaveBeenCalled();
```

Delete tests whose only contract was propagating a parsed total into the banner:

- malformed-to-ready total updates;
- recognition-attribute total updates;
- text-node total updates;
- reparsing malformed/ready totals;
- retaining remote sections while a banner total changes; and
- automatic malformed/repaired total propagation.

The GitHub DOM adapter tests continue to cover parsing those inputs.

- [ ] **Step 3: Change integration and browser acceptance tests**

In `test/content-entrypoint.integration.test.tsx`, rename the test to:

```ts
it('renders the real content entrypoint and never mutates the native counter', async () => {
```

Capture the counter before `definition.main(context)`, then require:

```ts
const nativeCounter =
  document.querySelector<HTMLAnchorElement>('a[aria-label="2 comments"]')!;
const nativeAttributes = {
  ariaHidden: nativeCounter.getAttribute('aria-hidden'),
  hidden: nativeCounter.hidden,
  style: nativeCounter.getAttribute('style'),
  tabindex: nativeCounter.getAttribute('tabindex'),
};

await definition.main(context);

await waitFor(() => {
  expect(renderedOverviewLine()).toBe(
    '0 unresolved · −353/+524 · 18 files · Copilot 1',
  );
});
expect(nativeCounter).toBeVisible();
expect({
  ariaHidden: nativeCounter.getAttribute('aria-hidden'),
  hidden: nativeCounter.hidden,
  style: nativeCounter.getAttribute('style'),
  tabindex: nativeCounter.getAttribute('tabindex'),
}).toEqual(nativeAttributes);
```

After invalidation, assert the extension host is gone and the same native
snapshot still matches.

In `test/e2e/extension.spec.ts`:

- change every fixture-backed banner line to
  `0 unresolved · −353/+524 · 18 files · Copilot 1`;
- expect `nativeCounter` to be visible immediately after mount;
- compare `readNativeCounterSnapshot(nativeCounter)` with the pristine
  connection snapshot both after mount and after route exit;
- remove `.comments` from typography objects and top-level selector lists;
- expect two top-level `.separator` elements for the one-agent E2E fixture;
- after changing GitHub's counter to `7 comments`, assert the native link has
  text `7`, is visible, and the banner still starts with `0 unresolved`;
- for an inserted row, assert its native counter is visible while its banner
  remains comment-free.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
npm test -- lib/domain.contract.test.ts lib/pr-reconciler.test.ts test/content-entrypoint.integration.test.tsx
```

Expected: FAIL/compile errors because `PullRequestSummary` still requires
`totalComments`, the reconciler still hides counters, and the real entrypoint
still renders comment text.

Build the Task 1 source and run the updated E2E test:

```bash
npm run build
npm run test:e2e -- test/e2e/extension.spec.ts
```

Expected: FAIL because the unpacked extension still hides the native counter,
even though Task 1 has already removed `2 comments` from the banner.

- [ ] **Step 5: Remove comment state from the domain model**

In `lib/domain.ts`, delete:

```ts
export interface TotalComments {
  count: number;
  href: string;
}
```

and delete this field from `PullRequestSummary`:

```ts
totalComments: SectionState<TotalComments>;
```

Then remove `totalComments` properties from every `PullRequestSummary` fixture
in `lib/pr-card.test.tsx` and `lib/pr-reconciler.test.ts`.

- [ ] **Step 6: Remove native-counter ownership from the reconciler**

In `lib/pr-reconciler.ts`:

1. Import only `PullRequestSummary` from `./domain`.
2. Keep `extractPullRequestRow` and `findPullRequestTitle`; remove the
   `findNativeCommentCounter` import.
3. Delete `AttributeSnapshot`, `NativeCounterState`, `nativeCounter`,
   `totalComments`, and `sameNativeComments`.
4. Remove `totalComments` from `loadingSummary`.
5. Return remote data without reconstructing comments:

```ts
function summaryWithRemote(
  extraction: PullRequestRowExtraction,
  remote: PullRequestRemoteSummary,
): PullRequestSummary {
  return { ...loadingSummary(extraction), ...remote };
}
```

6. Delete the `nativeCounter` field and all calls to
   `adoptNativeCounter`, `hideCurrentNativeCounter`, and
   `restoreNativeCounter`.
7. Delete `snapshot`, `hideCurrentNativeCounter`,
   `restoreNativeCounter`, `adoptNativeCounter`, and
   `needsNativeCounterRefresh`.
8. Replace `refreshNative` and `refresh` with:

```ts
private refreshExtraction(extraction: PullRequestRowExtraction): void {
  if (this.disposed) return;
  if (
    identityKey(extraction.identity) !==
    identityKey(this.currentExtraction.identity)
  ) return;
  this.currentExtraction = extraction;
}

refresh(extraction: PullRequestRowExtraction): void {
  this.refreshExtraction(extraction);
}
```

9. Remove both `this.adoptNativeCounter(extraction)` calls from remote success
   and failure handlers.
10. Keep `setAttributeExactly` only for restoring the extension's
    `data-pr-overview-authored` attribute.
11. Remove `nativeDirtyRows`, all writes/deletes/clears of that set, the
    `nativeDirty` argument, and call `controller.refresh(extraction)`.
12. Keep the MutationObserver filters and row reconciliation; GitHub mutations
    must still cause extraction, identity checks, dynamic-row handling, and
    mounted-UI recovery.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
npm test -- lib/domain.contract.test.ts lib/pr-card.test.tsx lib/pr-reconciler.test.ts test/content-entrypoint.integration.test.tsx
```

Expected: PASS with the native counter visible and no `totalComments` property
in card props.

- [ ] **Step 8: Run compile, build, and E2E acceptance**

Run:

```bash
npm run compile
npm run build
npm run test:e2e -- test/e2e/extension.spec.ts
```

Expected: all commands exit 0; Chromium shows GitHub's native counter on the
right while the banner starts with unresolved threads.

- [ ] **Step 9: Commit the ownership refactor**

```bash
git add lib/domain.ts lib/domain.contract.test.ts lib/pr-card.test.tsx lib/pr-reconciler.ts lib/pr-reconciler.test.ts test/content-entrypoint.integration.test.tsx test/e2e/extension.spec.ts
git commit -m "fix: preserve GitHub native comment counters"
```

---

### Task 3: Align Product Copy and Run the Release Gate

**Files:**
- Modify: `scripts/verify-manifest.test.mjs:10-31`
- Modify: `wxt.config.ts:3-7`
- Modify: `package.json:2-4`
- Modify: `README.md:1-25`

**Interfaces:**
- Consumes: the WXT manifest description from `wxt.config.ts`.
- Produces the exact package and manifest description:
  `Adds compact review-thread, diff, and AI-agent summaries alongside GitHub's native pull request comment counts.`

- [ ] **Step 1: Change the manifest contract test first**

Set `expectedManifest.description` in
`scripts/verify-manifest.test.mjs` to:

```js
description:
  "Adds compact review-thread, diff, and AI-agent summaries alongside GitHub's native pull request comment counts.",
```

Import the source configuration and add a copy-consistency test:

```js
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import wxtConfig from '../wxt.config.ts';

it('keeps package and generated-manifest descriptions aligned', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve('package.json'), 'utf8'),
  );

  expect(packageJson.description).toBe(expectedManifest.description);
  expect(wxtConfig.manifest.description).toBe(expectedManifest.description);
});
```

- [ ] **Step 2: Run the manifest test and verify RED**

Run:

```bash
npm test -- scripts/verify-manifest.test.mjs
```

Expected: FAIL in the copy-consistency test because `package.json` and
`wxt.config.ts` still contain the old `Adds compact comment...` description.

- [ ] **Step 3: Update package, manifest, and README copy**

Use this exact description in `package.json` and `wxt.config.ts`:

```text
Adds compact review-thread, diff, and AI-agent summaries alongside GitHub's native pull request comment counts.
```

Replace the README introduction and "What it shows" opening with:

```markdown
GitHub PR Overview is a read-only Chrome extension that adds a compact review
summary to repository pull-request lists while preserving GitHub's native
right-side comment counter. It runs on URLs matching
`https://github.com/*/*/pulls*`.

## What it shows

- GitHub's untouched native total-comment counter in its original position.
- Active unresolved review threads as `X unresolved`. The extension still
  computes the complete thread totals and resolved-or-outdated breakdown
  internally.
```

Change the line-layout paragraph to state that only the extension overview
metrics are separated by `·`. Keep the explanation that total comments and
review threads are independent, but say GitHub—not the extension—continues to
represent non-resolvable discussion in its native count.

- [ ] **Step 4: Run the manifest test and verify GREEN**

Run:

```bash
npm test -- scripts/verify-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Scan active source and copy for the obsolete replacement contract**

Run:

```bash
rg -n "replaces the standalone|2 comments ·|7 comments ·|23 comments ·|0 comments ·|— comments|Loading comments|summary\\.totalComments|totalComments:" \
  README.md package.json wxt.config.ts lib scripts test
```

Expected: no matches. Native-parser fixtures and tests may still contain
literal labels such as `aria-label="2 comments"`; those are correct and are not
part of this obsolete-contract scan.

- [ ] **Step 6: Run the complete verification gate**

Run:

```bash
npm run verify
```

Expected:

- Vitest and coverage pass;
- TypeScript compilation passes;
- WXT builds `output/chrome-mv3`;
- manifest and bundle verification pass without permission changes; and
- Playwright passes with the native counter visible.

- [ ] **Step 7: Inspect the final diff and worktree**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Expected: no whitespace errors; only the Task 3 copy files are uncommitted at
this checkpoint.

- [ ] **Step 8: Commit documentation and metadata**

```bash
git add README.md package.json wxt.config.ts scripts/verify-manifest.test.mjs
git commit -m "docs: describe native comment counter behavior"
```

- [ ] **Step 9: Confirm final repository state**

Run:

```bash
git status --short
git log -4 --oneline
```

Expected: clean worktree with the design and plan commits followed by the three
implementation commits from this plan.
