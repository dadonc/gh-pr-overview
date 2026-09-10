import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PullRequestRemoteSummary } from './github-client';
import { createPageReconciler, type CardProps, type ObserverConstructor, type PullRequestClient } from './pr-reconciler';

function summary(unresolved: number): PullRequestRemoteSummary {
  return {
    agents: { status: 'ready', data: [] },
    diff: { status: 'ready', data: { additions: 2, deletions: 1, filesChanged: 1 } },
    reviewThreads: { status: 'ready', data: { unresolved, total: unresolved, resolvedOrOutdated: 0 } },
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(client: PullRequestClient, IntersectionObserver?: ObserverConstructor, fakeAllTimers = false) {
  if (fakeAllTimers) vi.useFakeTimers();
  else vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.body.innerHTML = '<div id="issue_42" class="js-issue-row"><a class="Link--primary" href="/octo/demo/pull/42">PR</a><span class="opened-by">author</span><span class="comment-area"><a aria-label="2 comments" href="/octo/demo/pull/42#comments">2</a></span></div>';
  window.history.replaceState({}, '', '/octo/demo/pulls');
  let latest!: CardProps;
  const reconciler = createPageReconciler({ document, client, IntersectionObserver, uiFactory: {
    mount(anchor, props) {
      latest = props;
      const host = document.createElement('github-pr-overview');
      anchor.after(host);
      return { isConnected: () => host.isConnected, remove: () => host.remove(), update: props => { latest = props; } };
    },
  } });
  cleanup = () => reconciler.cleanup();
  reconciler.reconcile();
  return { reconciler, latest: () => latest };
}

describe('PR summary revalidation', () => {
  it('refreshes periodically only while visible and removes its timer on cleanup', async () => {
    const client = { loadPullRequest: vi.fn().mockResolvedValueOnce(summary(1)).mockResolvedValue(summary(2)) };
    const page = setup(client, undefined, true);
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(1).reviewThreads));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.latest().summary.reviewThreads).toEqual(summary(2).reviewThreads);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    page.reconciler.cleanup();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes stale data on focus, preserving loaded sections until the update arrives', async () => {
    let resolve!: (value: PullRequestRemoteSummary) => void;
    const client = { loadPullRequest: vi.fn()
      .mockResolvedValueOnce(summary(1))
      .mockImplementationOnce(() => new Promise<PullRequestRemoteSummary>(done => { resolve = done; })) };
    const page = setup(client);
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(1).reviewThreads));
    window.dispatchEvent(new Event('focus'));
    expect(client.loadPullRequest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60_001);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledTimes(2));
    expect(page.latest().refreshing).toBe(true);
    expect(page.latest().summary.reviewThreads).toEqual(summary(1).reviewThreads);
    expect(client.loadPullRequest.mock.calls[1]![1]).toMatchObject({ bypassCache: true });
    resolve(summary(3));
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(3).reviewThreads));
    expect(page.latest().refreshing).toBe(false);
  });

  it('coalesces native count changes during a load into one uncached follow-up', async () => {
    let resolve!: (value: PullRequestRemoteSummary) => void;
    const client = { loadPullRequest: vi.fn()
      .mockImplementationOnce(() => new Promise<PullRequestRemoteSummary>(done => { resolve = done; }))
      .mockResolvedValue(summary(4)) };
    const page = setup(client);
    const counter = document.querySelector('.comment-area a')!;
    counter.setAttribute('aria-label', '3 comments'); counter.textContent = '3';
    page.reconciler.reconcile();
    counter.setAttribute('aria-label', '4 comments'); counter.textContent = '4';
    page.reconciler.reconcile();
    expect(client.loadPullRequest).toHaveBeenCalledTimes(1);
    resolve(summary(1));
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(4).reviewThreads));
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(client.loadPullRequest.mock.calls[1]![1]).toMatchObject({ bypassCache: true });
  });

  it('retries an error explicitly without overlapping duplicate retry clicks', async () => {
    let resolve!: (value: PullRequestRemoteSummary) => void;
    const client = { loadPullRequest: vi.fn()
      .mockResolvedValueOnce({ ...summary(1), diff: { status: 'error', message: 'Timed out' } })
      .mockImplementationOnce(() => new Promise<PullRequestRemoteSummary>(done => { resolve = done; })) };
    const page = setup(client);
    await vi.waitFor(() => expect(page.latest().summary.diff.status).toBe('error'));
    expect(page.latest().onRetry).toBeTypeOf('function');
    page.latest().onRetry!();
    page.latest().onRetry!();
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    resolve(summary(2));
    await vi.waitFor(() => expect(page.latest().summary.diff.status).toBe('ready'));
    expect(page.latest().refreshing).toBe(false);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
  });

  it('discloses a rejected refresh while preserving sections updated during that refresh', async () => {
    const loadPullRequest = vi.fn<PullRequestClient['loadPullRequest']>()
      .mockResolvedValueOnce(summary(1))
      .mockImplementationOnce(async (_identity, options) => {
        options?.onUpdate?.({ kind: 'diff', diff: summary(2).diff });
        throw new Error('GitHub data could not be refreshed.');
      });
    const page = setup({ loadPullRequest });
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(1).reviewThreads));
    vi.setSystemTime(Date.now() + 60_001);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads.status).toBe('error'));
    expect(page.latest().summary.diff).toEqual(summary(2).diff);
    expect(page.latest().refreshing).toBe(false);
  });

  it('waits for offscreen rows to become eligible before refreshing and stops after cleanup', async () => {
    let intersect!: (visible: boolean) => void;
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        intersect = visible => callback([{ target: document.querySelector('#issue_42')!, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {} unobserve() {} disconnect() {}
    }
    const client = { loadPullRequest: vi.fn().mockResolvedValueOnce(summary(1)).mockResolvedValue(summary(2)) };
    const page = setup(client, Observer as unknown as ObserverConstructor);
    intersect(true);
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(1).reviewThreads));
    intersect(false);
    vi.setSystemTime(Date.now() + 60_001);
    window.dispatchEvent(new Event('focus'));
    expect(client.loadPullRequest).toHaveBeenCalledTimes(1);
    intersect(true);
    await vi.waitFor(() => expect(page.latest().summary.reviewThreads).toEqual(summary(2).reviewThreads));
    page.reconciler.cleanup();
    vi.setSystemTime(120_002);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelector('github-pr-overview')).toBeNull();
  });
});
