# Chrome Extension Full-Pass Design

Date: 2026-07-29

## Context

GitHub PR Overview is a read-only Chrome Manifest V3 extension that augments
GitHub pull-request list rows with native comment totals, review-thread counts,
diff totals, and allowlisted AI-reviewer participation.

The existing implementation has strong URL, permission, rendering, and teardown
guards, and its current unit suite passes. A live review of GitHub's July 2026
markup found compatibility gaps in current diff aggregation, timeline
pagination, deferred review threads, and Copilot events. The review also found
avoidable reconciliation work, pre-commit navigation churn, an inconsistent
zero-comment mount location, a missing generated CSS request, a manifest
verification gap, and no real-browser extension test.

## Goals

- Correctly interpret the current and legacy GitHub markup already covered by
  the extension's declared purpose.
- Preserve lower-bound semantics whenever GitHub withholds evidence.
- Keep every fetch same-origin, read-only, bounded, and tied to an explicit
  GitHub endpoint family.
- Make row reconciliation linear in the number of visible PR rows.
- Give zero- and nonzero-comment rows the same responsive mount behavior.
- Avoid aborting and recreating work against the old DOM during Turbo
  navigation.
- Remove unused runtime and dependency behavior.
- Add fixture-backed integration and Chromium extension coverage without using
  credentials or live network data in automated tests.

## Non-goals

- Replacing React with imperative DOM rendering.
- Adding automatic retries or a user-facing retry control.
- Fetching every progressive diff fragment or deferred review-thread body.
- Supporting unknown AI reviewers outside the explicit registry.
- Adding API tokens, a background worker, new permissions, host permissions, or
  cross-origin requests.
- Automating a signed-in GitHub account or persisting browser profiles, cookies,
  HAR files, or traces containing repository data.

## Architecture

The implementation will use a bounded adapter refactor rather than adding more
selectors to the existing monolithic parser.

The public `github-dom` module will remain a compatibility facade for tests and
callers. Internally, parsing responsibilities will be separated into:

- PR-list row extraction.
- Diff evidence extraction.
- Timeline, review-thread, and response-artifact extraction.
- Shared GitHub URL and PR-identity validation.

The `PullRequestIdentity` type will have one shared definition so DOM parsing,
URL validation, fetching, and reconciliation cannot drift.

The evidence flow is:

```text
PR-list row
  -> native total comments and viewer/author identity

Files page
  -> authoritative or lower-bound diff totals

Conversation page + validated timeline fragments
  -> review-thread identities and states
  -> review requests, review starts, reactions, reviews, comments, and replies

Conversation and timeline evidence
  -> independently complete review-thread and AI-agent sections
```

The files document is not appended to timeline extraction. Current conversation
markup exposes every review thread as either a loaded body or a deferred shell,
so that stream can make its own honest completeness decision. This keeps thread
and agent sections from being coupled to unrelated files-page fragments.

## URL and identity validation

All URL handling will continue to fail closed:

- Exact `https://github.com` origin.
- No credentials, ports, protocol-relative URLs, hashes on fetch targets,
  backslashes, raw dot segments, or encoded path separators/dot segments.
- Safe positive PR and fragment identifiers.
- Exact owner and repository paths, compared case-insensitively without
  rewriting opaque query values.

Owner and repository validation will be separated. Owners retain the current
alphanumeric-leading constraint. Repository names may begin with a dot, so
valid repositories such as `.github` are accepted while empty names, `.` and
`..` remain invalid.

Conversation and files pages remain exact, query-free targets:

```text
/{owner}/{repository}/pull/{number}
/{owner}/{repository}/pull/{number}/files
```

Timeline pagination will allow two explicit endpoint families:

```text
/{owner}/{repository}/pull/{number}/timeline
/{owner}/{repository}/timeline_focused_item
```

The current focused endpoint must contain exactly one nonempty `id` matching a
narrow PR-node-ID shape and the expected cursor keys. The first focused PR node
ID discovered in the validated conversation document will be pinned for the
entire pagination chain. A later fragment with a different ID is rejected.
Relative URLs without a leading slash are accepted because GitHub emits them.
Opaque cursor values keep their exact case and encoding.

Only URLs extracted from the exact timeline progressive-loader selector are
eligible as fragments. Response URLs are revalidated after fetch. Existing
GET-only, `credentials: "same-origin"`, `redirect: "error"`, HTML content-type,
authentication-document, abort, four-request limiter, and twenty-fragment
guards remain.

Deferred thread URLs are parsed but not fetched. An identity is accepted only
from a URL matching the exact current PR:

```text
/{owner}/{repository}/pull/{number}/threads/{positive-integer}
```

Allowed presentation query parameters do not influence the identity.

## Diff extraction

Diff evidence is interpreted in this order:

1. Current exact aggregate:
   - File count from `#files_tab_counter`, preferring its `title`.
   - Additions and deletions from `#diffstat`, accepting comma separators and
     ASCII or Unicode minus signs.
   - All three values must be nonnegative safe integers.
2. Existing legacy semantic aggregate containing files-changed, additions, and
   deletions phrases.
3. Rendered lower-bound fallback using unique rendered file roots and changed
   line identifiers.

Current progressive markers such as
`include-fragment.js-diff-progressive-loader[src]`, plus existing
collapsed/truncated markers, make only the rendered fallback partial. A complete
aggregate remains exact even when the rendered file list is progressive.

Bare `include-fragment` elements do not imply diff incompleteness. Progressive
diff fragments are not fetched because the aggregate already supplies exact
totals and crawling the render tree would add unstable, potentially large
request fan-out.

## Timeline and deferred-thread extraction

Timeline extraction will return separate completeness records for:

- Review threads.
- AI-agent artifacts.

A deferred thread shell with:

- A validated stable thread identity.
- Readable `data-resolved` or equivalent structured state.
- Readable outdated state, including the current `Label: Outdated` marker.

is sufficient for an exact thread count. Its unloaded body may hide an
allowlisted AI comment or reply, so only the agent section becomes partial.

An unreadable thread identity or state makes the thread section partial as
well. Duplicate shell, loaded-body, discussion-anchor, hidden-input, and GID
identities continue to be unioned so one logical thread is counted once.

Actual progressive timeline failures, invalid fragments, unrecognized fragment
HTML, and the fragment cap affect both timeline-derived sections. Hidden
response bodies or malformed response payloads affect only AI-agent
completeness.

## Modern Copilot extraction

Generic actor parsing will remain conservative. Current Copilot support will be
added through event-specific evidence:

- Automatic review requests matching GitHub's current
  "review requested due to automatic review settings" event.
- "started reviewing" events where `Copilot` is a nested strong label rather
  than an account anchor.
- Loaded automated inline-comment payloads from:

```css
react-partial script[type="application/json"][data-target="react-partial.embeddedData"]
```

Embedded JSON is parsed in `try/catch` and treated only as data. Extraction reads
the narrow `props.comment.author.login` and
`props.comment.automatedComment.source` shape. Source `copilot` plus display
login `Copilot` maps to the registry's canonical
`copilot-pull-request-reviewer` login. The outer typed DOM response ID remains
the deduplication identity.

Text fallbacks are limited to stable timeline event elements and exact event
phrases. Registry display labels map only inside those recognized events.
Arbitrary page text cannot register an agent.

Malformed recognized automated-comment JSON never throws or affects thread
counting; it makes AI-agent evidence partial.

## Completeness and caching

Section readiness and cacheability are independent:

| Condition | Diff | Threads | Agents | Cache |
| --- | --- | --- | --- | --- |
| Exact diff aggregate with progressive loader | ready | unaffected | unaffected | yes |
| Rendered diff fallback with hidden content | partial | unaffected | unaffected | yes |
| Deferred thread shell with readable identity/state | unaffected | ready | partial if body is hidden | yes |
| Invalid fragment, unknown successful fragment, or cap | unaffected | partial | partial | yes |
| Timeline fragment request failure | unaffected | partial | partial | no |
| Files request failure | error | unaffected | unaffected | no |
| Conversation request failure | unaffected | error | error | no |

Structurally partial summaries are cached for the normal sixty-second TTL
because an immediate retry sees the same intentionally bounded evidence.
Results containing transient network, HTTP, authentication, or parsing-fetch
failures are not cached.

No broader retry system or shared-request cancellation layer is added in this
pass.

## Row extraction and reconciliation

A new single-row extractor will accept the viewer login and one row element.
Full-document extraction will become a thin mapping operation.

Each reconciliation pass will:

1. Read the viewer login once.
2. Extract every current row once.
3. Build a row-to-extraction map.
4. Refresh, dispose, or create controllers from that map.

Async completion checks may re-extract only their own row. No controller will
scan every row in the document, removing the current quadratic behavior.

Every row will use one extension-owned inert mount marker. On current GitHub
markup it will be placed in the visible main-content column immediately after
the metadata block identified through the semantic title/opened-by structure.
This avoids:

- Appending zero-comment UI inside `.opened-by`.
- Mounting nonzero UI in GitHub's current `hide-sm` right-hand column.

Fallbacks may use a recognized row-end or counter container, but will never
append inside `.opened-by`; the marker is inserted as a sibling.

Native counter state is independent from the mount marker. A controller tracks
the currently recognized counter plus its exact `hidden`, `aria-hidden`,
`tabindex`, and `style` snapshot. Counter appearance, disappearance,
replacement, or correction updates total comments without remounting the card
or restarting the remote request.

A recognized native counter is hidden only after the extension UI mounts
successfully. Previous counters are restored exactly on replacement, failure,
or cleanup. Ambiguous counters and title anchors are never hidden.

## Navigation lifecycle

WXT's Navigation API path emits `wxt:locationchange` before the navigation
commits. The runtime will stop calling `reset()` synchronously.

The lifecycle interface will expose WXT's invalidation-aware
`requestAnimationFrame`. A location event will:

1. Capture `event.newUrl`.
2. Coalesce multiple events to the latest generation.
3. Schedule one animation frame.
4. Reconcile only when `document.location.href` matches the captured URL.

If the frame runs before commit, it is a no-op. The existing document
`MutationObserver` remains authoritative when Turbo replaces or mutates the
DOM. Canceled navigations leave mounted controllers untouched. Reconciliation
against the committed route already handles leaving PR lists, changed row
identities, and inserted or removed rows, so the public `reset()` operation can
be removed.

## UI, CSS, and accessibility

`cssInjectionMode: "ui"` will be removed. Styles already enter
`createShadowRootUi` through `CARD_STYLES`; removing the option prevents WXT
from requesting a nonexistent `/content-scripts/content.css`. No CSS asset or
`web_accessible_resources` entry will be added.

The card keeps its existing semantic group and descriptions. A single stable
visually hidden status node will use:

- `role="status"`.
- `aria-live="polite"`.
- `aria-atomic="true"`.

The group receives `aria-busy` while any remote section is loading. The status
text changes between loading and updated states so assistive technology hears
one concise completion message instead of every metric being re-announced.

The extension-owned host remains constrained to the row width and the card
continues to wrap metrics. Focus, dark-mode, and reduced-motion styles remain.

## Manifest and bundle verification

Manifest validation will require `content_scripts[0]` to be a plain object with
exactly:

```text
all_frames
js
matches
run_at
world
```

Extra or missing nested fields are errors, including `css`,
`exclude_matches`, glob fields, `match_about_blank`, and
`match_origin_as_fallback`. Existing exact top-level, path, world, frame, and
run-time checks remain.

A bundle verifier will check:

- The exact expected packaged file set.
- No packaged CSS asset or manifest CSS entry.
- Content-script size at or below 250,000 bytes.
- Total unpacked size at or below 270,000 bytes.

WXT's generic shadow-root helper may retain a dormant
`content-scripts/content.css` loader string even when the entrypoint does not
enable that branch. The entrypoint integration test must prove the option is
absent and direct `CARD_STYLES` injection is present; the Chromium smoke must
abort and fail on any actual CSS request.

These budgets are modest regression guards around the existing React-based
bundle, not a mandate to remove React.

## Automated verification

Existing synthetic fixtures and edge-case tests remain. A sanitized
`test/fixtures/github/current/` set will preserve the relevant July 2026
structures while removing names and content that are not required by the
tests:

- PR list with zero and nonzero native counters.
- Conversation with a focused timeline loader, deferred thread shell,
  automatic Copilot request, and started-reviewing event.
- Files page with current exact aggregate and progressive loader.
- Focused timeline fragment.
- Loaded automated inline-comment payload.
- Fixture provenance and sanitization notes.

Regression tests will cover:

- Current and legacy diff parsing.
- Focused timeline normalization, ID pinning, cycles, caps, and rejection cases.
- Deferred identity/state handling and split completeness.
- Current Copilot request/start/response extraction and malformed JSON.
- Structural-partial caching versus transient-failure retry behavior.
- `.github` repository identities.
- One extraction per row and all native-counter transitions.
- Responsive mount placement, exact restoration, and async mount failure.
- Pre-commit navigation, coalescing, cancellation, and committed DOM changes.
- Accessibility status transitions.
- Nested manifest and bundle validation.

One Vitest entrypoint integration test will stub the WXT host boundary while
using the real React root, runtime, reconciler, and client.

Two Playwright tests will load the built unpacked extension into a temporary
Chromium persistent context. All `https://github.com/**` requests will be
fulfilled from committed fixtures; unmatched network requests fail the test.
The tests will cover:

1. Real content-script injection, strict page CSP, shadow-root styles, summary
   rendering, console/page errors, and unexpected requests.
2. Real WXT location-change wiring, dynamic row insertion/removal, native
   restoration, and stale-summary prevention.

No service-worker wait is used because the extension intentionally has no
service worker.

Coverage and verification scripts will provide one local gate for unit,
integration, type, build, manifest, bundle, and Chromium checks. Coverage
thresholds target 90% statements, lines, and functions and 85% branches for
production modules. Thresholds may be adjusted only if a documented
environment-generated branch cannot be exercised safely.

The unused direct `web-ext` dependency will be removed. `@playwright/test` and
Vitest's V8 coverage provider will be added.

## Manual release verification

Automated fixture tests cannot prove authenticated cookies, private-repository
markup, or a future live GitHub deployment. The README will include a short
Chrome Stable release checklist covering:

- Public and disposable private PR lists.
- Correct totals on small and progressive diffs.
- Filters, scrolling, Turbo navigation, dynamic rows, and route exit.
- Native counter restoration after route exit or extension disable.
- No external requests, CSP errors, or extension-console errors.
- Narrow viewport, keyboard focus, dark mode, and reduced motion.

Profiles, cookies, private HTML, HAR files, traces, and screenshots containing
repository data must not be committed.

## Success criteria

- Current fixtures produce exact diff and thread results and honest agent lower
  bounds.
- Legacy fixtures continue to pass.
- Every rejected URL, malformed payload, and missing evidence path fails closed
  without throwing or fabricating zero.
- Reconciliation is linear per document pass and counter transitions do not
  restart remote work.
- Navigation never clears and remounts against an uncommitted URL.
- The generated extension makes no phantom CSS request and contains no
  unexpected manifest/package field.
- Unit, integration, type, build, manifest, bundle, coverage, and Chromium
  checks pass locally.
- The remaining signed-in Chrome check is documented explicitly rather than
  implied to be automated.
