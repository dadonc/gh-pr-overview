import { act, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CARD_STYLES } from '../lib/pr-card';
import currentConversationHtml from './fixtures/github/current/conversation.html?raw';
import currentFilesHtml from './fixtures/github/current/files.html?raw';
import currentPrListHtml from './fixtures/github/current/pr-list.html?raw';
import currentTimelineFragmentHtml from './fixtures/github/current/timeline-fragment.html?raw';

interface FakeContext {
  addEventListener(target: Window, type: string, listener: EventListener): void;
  onInvalidated(listener: () => void): () => void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

interface ReactRoot {
  render(node: React.ReactNode): void;
  unmount(): void;
}

interface ShadowRootUiOptions {
  anchor: Element;
  css: string;
  onMount(container: HTMLElement): ReactRoot;
  onRemove?(root: ReactRoot | undefined): void;
}

const wxtBoundary = vi.hoisted(() => ({
  options: undefined as ShadowRootUiOptions | undefined,
}));
const pendingInvalidations: Array<() => void> = [];

vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  async createShadowRootUi(ctx: FakeContext, options: ShadowRootUiOptions) {
    wxtBoundary.options = options;
    const host = document.createElement('github-pr-overview');
    options.anchor.after(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.append(container);
    let mounted: ReactRoot | undefined;
    const remove = () => {
      options.onRemove?.(mounted);
      host.remove();
      mounted = undefined;
    };
    ctx.onInvalidated(remove);
    return {
      shadowHost: host,
      mount() { act(() => { mounted = options.onMount(container); }); },
      remove,
      get mounted() { return mounted; },
    };
  },
}));

let definition: {
  matches: string[];
  main(ctx: FakeContext): Promise<void>;
};

function response(html: string, url: string): Response {
  return {
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    ok: true,
    status: 200,
    text: async () => html,
    url,
  } as Response;
}

function currentPullRequestRow(): void {
  const fixture = new DOMParser().parseFromString(currentPrListHtml, 'text/html');
  document.head.innerHTML = fixture.head.innerHTML;
  document.body.innerHTML = fixture.querySelector('#issue_42')!.outerHTML;
  window.history.replaceState({}, '', '/octo/demo/pulls');
}

function renderedOverviewLine(): string | undefined {
  const card = document.querySelector('github-pr-overview')
    ?.shadowRoot
    ?.querySelector<HTMLElement>('.pr-overview-card');
  if (!card) return undefined;
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
  return [...clone.children]
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function loadContentEntrypoint(fetcher: typeof fetch): Promise<void> {
  vi.stubGlobal('defineContentScript', (value: typeof definition) => {
    definition = value;
    return value;
  });
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  await import('../entrypoints/content');
}

afterEach(() => {
  act(() => {
    for (const invalidate of pendingInvalidations.splice(0)) invalidate();
  });
  wxtBoundary.options = undefined;
  vi.doUnmock('../lib/github-client');
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('renders the real content entrypoint with fixture-backed data and restores the native counter on invalidation', async () => {
  currentPullRequestRow();
  const fixtures = new Map([
    ['https://github.com/octo/demo/pull/42', currentConversationHtml],
    ['https://github.com/octo/demo/pull/42/files', currentFilesHtml],
    ['https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42', currentTimelineFragmentHtml],
  ]);
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const fixture = fixtures.get(url);
    if (!fixture) throw new Error(`Unexpected fixture request: ${url}`);
    return response(fixture, url);
  });
  const listeners = new Map<string, EventListener>();
  const invalidations: Array<() => void> = [];
  const frames: FrameRequestCallback[] = [];
  const context: FakeContext = {
    addEventListener(_target, type, listener) { listeners.set(type, listener); },
    onInvalidated(listener) { invalidations.push(listener); return () => {}; },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
  };

  await loadContentEntrypoint(fetcher);

  await definition.main(context);

  expect(definition.matches).toEqual(['https://github.com/*/*/pulls*']);
  expect(wxtBoundary.options?.css).toBe(CARD_STYLES);
  expect(wxtBoundary.options).not.toHaveProperty('cssInjectionMode');

  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('2 comments · 0 unresolved · −353/+524 · 18 files · Copilot 1');
  });
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([...fixtures.keys()]));
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ credentials: 'same-origin', method: 'GET', redirect: 'follow' });
  }

  listeners.get('wxt:locationchange')!(Object.assign(new Event('wxt:locationchange'), {
    newUrl: new URL('https://github.com/octo/demo/pulls?q=reviewed'),
  }));
  expect(frames).toHaveLength(1);
  await act(async () => {
    window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
    frames.shift()!(0);
  });

  const nativeCounter = document.querySelector<HTMLAnchorElement>('a[aria-label="2 comments"]')!;
  expect(nativeCounter.hidden).toBe(true);
  await act(async () => { invalidations.at(-1)!(); });
  expect(document.querySelector('github-pr-overview')).toBeNull();
  expect(nativeCounter.hidden).toBe(false);
  expect(nativeCounter).not.toHaveAttribute('aria-hidden');
  expect(nativeCounter).not.toHaveAttribute('tabindex');
});

it('renders the completed diff before timeline loading finishes', async () => {
  currentPullRequestRow();
  const files = deferred<Response>();
  const conversation = deferred<Response>();
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://github.com/octo/demo/pull/42/files') return files.promise;
    if (url === 'https://github.com/octo/demo/pull/42') return conversation.promise;
    if (url === 'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42') {
      return Promise.resolve(response(currentTimelineFragmentHtml, url));
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const context: FakeContext = {
    addEventListener() {},
    onInvalidated(listener) { pendingInvalidations.push(listener); return () => {}; },
    requestAnimationFrame() { return 1; },
  };

  await loadContentEntrypoint(fetcher as typeof fetch);
  await definition.main(context);

  await waitFor(() => {
    expect(fetcher).toHaveBeenCalledWith('https://github.com/octo/demo/pull/42/files', expect.anything());
    expect(fetcher).toHaveBeenCalledWith('https://github.com/octo/demo/pull/42', expect.anything());
  });

  await act(async () => {
    files.resolve(response(currentFilesHtml, 'https://github.com/octo/demo/pull/42/files'));
  });

  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('2 comments · Loading unresolved… · −353/+524 · 18 files · Loading agents…');
  });

  await act(async () => {
    conversation.resolve(response(currentConversationHtml, 'https://github.com/octo/demo/pull/42'));
  });
  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('2 comments · 0 unresolved · −353/+524 · 18 files · Copilot 1');
  });
});

it('keeps only two active real entrypoint rows until either completes', async () => {
  const fixture = new DOMParser().parseFromString(currentPrListHtml, 'text/html');
  const third = fixture.querySelector<HTMLElement>('#issue_42')!.cloneNode(true) as HTMLElement;
  third.id = 'issue_44';
  for (const link of third.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    link.href = link.getAttribute('href')!.replaceAll('/42', '/44');
  }
  document.head.innerHTML = fixture.head.innerHTML;
  document.body.replaceChildren(
    fixture.querySelector<HTMLElement>('#issue_42')!,
    fixture.querySelector<HTMLElement>('#issue_43')!,
    third,
  );
  window.history.replaceState({}, '', '/octo/demo/pulls');

  const completions = new Map<number, ReturnType<typeof deferred<{
    agents: { data: []; status: 'ready' };
    diff: { data: { additions: number; deletions: number; filesChanged: number }; status: 'ready' };
    reviewThreads: { data: { resolvedOrOutdated: number; total: number; unresolved: number }; status: 'ready' };
  }>>>();
  const loadPullRequest = vi.fn((identity: { number: number }) => {
    const completion = deferred<{
      agents: { data: []; status: 'ready' };
      diff: { data: { additions: number; deletions: number; filesChanged: number }; status: 'ready' };
      reviewThreads: { data: { resolvedOrOutdated: number; total: number; unresolved: number }; status: 'ready' };
    }>();
    completions.set(identity.number, completion);
    return completion.promise;
  });
  vi.doMock('../lib/github-client', () => ({
    createGitHubClient: () => ({ loadPullRequest }),
  }));
  const context: FakeContext = {
    addEventListener() {},
    onInvalidated(listener) { pendingInvalidations.push(listener); return () => {}; },
    requestAnimationFrame() { return 1; },
  };

  await loadContentEntrypoint(vi.fn() as unknown as typeof fetch);
  await definition.main(context);

  await waitFor(() => {
    expect(loadPullRequest.mock.calls.map(([identity]) => identity.number)).toEqual([42, 43]);
  });

  await act(async () => {
    completions.get(43)!.resolve({
      agents: { data: [], status: 'ready' },
      diff: { data: { additions: 43, deletions: 1, filesChanged: 2 }, status: 'ready' },
      reviewThreads: { data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 }, status: 'ready' },
    });
  });

  await waitFor(() => {
    expect(loadPullRequest.mock.calls.map(([identity]) => identity.number)).toEqual([42, 43, 44]);
  });

  await act(async () => {
    for (const number of [42, 44]) {
      completions.get(number)!.resolve({
        agents: { data: [], status: 'ready' },
        diff: { data: { additions: number, deletions: 1, filesChanged: 2 }, status: 'ready' },
        reviewThreads: { data: { resolvedOrOutdated: 0, total: 0, unresolved: 0 }, status: 'ready' },
      });
    }
  });
});
