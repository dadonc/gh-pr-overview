# Extension Reliability Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the bounded independent tasks and requesting-code-review for final review. Track completion below.

**Goal:** Implement every improvement approved in the extension audit.

**Architecture:** Preserve the existing WXT runtime, row scheduler, React cards, and HTML client. Extend their lifecycle and refresh contracts rather than replacing the parsers or adding an API backend.

**Tech Stack:** WXT, TypeScript, React, Vitest, Playwright.

## Global Constraints

Follow `docs/superpowers/specs/2026-09-10-extension-reliability-design.md`. Keep storage as the only named permission; site matching becomes `https://github.com/*`. Keep two active rows and four active fetches. Request timeout is 15 seconds; stale threshold is 60 seconds.

## Task 1: Bounded network requests and explicit cache bypass

Files: `lib/github-client.ts`, `lib/github-client.test.ts`, optional focused timeout helper/test.

Contract:
```ts
interface PullRequestLoadOptions {
  bypassCache?: boolean;
  onUpdate?: (update: PullRequestRemoteUpdate) => void;
  signal?: AbortSignal;
}
```

- [x] Add failing tests: hanging fetch and hanging response body both produce recoverable timeout errors and release limiter slots; caller abort retains abort semantics; a bypass reload obtains changed remote data inside the cache TTL.
- [x] Run the focused tests and confirm the missing behavior.
- [x] Implement a request-scoped abort controller and deadline inside the limiter slot, remove listeners/timers in finally, and support bypassCache without caching failure results. Do not treat request timeout as caller cancellation.
- [x] Run focused client tests and self-review concurrency/cleanup.

## Task 2: Honest card counts and retry affordance

Files: `lib/pr-card.tsx`, `lib/pr-card.test.tsx`.

Contract:
```ts
interface PullRequestCardProps {
  // Existing fields remain.
  onRetry?: () => void;
  refreshing?: boolean;
}
```

- [x] Add failing tests for visible `≥0 unresolved`, `Codex ≥1`, and Retry invoking its handler once with an accessible button.
- [x] Render Retry only for partial/error sections, disable it while refreshing, and include refreshing in aria-busy. Retain the current shadow styles and compact single line.
- [x] Run the focused card tests and self-review accessibility.

## Task 3: Navigation activation, refresh scheduling, and integration

Files: `entrypoints/content.tsx`, `lib/content-runtime.ts`, `lib/pr-reconciler.ts`, `lib/pr-load-scheduler.ts`, associated tests, manifest verifier/tests, browser tests, README.

- [x] Add failing browser coverage for initial load on a conversation followed by pushState to a PR list; add runtime tests proving off-route dormancy and teardown.
- [x] Change site matching and verifier contracts, maintain an enabled flag independent of reconciler existence, and create/destroy the reconciler on committed route changes.
- [x] Add failing scheduler/reconciler tests for revalidation, active-load invalidation, cache bypass, manual retry, focus, and cleanup.
- [x] Store eligibility separately from job completion. Add requeue support that keeps the two-row limit and defers active invalidations until completion.
- [x] Connect onRetry/refreshing card props. Track row freshness; compare native counts; revalidate stale visible rows at 60-second intervals and on focus/visibility restoration. Keep loaded data while refreshing and discard obsolete/aborted updates.
- [x] Run focused tests, then add browser checks for visible partial labels and successful retry/refresh.
- [x] Update README for broader activation, counts, revalidation, retry, and deadlines.

## Task 4: Dependency security maintenance

Files: `package.json`, `package-lock.json`; build compatibility changes only if required and coordinated.

- [x] Inspect current advisories and candidate upgrades from the registry.
- [x] Upgrade Vitest/coverage together and WXT to patched releases; update vulnerable compatible transitive dependencies.
- [x] Run npm audit for full and production scopes; report any unresolved advisories with actual exposure.
- [x] Check compile/build compatibility and report lockfile changes.

## Task 5: Final verification and review

- [x] Run full coverage, compile, build, manifest/icon/bundle checks, and all browser regressions.
- [x] Run React Doctor; inspect warnings rather than treating its score as proof of a defect.
- [x] Obtain independent code review, address material findings, and rerun affected checks.
- [x] Inspect final diff/status; leave a verified, reviewable branch and report the built extension location.

## Implementation notes

- Scoped reviews of cards, network deadlines/cache bypass, and dependency upgrades found no remaining issues. Final review identified unread error-response bodies; abort-on-settlement cleanup and its regression resolved the finding. Scoped re-review is clean.
- Preserve the 250,000-byte content-script limit. The total package budget is now 275,000 bytes to include the script plus the existing icons and service worker; measured package is about 271 kB.
- WXT 0.21 requires an explicit Node typings dependency and enables unchecked-index diagnostics; the pre-existing string split is asserted nonempty because splitting a string with limit 1 always returns its first element.
- React Doctor reports the same two baseline warnings: chained row-array passes and non-cryptographic React/WXT generated IDs. Neither is a new security defect.

## Final verification — 2026-09-10

- `npm run verify`: passed, including 374 unit/integration tests across 17 files and 10 browser tests.
- Coverage: statements 93.59%, branches 89.44%, functions 96.95%, lines 95.40%; all configured gates passed.
- TypeScript, production Chrome build, manifest, icons, and bundle validation passed. Content script remains below 250 kB.
- Full and production npm audits: zero vulnerabilities.
- Independent final review and scoped cleanup re-review: no open findings.
- Visual inspection confirms visible partial markers and the compact Retry button. Temporary screenshots remain outside the repository.
- An initial full browser run had one Chrome fixture setup timeout before its test body; a subsequent isolated full verification passed all ten browser tests. No retry setting or test timeout was relaxed.
- Signed-in real GitHub manual checks remain the release checklist in README; automated browser validation uses repository fixtures.
