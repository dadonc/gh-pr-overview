# GitHub Schema Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make diff, timeline, deferred-thread, Copilot, URL, completeness, and cache handling correct for current GitHub markup while retaining legacy behavior.

**Architecture:** Preserve `lib/github-dom.ts` as a public facade while splitting shared URL, row, diff, and timeline responsibilities into focused modules. The client will normalize only explicit same-origin endpoint families, keep files evidence independent from timeline evidence, and cache structural lower bounds but not transient failures.

**Tech Stack:** TypeScript 5.9, DOMParser/jsdom, Vitest 4, GitHub HTML fixtures, Chrome Manifest V3 content-script fetch semantics.

## Global Constraints

- Keep every request on exact origin `https://github.com`, GET-only, `credentials: "same-origin"`, and `redirect: "error"`.
- Keep the global fetch concurrency limit at 4 and timeline-fragment limit at 20.
- Add no permissions, host permissions, background worker, token, or cross-origin API call.
- Do not fetch progressive diff fragments or deferred thread bodies.
- Unknown AI agents remain ignored unless added to `AI_AGENT_REGISTRY`.
- Structurally partial results use lower-bound UI semantics and remain cacheable for 60,000 ms.
- Network, HTTP, authentication, response-validation, and fragment-fetch failures are not cacheable.
- Write each behavior test before its production implementation and observe the expected failure.

---

### Task 1: Establish shared identity and parser module boundaries

**Files:**
- Modify: `lib/domain.ts`
- Create: `lib/github-url.ts`
- Create: `lib/github-row-dom.ts`
- Create: `lib/github-diff-dom.ts`
- Create: `lib/github-timeline-dom.ts`
- Modify: `lib/github-dom.ts`
- Modify: `lib/github-client.ts`
- Modify: `lib/pr-reconciler.ts`
- Test: `lib/domain.contract.test.ts`
- Test: `lib/github-dom.test.ts`
- Test: `lib/github-client.test.ts`

**Interfaces:**
- Produces: `PullRequestIdentity` from `lib/domain.ts`.
- Produces: `trustedGitHubUrl(candidate)`, `isValidPullRequestIdentity(identity)`, and `pullRequestPath(identity)` from `lib/github-url.ts`.
- Produces: the existing row exports from `lib/github-row-dom.ts`.
- Produces: `extractDiffSummary(document)` from `lib/github-diff-dom.ts`.
- Produces: the existing timeline exports from `lib/github-timeline-dom.ts`.
- Preserves: every current export from `lib/github-dom.ts` through re-exports.

- [ ] **Step 1: Add a contract test for the shared identity type and `.github` repository validation**

Add this behavioral assertion to `lib/github-client.test.ts`:

```ts
it('accepts valid leading-dot repository names without weakening owner validation', () => {
  expect(isValidPullRequestIdentity({
    number: 1,
    owner: 'github',
    repository: '.github',
  })).toBe(true);
  expect(isValidPullRequestIdentity({
    number: 1,
    owner: '.github',
    repository: 'community',
  })).toBe(false);
});
```

Add a compile-time contract in `lib/domain.contract.test.ts` that imports
`PullRequestIdentity` from `./domain` and assigns:

```ts
const identity: PullRequestIdentity = {
  number: 42,
  owner: 'octo',
  repository: '.github',
};
expect(identity.repository).toBe('.github');
```

- [ ] **Step 2: Run the focused tests and verify the new imports/behavior fail**

Run:

```bash
npm test -- lib/domain.contract.test.ts lib/github-client.test.ts
```

Expected: FAIL because `PullRequestIdentity` is not exported from `domain.ts`
and the current repository validator rejects `.github`.

- [ ] **Step 3: Add the shared identity and URL primitives**

Add to `lib/domain.ts`:

```ts
export interface PullRequestIdentity {
  number: number;
  owner: string;
  repository: string;
}
```

Create `lib/github-url.ts` with these exact exports:

```ts
import type { PullRequestIdentity } from './domain';

export const GITHUB_ORIGIN = 'https://github.com';

export function trustedGitHubUrl(
  candidate: string | null | undefined,
): URL | undefined;

export function isValidPullRequestIdentity(
  identity: PullRequestIdentity,
): boolean;

export function pullRequestPath(identity: PullRequestIdentity): string;
```

Move the current raw-path, origin, credential, port, backslash, dot-segment, and
encoded-separator checks into `trustedGitHubUrl`. Use separate validators:

```ts
const validOwner = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);

const validRepository = (value: string) =>
  /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(value);
```

Keep the PR number requirement as a positive safe integer.

- [ ] **Step 4: Move parser responsibilities without changing behavior**

Move row-only code and types into `lib/github-row-dom.ts`, diff-only code into
`lib/github-diff-dom.ts`, and timeline-only code and types into
`lib/github-timeline-dom.ts`. Import `trustedGitHubUrl` instead of retaining a
second URL parser.

Replace `lib/github-dom.ts` with an explicit facade:

```ts
export * from './github-diff-dom';
export * from './github-row-dom';
export * from './github-timeline-dom';
```

Update `github-client.ts` and `pr-reconciler.ts` to import
`PullRequestIdentity` from `domain.ts`. Re-export it from `github-client.ts` only
because existing tests and callers import it there. Preserve the client's
public validator export through the shared URL module:

```ts
export type { PullRequestIdentity } from './domain';
export { isValidPullRequestIdentity } from './github-url';
```

- [ ] **Step 5: Run all parser/client tests after the behavior-preserving split**

Run:

```bash
npm test -- lib/domain.contract.test.ts lib/github-dom.test.ts lib/github-client.test.ts lib/pr-reconciler.test.ts
npm run compile
```

Expected: PASS, including the new `.github` assertions.

- [ ] **Step 6: Commit the adapter boundary**

```bash
git add lib/domain.ts lib/github-url.ts lib/github-row-dom.ts lib/github-diff-dom.ts lib/github-timeline-dom.ts lib/github-dom.ts lib/github-client.ts lib/pr-reconciler.ts lib/domain.contract.test.ts lib/github-client.test.ts
git commit -m "refactor: separate GitHub schema adapters"
```

### Task 2: Parse current authoritative and progressive diff markup

**Files:**
- Create: `test/fixtures/github/current/files.html`
- Create: `test/fixtures/github/current/files-no-aggregate.html`
- Modify: `lib/github-diff-dom.ts`
- Test: `lib/github-dom.test.ts`

**Interfaces:**
- Consumes: `DiffExtraction` and `extractDiffSummary(document)` from Task 1.
- Produces: exact current aggregate parsing before legacy and rendered fallback parsing.

- [ ] **Step 1: Add sanitized current files fixtures**

`test/fixtures/github/current/files.html` must contain:

```html
<!doctype html>
<span id="files_tab_counter" title="18">18</span>
<span id="diffstat">
  <span class="color-fg-success">+524</span>
  <span class="color-fg-danger">−353</span>
</span>
<div class="file js-file"><a title="src/one.ts"></a></div>
<div class="file js-file"><a title="src/two.ts"></a></div>
<include-fragment
  class="diff-progressive-loader js-diff-progressive-loader"
  src="/octo/demo/diffs?pull_number=42&amp;start_entry=2">
</include-fragment>
<include-fragment src="/octo/demo/unrelated"></include-fragment>
```

`files-no-aggregate.html` must retain the two rendered files and progressive
loader but omit `#files_tab_counter` and `#diffstat`. Include one addition and
one deletion line with stable `data-line-number` values.

- [ ] **Step 2: Add failing current-diff tests**

Add to `lib/github-dom.test.ts`:

```ts
it('uses the current exact aggregate even when rendered files are progressive', () => {
  const result = extractDiffSummary(fixture('current/files.html'));
  expect(result).toEqual({
    completeness: { isComplete: true, reasons: [] },
    data: { additions: 524, deletions: 353, filesChanged: 18 },
  });
});

it('marks the rendered fallback partial for a current progressive loader', () => {
  const result = extractDiffSummary(
    fixture('current/files-no-aggregate.html'),
  );
  expect(result.data).toEqual({
    additions: 1,
    deletions: 1,
    filesChanged: 2,
  });
  expect(result.completeness.isComplete).toBe(false);
});

it('does not treat an unrelated include-fragment as diff incompleteness', () => {
  const document = html(`
    <div class="file js-file"><a title="only.ts"></a></div>
    <include-fragment src="/octo/demo/unrelated"></include-fragment>
  `);
  expect(extractDiffSummary(document).completeness.isComplete).toBe(true);
});
```

Use the test file's existing fixture/HTML helpers rather than introducing a
second parser helper.

- [ ] **Step 3: Run the tests and observe the exact aggregate failure**

Run:

```bash
npm test -- lib/github-dom.test.ts -t "current exact aggregate|current progressive loader|unrelated include-fragment"
```

Expected: FAIL because the current code does not combine
`#files_tab_counter` with `#diffstat` and does not recognize `src` progressive
loaders.

- [ ] **Step 4: Implement the three-level diff precedence**

Add safe integer helpers in `github-diff-dom.ts`:

```ts
function parseUnsignedMetric(value: string | null | undefined): number | undefined {
  const normalized = value?.trim().replaceAll(',', '');
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseSignedDisplayMetric(
  value: string | null | undefined,
  sign: '+' | '-',
): number | undefined {
  const normalized = value?.trim().replaceAll(',', '').replace('−', '-');
  const pattern = sign === '+' ? /^\+(\d+)$/ : /^-(\d+)$/;
  const digits = normalized?.match(pattern)?.[1];
  return parseUnsignedMetric(digits);
}
```

Before the legacy semantic loop, require all three current values:

```ts
const filesCounter = document.querySelector<HTMLElement>('#files_tab_counter');
const diffstat = document.querySelector<HTMLElement>('#diffstat');
const current = {
  filesChanged: parseUnsignedMetric(
    filesCounter?.getAttribute('title') ?? filesCounter?.textContent,
  ),
  additions: parseSignedDisplayMetric(
    diffstat?.querySelector<HTMLElement>('.color-fg-success')?.textContent,
    '+',
  ),
  deletions: parseSignedDisplayMetric(
    diffstat?.querySelector<HTMLElement>('.color-fg-danger')?.textContent,
    '-',
  ),
};
```

Return exact only when every value is defined. Add these specific partial
selectors and retain the existing collapsed/truncated selectors:

```css
include-fragment.diff-progressive-loader[src],
include-fragment.js-diff-progressive-loader[src],
include-fragment[data-targets~="diff-file-filter.progressiveLoaders"][src]
```

Do not add bare `include-fragment`.

- [ ] **Step 5: Run the focused and full DOM tests**

Run:

```bash
npm test -- lib/github-dom.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit current diff support**

```bash
git add test/fixtures/github/current/files.html test/fixtures/github/current/files-no-aggregate.html lib/github-diff-dom.ts lib/github-dom.test.ts
git commit -m "fix: parse current GitHub diff aggregates"
```

### Task 3: Extract deferred threads and modern Copilot artifacts

**Files:**
- Create: `test/fixtures/github/current/conversation.html`
- Create: `test/fixtures/github/current/automated-comment.html`
- Modify: `lib/github-timeline-dom.ts`
- Test: `lib/github-dom.test.ts`

**Interfaces:**
- Changes: `extractTimeline(input, identity)` requires a `PullRequestIdentity`.
- Produces: `TimelineExtraction.completeness.agents` and `.reviewThreads`.
- Preserves: artifact and thread collections plus `nextTimelineFragments`.

- [ ] **Step 1: Add current conversation and automated-comment fixtures**

The conversation fixture must include these reduced structures:

```html
<div id="discussion_bucket"></div>
<div
  id="js-timeline-progressive-loader"
  data-timeline-item-src="octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&amp;id=PR_current42">
</div>
<review-thread-collapsible
  class="js-resolvable-timeline-thread-container"
  data-deferred-content-url="/octo/demo/pull/42/threads/2497380155?rendering_on_files_tab=false"
  data-hidden-comment-ids="3676782712"
  data-resolved="true">
  <span title="Label: Outdated">Outdated</span>
</review-thread-collapsible>
<div class="TimelineItem" id="event-100">
  <a href="/apps/copilot-pull-request-reviewer"
     data-hovercard-url="/copilot/hovercard?bot=copilot-pull-request-reviewer">
    Copilot
  </a>
  Copilot AI review requested due to automatic review settings
</div>
<div class="TimelineItem" id="event-101">
  <div class="TimelineItem-body">
    <strong>Copilot</strong> started reviewing on behalf of reviewer
  </div>
</div>
```

The automated-comment fixture must contain one
`id="discussion_r3676782635"` element with a
`react-partial > script[type="application/json"][data-target="react-partial.embeddedData"]`
whose JSON includes:

```json
{
  "props": {
    "comment": {
      "author": { "login": "Copilot" },
      "automatedComment": { "source": "copilot" }
    }
  }
}
```

- [ ] **Step 2: Add failing split-completeness and Copilot tests**

Add tests equivalent to:

```ts
const identity = { number: 42, owner: 'octo', repository: 'demo' };

it('counts a current deferred shell exactly but marks hidden agent bodies partial', () => {
  const result = extractTimeline(
    fixture('current/conversation.html'),
    identity,
  );
  expect(result.threads).toEqual([{
    id: 'thread-2497380155',
    isOutdated: true,
    isResolved: true,
  }]);
  expect(result.completeness.reviewThreads.isComplete).toBe(true);
  expect(result.completeness.agents.isComplete).toBe(false);
});

it('detects current automatic request and nested started-reviewing Copilot events', () => {
  const result = extractTimeline(
    fixture('current/conversation.html'),
    identity,
  );
  expect(result.artifacts.reviewRequests).toContainEqual({
    action: 'requested',
    id: 'event-100',
    requestedLogin: 'copilot-pull-request-reviewer',
  });
  expect(result.artifacts.reviewEvents).toContainEqual({
    action: 'started-reviewing',
    actorLogin: 'copilot-pull-request-reviewer',
    id: 'event-101',
  });
});

it('extracts Copilot from a validated automated-comment payload', () => {
  const result = extractTimeline(
    fixture('current/automated-comment.html'),
    identity,
  );
  expect(result.artifacts.inlineComments).toContainEqual({
    actorLogin: 'copilot-pull-request-reviewer',
    id: 'discussion_r3676782635',
  });
});
```

Also add table-driven deferred URL rejection cases for wrong owner, repository,
PR number, origin, credentials, port, traversal, encoded separators, nonnumeric
thread IDs, and hashes. Add a malformed embedded JSON assertion that does not
throw, keeps thread completeness unchanged, and makes agent completeness
partial.

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
npm test -- lib/github-dom.test.ts -t "deferred shell|automatic request|started-reviewing|automated-comment|deferred URL"
```

Expected: FAIL because the old extractor neither accepts an identity nor
returns split completeness and misses the current artifacts.

- [ ] **Step 4: Implement validated deferred identities**

Change the timeline signature:

```ts
export interface TimelineExtraction {
  artifacts: TimelineArtifactsExtraction;
  completeness: {
    agents: ExtractionCompleteness;
    reviewThreads: ExtractionCompleteness;
  };
  nextTimelineFragments: readonly string[];
  threads: readonly ReviewThread[];
}

export function extractTimeline(
  input: Document | readonly Document[],
  identity: PullRequestIdentity,
): TimelineExtraction;
```

Pass `identity` to `threadIdentities`. Parse
`data-deferred-content-url` with `trustedGitHubUrl`, require the exact
case-insensitive path:

```ts
`${pullRequestPath(identity)}/threads/${positiveInteger}`
```

and add the stable alias `thread-${positiveInteger}`. A deferred URL with
readable state contributes a thread. The presence of
`data-deferred-content-url` plus an unloaded/hidden body adds only this agent
reason:

```text
A deferred review thread may hide AI response details.
```

Maintain separate `Set<string>` reason accumulators for agents and threads.

- [ ] **Step 5: Implement narrow Copilot event and JSON recognition**

Add a registry-label helper that returns the first canonical login only when
the text exactly equals an `AI_AGENT_REGISTRY` label:

```ts
function loginForAgentLabel(value: string | null | undefined): string | undefined {
  const label = value?.trim().toLowerCase();
  return AI_AGENT_REGISTRY.find(
    (agent) => agent.label.toLowerCase() === label,
  )?.logins[0];
}
```

Limit new text fallbacks to `.TimelineItem[id^="event-"]`. For recognized
request/start phrases, prefer a recognized nested account anchor, then a
registry label in `strong`.

For typed response elements only, parse:

```css
react-partial script[type="application/json"][data-target="react-partial.embeddedData"]
```

Validate `props`, `comment`, `author.login`, and
`automatedComment.source` with `typeof value === 'object' && value !== null`
checks. Map only `{ login: "Copilot", source: "copilot" }` to
`copilot-pull-request-reviewer`. Use the outer typed DOM ID and never insert or
render JSON fields.

- [ ] **Step 6: Update every legacy timeline call and run the full DOM suite**

Update existing tests to pass the identity represented by each fixture:

```ts
extractTimeline(document, {
  number: 42,
  owner: 'octo',
  repository: 'demo',
});
```

Run:

```bash
npm test -- lib/github-dom.test.ts lib/domain.test.ts
npm run compile
```

Expected: PASS.

- [ ] **Step 7: Commit current timeline extraction**

```bash
git add test/fixtures/github/current/conversation.html test/fixtures/github/current/automated-comment.html lib/github-timeline-dom.ts lib/github-dom.test.ts
git commit -m "fix: parse current GitHub review evidence"
```

### Task 4: Follow focused timeline fragments securely

**Files:**
- Create: `test/fixtures/github/current/timeline-fragment.html`
- Modify: `lib/github-client.ts`
- Test: `lib/github-client.test.ts`

**Interfaces:**
- Preserves: public `isAllowedPullRequestUrl(candidate, identity, kind)`.
- Adds internally: normalized absolute fragment targets and pinned focused PR node IDs.
- Consumes: `extractTimeline(document, identity)` from Task 3.

- [ ] **Step 1: Add a terminal current timeline fragment fixture**

Create a fragment containing one deduplicatable review artifact and no next
loader:

```html
<!doctype html>
<div id="pullrequestreview-900" data-gid="PRR_current">
  <a href="/apps/copilot-pull-request-reviewer"
     data-hovercard-url="/copilot/hovercard?bot=copilot-pull-request-reviewer">
    Copilot
  </a>
</div>
```

- [ ] **Step 2: Add focused URL validation and traversal tests**

Add assertions for:

```ts
expect(isAllowedPullRequestUrl(
  'octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42',
  identity,
  'fragment',
)).toBe(true);
```

Reject wrong owner/repository, `/pull/N/timeline_focused_item`, missing or
duplicate `id`, invalid `id`, missing/duplicate cursor, extra query keys, hash,
credentials, port, cross-origin URL, protocol-relative URL, dot segment,
backslash, and encoded separator.

Retain a valid legacy assertion:

```ts
expect(isAllowedPullRequestUrl(
  '/octo/demo/pull/42/timeline?after=CaseSensitiveToken',
  identity,
  'fragment',
)).toBe(true);
```

- [ ] **Step 3: Add a failing focused-chain client test**

Stub the conversation response with `current/conversation.html`, the files
response with `current/files.html`, and the exact focused target with
`current/timeline-fragment.html`. Assert:

```ts
expect(fetcher).toHaveBeenCalledWith(
  'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42',
  expect.objectContaining({
    credentials: 'same-origin',
    method: 'GET',
    redirect: 'error',
  }),
);
```

Add a second fragment with a different `id=PR_other` and prove it is rejected
as partial rather than fetched. Preserve cursor case and encoding in the
expected URL.

- [ ] **Step 4: Run the focused client tests and verify failure**

Run:

```bash
npm test -- lib/github-client.test.ts -t "focused|leading-dot|legacy"
```

Expected: FAIL because only `/pull/N/timeline` is currently allowed.

- [ ] **Step 5: Implement explicit fragment normalization and ID pinning**

Use `trustedGitHubUrl` for the shared origin/path guard. For focused fragments,
require:

```ts
url.pathname.toLowerCase() ===
  `/${identity.owner}/${identity.repository}/timeline_focused_item`.toLowerCase()
```

Require exactly one `id`, one `after_cursor`, no other keys, and:

```ts
/^PR_[A-Za-z0-9_-]+$/.test(id)
```

For legacy fragments, require the exact `/pull/N/timeline` path and exactly one
nonempty `after` or `after_cursor` key.

Fetch `url.href` without lowercasing it. Dedupe with a separate key:

```ts
`${url.origin}${url.pathname.toLowerCase()}${url.search}`
```

Pin the first focused ID accepted from the validated conversation loader. A
later focused URL is allowed only when its ID is identical. Keep the existing
four-at-a-time batching and twenty-fragment cap.

- [ ] **Step 6: Run all client URL, pagination, abort, and cap tests**

Run:

```bash
npm test -- lib/github-client.test.ts
npm run compile
```

Expected: PASS.

- [ ] **Step 7: Commit focused timeline support**

```bash
git add test/fixtures/github/current/timeline-fragment.html lib/github-client.ts lib/github-client.test.ts
git commit -m "fix: follow current GitHub timeline fragments"
```

### Task 5: Separate evidence completeness and cache structural lower bounds

**Files:**
- Modify: `lib/github-client.ts`
- Test: `lib/github-client.test.ts`

**Interfaces:**
- Consumes: split timeline completeness from Task 3.
- Produces internally: `{ retryableFailure: boolean; summary: PullRequestRemoteSummary }`.
- Preserves: `createGitHubClient().loadPullRequest(identity, signal)`.

- [ ] **Step 1: Add failing independence and cache tests**

Add these scenarios:

```ts
it('keeps files-page fragments isolated from timeline completeness', async () => {
  const summary = await clientFor({
    conversation: currentConversation,
    files: currentFilesWithProgressiveLoader,
    fragment: currentTimelineFragment,
  }).loadPullRequest(identity);

  expect(summary.diff.status).toBe('ready');
  expect(summary.reviewThreads.status).toBe('ready');
  expect(summary.agents.status).toBe('partial');
});

it('caches structural partials for the normal TTL', async () => {
  const client = createFixtureClient({ conversation: deferredConversation });
  await client.loadPullRequest(identity);
  await client.loadPullRequest(identity);
  expect(fetcher).toHaveBeenCalledTimes(expectedFirstLoadRequests);
});

it('does not cache a result containing a failed timeline fragment', async () => {
  const client = createFailingFragmentClient();
  await client.loadPullRequest(identity);
  await client.loadPullRequest(identity);
  expect(fragmentRequestCount()).toBe(2);
});
```

Also assert that a files fetch failure produces only `diff: error`, a
conversation failure produces only timeline-section errors, and the files
document's fake review artifacts never appear in agent aggregation.

- [ ] **Step 2: Run the new tests and verify the old coupling/cache failures**

Run:

```bash
npm test -- lib/github-client.test.ts -t "isolated|structural partials|failed timeline fragment|files fetch failure|conversation failure"
```

Expected: FAIL because files are appended to `timelineDocuments`, any files
fragment marks timeline partial, and only fully ready results are cached.

- [ ] **Step 3: Implement independent timeline streams and retryability**

Remove `filesMayHideTimelineData`. Keep:

```ts
const timelineDocuments: Document[] = [conversation.document];
```

and never append `files.document`.

Collect `agentReasons` and `threadReasons` separately. Merge global fragment
reasons into both sets, then merge
`timeline.completeness.agents.reasons` and
`timeline.completeness.reviewThreads.reasons` into their respective sets.

Build sections independently:

```ts
agents: sectionFromCompleteness(
  agentData,
  agentReasons.size === 0,
  [...agentReasons],
),
reviewThreads: sectionFromCompleteness(
  threadData,
  threadReasons.size === 0,
  [...threadReasons],
),
```

Change the internal load result to:

```ts
interface LoadOutcome {
  retryableFailure: boolean;
  summary: PullRequestRemoteSummary;
}
```

Set `retryableFailure` for files/conversation/fragment fetch or response
failures. Do not set it for deferred bodies, invalid fragments, unrecognized
successful HTML, or the fragment cap. Cache when
`!loaded.retryableFailure && !signal?.aborted`, regardless of section status.

- [ ] **Step 4: Run client tests, the full unit suite, and TypeScript**

Run:

```bash
npm test -- lib/github-client.test.ts
npm test
npm run compile
```

Expected: PASS.

- [ ] **Step 5: Commit completeness and caching changes**

```bash
git add lib/github-client.ts lib/github-client.test.ts
git commit -m "fix: separate GitHub evidence completeness"
```

### Task 6: Review the schema/client subproject

**Files:**
- Review: `lib/domain.ts`
- Review: `lib/github-url.ts`
- Review: `lib/github-row-dom.ts`
- Review: `lib/github-diff-dom.ts`
- Review: `lib/github-timeline-dom.ts`
- Review: `lib/github-dom.ts`
- Review: `lib/github-client.ts`
- Review: `test/fixtures/github/current/*`

**Interfaces:**
- Produces: a green, independently reviewable schema/client foundation for the row-lifecycle and verification plans.

- [ ] **Step 1: Run the subproject gate**

```bash
npm test
npm run compile
npm run build
npm run verify:manifest
```

Expected: all commands exit 0.

- [ ] **Step 2: Inspect the generated manifest and network strings**

Run:

```bash
rg -n "https?://|host_permissions|permissions|background|web_accessible_resources" .output/chrome-mv3/manifest.json .output/chrome-mv3/content-scripts/content.js
```

Expected: application fetch targets remain `https://github.com`; the manifest
has no new permission, background, or web-accessible-resource field.

- [ ] **Step 3: Inspect the diff and working tree**

```bash
git diff --check HEAD~5..HEAD
git status --short
```

Expected: no whitespace errors and a clean working tree.

- [ ] **Step 4: Request a code review before starting the dependent plans**

Use the `requesting-code-review` skill against the commits produced by Tasks
1-5. Resolve any correctness or security finding before continuing.
