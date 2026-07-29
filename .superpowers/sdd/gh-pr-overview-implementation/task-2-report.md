# Task 2 report — GitHub DOM extractors

## Files changed

- `lib/github-dom.ts`: pure DOM-only extractors for PR rows, review threads, timeline artifacts/request state/reactions, pagination discovery, and exact-or-partial diffs.
- `lib/github-dom.test.ts`: DOMParser-based behavior tests for rows, threads, artifacts, formal-request state, reactions, aliases, and diffs.
- `test/fixtures/github/*.html`: sanitized realistic PR-list, timeline, semantic-diffstat, and rendered-partial-diff fixtures.

## Red evidence

- `npm test -- lib/github-dom.test.ts` before implementation failed to resolve `./github-dom`, proving the new extractor contract had no implementation.
- After adding the narrowly scoped legacy event-text fixture, the focused suite had **1 failure**: no formal request/removal artifacts were extracted.
- After adding the cross-document canonical-permalink regression, the focused suite had **1 failure**: a thread exposed as `PRRT_resolved` in one document and `discussion_r102` in another was counted twice (9 rather than 8).

## Green verification

- `npm test -- lib/github-dom.test.ts` — **13 tests passed**.
- `npm test` — **4 test files and 36 tests passed**.
- `npm run compile` — `tsc --noEmit` exited successfully.
- `git diff --check` — exited successfully with no whitespace errors.

## Commit

`feat: add GitHub DOM extractors` (the Task 2 commit on `ds/github-pr-overview`)

## Self-review

- PR identity is taken only from canonical pull URLs; native counters preserve GitHub's href and distinguish omitted zero counters from malformed comment-like markup.
- Thread aliases merge hidden GitHub IDs, `data-gid`, canonical discussion permalinks, semantic `discussion_r*`, and legacy `discussion-diff-*` IDs. Any resolved/outdated copy wins.
- Timeline extraction returns discovered next-fragment URLs rather than declaring itself partial just because a fetched page contains a loader; Task 3 can mark only unresolved/capped pagination partial.
- Formal request history is retained and a chronological `currentReviewRequests` reducer excludes removed-only reviewers. Response types remain separate and are deduplicated by stable identity.
- Actor extraction passes candidates through the centralized registry normalizer and supports direct app/user profile hrefs; unknown bots and actorless reaction aggregates are omitted.
- Diff totals use GitHub-like ARIA/title/diffstat semantics when all three totals are present; rendered fallback is explicitly partial when GitHub shows collapsed, load, suppressed, truncated, or fragment markers.

## Concerns

- GitHub markup changes frequently. The extractor intentionally uses semantic attributes and several documented stable identities, but Task 3 should surface the explicit completeness/error outputs rather than silently treating unavailable data as zero.

## Follow-up independent-review fixes

- Replaced forward-only thread alias mapping with a unioned alias graph. A late bridge now merges previously created records, repoints every identity through the component, deterministically retains a GitHub thread ID over a discussion alias, and merges flags regardless of document order.
- Reduced structured and legacy review-request events in one document-ordered traversal. Added narrow `.TimelineItem` started-reviewing fallback support.
- Hardened actor extraction for semantic comment/review headers, nested reaction actors, app/user hovercard URLs, and bot-suffixed profile metadata while excluding reaction actors from an enclosing comment's author selection.
- Prefer canonical typed response DOM IDs over `data-gid` for cross-render deduplication; retain `data-gid` priority for timeline event identities.
- Treat missing counter destinations and comment-like non-ARIA links as malformed; retain genuine omitted counters as zero.
- Restricted exact diffstat parsing to coherent recognized diffstat regions. Rendered evidence is ready only when present and unmarked partial; absent/inaccessible evidence is explicitly incomplete.
- Mark timeline extraction incomplete if a resolvable thread lacks any stable identity, while keeping discovered next-fragment URLs independent.

### Follow-up red evidence

- `npm test -- lib/github-dom.test.ts` after adding the review regressions produced **7 failures**: missing href/comment-like counter markup, interleaved request chronology, legacy started-reviewing, nested/header actors, typed-ID copies, page-wide diffstat contamination, and absent diff evidence.
- `npm test -- lib/github-dom.test.ts` after adding the late-alias bridge regression produced **1 failure**: two merged aliases remained as separate records in first-to-last document order.

### Follow-up green verification

- `npm test -- lib/github-dom.test.ts` — **23 tests passed**.
- `npm test` — **4 test files and 46 tests passed**.
- `npm run compile` — `tsc --noEmit` exited successfully.
- `git diff --check` — exited successfully with no whitespace errors.
