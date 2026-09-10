# Extension reliability improvements

The user approved all findings from the extension audit, including request timeouts.

## Behavior

- Register the isolated content script on `https://github.com/*` so navigation into a PR list works from any GitHub page. Keep only the route/preference lifecycle active outside repository PR lists; do not mount cards, observe page mutations, or request PR data there.
- Keep the existing card layout. Show plain numbers for thread and agent counts, including partial data, per the user's display preference; retain explanatory hover and accessible descriptions.
- Revalidate completed rows after 60 seconds on focus/visibility restoration and on a visible-page periodic check. A native comment-count change invalidates that row immediately. Retain completed data while refreshing, use existing concurrency limits and intersection eligibility, and coalesce invalidations during an active request.
- Show an accessible Retry button when a request fails, including partial data from failed timeline fragment requests. Hidden or omitted data in successful responses is not retryable. Retry bypasses cached results, never overlaps the row's active load, and preserves completed sections while work is in progress. Use a refreshing flag to disable repeated manual retries.
- Bound each actual network request, including body download, to 15 seconds. A timeout becomes a normal recoverable section error and releases concurrency slots. Abort still cancels without rendering errors. Do not cache timeout/error results. No automatic retry loop or new persistent data.
- Upgrade affected development dependencies and regenerate the lockfile. Check audit results explicitly and preserve working build and verification behavior.

## Constraints and tradeoffs

Wider GitHub content-script matching is necessary for same-document route entry. No additional named permission, host permission, remote code, or third-party data service is required. A background scripting injector would need extra permissions; a split bootstrap would add bundle and resource complexity, so use the current single script with a dormant runtime off-route.

Keep strict URL validation, GET-only requests, native comment counters, toolbar preference, progressive section loading, two active rows, and four active fetches. New refresh work uses those same queues. Timers and listeners must be removed on disable, route exit, and invalidation. Preserve successful data during refresh, but disclose refresh errors when a section cannot be revalidated.

## Verification

Add regressions for cold same-document route entry, visible partial counts, refresh after stale/focus and native updates, manual retries, concurrent invalidations, timeout while downloading the body, queue release, cancellation, and cleanup. Run coverage, compile, Chrome build, manifest/icon/bundle validation, browser tests, React Doctor, and npm audit. Existing signed-in manual checks remain outside fixture-based coverage.
