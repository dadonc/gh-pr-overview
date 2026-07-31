import { describe, expect, it, vi } from 'vitest';

import currentPrListHtml from '../test/fixtures/github/current/pr-list.html?raw';
import type { PullRequestLoadOptions, PullRequestRemoteSummary } from './github-client';
import { createPageReconciler, isPullRequestListRoute, type CardProps, type MountedCard, type ObserverConstructor } from './pr-reconciler';

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

function recognitionRow(counter: string) {
  return `<div id="issue_42" class="js-issue-row"><a class="Link--primary" href="/octo/demo/pull/42">A realistic pull request</a><span class="opened-by"><a data-hovercard-type="user">octo-author</a></span>${counter}</div>`;
}

function snapshotAttributes(element: Element) {
  return {
    ariaHidden: element.getAttribute('aria-hidden'),
    hidden: element.getAttribute('hidden'),
    style: element.getAttribute('style'),
    tabindex: element.getAttribute('tabindex'),
  };
}

function expectSnapshot(element: Element, expected: ReturnType<typeof snapshotAttributes>) {
  expect(snapshotAttributes(element)).toEqual(expected);
}

function createLifecycleCard(anchor: Element) {
  const expectedRow = anchor.closest('[id^="issue_"].js-issue-row');
  const host = anchor.ownerDocument.createElement('github-pr-overview');
  anchor.after(host);
  const remove = vi.fn(() => host.remove());
  const update = vi.fn();
  const mounted: MountedCard = {
    // Mirrors the adapter's row-ownership contract while the marker is connected.
    // Capturing its original row lets marker-only tests exercise the controller's separate exact-marker check.
    isConnected: () => host.isConnected &&
      host.closest('[id^="issue_"].js-issue-row') === expectedRow,
    remove,
    update,
  };
  return { anchor, host, mounted, remove, update };
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

  it('exposes reconciliation and cleanup without a navigation reset API', () => {
    const reconciler = createPageReconciler({
      document: page(row()),
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: { mount() { return { isConnected: () => true, remove: vi.fn(), update: vi.fn() }; } },
    });

    expect(reconciler).toEqual(expect.objectContaining({ cleanup: expect.any(Function), reconcile: expect.any(Function) }));
    expect(reconciler).not.toHaveProperty('reset');
    reconciler.cleanup();
  });

  it('mount marker lives in the current row main content and never in native metadata', async () => {
    const document = page(currentPrListHtml);
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));

    for (const row of document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')) {
      const marker = row.querySelector('[data-pr-overview-mount-anchor]')!;
      expect(marker.parentElement).toBe(row.querySelector('.flex-auto.min-width-0'));
      expect(marker.closest('.hide-sm')).toBeNull();
      expect(row.querySelector('.opened-by')!.contains(marker)).toBe(false);
      expect(marker.getAttribute('aria-hidden')).toBe('true');
    }
    reconciler.cleanup();
  });

  it('places fallback markers in shared visible main content without nesting inside anchors or metadata', async () => {
    const document = page(`
      <div id="issue_42" class="js-issue-row">
        <div class="d-flex position-relative">
          <div class="flex-auto min-width-0 p-2">
            <div class="title-wrap"><a class="Link--primary" href="/octo/demo/pull/42">Nested title</a></div>
            <div class="metadata-wrap"><span class="opened-by">opened by <a data-hovercard-type="user">author</a></span></div>
          </div>
          <div class="hide-sm"><a aria-label="2 comments" href="/octo/demo/pull/42#comments">2</a></div>
        </div>
      </div>
      <div id="issue_43" class="js-issue-row">
        <div class="d-flex position-relative">
          <div class="flex-auto min-width-0 p-2">
            <a class="Link--primary" href="/octo/demo/pull/43">Anchor fallback</a>
            <a class="comment-area" aria-label="3 comments" href="/octo/demo/pull/43#comments">3</a>
          </div>
        </div>
      </div>
    `);
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));

    for (const row of document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')) {
      const marker = row.querySelector('[data-pr-overview-mount-anchor]')!;
      expect(marker.parentElement).toBe(row.querySelector('.flex-auto.min-width-0'));
      expect(marker.closest('.opened-by, .hide-sm, a')).toBeNull();
      expect(row.querySelector('.Link--primary')!.contains(marker)).toBe(false);
      expect(row.querySelector('[aria-label$="comments"]')!.contains(marker)).toBe(false);
    }
    reconciler.cleanup();
  });

  it('does not finish a detached row mount or adopt its remote result', async () => {
    const document = page(row());
    const rowElement = document.querySelector<HTMLElement>('#issue_42')!;
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let resolveRemote!: (value: PullRequestRemoteSummary) => void;
    let resolveMount!: (card: MountedCard) => void;
    const remoteResult = new Promise<PullRequestRemoteSummary>((resolve) => { resolveRemote = resolve; });
    const mountResult = new Promise<MountedCard>((resolve) => { resolveMount = resolve; });
    const remove = vi.fn();
    const update = vi.fn();
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(() => remoteResult) },
      IntersectionObserver: undefined,
      uiFactory: { mount() { return mountResult; } },
    });

    reconciler.reconcile();
    rowElement.remove();
    resolveRemote(remote);
    resolveMount({ isConnected: () => false, remove, update });
    await Promise.resolve();
    await Promise.resolve();

    expect(native.hidden).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    reconciler.cleanup();
  });

  it('zero-to-one adopts a counter without remounting or refetching', async () => {
    const document = page(currentPrListHtml);
    const row = document.querySelector<HTMLElement>('#issue_43')!;
    document.querySelector('#issue_42')!.remove();
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
    const marker = row.querySelector('[data-pr-overview-mount-anchor]')!;
    const counter = document.createElement('a');
    counter.className = 'comments-link';
    counter.setAttribute('aria-label', '1 comment');
    counter.setAttribute('href', '/octo/demo/pull/43#comments');
    counter.setAttribute('hidden', 'github-hidden');
    counter.setAttribute('aria-hidden', 'github-aria');
    counter.setAttribute('tabindex', '7');
    counter.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(counter);
    row.querySelector('.hide-sm')!.append(counter);

    await vi.waitFor(() => expect(counter.getAttribute('aria-hidden')).toBe('true'));
    expect(mount).toHaveBeenCalledOnce();
    expect(client.loadPullRequest).toHaveBeenCalledOnce();
    expect(row.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);
    expect(row.querySelector('[data-pr-overview-mount-anchor]')).toBe(marker);

    reconciler.cleanup();
    expectSnapshot(counter, expected);
  });

  it('one-to-zero restores the departed counter without remounting or refetching', async () => {
    const document = page(currentPrListHtml);
    const row = document.querySelector<HTMLElement>('#issue_42')!;
    document.querySelector('#issue_43')!.remove();
    const counter = row.querySelector<HTMLAnchorElement>('[aria-label="2 comments"]')!;
    counter.setAttribute('hidden', 'github-hidden');
    counter.setAttribute('aria-hidden', 'github-aria');
    counter.setAttribute('tabindex', '7');
    counter.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(counter);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();
    await vi.waitFor(() => expect(counter.getAttribute('aria-hidden')).toBe('true'));
    counter.remove();

    await vi.waitFor(() => expectSnapshot(counter, expected));
    expect(mount).toHaveBeenCalledOnce();
    expect(client.loadPullRequest).toHaveBeenCalledOnce();
    expectSnapshot(counter, expected);
    expect(row.querySelector('[data-pr-overview-mount-anchor]')).toBeTruthy();

    reconciler.cleanup();
    expect(row.querySelector('[data-pr-overview-mount-anchor]')).toBeNull();
  });

  it('malformed-to-ready updates the mounted total without remounting or refetching', async () => {
    const document = page(currentPrListHtml);
    document.querySelector('#issue_43')!.remove();
    const counter = document.querySelector<HTMLAnchorElement>('#issue_42 [aria-label="2 comments"]')!;
    counter.setAttribute('aria-label', 'many comments');
    counter.setAttribute('hidden', 'github-hidden');
    counter.setAttribute('aria-hidden', 'github-aria');
    counter.setAttribute('tabindex', '7');
    counter.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(counter);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const updates: CardProps[] = [];
    const mount = vi.fn((_anchor, props: CardProps) => {
      updates.push(props);
      return { isConnected: () => true, remove: vi.fn(), update(next: CardProps) { updates.push(next); } };
    });
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();
    await vi.waitFor(() => expect(counter.getAttribute('aria-hidden')).toBe('true'));
    const marker = document.querySelector('[data-pr-overview-mount-anchor]');
    counter.setAttribute('aria-label', '2 comments');

    await vi.waitFor(() => expect(updates.at(-1)!.summary.totalComments).toEqual({
      data: { count: 2, href: '/octo/demo/pull/42#comments' },
      status: 'ready',
    }));
    expect(document.querySelector('[data-pr-overview-mount-anchor]')).toBe(marker);
    expect(mount).toHaveBeenCalledOnce();
    expect(client.loadPullRequest).toHaveBeenCalledOnce();
    reconciler.cleanup();
    expectSnapshot(counter, expected);
  });

  it.each([
    ['class', '<a data-probe-counter class="comments-link" href="/octo/demo/pull/42">many</a>', (element: Element) => element.removeAttribute('class'), (element: Element) => element.setAttribute('class', 'comments-link')],
    ['role', '<a data-probe-counter role="comment" href="/octo/demo/pull/42">many</a>', (element: Element) => element.removeAttribute('role'), (element: Element) => element.setAttribute('role', 'comment')],
    ['data-comment-count', '<span data-comment-count><a data-probe-counter href="/octo/demo/pull/42">many</a></span>', (element: Element) => element.removeAttribute('data-comment-count'), (element: Element) => element.setAttribute('data-comment-count', '')],
  ])('automatically reconciles a %s-based native counter when its recognition changes', async (_attribute, markup, removeRecognition, restoreRecognition) => {
    const document = page(recognitionRow(markup));
    const target = document.querySelector<HTMLElement>(_attribute === 'data-comment-count' ? '[data-comment-count]' : '[data-probe-counter]')!;
    const totals: CardProps['summary']['totalComments'][] = [];
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: { mount(_anchor, props) { totals.push(props.summary.totalComments); return { isConnected: () => true, remove: vi.fn(), update(next) { totals.push(next.summary.totalComments); } }; } },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(totals).toContainEqual({ message: 'GitHub comment counter is malformed.', status: 'error' }));
    removeRecognition(target);
    await vi.waitFor(() => expect(totals).toContainEqual({ data: { count: 0, href: '/octo/demo/pull/42' }, status: 'ready' }));
    restoreRecognition(target);
    await vi.waitFor(() => expect(totals.at(-1)).toEqual({ message: 'GitHub comment counter is malformed.', status: 'error' }));
    reconciler.cleanup();
  });

  it('automatically reconciles comment-counter text node changes', async () => {
    const document = page(recognitionRow('<a data-probe-counter href="/octo/demo/pull/42">2 comments</a>'));
    const counter = document.querySelector<HTMLAnchorElement>('[data-probe-counter]')!;
    const totals: CardProps['summary']['totalComments'][] = [];
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: { mount(_anchor, props) { totals.push(props.summary.totalComments); return { isConnected: () => true, remove: vi.fn(), update(next) { totals.push(next.summary.totalComments); } }; } },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(totals).toContainEqual({ message: 'GitHub comment counter is malformed.', status: 'error' }));
    counter.firstChild!.textContent = 'not a counter';
    await vi.waitFor(() => expect(totals).toContainEqual({ data: { count: 0, href: '/octo/demo/pull/42' }, status: 'ready' }));
    counter.firstChild!.textContent = '2 comments';
    await vi.waitFor(() => expect(totals.at(-1)).toEqual({ message: 'GitHub comment counter is malformed.', status: 'error' }));
    reconciler.cleanup();
  });

  it('counter replacement restores each native snapshot without remounting or refetching', async () => {
    const document = page(currentPrListHtml);
    const row = document.querySelector<HTMLElement>('#issue_42')!;
    document.querySelector('#issue_43')!.remove();
    const original = row.querySelector<HTMLAnchorElement>('[aria-label="2 comments"]')!;
    original.setAttribute('hidden', 'github-hidden');
    original.setAttribute('aria-hidden', 'github-aria');
    original.setAttribute('tabindex', '7');
    original.setAttribute('style', 'display: inline');
    const originalSnapshot = snapshotAttributes(original);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();
    await vi.waitFor(() => expect(original.getAttribute('aria-hidden')).toBe('true'));
    const replacement = original.cloneNode(true) as HTMLAnchorElement;
    replacement.setAttribute('aria-label', '3 comments');
    replacement.setAttribute('hidden', 'replacement-hidden');
    replacement.setAttribute('aria-hidden', 'replacement-aria');
    replacement.setAttribute('tabindex', '8');
    replacement.setAttribute('style', 'display: contents');
    const replacementSnapshot = snapshotAttributes(replacement);
    original.replaceWith(replacement);

    await vi.waitFor(() => expect(replacement.getAttribute('aria-hidden')).toBe('true'));
    expect(mount).toHaveBeenCalledOnce();
    expect(client.loadPullRequest).toHaveBeenCalledOnce();
    expectSnapshot(original, originalSnapshot);

    reconciler.cleanup();
    expectSnapshot(replacement, replacementSnapshot);
  });

  it('pending replacement leaves both old and new counters visible until the mount resolves', async () => {
    const document = page(currentPrListHtml);
    const row = document.querySelector<HTMLElement>('#issue_42')!;
    document.querySelector('#issue_43')!.remove();
    const original = row.querySelector<HTMLAnchorElement>('[aria-label="2 comments"]')!;
    let resolveMount!: (card: MountedCard) => void;
    const pendingMount = new Promise<MountedCard>((resolve) => { resolveMount = resolve; });
    const mount = vi.fn(() => pendingMount);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();
    const replacement = original.cloneNode(true) as HTMLAnchorElement;
    replacement.setAttribute('aria-label', '3 comments');
    replacement.removeAttribute('hidden');
    replacement.removeAttribute('aria-hidden');
    replacement.removeAttribute('tabindex');
    replacement.removeAttribute('style');
    const replacementSnapshot = snapshotAttributes(replacement);
    original.replaceWith(replacement);
    await Promise.resolve();

    expect(original.hidden).toBe(false);
    expect(replacement.hidden).toBe(false);
    expect(mount).toHaveBeenCalledOnce();
    expect(client.loadPullRequest).toHaveBeenCalledOnce();

    resolveMount({ isConnected: () => true, remove: vi.fn(), update: vi.fn() });
    await vi.waitFor(() => expect(replacement.hidden).toBe(true));
    reconciler.cleanup();
    expectSnapshot(replacement, replacementSnapshot);
  });

  it('automatically replaces a controller when only its mounted host is removed', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    native.setAttribute('aria-hidden', 'github-aria');
    native.setAttribute('tabindex', '7');
    native.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(native);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const cards: ReturnType<typeof createLifecycleCard>[] = [];
    let resolveReplacement!: (card: MountedCard) => void;
    const mount = vi.fn((anchor: Element) => {
      const card = createLifecycleCard(anchor);
      cards.push(card);
      return cards.length === 1
        ? card.mounted
        : new Promise<MountedCard>((resolve) => { resolveReplacement = resolve; });
    });
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(cards[0]!.update).toHaveBeenCalledTimes(2));
    expect(native.hidden).toBe(true);
    cards[0]!.host.remove();

    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(0);
    expectSnapshot(native, expected);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    resolveReplacement(cards[1]!.mounted);
    await vi.waitFor(() => expect(cards[1]!.update).toHaveBeenCalledTimes(1));
    expect(native.hidden).toBe(true);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    reconciler.cleanup();
    expectSnapshot(native, expected);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
  });

  it('automatically replaces a settled controller when only its marker is removed', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    native.setAttribute('aria-hidden', 'github-aria');
    native.setAttribute('tabindex', '7');
    native.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(native);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const cards: ReturnType<typeof createLifecycleCard>[] = [];
    let resolveReplacement!: (card: MountedCard) => void;
    const mount = vi.fn((anchor: Element) => {
      const card = createLifecycleCard(anchor);
      cards.push(card);
      return cards.length === 1
        ? card.mounted
        : new Promise<MountedCard>((resolve) => { resolveReplacement = resolve; });
    });
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(cards[0]!.update).toHaveBeenCalledTimes(2));
    expect(native.hidden).toBe(true);
    document.querySelector('[data-pr-overview-mount-anchor]')!.remove();

    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(0);
    expectSnapshot(native, expected);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    resolveReplacement(cards[1]!.mounted);
    await vi.waitFor(() => expect(cards[1]!.update).toHaveBeenCalledTimes(1));
    expect(native.hidden).toBe(true);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    reconciler.cleanup();
    expectSnapshot(native, expected);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
  });

  it('automatically replaces a pending controller when only its marker is removed', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    native.setAttribute('aria-hidden', 'github-aria');
    native.setAttribute('tabindex', '7');
    native.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(native);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const cards: Array<ReturnType<typeof createLifecycleCard> & {
      resolve(card: MountedCard): void;
    }> = [];
    const mount = vi.fn((anchor: Element) => {
      const card = createLifecycleCard(anchor);
      let resolve!: (card: MountedCard) => void;
      const pending = new Promise<MountedCard>((done) => { resolve = done; });
      cards.push({ ...card, resolve });
      return pending;
    });
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    document.querySelector('[data-pr-overview-mount-anchor]')!.remove();

    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    expect(cards[0]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(0);
    expectSnapshot(native, expected);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(2);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    cards[0]!.resolve(cards[0]!.mounted);
    await vi.waitFor(() => expect(cards[0]!.remove).toHaveBeenCalledTimes(1));
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(0);
    expectSnapshot(native, expected);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);

    cards[1]!.resolve(cards[1]!.mounted);
    await vi.waitFor(() => expect(cards[1]!.update).toHaveBeenCalledTimes(1));
    expect(native.hidden).toBe(true);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);
    expect(mount).toHaveBeenCalledTimes(2);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);

    reconciler.cleanup();
    expectSnapshot(native, expected);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
  });

  it('automatically replaces a pending controller whose mounted host was removed before resolution', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    native.setAttribute('aria-hidden', 'github-aria');
    native.setAttribute('tabindex', '7');
    native.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(native);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const cards: Array<ReturnType<typeof createLifecycleCard> & {
      resolve(card: MountedCard): void;
    }> = [];
    const mount = vi.fn((anchor: Element) => {
      const card = createLifecycleCard(anchor);
      let resolve!: (card: MountedCard) => void;
      const pending = new Promise<MountedCard>((done) => { resolve = done; });
      cards.push({ ...card, resolve });
      return pending;
    });
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    cards[0]!.host.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    cards[0]!.resolve(cards[0]!.mounted);

    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(0);
    expectSnapshot(native, expected);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    cards[1]!.resolve(cards[1]!.mounted);
    await vi.waitFor(() => expect(cards[1]!.update).toHaveBeenCalledTimes(1));
    expect(native.hidden).toBe(true);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);
    expect(mount).toHaveBeenCalledTimes(2);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);

    reconciler.cleanup();
    expectSnapshot(native, expected);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(0);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[1]!.update).toHaveBeenCalledTimes(1);
  });

  it('automatically replaces a connected mounted host moved into a different pull request row', async () => {
    const document = page(
      row() +
      row(43, '<a class="comments-link" aria-label="5 comments" href="/octo/demo/pull/43#issuecomment-5">5</a>'),
    );
    const originalRow = document.querySelector<HTMLElement>('#issue_42')!;
    const destinationRow = document.querySelector<HTMLElement>('#issue_43')!;
    const originalNative = originalRow.querySelector<HTMLAnchorElement>('.comments-link')!;
    const destinationNative = destinationRow.querySelector<HTMLAnchorElement>('.comments-link')!;
    originalNative.setAttribute('aria-hidden', 'github-aria');
    originalNative.setAttribute('tabindex', '7');
    originalNative.setAttribute('style', 'display: inline');
    const originalExpected = snapshotAttributes(originalNative);
    const destinationExpected = snapshotAttributes(destinationNative);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const cards = new Map<string, ReturnType<typeof createLifecycleCard>[]>([
      ['issue_42', []],
      ['issue_43', []],
    ]);
    let resolveReplacement!: (card: MountedCard) => void;
    const mount = vi.fn((anchor: Element) => {
      const owner = anchor.closest<HTMLElement>('[id^="issue_"].js-issue-row')!;
      const card = createLifecycleCard(anchor);
      const rowCards = cards.get(owner.id)!;
      rowCards.push(card);
      return owner === originalRow && rowCards.length === 2
        ? new Promise<MountedCard>((resolve) => { resolveReplacement = resolve; })
        : card.mounted;
    });
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    const originalCards = cards.get('issue_42')!;
    const destinationCards = cards.get('issue_43')!;
    await vi.waitFor(() => {
      expect(originalCards[0]!.update).toHaveBeenCalledTimes(2);
      expect(destinationCards[0]!.update).toHaveBeenCalledTimes(2);
    });
    expect(originalNative.hidden).toBe(true);
    expect(destinationNative.hidden).toBe(true);

    destinationRow.querySelector('.comment-area')!.append(originalCards[0]!.host);

    await vi.waitFor(() => {
      expect(mount).toHaveBeenCalledTimes(3);
      expect(destinationCards[0]!.update).toHaveBeenCalledTimes(4);
    });
    expect(originalCards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(originalCards[0]!.update).toHaveBeenCalledTimes(2);
    expect(originalCards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(originalCards[1]!.update).toHaveBeenCalledTimes(0);
    expect(destinationCards[0]!.remove).toHaveBeenCalledTimes(0);
    expect(destinationCards[0]!.update).toHaveBeenCalledTimes(4);
    expectSnapshot(originalNative, originalExpected);
    expect(destinationNative.hidden).toBe(true);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(3);
    expect(originalRow.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(destinationRow.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(originalRow.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);
    expect(destinationRow.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);
    expect(originalCards[1]!.host.closest('[id^="issue_"].js-issue-row')).toBe(originalRow);
    expect(destinationCards[0]!.host.closest('[id^="issue_"].js-issue-row')).toBe(destinationRow);

    resolveReplacement(originalCards[1]!.mounted);
    await vi.waitFor(() => expect(originalCards[1]!.update).toHaveBeenCalledTimes(1));
    expect(originalNative.hidden).toBe(true);
    expect(destinationNative.hidden).toBe(true);
    expect(mount).toHaveBeenCalledTimes(3);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(3);
    expect(originalCards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(originalCards[0]!.update).toHaveBeenCalledTimes(2);
    expect(originalCards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(originalCards[1]!.update).toHaveBeenCalledTimes(1);
    expect(destinationCards[0]!.remove).toHaveBeenCalledTimes(0);
    expect(destinationCards[0]!.update).toHaveBeenCalledTimes(4);
    expect(originalRow.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(destinationRow.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(originalRow.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);
    expect(destinationRow.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    reconciler.cleanup();
    expectSnapshot(originalNative, originalExpected);
    expectSnapshot(destinationNative, destinationExpected);
    expect(originalCards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(originalCards[0]!.update).toHaveBeenCalledTimes(2);
    expect(originalCards[1]!.remove).toHaveBeenCalledTimes(1);
    expect(originalCards[1]!.update).toHaveBeenCalledTimes(1);
    expect(destinationCards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(destinationCards[0]!.update).toHaveBeenCalledTimes(4);
  });

  it('rejects a disconnected mounted host during explicit reconciliation', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    native.setAttribute('aria-hidden', 'github-aria');
    native.setAttribute('tabindex', '7');
    native.setAttribute('style', 'display: inline');
    const expected = snapshotAttributes(native);
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const cards: ReturnType<typeof createLifecycleCard>[] = [];
    const mount = vi.fn((anchor: Element) => {
      const card = createLifecycleCard(anchor);
      cards.push(card);
      return card.mounted;
    });
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(cards[0]!.update).toHaveBeenCalledTimes(2));
    expect(native.hidden).toBe(true);
    cards[0]!.host.remove();
    reconciler.reconcile();

    expect(mount).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(cards[1]!.update).toHaveBeenCalledTimes(3));
    expect(native.hidden).toBe(true);
    expect(client.loadPullRequest).toHaveBeenCalledTimes(2);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(0);
    expect(cards[1]!.update).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pr-overview-mount-anchor]')).toHaveLength(1);

    reconciler.cleanup();
    expectSnapshot(native, expected);
    expect(cards[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[0]!.update).toHaveBeenCalledTimes(2);
    expect(cards[1]!.remove).toHaveBeenCalledTimes(1);
    expect(cards[1]!.update).toHaveBeenCalledTimes(3);
  });

  it('reconciles a changed counter across 30 rows with bounded row-local queries', async () => {
    const document = page(Array.from({ length: 30 }, (_, index) => {
      const number = index + 1;
      return row(number, `<a class="comments-link" aria-label="23 comments" href="/octo/demo/pull/${number}#issuecomment-${number}">23</a>`);
    }).join(''));
    const client = { loadPullRequest: vi.fn(async (_identity: { number: number }) => remote) };
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: { mount() { return { isConnected: () => true, remove: vi.fn(), update: vi.fn() }; } },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledTimes(30));

    const rows = [...document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')];
    const rowQuerySpies = new Map(rows.map((row) => [row, vi.spyOn(row, 'querySelectorAll')]));
    document.querySelector<HTMLElement>('#issue_15 .comments-link')!.setAttribute('aria-label', '24 comments');

    reconciler.reconcile();

    expect(
      rows.reduce((total, row) => total + rowQuerySpies.get(row)!.mock.calls.length, 0),
    ).toBeLessThan(120);
    expect(client.loadPullRequest.mock.calls.filter(([identity]) => identity.number === 15)).toHaveLength(1);
  });

  it('hides the native counter while mounting its value, restores it exactly on teardown, and restores authored accent', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    document.querySelector('#issue_42')!.setAttribute('data-pr-overview-authored', 'github-original');
    native.hidden = false; native.setAttribute('aria-hidden', 'false'); native.setAttribute('tabindex', '0');
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mounts: Array<MountedCard & { remove: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }> = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: Observer, uiFactory: { mount(_anchor, props) { expect(props.summary.totalComments).toEqual({ data: { count: 23, href: '/octo/demo/pull/42#issuecomment-23' }, status: 'ready' }); const mount = { isConnected: () => true, remove: vi.fn(), update: vi.fn() }; mounts.push(mount); return mount; } } });

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
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(anchor) { mountedAt = anchor; return { isConnected: () => true, remove: vi.fn(), update: vi.fn() }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    expect(title.hidden).toBe(false);
    expect(counter.hidden).toBe(true);
    expect(mountedAt).toHaveAttribute('data-pr-overview-mount-anchor');
  });

  it.each([
    [
      'malformed',
      '<a class="comments-link" aria-label="many comments" href="http://[">many</a>',
    ],
    [
      'off-origin',
      '<a class="comments-link" href="https://evil.example/octo/demo/pull/45">many</a>',
    ],
    [
      'href-only',
      '<a href="/octo/demo/pull/45#comments">many</a>',
    ],
    [
      'role-only',
      '<a role="comment" href="/octo/demo/pull/45#not-a-conversation">many</a>',
    ],
    [
      'nested-icon',
      '<span data-comment-count><a href="/octo/demo/pull/45#not-a-conversation"><svg aria-label="comment"></svg>many</a></span>',
    ],
    [
      'unrelated-number-label',
      '<a aria-label="comments unavailable; retry in 30 seconds" href="/octo/demo/pull/45#comments">many</a>',
    ],
    [
      'unsafe-grouped-number',
      '<a aria-label="9,007,199,254,740,992 comments" href="/octo/demo/pull/45#comments">many</a>',
    ],
    [
      'unsafe-long-number',
      '<a aria-label="99999999999999999999 comments" href="/octo/demo/pull/45#comments">many</a>',
    ],
  ])('keeps a comment-count-looking title visible while replacing a %s counter with an error card', async (_kind, counterMarkup) => {
    const document = page(`
      <div id="issue_45" class="js-issue-row">
        <a class="Link--primary" aria-label="12 comments" href="/octo/demo/pull/45">12 comments</a>
        <span class="opened-by"><a data-hovercard-type="user">octo-author</a></span>
        <span class="comment-area">${counterMarkup}</span>
      </div>
    `);
    const title = document.querySelector<HTMLAnchorElement>('.Link--primary')!;
    const counter = document.querySelector<HTMLAnchorElement>('.comment-area a')!;
    let initial: any;
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: {
        mount(anchor, props) {
          initial = { anchor, props };
          return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(initial.anchor).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(initial.props.summary.totalComments).toEqual({
      message: 'GitHub comment counter is malformed.',
      status: 'error',
    });
    expect(title.hidden).toBe(false);
    expect(counter.hidden).toBe(true);
  });

  it('uses counter structure to preserve an unmarked comment-named title when every canonical link is comment-like', async () => {
    const document = page(`
      <div id="issue_45" class="js-issue-row">
        <span class="comment-area">
          <a role="comment" href="/octo/demo/pull/45">many</a>
        </span>
        <a data-probe-title href="/octo/demo/pull/45">12 comments</a>
        <span class="opened-by"><a data-hovercard-type="user">octo-author</a></span>
      </div>
    `);
    const title = document.querySelector<HTMLAnchorElement>('[data-probe-title]')!;
    const counter = document.querySelector<HTMLAnchorElement>('[role="comment"]')!;
    let initial: any;
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: {
        mount(anchor, props) {
          initial = { anchor, props };
          return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(initial.anchor).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(initial.props.summary.totalComments).toEqual({
      message: 'GitHub comment counter is malformed.',
      status: 'error',
    });
    expect(title.hidden).toBe(false);
    expect(counter.hidden).toBe(true);
  });

  it.each(['counter-first', 'title-first'])(
    'targets only the structural counter when same-PR title links are ambiguous (%s)',
    async (order) => {
      const counter = '<span class="comment-area"><a role="comment" href="/octo/demo/pull/45">many</a></span>';
      const title = '<a data-probe-title href="/octo/demo/pull/45">12 comments</a>';
      const ordered = order === 'counter-first' ? `${counter}${title}` : `${title}${counter}`;
      const document = page(`
        <div id="issue_45" class="js-issue-row">
          ${ordered}
          <a data-extra-link href="/octo/demo/pull/45">Open pull request</a>
          <span class="opened-by"><a data-hovercard-type="user">octo-author</a></span>
        </div>
      `);
      const titleAnchor = document.querySelector<HTMLAnchorElement>('[data-probe-title]')!;
      const counterAnchor = document.querySelector<HTMLAnchorElement>('[role="comment"]')!;
      const extraAnchor = document.querySelector<HTMLAnchorElement>('[data-extra-link]')!;
      let initial: any;
      const reconciler = createPageReconciler({
        document,
        client: { loadPullRequest: vi.fn(async () => remote) },
        IntersectionObserver: undefined,
        uiFactory: {
          mount(anchor, props) {
            initial = { anchor, props };
            return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
          },
        },
      });

      reconciler.reconcile();
      await Promise.resolve();

      expect(initial.anchor).toHaveAttribute('data-pr-overview-mount-anchor');
      expect(initial.props.summary.totalComments).toEqual({
        message: 'GitHub comment counter is malformed.',
        status: 'error',
      });
      expect(titleAnchor.hidden).toBe(false);
      expect(counterAnchor.hidden).toBe(true);
      expect(extraAnchor.hidden).toBe(false);
    },
  );

  it.each(['number-first', 'title-first'])(
    'keeps both unmarked same-PR links visible when text alone cannot identify a counter (%s)',
    async (order) => {
      const numberLink = '<a data-number-link href="/octo/demo/pull/45">#45</a>';
      const title = '<a data-probe-title href="/octo/demo/pull/45">12 comments</a>';
      const ordered = order === 'number-first' ? `${numberLink}${title}` : `${title}${numberLink}`;
      const document = page(`
        <div id="issue_45" class="js-issue-row">
          ${ordered}
          <span class="opened-by"><a data-hovercard-type="user">octo-author</a></span>
        </div>
      `);
      const titleAnchor = document.querySelector<HTMLAnchorElement>('[data-probe-title]')!;
      const numberAnchor = document.querySelector<HTMLAnchorElement>('[data-number-link]')!;
      let initial: any;
      const reconciler = createPageReconciler({
        document,
        client: { loadPullRequest: vi.fn(async () => remote) },
        IntersectionObserver: undefined,
        uiFactory: {
          mount(anchor, props) {
            initial = { anchor, props };
            return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
          },
        },
      });

      reconciler.reconcile();
      await Promise.resolve();

      expect(initial.anchor).not.toBe(titleAnchor);
      expect(initial.anchor).not.toBe(numberAnchor);
      expect(initial.props.summary.totalComments).toEqual({
        message: 'GitHub comment counter is malformed.',
        status: 'error',
      });
      expect(titleAnchor.hidden).toBe(false);
      expect(numberAnchor.hidden).toBe(false);
    },
  );

  it.each([
    [
      'two valid',
      '<a data-counter-a aria-label="2 comments" href="/octo/demo/pull/45#comments">2</a>',
      '<a data-counter-b aria-label="3 comments" href="/octo/demo/pull/45#comments">3</a>',
    ],
    [
      'invalid and valid',
      '<a data-counter-a aria-label="9 comments" href="https://evil.example/octo/demo/pull/45#comments">9</a>',
      '<a data-counter-b aria-label="3 comments" href="/octo/demo/pull/45#comments">3</a>',
    ],
    [
      'cross-PR empty-fragment and valid',
      '<a data-counter-a aria-label="9 comments" href="/octo/demo/pull/99">9</a>',
      '<a data-counter-b aria-label="3 comments" href="/octo/demo/pull/45#comments">3</a>',
    ],
    [
      'two malformed',
      '<a data-counter-a role="comment" href="/octo/demo/pull/45">many</a>',
      '<a data-counter-b class="comments-link" href="/octo/demo/pull/45">many</a>',
    ],
  ].flatMap(([kind, first, second]) => [
    [`${kind}, first order`, first, second],
    [`${kind}, reverse order`, second, first],
  ]))(
    'uses a synthetic error mount for ambiguous counters (%s)',
    async (_kind, first, second) => {
      const document = page(`
        <div id="issue_45" class="js-issue-row">
          <a class="Link--primary" href="/octo/demo/pull/45">A pull request title</a>
          <span class="comment-area">${first}${second}</span>
          <span class="opened-by"><a data-hovercard-type="user">octo-author</a></span>
        </div>
      `);
      const candidates = [...document.querySelectorAll<HTMLAnchorElement>('[data-counter-a], [data-counter-b]')];
      let initial: any;
      const reconciler = createPageReconciler({
        document,
        client: { loadPullRequest: vi.fn(async () => remote) },
        IntersectionObserver: undefined,
        uiFactory: {
          mount(anchor, props) {
            initial = { anchor, props };
            return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
          },
        },
      });

      reconciler.reconcile();
      await Promise.resolve();

      expect(candidates).toHaveLength(2);
      expect(candidates).not.toContain(initial.anchor);
      expect(initial.props.summary.totalComments).toEqual({
        message: 'GitHub comment counter is malformed.',
        status: 'error',
      });
      expect(candidates.every((candidate) => candidate.hidden === false)).toBe(true);
    },
  );

  it.each([
    ['external', 'https://evil.example/octo/demo/pull/43'],
    ['explicit-port', 'https://github.com:443/octo/demo/pull/43'],
    ['query-bearing', '/octo/demo/pull/43?return_to=evil'],
  ])('ignores %s PR-shaped links when locating a row identity', (_kind, untrustedHref) => {
    const document = page(row().replace(
      '<a class="Link--primary"',
      `<a href="${untrustedHref}">Untrusted PR-shaped link</a><a class="Link--primary"`,
    ));
    const client = { loadPullRequest: vi.fn(async (_identity: { number: number }) => remote) };
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount } });

    reconciler.reconcile();

    expect(mount).toHaveBeenCalledOnce();
    expect(client.loadPullRequest.mock.calls[0]![0].number).toBe(42);
  });

  it('replaces a valid same-PR numeric counter whose conversation href has an empty fragment', async () => {
    const document = page(row(42, '<a class="comments-link" aria-label="23 comments" href="/octo/demo/pull/42">23</a>'));
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let mountedAt: Element | undefined;
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: {
        mount(anchor) {
          mountedAt = anchor;
          return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(mountedAt).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(counter.hidden).toBe(true);
  });

  it.each([
    ['explicit default port', 'https://github.com:443/octo/demo/pull/42'],
    ['query-bearing', '/octo/demo/pull/42?return_to=evil'],
  ])('replaces a recognized counter with a rejected %s href', async (_kind, unsafeHref) => {
    const document = page(row(42, `<a class="comments-link" aria-label="23 comments" href="${unsafeHref}">23</a>`));
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let mountedAt: Element | undefined;
    let initial: any;
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: {
        mount(anchor, props) {
          mountedAt = anchor;
          initial = props;
          return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(mountedAt).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(counter.hidden).toBe(true);
    expect(initial.summary.totalComments).toEqual({ message: 'GitHub comment counter is malformed.', status: 'error' });
  });

  it('replaces an unsafe PR-shaped native counter instead of mistaking it for the title', async () => {
    const unsafeCounter = '<a class="comments-link" aria-label="23 comments" href="https://evil.example/octo/demo/pull/42">23</a>';
    const document = page(row(42, unsafeCounter));
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let mountedAt: Element | undefined;
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: {
        mount(anchor) {
          mountedAt = anchor;
          return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(mountedAt).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(counter.hidden).toBe(true);
  });

  it('replaces a native counter with an unparseable href without crashing reconciliation', async () => {
    const document = page(row(42, '<a class="comments-link" aria-label="many comments" href="http://[">many</a>'));
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let mountedAt: Element | undefined;
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: {
        mount(anchor) {
          mountedAt = anchor;
          return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    expect(() => reconciler.reconcile()).not.toThrow();
    await Promise.resolve();

    expect(mountedAt).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(counter.hidden).toBe(true);
  });

  it('hides an aria-labeled malformed counter even when GitHub omitted its href', async () => {
    const document = page(row(46, '<a class="comments-link" aria-label="many comments">many</a>'));
    const malformed = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let initial: any;
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(anchor, props) { initial = { anchor, props }; return { isConnected: () => true, remove: vi.fn(), update: vi.fn() }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    expect(initial.anchor).toHaveAttribute('data-pr-overview-mount-anchor');
    expect(initial.props.summary.totalComments).toEqual({ message: 'GitHub comment counter is malformed.', status: 'error' });
    expect(malformed.hidden).toBe(true);
  });

  it('does not hide native UI until an async replacement mounts and restores state after mount failures or disposal races', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    let resolve!: (mount: MountedCard) => void;
    const deferred = new Promise<MountedCard>((done) => { resolve = done; });
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { return deferred; } } });
    reconciler.reconcile();
    expect(native.hidden).toBe(false);
    const remove = vi.fn(); resolve({ isConnected: () => true, remove, update: vi.fn() });
    await Promise.resolve();
    expect(native.hidden).toBe(true);
    reconciler.cleanup();
    expect(native.hidden).toBe(false);
    expect(remove).toHaveBeenCalledOnce();

    const failed = page(row());
    const failedNative = failed.querySelector<HTMLAnchorElement>('.comments-link')!;
    const failedReconciler = createPageReconciler({ document: failed, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { throw new Error('mount failed'); } } });
    failedReconciler.reconcile();
    await Promise.resolve();
    expect(failedNative.hidden).toBe(false);
    failedReconciler.cleanup();

    const rejected = page(row());
    const rejectedNative = rejected.querySelector<HTMLAnchorElement>('.comments-link')!;
    let reject!: (reason: Error) => void;
    const rejectMount = new Promise<MountedCard>((_resolve, fail) => { reject = fail; });
    const rejectedReconciler = createPageReconciler({ document: rejected, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { return rejectMount; } } });
    rejectedReconciler.reconcile();
    reject(new Error('async mount failed'));
    await Promise.resolve(); await Promise.resolve();
    expect(rejectedNative.hidden).toBe(false);
    rejectedReconciler.cleanup();

    const racing = page(row());
    const racingNative = racing.querySelector<HTMLAnchorElement>('.comments-link')!;
    let resolveRace!: (mount: MountedCard) => void;
    const race = new Promise<MountedCard>((done) => { resolveRace = done; });
    const raceRemove = vi.fn();
    const raceReconciler = createPageReconciler({ document: racing, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount() { return race; } } });
    raceReconciler.reconcile(); raceReconciler.cleanup(); resolveRace({ isConnected: () => true, remove: raceRemove, update: vi.fn() });
    await Promise.resolve();
    expect(racingNative.hidden).toBe(false);
    expect(raceRemove).toHaveBeenCalledOnce();
  });

  it.each(['synchronous throw', 'asynchronous rejection'] as const)(
    'retries an unchanged row after a %s only on a later reconciliation',
    async (failureMode) => {
      const document = page(row());
      const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
      let attempts = 0;
      const mount = vi.fn(() => {
        attempts += 1;
        if (attempts === 1) {
          if (failureMode === 'synchronous throw') throw new Error('temporary mount failure');
          return Promise.reject(new Error('temporary mount failure'));
        }
        return { isConnected: () => true, remove: vi.fn(), update: vi.fn() };
      });
      const reconciler = createPageReconciler({
        document,
        client: { loadPullRequest: vi.fn(async () => remote) },
        IntersectionObserver: undefined,
        uiFactory: { mount },
      });

      reconciler.reconcile();
      await Promise.resolve();
      await Promise.resolve();
      expect(mount).toHaveBeenCalledTimes(1);
      expect(native.hidden).toBe(false);

      reconciler.reconcile();
      await Promise.resolve();
      expect(mount).toHaveBeenCalledTimes(2);
      expect(native.hidden).toBe(true);
    },
  );

  it('does not automatically spin when a zero-row mount keeps failing', async () => {
    const document = page(row(43, ''));
    const mount = vi.fn(() => { throw new Error('persistent mount failure'); });
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(mount).toHaveBeenCalledTimes(1);

    reconciler.reconcile();
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it('creates and removes a stable mount marker for a zero-count row', () => {
    const document = page(row(43, ''));
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mounted: Element[] = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount(anchor) { mounted.push(anchor); return { isConnected: () => true, remove: vi.fn(), update: vi.fn() }; } } });

    reconciler.reconcile();
    const extensionAnchor = document.querySelector('[data-pr-overview-mount-anchor]')!;
    expect(extensionAnchor).toBeTruthy();
    expect(extensionAnchor.tagName).toBe('SPAN');
    expect(extensionAnchor).not.toHaveAttribute('href');
    expect((extensionAnchor as HTMLElement).tabIndex).toBe(-1);
    expect(mounted).toEqual([extensionAnchor]);
    reconciler.cleanup();
    expect(document.querySelector('[data-pr-overview-mount-anchor]')).toBeNull();
  });

  it('adopts a new ready counter without remounting when GitHub retains the former node', async () => {
    const document = page(row());
    const oldCounter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    const mount = vi.fn(() => ({ isConnected: () => true, remove: vi.fn(), update: vi.fn() }));
    const reconciler = createPageReconciler({
      document,
      client: { loadPullRequest: vi.fn(async () => remote) },
      IntersectionObserver: undefined,
      uiFactory: { mount },
    });

    reconciler.reconcile();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());

    oldCounter.removeAttribute('aria-label');
    oldCounter.removeAttribute('class');
    oldCounter.setAttribute('href', '/octo/demo/pull/42/files');
    const replacement = document.createElement('a');
    replacement.className = 'comments-link';
    replacement.setAttribute('aria-label', '24 comments');
    replacement.setAttribute('href', '/octo/demo/pull/42#issuecomment-24');
    replacement.textContent = '24';
    oldCounter.parentElement!.replaceChildren(replacement);
    document.querySelector('#issue_42')!.append(oldCounter);

    reconciler.reconcile();
    await vi.waitFor(() => expect(replacement.hidden).toBe(true));

    expect(oldCounter.hidden).toBe(false);
    expect(mount).toHaveBeenCalledOnce();
    expect(replacement.hidden).toBe(true);
  });

  it('reparses malformed and dynamic native counters without retaining a stale total', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    const updates: unknown[] = [];
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { updates.push(props.summary.totalComments); return { isConnected: () => true, remove: vi.fn(), update(next) { updates.push(next.summary.totalComments); } }; } } });
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
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { latest.push(props); return { isConnected: () => true, remove: vi.fn(), update(next) { latest.push(next); } }; } } });
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
    const mount = vi.fn(() => ({ isConnected: () => true, remove: removed, update: vi.fn() }));
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
    const client = { loadPullRequest: vi.fn((_identity, options?: PullRequestLoadOptions) => { calls.push(options!.signal!); return new Promise<PullRequestRemoteSummary>(() => {}); }) };
    const updates: any[] = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { updates.push(props); return { isConnected: () => true, remove: vi.fn(), update(next) { updates.push(next); } }; } } });
    reconciler.reconcile();
    await Promise.resolve();
    const title = document.querySelector<HTMLAnchorElement>('.Link--primary')!;
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    title.setAttribute('href', '/octo/demo/pull/43'); counter.setAttribute('href', '/octo/demo/pull/43#comments'); counter.setAttribute('aria-label', 'many comments');
    await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledTimes(2));
    expect(calls[0]!.aborted).toBe(true);
    expect(updates.some((entry) => entry.summary.totalComments.status === 'error')).toBe(true);
  });

  it('never adopts a completed summary after its row has been reused for another pull request', async () => {
    const document = page(row());
    const remote42: PullRequestRemoteSummary = {
      ...remote,
      diff: { data: { additions: 42, deletions: 1, filesChanged: 2 }, status: 'ready' },
    };
    const remote43: PullRequestRemoteSummary = {
      ...remote,
      diff: { data: { additions: 43, deletions: 1, filesChanged: 2 }, status: 'ready' },
    };
    let resolve42!: (value: PullRequestRemoteSummary) => void;
    const signals: AbortSignal[] = [];
    const client = {
      loadPullRequest: vi.fn((identity: { number: number }, options?: PullRequestLoadOptions) => {
        signals.push(options!.signal!);
        if (identity.number === 42) return new Promise<PullRequestRemoteSummary>((resolve) => { resolve42 = resolve; });
        return Promise.resolve(remote43);
      }),
    };
    const updates: any[] = [];
    const removed = vi.fn();
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: {
        mount(_anchor, props) {
          updates.push(props);
          return { isConnected: () => true, remove: removed, update(next) { updates.push(next); } };
        },
      },
    });

    reconciler.reconcile();
    const title = document.querySelector<HTMLAnchorElement>('.Link--primary')!;
    const counter = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    title.setAttribute('href', '/octo/demo/pull/43');
    counter.setAttribute('href', '/octo/demo/pull/43#issuecomment-43');
    resolve42(remote42);

    await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(updates.some((entry) => entry.conversationHref === '/octo/demo/pull/43' && entry.summary.diff.data?.additions === 43)).toBe(true));
    expect(client.loadPullRequest.mock.calls.map(([identity]) => identity.number)).toEqual([42, 43]);
    expect(signals[0]!.aborted).toBe(true);
    expect(removed).toHaveBeenCalledOnce();
    expect(updates.some((entry) => entry.conversationHref === '/octo/demo/pull/43' && entry.summary.diff.data?.additions === 42)).toBe(false);
  });

  it('never renders a rejected request after its row has been reused for another pull request', async () => {
    class DeferredMutationObserver {
      static instances: DeferredMutationObserver[] = [];
      readonly disconnect = vi.fn();
      readonly observe = vi.fn();
      readonly takeRecords = vi.fn((): MutationRecord[] => []);
      constructor(readonly callback: MutationCallback) { DeferredMutationObserver.instances.push(this); }
      fire(records: MutationRecord[]) { this.callback(records, this as unknown as MutationObserver); }
    }
    const NativeMutationObserver = globalThis.MutationObserver;
    vi.stubGlobal('MutationObserver', DeferredMutationObserver as unknown as typeof MutationObserver);
    const document = page(row());
    let reject42!: (reason: Error) => void;
    const client = {
      loadPullRequest: vi.fn((identity: { number: number }) => {
        if (identity.number === 42) return new Promise<PullRequestRemoteSummary>((_resolve, reject) => { reject42 = reject; });
        return Promise.resolve(remote);
      }),
    };
    const updates: any[] = [];
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: {
        mount(_anchor, props) {
          updates.push(props);
          return { isConnected: () => true, remove: vi.fn(), update(next) { updates.push(next); } };
        },
      },
    });

    try {
      reconciler.reconcile();
      const title = document.querySelector<HTMLAnchorElement>('.Link--primary')!;
      title.setAttribute('href', '/octo/demo/pull/43');
      document.querySelector<HTMLAnchorElement>('.comments-link')!.setAttribute('href', '/octo/demo/pull/43#issuecomment-43');
      reject42(new Error('PR 42 failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(updates.some((entry) => entry.summary.diff.status === 'error')).toBe(false);

      const noNodes = document.createDocumentFragment().childNodes;
      DeferredMutationObserver.instances[0]!.fire([{
        addedNodes: noNodes,
        attributeName: 'href',
        attributeNamespace: null,
        nextSibling: null,
        oldValue: '/octo/demo/pull/42',
        previousSibling: null,
        removedNodes: noNodes,
        target: title,
        type: 'attributes',
      }]);
      await vi.waitFor(() => expect(client.loadPullRequest).toHaveBeenCalledTimes(2));
      expect(client.loadPullRequest.mock.calls.map(([identity]) => identity.number)).toEqual([42, 43]);
    } finally {
      reconciler.cleanup();
      vi.stubGlobal('MutationObserver', NativeMutationObserver);
    }
  });

  it('accepts a pending remote summary after a same-identity native count update', async () => {
    const document = page(row());
    let resolve!: (value: PullRequestRemoteSummary) => void;
    const client = {
      loadPullRequest: vi.fn(() => new Promise<PullRequestRemoteSummary>((done) => { resolve = done; })),
    };
    const updates: any[] = [];
    const removed = vi.fn();
    const reconciler = createPageReconciler({
      document,
      client,
      IntersectionObserver: undefined,
      uiFactory: {
        mount(_anchor, props) {
          updates.push(props);
          return { isConnected: () => true, remove: removed, update(next) { updates.push(next); } };
        },
      },
    });

    reconciler.reconcile();
    document.querySelector<HTMLAnchorElement>('.comments-link')!.setAttribute('aria-label', '24 comments');
    resolve(remote);

    await vi.waitFor(() => expect(updates.some((entry) =>
      entry.summary.reviewThreads.status === 'ready' &&
      entry.summary.totalComments.data?.count === 24,
    )).toBe(true));
    expect(client.loadPullRequest).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it('automatically propagates malformed and repaired native aria labels without an explicit reconciliation call', async () => {
    const document = page(row());
    const native = document.querySelector<HTMLAnchorElement>('.comments-link')!;
    const totals: any[] = [];
    const reconciler = createPageReconciler({ document, client: { loadPullRequest: vi.fn(async () => remote) }, IntersectionObserver: undefined, uiFactory: { mount(_anchor, props) { totals.push(props.summary.totalComments); return { isConnected: () => true, remove: vi.fn(), update(next) { totals.push(next.summary.totalComments); } }; } } });
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
    const mount = vi.fn((_anchor: Element, props: any) => { updates.push(props); return { isConnected: () => true, remove: vi.fn(), update(next: any) { updates.push(next); } }; });
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
