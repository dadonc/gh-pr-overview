import { describe, expect, it, vi } from 'vitest';

import diffAggregateHtml from '../test/fixtures/github/diff-aggregate.html?raw';
import timelineHtml from '../test/fixtures/github/timeline.html?raw';
import {
  createFetchLimiter,
  createGitHubClient,
  isAllowedPullRequestUrl,
} from './github-client';

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

const failed = (status = 500) => ({
  headers: new Headers({ 'content-type': 'text/html' }),
  ok: false,
  status,
  text: async () => '',
  url: 'https://github.com/octo/demo/pull/42',
}) as Response;

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
  it('accepts only canonical same-PR GitHub conversation, files, and timeline URLs', () => {
    expect(isAllowedPullRequestUrl('/octo/demo/pull/42', identity, 'conversation')).toBe(true);
    expect(isAllowedPullRequestUrl('https://github.com/octo/demo/pull/42/files', identity, 'files')).toBe(true);
    expect(isAllowedPullRequestUrl('/octo/demo/pull/42/timeline?after=cursor', identity, 'fragment')).toBe(true);
    expect(isAllowedPullRequestUrl('/octo/demo/pull/42/timeline?after_cursor=opaque&source=fragment', identity, 'fragment')).toBe(true);

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
      '/octo/demo/issues/42',
    ]) {
      expect(isAllowedPullRequestUrl(candidate, identity, 'fragment')).toBe(false);
    }
  });

  it('uses a credentialed GET with the caller abort signal and rejects redirected cross-origin content', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ credentials: 'same-origin', method: 'GET', redirect: 'error', signal });
      return response(timelineHtml, 'https://evil.test/octo/demo/pull/42');
    });

    const result = await clientFor(fetcher).loadPullRequest(identity, signal);

    expect(fetcher).toHaveBeenCalled();
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

  it('returns a conversation error without blocking the independent diff load', async () => {
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

  it('does not start an already-aborted queued fetch and forwards aborts to active work', async () => {
    const limiter = createFetchLimiter(1);
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => { await active; return response(timelineHtml); });
    const blockedClient = clientFor(fetcher, { limiter });
    const first = blockedClient.loadPullRequest(identity);
    const controller = new AbortController();
    const second = blockedClient.loadPullRequest({ ...identity, number: 43 }, controller.signal);
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
    const pending = client.loadPullRequest(identity, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalled();
    allowSuccess = true;
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
    now = 60_001;
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
