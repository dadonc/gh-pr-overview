import { describe, expect, it, vi } from 'vitest';

import type { PullRequestRemoteSummary } from './github-client';
import { createPageReconciler, isPullRequestListRoute, type ObserverConstructor } from './pr-reconciler';

const remote: PullRequestRemoteSummary = {
  agents: { data: [], status: 'ready' },
  diff: { data: { additions: 4, deletions: 1, filesChanged: 2 }, status: 'ready' },
  reviewThreads: { data: { resolvedOrOutdated: 1, total: 2, unresolved: 1 }, status: 'ready' },
};

function page(body: string, url = 'https://github.com/octo/demo/pulls') {
  document.head.innerHTML = '<meta name="user-login" content="octo-author">';
  document.body.innerHTML = body;
  window.history.replaceState({}, '', new URL(url).pathname);
  return document;
}

function row(number = 42, counter = '<a class="comments-link" aria-label="23 comments" href="/octo/demo/pull/42#issuecomment-23">23</a>') {
  return `<div id="issue_${number}" class="js-issue-row"><a class="Link--primary" href="/octo/demo/pull/${number}">A realistic pull request</a><span class="opened-by"><a data-hovercard-type="user">octo-author</a></span><span class="comment-area">${counter}</span></div>`;
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: (entries: IntersectionObserverEntry[]) => void) { FakeObserver.instances.push(this); }
  fire(target: Element, isIntersecting = true) { this.callback([{ isIntersecting, target } as IntersectionObserverEntry]); }
}

const Observer = FakeObserver as unknown as ObserverConstructor;

describe('page reconciler', () => {
  it('only accepts an exact repository pulls route with query or trailing slash', () => {
    expect(isPullRequestListRoute(new URL('https://github.com/o/r/pulls'))).toBe(true);
    expect(isPullRequestListRoute(new URL('https://github.com/o/r/pulls/?q=open'))).toBe(true);
    expect(isPullRequestListRoute(new URL('https://github.com/o/r/pulls/42'))).toBe(false);
    expect(isPullRequestListRoute(new URL('https://github.com/o/r/issues'))).toBe(false);
  });

  it('hides the native counter while mounting its value, restores it exactly on teardown, and restores authored accent', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    document.querySelector('#issue_42')!.setAttribute('data-pr-overview-authored', 'github-original');
    native.hidden = false; native.setAttribute('aria-hidden', 'false'); native.setAttribute('tabindex', '0');
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mounts: Array<{ remove: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }> = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: Observer, uiFactory: { mount(_anchor, props) { expect(props.summary.totalComments).toEqual({ data: { count: 23, href: '/octo/demo/pull/42#issuecomment-23' }, status: 'ready' }); const mount = { remove: vi.fn(), update: vi.fn() }; mounts.push(mount); return mount; } } });

    reconciler.reconcile();
    FakeObserver.instances.at(-1)!.fire(document.querySelector('#issue_42')!);
    await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledOnce());
    expect(native.hidden).toBe(true);
    expect(native.getAttribute('aria-hidden')).toBe('true');
    expect(native.getAttribute('tabindex')).toBe('-1');
    expect(document.querySelector('#issue_42')!.getAttribute('data-pr-overview-authored')).toBe('true');

    reconciler.cleanup();
    expect(native.hidden).toBe(false);
    expect(native.getAttribute('aria-hidden')).toBe('false');
    expect(native.getAttribute('tabindex')).toBe('0');
    expect(document.querySelector('#issue_42')!.getAttribute('data-pr-overview-authored')).toBe('github-original');
    expect(mounts[0]!.remove).toHaveBeenCalledOnce();
  });

  it('keeps a pull title mentioning comments visible and anchors the card at the real numeric counter', async () => {
    const document = page(row(45, '<a aria-label="23 comments" href="/octo/demo/pull/45#issuecomment-23">23</a>').replace('A realistic pull request', 'Fix comments parsing'));
    const title = document.querySelector<HTMLAnchorElement>('.Link--primary')!;
    const counter = document.querySelector<HTMLAnchorElement>('[aria-label="23 comments"]')!;
    let mountedAt: Element | undefined;
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(anchor) { mountedAt = anchor; return { remove: vi.fn(), update: vi.fn() }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    expect(title.hidden).toBe(false);
    expect(counter.hidden).toBe(true);
    expect(mountedAt).toBe(counter);
  });

  it('hides an aria-labeled malformed counter even when GitHub omitted its href', async () => {
    const document = page(row(46, '<a class="comments-link" aria-label="many comments">many</a>'));
    const malformed = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let initial: any;
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(anchor, props) { initial = { anchor, props }; return { remove: vi.fn(), update: vi.fn() }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    expect(initial.anchor).toBe(malformed);
    expect(initial.props.summary.totalComments).toEqual({ message: 'GitHub comment counter is malformed.', status: 'error' });
    expect(malformed.hidden).toBe(true);
  });

  it('does not hide native UI until an async replacement mounts and restores state after mount failures or disposal races', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let resolve!: (mount: { remove(): void; update(): void }) => void;
    const deferred = new Promise<{ remove(): void; update(): void }>((done) => { resolve = done; });
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { return deferred; } } });
    reconciler.reconcile();
    expect(native.hidden).toBe(false);
    const remove = vi.fn(); resolve({ remove, update: vi.fn() });
    await Promise.resolve();
    expect(native.hidden).toBe(true);
    reconciler.cleanup();
    expect(native.hidden).toBe(false);
    expect(remove).toHaveBeenCalledOnce();

    const failed = page(row());
    const failedNative = failed.querySelector<HTMLAnchorElement>('.comments-link')!;
    createPageReconciler({ document: failed, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { throw new Error('mount failed'); } } }).reconcile();
    await Promise.resolve();
    expect(failedNative.hidden).toBe(false);

    const rejected = page(row());
    const rejectedNative = rejected.querySelector<HTMLAnchorElement>('.comments-link')!;
    let reject!: (reason: Error) => void;
    const rejectMount = new Promise<{ remove(): void; update(): void }>((_resolve, fail) => { reject = fail; });
    createPageReconciler({ document: rejected, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { return rejectMount; } } }).reconcile();
    reject(new Error('async mount failed'));
    await Promise.resolve(); await Promise.resolve();
    expect(rejectedNative.hidden).toBe(false);

    const racing = page(row());
    const racingNative = racing.querySelector<HTMLAnchorElement>('.comments-link')!;
    let resolveRace!: (mount: { remove(): void; update(): void }) => void;
    const race = new Promise<{ remove(): void; update(): void }>((done) => { resolveRace = done; });
    const raceRemove = vi.fn();
    const raceReconciler = createPageReconciler({ document: racing, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { return race; } } });
    raceReconciler.reconcile(); raceReconciler.cleanup(); resolveRace({ remove: raceRemove, update: vi.fn() });
    await Promise.resolve();
    expect(racingNative.hidden).toBe(false);
    expect(raceRemove).toHaveBeenCalledOnce();
  });

  it('creates and removes a zero-count anchor and remounts when GitHub replaces it', () => {
    const document = page(row(43, ''));
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mounted: Element[] = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount(anchor) { mounted.push(anchor); return { remove: vi.fn(), update: vi.fn() }; } } });

    reconciler.reconcile();
    const extensionAnchor = document.querySelector('[data-pr-overview-zero-anchor]')!;
    expect(extensionAnchor).toBeTruthy();
    expect(mounted).toEqual([extensionAnchor]);
    extensionAnchor.replaceWith(Object.assign(document.createElement('a'), { href: '/octo/demo/pull/43#comments', ariaLabel: '1 comment' }));
    reconciler.reconcile();
    expect(mounted).toHaveLength(2);
    reconciler.cleanup();
    expect(document.querySelector('[data-pr-overview-zero-anchor]')).toBeNull();
  });

  it('reparses malformed and dynamic native counters without retaining a stale total', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    const updates: unknown[] = [];
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { updates.push(props.summary.totalComments); return { remove: vi.fn(), update(next) { updates.push(next.summary.totalComments); } }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    native.setAttribute('aria-label', 'many comments');
    reconciler.reconcile();
    await Promise.resolve();
    native.setAttribute('aria-label', '24 comments');
    reconciler.reconcile();

    expect(updates).toContainEqual({ message: 'GitHub comment counter is malformed.', status: 'error' });
    expect(updates).toContainEqual({ data: { count: 24, href: '/octo/demo/pull/42#issuecomment-23' }, status: 'ready' });
  });

  it('keeps ready remote sections when a native counter changes', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    const latest: any[] = [];
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { latest.push(props); return { remove: vi.fn(), update(next) { latest.push(next); } }; } } });
    reconciler.reconcile();
    await vi.waitFor(() => expect(latest.some((item) => item.summary.reviewThreads.status === 'ready')).toBe(true));
    native.setAttribute('aria-label', '24 comments');
    reconciler.reconcile();

    expect(latest.at(-1)!.summary.totalComments).toEqual({ data: { count: 24, href: '/octo/demo/pull/42#issuecomment-23' }, status: 'ready' });
    expect(latest.at(-1)!.summary.reviewThreads).toEqual(remote.reviewThreads);
  });

  it('automatically mounts inserted rows, disposes removed rows, and never remounts from a queued mutation after cleanup', async () => {
    const document = page(row());
    const removed = vi.fn();
    const mount = vi.fn(() => ({ remove: removed, update: vi.fn() }));
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount } });
    reconciler.reconcile();
    const added = document.createElement('div'); added.innerHTML = row(44); const newRow = added.firstElementChild!; document.body.append(newRow);
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    newRow.remove();
    await vi.waitFor(() => expect(removed).toHaveBeenCalled());
    document.body.append(document.createElement('div'));
    reconciler.cleanup();
    await Promise.resolve();
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it('automatically remounts a reused row after GitHub changes its pull href and updates native labels', async () => {
    const document = page(row());
    const calls: AbortSignal[] = [];
    const client = { loadPullRequest: vi.fn((_identity, signal?: AbortSignal) => { calls.push(signal!); return new Promise<PullRequestRemoteSummary>(() => {}); }) };
    const updates: any[] = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { updates.push(props); return { remove: vi.fn(), update(next) { updates.push(next); } }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    const title = document.querySelector<HTMLAnchorElement>('.Link--primary')!;
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    title.setAttribute('href', '/octo/demo/pull/43'); counter.setAttribute('href', '/octo/demo/pull/43#comments'); counter.setAttribute('aria-label', 'many comments');
    await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledTimes(2));
    expect(calls[0]!.aborted).toBe(true);
    expect(updates.some((entry) => entry.summary.totalComments.status === 'error')).toBe(true);
  });

  it('automatically propagates malformed and repaired native aria labels without an explicit reconciliation call', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    const totals: any[] = [];
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { totals.push(props.summary.totalComments); return { remove: vi.fn(), update(next) { totals.push(next.summary.totalComments); } }; } } });
    reconciler.reconcile(); await Promise.resolve();
    native.setAttribute('aria-label', 'many comments');
    await vi.waitFor(() => expect(totals).toContainEqual({ message: 'GitHub comment counter is malformed.', status: 'error' }));
    native.setAttribute('aria-label', '24 comments');
    await vi.waitFor(() => expect(totals).toContainEqual({ data: { count: 24, href: '/octo/demo/pull/42#issuecomment-23' }, status: 'ready' }));
  });

  it('reconciles inserted and removed rows idempotently, falls back to immediate loads, and ignores stale aborted results', async () => {
    const document = page(row());
    let resolve!: (value: PullRequestRemoteSummary) => void;
    const pending = new Promise<PullRequestRemoteSummary>((done) => { resolve = done; });
    const client = { loadPullRequest: vi.fn(() => pending) };
    const updates: unknown[] = [];
    const mount = vi.fn((_anchor: Element, props: any) => { updates.push(props); return { remove: vi.fn(), update(next: any) { updates.push(next); } }; });
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });
    reconciler.reconcile(); reconciler.reconcile();
    expect(mount).toHaveBeenCalledTimes(1);
    const added = document.createElement('div'); added.innerHTML = row(44); document.body.append(added.firstElementChild!);
    reconciler.reconcile();
    expect(mount).toHaveBeenCalledTimes(2);
    reconciler.cleanup();
    resolve(remote);
    await Promise.resolve();
    expect(updates.filter((item: any) => item.summary?.reviewThreads?.status === 'ready')).toHaveLength(0);
  });
});
