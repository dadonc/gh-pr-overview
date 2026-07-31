# GitHub Timeline Fragment Request Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load GitHub timeline fragments without false 404 partial states by matching GitHub's current fragment request contract and focused-loader URL shape.

**Architecture:** Keep fragment URL normalization and fetching inside `lib/github-client.ts`. Extend focused URL validation for one optional `before_cursor`, then derive GitHub's fragment-only headers from the already trusted conversation document and pass them through the existing limited fetch path without changing conversation or files requests.

**Tech Stack:** TypeScript 5.9, DOM `Document`/`Headers`/`fetch`, Vitest 4, jsdom 28, WXT 0.20.

## Global Constraints

- Focused fragment URLs still require one nonempty `after_cursor` and one valid `PR_` node ID.
- At most one nonempty `before_cursor` is allowed; every unrelated query key remains rejected.
- `X-Requested-With` is sent on every validated fragment request.
- `X-Fetch-Nonce` and `X-GitHub-Client-Version` are sent only when the conversation document exposes nonempty `fetch-nonce` and `release` meta values.
- Fragment-only headers never appear on canonical conversation or files requests.
- Genuine fragment failures preserve accumulated lower-bound data as partial and remain uncached.
- Keep the existing fragment concurrency cap, deduplication, cycle protection, pull-request node pinning, and 20-fragment limit.
- Do not change UI wording, styling, dependencies, extension permissions, or manifest configuration.

## File Structure

- Modify `lib/github-client.ts`: validate the current focused fragment query shape, derive request metadata, and apply it only at the fragment fetch boundary.
- Modify `lib/github-client.test.ts`: add regression coverage for `before_cursor`, fragment request headers, missing optional metadata, page-request isolation, and retained partial failure behavior.

---

### Task 1: Accept GitHub's optional focused-fragment `before_cursor`

**Files:**
- Modify: `lib/github-client.ts:119-159`
- Test: `lib/github-client.test.ts:317-385`

**Interfaces:**
- Consumes: `normalizeTimelineFragment(candidate: string, identity: PullRequestIdentity): NormalizedTimelineFragment | undefined`
- Produces: the same private interface, accepting focused URLs with exactly one optional nonempty `before_cursor` while preserving the original URL encoding in `href` and `dedupeKey`.

- [ ] **Step 1: Add focused URL acceptance and rejection cases**

In `lib/github-client.test.ts`, extend `accepts only canonical same-PR focused and legacy timeline URLs` with this accepted URL after the existing focused URL assertion:

```ts
expect(isAllowedPullRequestUrl(
  'octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&before_cursor=Cursor%2BZero&id=PR_current42',
  identity,
  'fragment',
)).toBe(true);
```

Add both malformed variants to the rejected-candidate array:

```ts
'/octo/demo/timeline_focused_item?after_cursor=cursor&before_cursor=&id=PR_current42',
'/octo/demo/timeline_focused_item?after_cursor=cursor&before_cursor=one&before_cursor=two&id=PR_current42',
```

Keep the existing `source=fragment`, duplicate `after_cursor`, missing ID, wrong repository, credential, port, fragment, and path rejection cases unchanged.

Add a pipeline test after the validator test so acceptance is proven at the
fetch boundary, not only through the exported predicate:

```ts
it('follows a focused timeline fragment with an optional before cursor', async () => {
  const fragmentUrl = 'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&before_cursor=Cursor%2BZero&id=PR_current42';
  const conversation = `<div id="discussion_bucket"></div>
    <div id="js-timeline-progressive-loader"
         data-timeline-item-src="/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&amp;before_cursor=Cursor%2BZero&amp;id=PR_current42"></div>`;
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const value = String(url);
    if (value.endsWith('/files')) return response(diffAggregateHtml, value);
    if (value === fragmentUrl) return response(currentTimelineFragmentHtml, value);
    return response(conversation, value);
  });

  const summary = await clientFor(fetcher).loadPullRequest(identity);

  expect(fetcher).toHaveBeenCalledWith(
    fragmentUrl,
    expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
  );
  expect(summary.reviewThreads.status).toBe('ready');
});
```

- [ ] **Step 2: Run the focused validator test and confirm the new valid case fails**

Run:

```bash
npm test -- lib/github-client.test.ts -t "accepts only canonical|optional before cursor"
```

Expected: FAIL because the valid three-parameter focused URL currently hits `parameters.size !== 2` and returns `false`. The pipeline test also fails because the fragment is rejected before the fetch boundary. The malformed cases should already return `false`.

- [ ] **Step 3: Implement the minimal focused-query validation change**

In the focused branch of `normalizeTimelineFragment`, read `before_cursor` and compare the total parameter count against the exact number of recognized entries:

```ts
const ids = parameters.getAll('id');
const cursors = parameters.getAll('after_cursor');
const beforeCursors = parameters.getAll('before_cursor');
if (
  parameters.size !== 2 + beforeCursors.length ||
  ids.length !== 1 ||
  cursors.length !== 1 ||
  !cursors[0] ||
  beforeCursors.length > 1 ||
  (beforeCursors.length === 1 && !beforeCursors[0]) ||
  !/^PR_[A-Za-z0-9_-]+$/.test(ids[0] ?? '')
) return undefined;
```

The `parameters.size` equality is important: it continues to reject unknown keys even when a valid optional `before_cursor` is present.

- [ ] **Step 4: Re-run the focused validator test**

Run:

```bash
npm test -- lib/github-client.test.ts -t "accepts only canonical|optional before cursor"
```

Expected: PASS.

- [ ] **Step 5: Run the complete GitHub client unit file**

Run:

```bash
npm test -- lib/github-client.test.ts
```

Expected: all tests in `lib/github-client.test.ts` pass.

- [ ] **Step 6: Commit the URL compatibility change**

```bash
git add lib/github-client.ts lib/github-client.test.ts
git commit -m "fix: accept current GitHub timeline cursors"
```

---

### Task 2: Send GitHub fragment request metadata without changing page requests

**Files:**
- Modify: `lib/github-client.ts:240-380`
- Test: `lib/github-client.test.ts:223-302,430-463`

**Interfaces:**
- Produces: private `fragmentRequestHeaders(document: Document): Headers`.
- Extends: private `fetchDocument(target, identity, kind, signal, headers?)` and `settle(target, kind, headers?)` call paths with an optional `HeadersInit` argument.
- Preserves: public `createGitHubClient(options)` and `loadPullRequest(identity, loadOptions?)` signatures unchanged.

- [ ] **Step 1: Add a regression test for GitHub's complete fragment header set**

Add this test near the existing focused-fragment tests in `lib/github-client.test.ts`:

```ts
it('uses GitHub request metadata only for timeline fragment fetches', async () => {
  const fragmentUrl = 'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42';
  const conversation = `<!doctype html>
    <html>
      <head>
        <meta name="fetch-nonce" content="v2:test-fetch-nonce">
        <meta name="release" content="0123456789abcdef0123456789abcdef01234567">
      </head>
      <body>
        <div id="discussion_bucket"></div>
        <div id="js-timeline-progressive-loader"
             data-timeline-item-src="/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&amp;id=PR_current42"></div>
      </body>
    </html>`;
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const value = String(url);
    if (value.endsWith('/files')) return response(diffAggregateHtml, value);
    if (value === fragmentUrl) return response(currentTimelineFragmentHtml, value);
    return response(conversation, value);
  });

  await clientFor(fetcher).loadPullRequest(identity);

  const fragmentCall = fetcher.mock.calls.find(([url]) => String(url) === fragmentUrl);
  expect(fragmentCall).toBeDefined();
  const fragmentHeaders = new Headers(fragmentCall?.[1]?.headers);
  expect(fragmentHeaders.get('X-Requested-With')).toBe('XMLHttpRequest');
  expect(fragmentHeaders.get('X-Fetch-Nonce')).toBe('v2:test-fetch-nonce');
  expect(fragmentHeaders.get('X-GitHub-Client-Version')).toBe(
    '0123456789abcdef0123456789abcdef01234567',
  );

  for (const pageUrl of [
    'https://github.com/octo/demo/pull/42',
    'https://github.com/octo/demo/pull/42/files',
  ]) {
    const pageCall = fetcher.mock.calls.find(([url]) => String(url) === pageUrl);
    expect(pageCall).toBeDefined();
    expect([...new Headers(pageCall?.[1]?.headers)]).toEqual([]);
  }
});
```

- [ ] **Step 2: Add a regression test for absent optional meta values**

Add a second test immediately after it:

```ts
it('still marks a fragment request when optional GitHub metadata is absent', async () => {
  const fragmentUrl = 'https://github.com/octo/demo/pull/42/timeline?after=next';
  const conversation = `<div id="discussion_bucket"></div>
    <div id="js-timeline-progressive-loader"
         data-timeline-item-src="/octo/demo/pull/42/timeline?after=next"></div>`;
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const value = String(url);
    if (value.endsWith('/files')) return response(diffAggregateHtml, value);
    if (value === fragmentUrl) return response('<div id="discussion_bucket"></div>', value);
    return response(conversation, value);
  });

  await clientFor(fetcher).loadPullRequest(identity);

  const fragmentCall = fetcher.mock.calls.find(([url]) => String(url) === fragmentUrl);
  expect(fragmentCall).toBeDefined();
  expect(Object.fromEntries(new Headers(fragmentCall?.[1]?.headers))).toEqual({
    'x-requested-with': 'XMLHttpRequest',
  });
});
```

- [ ] **Step 3: Run the two new tests and confirm they fail for missing headers**

Run:

```bash
npm test -- lib/github-client.test.ts -t "request metadata|optional GitHub metadata"
```

Expected: both tests FAIL because the fragment request currently has no `headers` in its `RequestInit`.

- [ ] **Step 4: Add the fragment-header derivation helper**

Add this private helper after `isAuthenticationDocument` in `lib/github-client.ts`:

```ts
function fragmentRequestHeaders(document: Document): Headers {
  const headers = new Headers({ 'X-Requested-With': 'XMLHttpRequest' });
  const fetchNonce = document.querySelector<HTMLMetaElement>('meta[name="fetch-nonce"]')?.content.trim();
  const clientVersion = document.querySelector<HTMLMetaElement>('meta[name="release"]')?.content.trim();
  if (fetchNonce) headers.set('X-Fetch-Nonce', fetchNonce);
  if (clientVersion) headers.set('X-GitHub-Client-Version', clientVersion);
  return headers;
}
```

Do not export this helper. Its input is the successfully fetched, same-origin conversation document; its output is used only after fragment URL validation.

- [ ] **Step 5: Thread optional headers through the existing fetch boundary**

Extend `fetchDocument` with an optional fifth parameter:

```ts
const fetchDocument = async (
  target: string,
  identity: PullRequestIdentity,
  kind: PullRequestUrlKind,
  signal: AbortSignal | undefined,
  headers?: HeadersInit,
): Promise<Document> => {
```

Inside its limiter callback, build the request without adding a `headers: undefined` property to page requests:

```ts
const request: RequestInit = {
  credentials: 'same-origin',
  method: 'GET',
  redirect: 'follow',
  signal,
};
if (headers) request.headers = headers;
const response = await fetcher(target, request);
```

Extend `settle` in `loadUncached` and forward the optional argument:

```ts
const settle = async (
  target: string,
  kind: PullRequestUrlKind,
  headers?: HeadersInit,
): Promise<FetchResult> => {
  try {
    return { document: await fetchDocument(target, identity, kind, signal, headers), ok: true };
  } catch (error) {
    if (signal?.aborted || isAbort(error)) throw error;
    return { error: asError(error), ok: false };
  }
};
```

- [ ] **Step 6: Apply the derived headers only to timeline fragments**

Immediately after the successful conversation branch begins, derive the headers once:

```ts
const timelineDocuments: Document[] = [conversation.document];
const fragmentHeaders = fragmentRequestHeaders(conversation.document);
```

Change only the batch fragment call:

```ts
const results = await Promise.all(
  batch.map(({ href }) => settle(href, 'fragment', fragmentHeaders)),
);
```

Leave `settle(conversationTarget, 'conversation')` and `settle(filesTarget, 'files')` without a third argument.

- [ ] **Step 7: Re-run the header regression tests**

Run:

```bash
npm test -- lib/github-client.test.ts -t "request metadata|optional GitHub metadata"
```

Expected: both tests PASS.

- [ ] **Step 8: Re-run the complete GitHub client tests, including partial failure and cache coverage**

Run:

```bash
npm test -- lib/github-client.test.ts
```

Expected: all tests pass, including:

- `publishes a partial final timeline update when a fragment fails`;
- `does not cache a result containing a failed timeline fragment`;
- `follows a focused timeline fragment with its original cursor encoding and rejects an ID mismatch`;
- limiter, abort, redirect, and structural-partial tests.

- [ ] **Step 9: Run static compilation**

Run:

```bash
npm run compile
```

Expected: TypeScript exits successfully with no diagnostics.

- [ ] **Step 10: Run repository-wide verification**

Run:

```bash
npm run verify
```

Expected: coverage tests, compile, WXT build, manifest verification, bundle verification, and Playwright end-to-end tests all pass.

- [ ] **Step 11: Review the final diff for scope and formatting**

Run:

```bash
git diff --check
git diff -- lib/github-client.ts lib/github-client.test.ts
git status --short
```

Expected: no whitespace errors; only the two planned source/test files are modified; the pre-existing untracked `.superpowers/` directory remains untouched.

- [ ] **Step 12: Commit the request compatibility fix**

```bash
git add lib/github-client.ts lib/github-client.test.ts
git commit -m "fix: send GitHub timeline fragment headers"
```
