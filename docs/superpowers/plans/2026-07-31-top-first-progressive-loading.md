# Top-First Progressive PR Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prioritize pull-request loading from the top of the list and render independently complete diff data without waiting for timeline pagination.

**Architecture:** A generic two-job scheduler controls which eligible PR rows may start remote work. The GitHub client runs files and timeline branches independently, emits final section updates, and still resolves one complete summary for existing caching and lifecycle semantics.

**Tech Stack:** TypeScript 5.9, WXT 0.20, React 19, IntersectionObserver, Vitest/jsdom, Playwright.

## Global Constraints

- Production permits at most two active PR jobs and four active HTTP requests.
- Preserve the existing 800 px eligibility margin, twenty-fragment cap, and sixty-second completed-summary cache.
- Top-down means deterministic job-start priority; never buffer an already-ready lower-row result.
- Progressive means independently final sections only. Never publish provisional timeline counts as partial lower bounds.
- Active jobs continue when scrolled outside the margin; queued jobs pause until eligible again.
- Row removal, identity reuse, route exit, and content-script invalidation abort work and suppress stale updates.
- Preserve same-origin authenticated GET requests, existing URL validation, privacy behavior, section error semantics, and total request count.
- Add no retry, timeout, persistent or per-source cache, permissions, background worker, API token, or lazy card mounting.
- Use strict test-driven development: write each behavior test first, run it to observe the expected failure, then add minimal production code.

---

### Task 1: Add the top-first PR job scheduler

**Files:**
- Create: `lib/pr-load-scheduler.ts`
- Create: `lib/pr-load-scheduler.test.ts`

**Interfaces:**
- Produce `createPrLoadScheduler<Job>(maximumActive: number)`.
- Return methods:
  - `register(job: Job, run: () => Promise<void>): void`
  - `unregister(job: Job): void`
  - `setOrder(jobs: readonly Job[]): void`
  - `updateEligibility(updates: readonly { job: Job; eligible: boolean }[]): void`
  - `clear(): void`

**Required behavior:**
- Registered jobs are one-shot and do not start before becoming eligible.
- Each batched eligibility update is fully applied before draining.
- Eligible queued jobs start in the latest `setOrder` order, regardless of update order.
- No more than `maximumActive` jobs run concurrently.
- Completion or rejection releases exactly one slot and starts the next eligible job.
- `eligible: false` pauses only queued jobs; active jobs continue.
- `unregister` prevents queued work from starting and immediately releases an active scheduler slot without double-release when its promise later settles.
- `clear` removes all jobs and eligibility state, releases scheduler slots, and permits later registrations.

- [ ] **Step 1: Write scheduler tests for ordering, the two-job window, and one-shot completion**

Use deferred promises and literal start-order assertions. Include a bottom-up eligibility batch for jobs `[5, 4, 3, 2, 1]` after setting order `[1, 2, 3, 4, 5]`; only jobs `1` and `2` may start, and resolving either must start `3`.

- [ ] **Step 2: Run the scheduler tests and verify RED**

Run: `npm test -- lib/pr-load-scheduler.test.ts`

Expected: FAIL because `lib/pr-load-scheduler.ts` does not exist.

- [ ] **Step 3: Implement the minimal generic scheduler**

Use explicit registered/queued/active/completed state so duplicate eligibility events cannot restart a job and unregistered active jobs cannot release twice.

- [ ] **Step 4: Add tests for pause, unregister, reorder, rejection, duplicate updates, and clear/reuse**

Each test must name the incorrect state transition it catches and assert observable start order or active count.

- [ ] **Step 5: Run focused tests and compile**

Run: `npm test -- lib/pr-load-scheduler.test.ts && npm run compile`

Expected: PASS with no warnings or type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/pr-load-scheduler.ts lib/pr-load-scheduler.test.ts
git commit -m "feat: add top-first PR load scheduler"
```

---

### Task 2: Publish independently final GitHub client sections

**Files:**
- Modify: `lib/github-client.ts`
- Modify: `lib/github-client.test.ts`
- Modify only for the options-interface migration: `lib/pr-reconciler.ts`

**Interfaces:**
- Add:

```ts
export type PullRequestRemoteUpdate =
  | { kind: 'diff'; diff: PullRequestRemoteSummary['diff'] }
  | {
      kind: 'timeline';
      agents: PullRequestRemoteSummary['agents'];
      reviewThreads: PullRequestRemoteSummary['reviewThreads'];
    }
  | { kind: 'complete'; summary: PullRequestRemoteSummary };

export interface PullRequestLoadOptions {
  onUpdate?: (update: PullRequestRemoteUpdate) => void;
  signal?: AbortSignal;
}
```

- Change `loadPullRequest(identity, signal?)` to:

```ts
loadPullRequest(
  identity: PullRequestIdentity,
  options?: PullRequestLoadOptions,
): Promise<PullRequestRemoteSummary>
```

**Required behavior:**
- Cache hits and invalid identities emit one `complete` update.
- Uncached loads start conversation and files requests together.
- A settled files branch parses and emits exactly one final `diff` update without waiting for conversation or timeline work.
- A settled conversation branch begins fragment discovery and pagination without waiting for files.
- Timeline emits exactly one final `timeline` update after all accepted fragments settle.
- The returned promise waits for both branches, combines their retryable-failure state, preserves current final summary values, and writes only the existing whole-summary cache.
- File failure affects only the diff update; conversation failure affects only the timeline update; fragment failure retains current partial semantics.
- No update is emitted after `options.signal` is aborted.
- Migrate the existing `PullRequestClient` declaration and RowController call
  to `PullRequestLoadOptions`/`{ signal }` so this task compiles independently;
  do not consume `onUpdate` in the reconciler until Task 3.

- [ ] **Step 1: Add deferred-response tests for early diff and early fragment start**

Prove files can emit while conversation is unresolved, and prove a conversation fragment request starts while files remains unresolved.

- [ ] **Step 2: Run the new client tests and verify RED**

Run: `npm test -- lib/github-client.test.ts -t "publishes|without waiting|complete update"`

Expected: FAIL because the option/update contract and independent branches do not exist.

- [ ] **Step 3: Split `loadUncached` into independent diff and timeline outcomes**

Start both branch promises before awaiting either. Keep URL validation, limiter use, parsing, pagination, aggregation, caps, and final cacheability rules unchanged.

- [ ] **Step 4: Add cache, validation, abort, and isolated-failure update tests**

Assert exact update discriminants and final summaries. Keep the existing four-request concurrency test.

- [ ] **Step 5: Update existing signal call sites and run the full client and reconciler suites**

Run: `npm test -- lib/github-client.test.ts lib/pr-reconciler.test.ts && npm run compile`

Expected: PASS with all existing request counts and summaries unchanged.

- [ ] **Step 6: Commit**

```bash
git add lib/github-client.ts lib/github-client.test.ts lib/pr-reconciler.ts
git commit -m "feat: stream final PR summary sections"
```

---

### Task 3: Schedule rows top-first and merge progressive updates safely

**Files:**
- Modify: `lib/pr-reconciler.ts`
- Modify: `lib/pr-reconciler.test.ts`
- Modify: `test/content-entrypoint.integration.test.tsx`

**Interfaces:**
- Extend the Task 2 `PullRequestLoadOptions` caller to consume `onUpdate`.
- `RowController.start()` returns `Promise<void>` representing the complete remote load.
- `createPageReconciler` owns one scheduler configured with `2` and one shared `IntersectionObserver` configured with `{ rootMargin: '800px' }`.

**Required behavior:**
- All cards still mount immediately with native comments and remote loading placeholders.
- Observer callbacks pass one complete eligibility batch to the scheduler; queued rows use current document order.
- Reconciliation updates scheduler order after DOM insertion, filtering, or reordering.
- Without `IntersectionObserver`, all current rows become eligible as one DOM-ordered batch.
- Queued rows leaving the margin do not start. Active rows leaving it continue.
- Removing or replacing controllers first unobserves and disposes the complete
  stale batch so every stale request is aborted, then unregisters those jobs
  and releases scheduler slots; the next eligible live row may start immediately.
- Every `diff`, `timeline`, or `complete` update passes the existing disposed, epoch, abort, identity, mount-anchor, and mounted-UI guards before merging.
- An unexpected rejection converts only still-loading remote sections to errors; already-ready sections remain unchanged.
- Promise completion fills any sections omitted by a test double but does not regress a ready/error section to loading.

- [ ] **Step 1: Add reconciler and real-entrypoint tests before wiring the scheduler**

Use at least three DOM-ordered rows and deferred client promises. Assert no request before eligibility, observer options include `rootMargin: '800px'`, rows one and two start from a bottom-up callback batch, and row three starts when either completes.

In the real entrypoint integration test, defer files and conversation independently. Assert the completed diff appears alongside loading timeline placeholders before releasing conversation, then assert the unchanged final line. Add a multi-row controlled case showing that no third PR starts before either top-two job completes.

- [ ] **Step 2: Run the new ordering tests and verify RED**

Run: `npm test -- lib/pr-reconciler.test.ts test/content-entrypoint.integration.test.tsx -t "top-first|two active|eligibility|before timeline"`

Expected: FAIL because rows currently own independent observers, start directly, and do not merge client section updates.

- [ ] **Step 3: Integrate the scheduler and shared observer**

Register each controller after construction, update order once per reconciliation,
and batch observer entries. During removal/replacement, unobserve and dispose the
complete stale-controller batch before unregistering any of its jobs so draining
cannot start another stale row.

- [ ] **Step 4: Add progressive update and stale-update tests**

Cover early diff with timeline still loading, lower-row completion without reveal buffering, row identity reuse, detached rows, active abort, route exit, dynamic insertion/reorder, duplicate observer events, no observer, and unexpected rejection after a ready diff.

- [ ] **Step 5: Implement guarded update merging and run reconciler/card tests**

Run: `npm test -- lib/pr-reconciler.test.ts lib/pr-card.test.tsx test/content-entrypoint.integration.test.tsx && npm run compile`

Expected: PASS; existing card layout and accessibility behavior remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add lib/pr-reconciler.ts lib/pr-reconciler.test.ts test/content-entrypoint.integration.test.tsx
git commit -m "feat: load PR rows from the top down"
```

---

### Task 4: Document loading semantics and run the release gate

**Files:**
- Modify: `README.md`
- Verify without modifying unless a failure requires a test-first fix: `test/e2e/extension-fixture.ts`
- Verify without modifying unless a failure requires a test-first fix: `test/e2e/extension.spec.ts`

**Required behavior:**
- The Task 3 real-entrypoint tests demonstrate early diff display and the top-two job window.
- Final rendered summaries remain identical to the current fixture expectations.
- README states that eligible rows are prioritized from the top and independently complete diff data appears while review/agent data continues loading.
- The manual checklist covers top-first scrolling, progressive section display, Turbo navigation, and native UI restoration.

- [x] **Step 1: Review the Task 3 integration evidence**

Confirm the committed tests cover early diff display, top-two scheduling, unchanged final summaries, and stale-update suppression. If a gap is found, add its failing test before changing production code.

- [x] **Step 2: Update README loading behavior and manual verification bullets**

Do not change privacy, permissions, or data-source claims.

- [x] **Step 3: Run the complete release gate**

Run: `npm run verify`

Expected: all unit, coverage, compile, build, manifest, bundle, and Chromium tests pass with no unexpected requests or console errors.

- [x] **Step 4: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-31-top-first-progressive-loading.md
git commit -m "docs: describe progressive top-first loading"
```
