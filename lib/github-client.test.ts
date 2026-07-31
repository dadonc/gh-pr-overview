import { describe, expect, it, vi } from 'vitest';

import diffAggregateHtml from '../test/fixtures/github/diff-aggregate.html?raw';
import diffRenderedPartialHtml from '../test/fixtures/github/diff-rendered-partial.html?raw';
import timelineHtml from '../test/fixtures/github/timeline.html?raw';
import currentPrListHtml from '../test/fixtures/github/current/pr-list.html?raw';
import currentChangesHtml from '../test/fixtures/github/current/changes.html?raw';
import currentConversationHtml from '../test/fixtures/github/current/conversation.html?raw';
import currentFilesHtml from '../test/fixtures/github/current/files.html?raw';
import currentTimelineFragmentHtml from '../test/fixtures/github/current/timeline-fragment.html?raw';
import currentAutomatedCommentHtml from '../test/fixtures/github/current/automated-comment.html?raw';
import {
  createFetchLimiter,
  createGitHubClient,
  isValidPullRequestIdentity,
  isAllowedPullRequestUrl,
  type PullRequestRemoteUpdate,
} from './github-client';
import { extractPullRequestRows } from './github-dom';

const identity = { number: 42, owner: 'octo', repository: 'demo' };
const documentFor = (html: string) => new DOMParser().parseFromString(html, 'text/html');
// Response does not accept url in its init, so fixture fetches use this tiny browser-shaped response.
const response = (html: string, url = 'https://github.com/octo/demo/pull/42') => ({
  headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
  ok: true,
  status: 200,
  text: async () => html,
  url,
}) as Response;

const failed = (status = 500, url = 'https://github.com/octo/demo/pull/42') => ({
  headers: new Headers({ 'content-type': 'text/html' }),
  ok: false,
  status,
  text: async () => '',
  url,
}) as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function clientFor(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: Partial<Parameters<typeof createGitHubClient>[0]> = {},
) {
  return createGitHubClient({
    clock: () => 1_000,
    fetch: fetcher,
    parseDocument: documentFor,
    ...options,
  });
}

describe('GitHub pull-request data pipeline', () => {
  it('publishes the final diff while the conversation request remains unresolved', async () => {
    const conversation = deferred<Response>();
    const files = deferred<Response>();
    const updates: unknown[] = [];
    const fetcher = vi.fn((url: RequestInfo | URL) =>
      String(url).endsWith('/files') ? files.promise : conversation.promise,
    );
    const client = clientFor(fetcher);
    const pending = client.loadPullRequest(identity, { onUpdate: (update) => updates.push(update) });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    files.resolve(response(diffAggregateHtml, 'https://github.com/octo/demo/pull/42/files'));

    await vi.waitFor(() => expect(updates).toEqual([{
      diff: { data: { additions: 1204, deletions: 56, filesChanged: 3 }, status: 'ready' },
      kind: 'diff',
    }]));

    conversation.resolve(response('<div id="discussion_bucket"></div>'));
    await pending;
  });

  it('starts a conversation fragment without waiting for the files request', async () => {
    const files = deferred<Response>();
    const fragmentStarted = deferred<void>();
    const updates: PullRequestRemoteUpdate[] = [];
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=next"></div>';
    const fetcher = vi.fn((url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return files.promise;
      if (value.includes('/timeline?after=next')) {
        fragmentStarted.resolve();
        return Promise.resolve(response('<div id="discussion_bucket"></div>', value));
      }
      return Promise.resolve(response(conversation, value));
    });
    const client = clientFor(fetcher);
    const pending = client.loadPullRequest(identity, { onUpdate: (update) => updates.push(update) });

    await expect(Promise.race([
      fragmentStarted.promise,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Timeline fragment did not start before files resolved.')), 100)),
    ])).resolves.toBeUndefined();

    files.resolve(response(diffAggregateHtml, 'https://github.com/octo/demo/pull/42/files'));
    await pending;

    expect(updates.filter((update) => update.kind === 'timeline')).toEqual([{
      agents: { data: [], status: 'ready' },
      kind: 'timeline',
      reviewThreads: { data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 }, status: 'ready' },
    }]);
  });

  it('keeps the complete update observer from undermining the cached summary', async () => {
    let updateAttempts = 0;
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : '<div id="discussion_bucket"></div>', String(url)),
    );
    const client = clientFor(fetcher);
    const onUpdate = () => {
      updateAttempts += 1;
      throw new Error('Observer failed.');
    };

    const first = await client.loadPullRequest(identity, { onUpdate });
    const second = await client.loadPullRequest(identity, { onUpdate });

    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(updateAttempts).toBe(3);
  });

  it('publishes one complete update for cached and invalid identities', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : '<div id="discussion_bucket"></div>', String(url)),
    );
    const client = clientFor(fetcher);
    const summary = await client.loadPullRequest(identity);
    const cachedUpdates: PullRequestRemoteUpdate[] = [];

    expect(await client.loadPullRequest(identity, { onUpdate: (update) => cachedUpdates.push(update) })).toBe(summary);
    expect(cachedUpdates).toEqual([{ kind: 'complete', summary }]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const invalidUpdates: PullRequestRemoteUpdate[] = [];
    const invalidSummary = await client.loadPullRequest({ number: 0, owner: 'octo', repository: 'demo' }, {
      onUpdate: (update) => invalidUpdates.push(update),
    });

    expect(invalidUpdates).toEqual([{ kind: 'complete', summary: invalidSummary }]);
    expect(invalidSummary).toEqual({
      agents: { message: 'Pull request identity is invalid.', status: 'error' },
      diff: { message: 'Pull request identity is invalid.', status: 'error' },
      reviewThreads: { message: 'Pull request identity is invalid.', status: 'error' },
    });
  });

  it('publishes no update after its caller aborts before the responses settle', async () => {
    const controller = new AbortController();
    const resolvers = new Map<string, (value: Response) => void>();
    const updates: PullRequestRemoteUpdate[] = [];
    const fetcher = vi.fn((url: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolvers.set(String(url), resolve);
    }));
    const client = clientFor(fetcher);
    const pending = client.loadPullRequest(identity, {
      onUpdate: (update) => updates.push(update),
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort();
    resolvers.get('https://github.com/octo/demo/pull/42')?.(response('<div id="discussion_bucket"></div>'));
    resolvers.get('https://github.com/octo/demo/pull/42/files')?.(response(diffAggregateHtml, 'https://github.com/octo/demo/pull/42/files'));
    await pending;

    expect(updates).toEqual([]);
  });

  it('publishes a file failure only in its final diff update', async () => {
    const updates: PullRequestRemoteUpdate[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/files') ? failed(500, String(url)) : response('<div id="discussion_bucket"></div>', String(url)),
    );

    const summary = await clientFor(fetcher).loadPullRequest(identity, { onUpdate: (update) => updates.push(update) });

    expect(updates.find((update) => update.kind === 'diff')).toEqual({
      diff: { message: 'GitHub request failed (500).', status: 'error' },
      kind: 'diff',
    });
    expect(updates.find((update) => update.kind === 'timeline')).toEqual({
      agents: { data: [], status: 'ready' },
      kind: 'timeline',
      reviewThreads: { data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 }, status: 'ready' },
    });
    expect(summary.diff.status).toBe('error');
    expect(summary.agents.status).toBe('ready');
    expect(summary.reviewThreads.status).toBe('ready');
  });

  it('publishes a conversation failure only in its final timeline update', async () => {
    const updates: PullRequestRemoteUpdate[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/files') ? response(diffAggregateHtml, String(url)) : failed(),
    );

    const summary = await clientFor(fetcher).loadPullRequest(identity, { onUpdate: (update) => updates.push(update) });

    expect(updates.find((update) => update.kind === 'diff')).toEqual({
      diff: { data: { additions: 1204, deletions: 56, filesChanged: 3 }, status: 'ready' },
      kind: 'diff',
    });
    expect(updates.find((update) => update.kind === 'timeline')).toEqual({
      agents: { message: 'GitHub request failed (500).', status: 'error' },
      kind: 'timeline',
      reviewThreads: { message: 'GitHub request failed (500).', status: 'error' },
    });
    expect(summary.diff.status).toBe('ready');
    expect(summary.agents.status).toBe('error');
    expect(summary.reviewThreads.status).toBe('error');
  });

  it('publishes a partial final timeline update when a fragment fails', async () => {
    const updates: PullRequestRemoteUpdate[] = [];
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=retry"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      return value.includes('after=retry') ? failed() : response(conversation, value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity, { onUpdate: (update) => updates.push(update) });
    const timeline = updates.find((update) => update.kind === 'timeline');

    expect(timeline).toMatchObject({
      agents: { status: 'partial' },
      kind: 'timeline',
      reviewThreads: { status: 'partial' },
    });
    expect(summary.diff.status).toBe('ready');
    expect(summary.agents.status).toBe('partial');
    expect(summary.reviewThreads.status).toBe('partial');
  });

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
    expect(fragmentCall?.[1]).toMatchObject({ redirect: 'error' });
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
      expect(pageCall?.[1]).toMatchObject({ redirect: 'follow' });
      expect([...new Headers(pageCall?.[1]?.headers)]).toEqual([]);
    }
  });

  it('ignores fragment metadata outside the conversation document head', async () => {
    const fragmentUrl = 'https://github.com/octo/demo/pull/42/timeline?after=next';
    const conversation = `<!doctype html>
      <html>
        <head><title>Conversation</title></head>
        <body>
          <meta name="fetch-nonce" content="body-fetch-nonce">
          <meta name="release" content="body-client-version">
          <div id="discussion_bucket"></div>
          <div id="js-timeline-progressive-loader"
               data-timeline-item-src="/octo/demo/pull/42/timeline?after=next"></div>
        </body>
      </html>`;
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

  it('summarizes the committed current fixture set with exact requests', async () => {
    const fixtureResponses = new Map([
      ['https://github.com/octo/demo/pull/42', currentConversationHtml],
      ['https://github.com/octo/demo/pull/42/files', currentFilesHtml],
      ['https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42', currentTimelineFragmentHtml],
    ]);
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const value = String(url);
      const fixture = fixtureResponses.get(value);
      if (!fixture) throw new Error(`Unexpected fixture request: ${value}`);
      return response(fixture, value);
    });

    const nativeComments = extractPullRequestRows(documentFor(currentPrListHtml)).find(
      (row) => row.identity.number === identity.number,
    )?.nativeComments;
    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(nativeComments).toEqual({
      count: 2,
      href: '/octo/demo/pull/42#comments',
      status: 'ready',
    });
    expect(summary).toEqual({
      agents: {
        data: [{
          agentId: 'copilot',
          requestSources: ['formal-review-request', 'started-reviewing'],
          responseCount: 1,
          state: 'responded',
        }],
        reason: 'A deferred review thread may hide AI response details.',
        status: 'partial',
      },
      diff: {
        data: { additions: 524, deletions: 353, filesChanged: 18 },
        status: 'ready',
      },
      reviewThreads: {
        data: { resolvedOrOutdated: 1, total: 1, unresolved: 0 },
        status: 'ready',
      },
    });
    const expectedUrls = [
      'https://github.com/octo/demo/pull/42',
      'https://github.com/octo/demo/pull/42/files',
      'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42',
    ];
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Set(fetcher.mock.calls.map(([url]) => String(url)))).toEqual(new Set(expectedUrls));
    for (const [url, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        credentials: 'same-origin',
        method: 'GET',
        redirect: String(url) === expectedUrls[2] ? 'error' : 'follow',
      });
    }
  });

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

  it('accepts only canonical same-PR focused and legacy timeline URLs', () => {
    expect(isAllowedPullRequestUrl('/octo/demo/pull/42', identity, 'conversation')).toBe(true);
    expect(isAllowedPullRequestUrl('https://github.com/octo/demo/pull/42/files', identity, 'files')).toBe(true);
    expect(isAllowedPullRequestUrl('https://github.com/octo/demo/pull/42/changes', identity, 'files')).toBe(true);
    for (const candidate of [
      'https://github.com/octo/demo/pull/42/changes?diff=split',
      'https://github.com/octo/demo/pull/42/changes#diff',
      'https://github.com/octo/demo/pull/43/changes',
      'https://github.com/other/demo/pull/42/changes',
      'https://evil.test/octo/demo/pull/42/changes',
    ]) {
      expect(isAllowedPullRequestUrl(candidate, identity, 'files')).toBe(false);
    }
    expect(isAllowedPullRequestUrl(
      'octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42',
      identity,
      'fragment',
    )).toBe(true);
    expect(isAllowedPullRequestUrl(
      'octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&before_cursor=Cursor%2BZero&id=PR_current42',
      identity,
      'fragment',
    )).toBe(true);
    expect(isAllowedPullRequestUrl(
      '/octo/demo/pull/42/timeline?after=CaseSensitiveToken',
      identity,
      'fragment',
    )).toBe(true);

    for (const candidate of [
      'https://api.github.com/repos/octo/demo/pulls/42',
      'https://github.com.evil.test/octo/demo/pull/42',
      'https://github.com/other/demo/pull/42',
      'https://github.com/octo/demo/pull/43',
      'https://user:secret@github.com/octo/demo/pull/42',
      'https://github.com:444/octo/demo/pull/42',
      'javascript:alert(1)',
      'data:text/html,nope',
      '//evil.test/octo/demo/pull/42',
      '/octo/demo/pull/42/merge',
      '/octo%2fdemo/pull/42/timeline?after=cursor',
      '/octo/demo/pull/%2e%2e/timeline?after=cursor',
      '/octo\\demo/pull/42/timeline?after=cursor',
      '/octo/demo/pull/./42/timeline?after=cursor',
      '/octo/demo/pull/42/../42/timeline?after=cursor',
      '//github.com/octo/demo/pull/42/timeline?after=cursor',
      '/octo/demo/issues/42',
      '/other/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo/other/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo/demo/pull/42/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo/demo/timeline_focused_item?after_cursor=cursor',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42&id=PR_other',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&id=not-a-pr-node',
      '/octo/demo/timeline_focused_item?id=PR_current42',
      '/octo/demo/timeline_focused_item?after_cursor=one&after_cursor=two&id=PR_current42',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&before_cursor=&id=PR_current42',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&before_cursor=one&before_cursor=two&id=PR_current42',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42&source=fragment',
      'https://user:secret@github.com/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      'https://github.com:444/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      'https://evil.test/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '//github.com/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo/demo/../demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo\\demo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo%2fdemo/timeline_focused_item?after_cursor=cursor&id=PR_current42',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42#fragment',
      '/octo/demo/timeline_focused_item?after_cursor=cursor&id=PR_current42#',
      '/octo/demo/pull/42/timeline',
      '/octo/demo/pull/42/timeline?after=',
      '/octo/demo/pull/42/timeline?after=cursor#',
      '/octo/demo/pull/42/timeline?after=cursor&after_cursor=other',
      '/octo/demo/pull/42/timeline?after=cursor&source=fragment',
    ]) {
      expect(isAllowedPullRequestUrl(candidate, identity, 'fragment')).toBe(false);
    }
  });

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

  it('follows the same-PR files redirect to changes and parses the diff', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      expect(init).toMatchObject({
        credentials: 'same-origin',
        method: 'GET',
        redirect: 'follow',
      });
      return value.endsWith('/files')
        ? response(currentChangesHtml, 'https://github.com/octo/demo/pull/42/changes')
        : response('<div id="discussion_bucket"></div>', value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(fetcher).toHaveBeenCalledWith(
      'https://github.com/octo/demo/pull/42/files',
      expect.objectContaining({ redirect: 'follow' }),
    );
    expect(summary.diff).toEqual({
      data: { additions: 584, deletions: 174, filesChanged: 14 },
      status: 'ready',
    });
  });

  it('rejects a followed files redirect to GitHub login', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      return value.endsWith('/files')
        ? response(currentFilesHtml, 'https://github.com/login?return_to=%2Focto%2Fdemo%2Fpull%2F42%2Ffiles')
        : response('<div id="discussion_bucket"></div>', value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.diff).toEqual({
      message: 'GitHub redirected to an untrusted URL.',
      status: 'error',
    });
    expect(summary.reviewThreads.status).toBe('ready');
    expect(summary.agents.status).toBe('ready');
  });

  it('follows a focused timeline fragment with its original cursor encoding and rejects an ID mismatch', async () => {
    const mismatchedNextFragment = `${currentTimelineFragmentHtml}<div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/timeline_focused_item?after_cursor=Later&id=PR_other"></div>`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(currentFilesHtml, value);
      if (value === 'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42') {
        return response(mismatchedNextFragment, value);
      }
      return response(currentConversationHtml, value);
    });

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(fetcher).toHaveBeenCalledWith(
      'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42',
      expect.objectContaining({
        credentials: 'same-origin',
        method: 'GET',
        redirect: 'error',
      }),
    );
    expect(fetcher).not.toHaveBeenCalledWith(
      'https://github.com/octo/demo/timeline_focused_item?after_cursor=Later&id=PR_other',
      expect.anything(),
    );
    expect(result.reviewThreads).toMatchObject({
      reason: expect.stringContaining('GitHub exposed an invalid timeline fragment.'),
      status: 'partial',
    });
    expect(result.agents).toMatchObject({
      reason: expect.stringContaining('GitHub exposed an invalid timeline fragment.'),
      status: 'partial',
    });
  });

  it('rejects a fragment response whose final URL changes the focused pull-request ID', async () => {
    const fragmentUrl = 'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42';
    const conversation = `<div id="discussion_bucket"></div>
      <div id="js-timeline-progressive-loader"
           data-timeline-item-src="/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&amp;id=PR_current42"></div>`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value === fragmentUrl) {
        return response(
          currentTimelineFragmentHtml,
          'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_other',
        );
      }
      return response(conversation, value);
    });

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads).toMatchObject({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      reason: expect.stringContaining('GitHub redirected to an untrusted URL.'),
      status: 'partial',
    });
    expect(result.agents).toMatchObject({
      data: [],
      reason: expect.stringContaining('GitHub redirected to an untrusted URL.'),
      status: 'partial',
    });
  });

  it('rejects a fragment response without a final URL', async () => {
    const fragmentUrl = 'https://github.com/octo/demo/pull/42/timeline?after=next';
    const conversation = `<div id="discussion_bucket"></div>
      <div id="js-timeline-progressive-loader"
           data-timeline-item-src="/octo/demo/pull/42/timeline?after=next"></div>`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value === fragmentUrl) return response(currentTimelineFragmentHtml, '');
      return response(conversation, value);
    });

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads).toMatchObject({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      reason: expect.stringContaining('GitHub redirected to an untrusted URL.'),
      status: 'partial',
    });
    expect(result.agents).toMatchObject({
      data: [],
      reason: expect.stringContaining('GitHub redirected to an untrusted URL.'),
      status: 'partial',
    });
  });

  it('keeps a typed automated-comment fragment complete and aggregates its Copilot response', async () => {
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=automated-comment"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value.includes('after=automated-comment')) return response(currentAutomatedCommentHtml, value);
      return response(conversation, value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.reviewThreads).toEqual({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      status: 'ready',
    });
    expect(summary.agents).toEqual({
      data: [{
        agentId: 'copilot',
        requestSources: [],
        responseCount: 1,
        state: 'responded',
      }],
      status: 'ready',
    });
  });

  it('keeps a phrase-based review event fragment complete and aggregates its Copilot request state', async () => {
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=started-reviewing"></div>';
    const eventFragment = '<div class="TimelineItem" id="event-201"><strong>Copilot</strong> started reviewing</div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value.includes('after=started-reviewing')) return response(eventFragment, value);
      return response(conversation, value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.reviewThreads).toEqual({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      status: 'ready',
    });
    expect(summary.agents).toEqual({
      data: [{
        agentId: 'copilot',
        requestSources: ['started-reviewing'],
        responseCount: 0,
        state: 'requested',
      }],
      status: 'ready',
    });
  });

  it('keeps an unrelated event-only fragment structurally partial instead of exact ready zeroes', async () => {
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=commit"></div>';
    const eventFragment = '<div class="TimelineItem" id="event-commit">someone committed</div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value.includes('after=commit')) return response(eventFragment, value);
      return response(conversation, value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.reviewThreads).toEqual({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      reason: 'A timeline fragment had no recognizable review data.',
      status: 'partial',
    });
    expect(summary.agents).toEqual({
      data: [],
      reason: 'A timeline fragment had no recognizable review data.',
      status: 'partial',
    });
  });

  it('uses a credentialed GET with the caller abort signal and rejects redirected cross-origin content', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ credentials: 'same-origin', method: 'GET', redirect: 'follow', signal });
      return response(timelineHtml, 'https://evil.test/octo/demo/pull/42');
    });

    const result = await clientFor(fetcher).loadPullRequest(identity, { signal });

    expect(fetcher).toHaveBeenCalled();
    expect(result.reviewThreads.status).toBe('error');
    expect(result.agents.status).toBe('error');
  });

  it('does not fetch rejected dot-segment or protocol-relative timeline loaders', async () => {
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/./42/timeline?after=one"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="//github.com/octo/demo/pull/42/timeline?after=two"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : conversation, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.reviewThreads.status).toBe('partial');
  });

  it('accepts a public conversation containing a sign-in header and discussion text about access denial', async () => {
    const publicConversation = '<a href="/login">Sign in</a><div id="discussion_bucket"></div><article id="issuecomment-1">The deploy says access denied, but the PR is public.</article>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : publicConversation, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads.status).toBe('ready');
    expect(result.agents.status).toBe('ready');
  });

  it('rejects a real GitHub session login page', async () => {
    const loginPage = '<title>Sign in to GitHub · GitHub</title><form action="/session"><input name="login"></form>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : loginPage, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads.status).toBe('error');
    expect(result.agents.status).toBe('error');
  });

  it('follows each timeline fragment once, avoids cycles, and merges duplicate threads from all sources', async () => {
    const first = `${timelineHtml}<div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=cycle"></div>`;
    const fragment = `<div class="js-resolvable-timeline-thread-container" data-resolved="false"><input name="pull_request_review_thread_id" value="PRRT_active"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=cycle"></div>`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value.includes('after=cursor')) return response(fragment, value);
      if (value.includes('after=cycle')) return response(fragment, value);
      return response(first, value);
    });

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('after=cycle'))).toHaveLength(1);
    expect(result.reviewThreads).toMatchObject({ status: 'ready', data: { total: 8 } });
    expect(result.agents).toMatchObject({ status: 'ready' });
  });

  it('deduplicates case-variant fragment paths without changing opaque query values', async () => {
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=CaseSensitiveToken"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/OCTO/DEMO/PULL/42/TIMELINE?after=CaseSensitiveToken"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(diffAggregateHtml, value);
      if (value.includes('CaseSensitiveToken')) return response('<div id="discussion_bucket"></div>', value);
      return response(conversation, value);
    });

    await clientFor(fetcher).loadPullRequest(identity);

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('CaseSensitiveToken'))).toHaveLength(1);
  });

  it('marks thread and agent counts partial when the fragment cap is reached', async () => {
    const loaders = Array.from({ length: 21 }, (_, index) =>
      `<div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=${index}"></div>`,
    ).join('');
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      return response(value.endsWith('/files') ? diffAggregateHtml : loaders, value);
    });

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/timeline?'))).toHaveLength(20);
    expect(result.reviewThreads).toMatchObject({ status: 'partial', data: { total: 0 } });
    expect(result.agents.status).toBe('partial');
  });

  it('caches a capped structural partial for the normal TTL', async () => {
    const loaders = Array.from({ length: 21 }, (_, index) =>
      `<div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=${index}"></div>`,
    ).join('');
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      return response(value.endsWith('/files') ? diffAggregateHtml : loaders, value);
    });
    const client = clientFor(fetcher);

    expect((await client.loadPullRequest(identity)).reviewThreads.status).toBe('partial');
    expect((await client.loadPullRequest(identity)).reviewThreads.status).toBe('partial');

    expect(fetcher).toHaveBeenCalledTimes(22);
  });

  it('keeps accumulated conversation data as partial when a timeline fragment or files page fails', async () => {
    const conversation = '<div class="js-resolvable-timeline-thread-container" data-resolved="false"><input name="pull_request_review_thread_id" value="PRRT_one"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=next"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files') || value.includes('after=next')) return failed();
      return response(conversation, value);
    });

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.diff.status).toBe('error');
    expect(result.reviewThreads).toMatchObject({ status: 'partial', data: { total: 1 } });
    expect(result.agents.status).toBe('partial');
  });

  it('keeps timeline-derived sections isolated when the files extractor is incomplete', async () => {
    const conversation = '<div id="discussion_bucket"></div><div class="js-resolvable-timeline-thread-container" data-resolved="false"><input name="pull_request_review_thread_id" value="PRRT_one"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffRenderedPartialHtml : conversation, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.diff.status).toBe('partial');
    expect(result.reviewThreads).toMatchObject({ data: { total: 1 }, status: 'ready' });
    expect(result.agents.status).toBe('ready');
  });

  it('keeps timeline data ready while hidden file fragments leave the diffstat exact', async () => {
    const conversation = '<div id="discussion_bucket"></div><div class="js-resolvable-timeline-thread-container" data-resolved="false"><input name="pull_request_review_thread_id" value="PRRT_one"></div>';
    const filesWithHiddenReviews = `${diffAggregateHtml}<include-fragment data-fragment-url="/octo/demo/pull/42/files?fragment=hidden"></include-fragment>`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? filesWithHiddenReviews : conversation, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.diff).toMatchObject({ data: { filesChanged: 3 }, status: 'ready' });
    expect(result.reviewThreads).toMatchObject({ data: { total: 1 }, status: 'ready' });
    expect(result.agents.status).toBe('ready');
  });

  it('keeps files-page fragments isolated from timeline completeness', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(currentFilesHtml, value);
      if (value.includes('timeline_focused_item')) return response(currentTimelineFragmentHtml, value);
      return response(currentConversationHtml, value);
    });

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.diff.status).toBe('ready');
    expect(summary.reviewThreads.status).toBe('ready');
    expect(summary.agents.status).toBe('partial');
  });

  it('caches structural partials for the normal TTL', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/files')) return response(currentFilesHtml, value);
      if (value.includes('timeline_focused_item')) return response(currentTimelineFragmentHtml, value);
      return response(currentConversationHtml, value);
    });
    const client = clientFor(fetcher);

    await client.loadPullRequest(identity);
    await client.loadPullRequest(identity);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not cache a result containing a failed timeline fragment', async () => {
    const conversation = '<div id="discussion_bucket"></div><div id="js-timeline-progressive-loader" data-timeline-item-src="/octo/demo/pull/42/timeline?after=retry"></div>';
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.includes('after=retry')) return failed();
      return response(value.endsWith('/files') ? diffAggregateHtml : conversation, value);
    });
    const client = clientFor(fetcher);

    await client.loadPullRequest(identity);
    await client.loadPullRequest(identity);

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('after=retry'))).toHaveLength(2);
  });

  it('leaves timeline sections ready when a files fetch failure produces only diff error', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/files') ? failed() : response('<div id="discussion_bucket"></div>', String(url)),
    );

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.diff.status).toBe('error');
    expect(summary.reviewThreads.status).toBe('ready');
    expect(summary.agents.status).toBe('ready');
  });

  it('keeps files-page review artifacts out of agent aggregation', async () => {
    const filesWithFakeReview = `${diffAggregateHtml}<div id="pullrequestreview-999"><a href="/apps/copilot-pull-request-reviewer">Copilot</a></div>`;
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? filesWithFakeReview : '<div id="discussion_bucket"></div>', String(url)),
    );

    const summary = await clientFor(fetcher).loadPullRequest(identity);

    expect(summary.agents).toEqual({ data: [], status: 'ready' });
  });

  it('returns only timeline-section errors for a conversation failure while keeping diff independent', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/files') ? response(diffAggregateHtml, String(url)) : failed(),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads.status).toBe('error');
    expect(result.agents.status).toBe('error');
    expect(result.diff).toMatchObject({ status: 'ready', data: { filesChanged: 3 } });
  });

  it('uses current formal requests and response precedence without adding a total-comment aggregate', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : timelineHtml, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result).not.toHaveProperty('totalComments');
    expect(result.agents).toMatchObject({
      status: 'ready',
      data: expect.arrayContaining([
        expect.objectContaining({ agentId: 'coderabbit', state: 'requested' }),
        expect.objectContaining({ agentId: 'claude', responseCount: 1, state: 'responded' }),
      ]),
    });
  });

  it('omits a formally requested reviewer when their final timeline event removes the request', async () => {
    const emptyConversation = `
      <div id="discussion_bucket"></div>
      <div data-review-request-action="requested" data-review-requested-login="coderabbitai" data-gid="request-1"></div>
      <div data-review-request-action="removed" data-review-requested-login="coderabbitai" data-gid="request-2"></div>
    `;
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : emptyConversation, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.agents).toEqual({ data: [], status: 'ready' });
  });

  it('returns an exact zero thread/agent result for an empty but recognizable conversation page', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : '<div id="discussion_bucket"></div>', String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads).toEqual({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      status: 'ready',
    });
    expect(result.agents).toEqual({ data: [], status: 'ready' });
  });

  it('reports an identifiable thread with unreadable state as partial instead of exact zero', async () => {
    const conversation = `
      <div id="discussion_bucket"></div>
      <div class="js-resolvable-timeline-thread-container" data-review-thread-id="PRRT_unknown"></div>
    `;
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : conversation, String(url)),
    );

    const result = await clientFor(fetcher).loadPullRequest(identity);

    expect(result.reviewThreads).toEqual({
      data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 },
      reason: 'A resolvable review thread had unreadable resolution or outdated state.',
      status: 'partial',
    });
  });

  it('does not start an already-aborted queued fetch and forwards aborts to active work', async () => {
    const limiter = createFetchLimiter(1);
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => { await active; return response(timelineHtml); });
    const blockedClient = clientFor(fetcher, { limiter });
    const first = blockedClient.loadPullRequest(identity);
    const controller = new AbortController();
    const second = blockedClient.loadPullRequest({ ...identity, number: 43 }, { signal: controller.signal });
    controller.abort();
    release();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await first;
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/pull/43'))).toHaveLength(0);
  });

  it('aborts active fetches through the caller signal without caching the aborted load', async () => {
    const controller = new AbortController();
    let allowSuccess = false;
    const fetcher = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (allowSuccess) return Promise.resolve(response(String(url).endsWith('/files') ? diffAggregateHtml : timelineHtml.replace(/<div id="js-timeline-progressive-loader"[\s\S]*?<\/div>/, ''), String(url)));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const client = clientFor(fetcher);
    const pending = client.loadPullRequest(identity, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalled();
    allowSuccess = true;
    await client.loadPullRequest(identity);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('releases an aborted active limiter slot so queued work proceeds without exceeding the cap', async () => {
    const limiter = createFetchLimiter(1);
    const controller = new AbortController();
    let active = 0;
    let maximum = 0;
    const first = limiter.run(controller.signal, () => new Promise<never>((_resolve, reject) => {
      active += 1;
      maximum = Math.max(maximum, active);
      controller.signal.addEventListener('abort', () => {
        active -= 1;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
    const second = limiter.run(undefined, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
      return 'queued work';
    });

    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBe('queued work');
    expect(maximum).toBe(1);
  });

  it('does not cache a completed load when its caller aborts before the responses settle', async () => {
    const controller = new AbortController();
    let delayed = true;
    const resolvers = new Map<string, (value: Response) => void>();
    const noFragments = '<div id="discussion_bucket"></div>';
    const fetcher = vi.fn((url: RequestInfo | URL) => {
      const value = String(url);
      if (!delayed) return Promise.resolve(response(value.endsWith('/files') ? diffAggregateHtml : noFragments, value));
      return new Promise<Response>((resolve) => resolvers.set(value, resolve));
    });
    const client = clientFor(fetcher);
    const pending = client.loadPullRequest(identity, { signal: controller.signal });

    await Promise.resolve();
    controller.abort();
    resolvers.get('https://github.com/octo/demo/pull/42')?.(response(noFragments, 'https://github.com/octo/demo/pull/42'));
    resolvers.get('https://github.com/octo/demo/pull/42/files')?.(response(diffAggregateHtml, 'https://github.com/octo/demo/pull/42/files'));
    await pending;
    delayed = false;
    await client.loadPullRequest(identity);

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('never exceeds four active fetches across concurrent PR loads', async () => {
    let active = 0;
    let maximum = 0;
    const fetcher = async (url: RequestInfo | URL) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return response(String(url).endsWith('/files') ? diffAggregateHtml : timelineHtml, String(url));
    };
    const client = clientFor(fetcher, { limiter: createFetchLimiter(4) });

    await Promise.all(Array.from({ length: 5 }, (_, index) => client.loadPullRequest({ ...identity, number: index + 1 })));

    expect(maximum).toBe(4);
  });

  it('reuses only unexpired per-PR completed summaries and never caches aborts', async () => {
    let now = 0;
    const noFragments = timelineHtml.replace(/<div id="js-timeline-progressive-loader"[\s\S]*?<\/div>/, '');
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).endsWith('/files') ? diffAggregateHtml : noFragments, String(url)),
    );
    const client = clientFor(fetcher, { clock: () => now });

    await client.loadPullRequest(identity);
    await client.loadPullRequest({ number: 42, owner: 'OCTO', repository: 'DEMO' });
    await client.loadPullRequest({ ...identity, number: 43 });
    now = 60_000;
    await client.loadPullRequest(identity);

    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('does not cache a transient request failure', async () => {
    let fail = true;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (!value.endsWith('/files') && fail) return failed();
      return response(value.endsWith('/files') ? diffAggregateHtml : timelineHtml.replace(/<div id="js-timeline-progressive-loader"[\s\S]*?<\/div>/, ''), value);
    });
    const client = clientFor(fetcher);

    expect((await client.loadPullRequest(identity)).reviewThreads.status).toBe('error');
    fail = false;
    expect((await client.loadPullRequest(identity)).reviewThreads.status).toBe('ready');

    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
