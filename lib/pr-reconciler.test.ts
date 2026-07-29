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
          return { remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(initial.anchor).toBe(counter);
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
          return { remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(initial.anchor).toBe(counter);
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
            return { remove: vi.fn(), update: vi.fn() };
          },
        },
      });

      reconciler.reconcile();
      await Promise.resolve();

      expect(initial.anchor).toBe(counterAnchor);
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
            return { remove: vi.fn(), update: vi.fn() };
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
            return { remove: vi.fn(), update: vi.fn() };
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
    const mount = vi.fn(() => ({ remove: vi.fn(), update: vi.fn() }));
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
          return { remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(mountedAt).toBe(counter);
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
          return { remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(mountedAt).toBe(counter);
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
          return { remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(mountedAt).toBe(counter);
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
          return { remove: vi.fn(), update: vi.fn() };
        },
      },
    });

    expect(() => reconciler.reconcile()).not.toThrow();
    await Promise.resolve();

    expect(mountedAt).toBe(counter);
    expect(counter.hidden).toBe(true);
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
        return { remove: vi.fn(), update: vi.fn() };
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

  it('creates and removes a zero-count anchor and remounts when GitHub replaces it', () => {
    const document = page(row(43, ''));
    const client = { loadPullRequest: vi.fn(async () => remote) };
    const mounted: Element[] = [];
    const reconciler = createPageReconciler({ document, client, IntersectionObserver: undefined, uiFactory: { mount(anchor) { mounted.push(anchor); return { remove: vi.fn(), update: vi.fn() }; } } });

    reconciler.reconcile();
    const extensionAnchor = document.querySelector('[data-pr-overview-zero-anchor]')!;
    expect(extensionAnchor).toBeTruthy();
    expect(extensionAnchor.tagName).toBe('SPAN');
    expect(extensionAnchor).not.toHaveAttribute('href');
    expect((extensionAnchor as HTMLElement).tabIndex).toBe(-1);
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
      loadPullRequest: vi.fn((identity: { number: number }, signal?: AbortSignal) => {
        signals.push(signal!);
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
          return { remove: removed, update(next) { updates.push(next); } };
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
          return { remove: vi.fn(), update(next) { updates.push(next); } };
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
          return { remove: removed, update(next) { updates.push(next); } };
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
