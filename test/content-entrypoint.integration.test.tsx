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
const pendingInvalidations = new Set<() => void>();

type StorageListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

let storedEnabled: unknown = true;
const storageListeners = new Set<StorageListener>();
const browserMock = {
  storage: {
    local: {
      get: vi.fn(async () => ({ enabled: storedEnabled })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        storedEnabled = items.enabled;
      }),
    },
    onChanged: {
      addListener: vi.fn((listener: StorageListener) => {
        storageListeners.add(listener);
      }),
      removeListener: vi.fn((listener: StorageListener) => {
        storageListeners.delete(listener);
      }),
    },
  },
};

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

function createFakeContext() {
  const frames: FrameRequestCallback[] = [];
  const invalidations: Array<() => void> = [];
  const listeners = new Map<string, EventListener>();
  let invalidated = false;
  const value: FakeContext = {
    addEventListener(_target, type, listener) {
      listeners.set(type, listener);
    },
    onInvalidated(listener) {
      if (invalidated) return () => {};
      let active = true;
      const invalidate = () => {
        if (!active) return;
        active = false;
        pendingInvalidations.delete(invalidate);
        listener();
      };
      invalidations.push(invalidate);
      pendingInvalidations.add(invalidate);
      return () => {
        active = false;
        pendingInvalidations.delete(invalidate);
      };
    },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
  };
  const invalidate = () => {
    if (invalidated) return;
    invalidated = true;
    for (const callback of [...invalidations]) callback();
  };
  return { frames, invalidate, invalidations, listeners, value };
}

function resetBrowserMock(): void {
  storedEnabled = true;
  storageListeners.clear();
  browserMock.storage.local.get.mockReset();
  browserMock.storage.local.get.mockImplementation(async () => ({ enabled: storedEnabled }));
  browserMock.storage.local.set.mockReset();
  browserMock.storage.local.set.mockImplementation(async (items) => {
    storedEnabled = items.enabled;
  });
  browserMock.storage.onChanged.addListener.mockReset();
  browserMock.storage.onChanged.addListener.mockImplementation((listener) => {
    storageListeners.add(listener);
  });
  browserMock.storage.onChanged.removeListener.mockReset();
  browserMock.storage.onChanged.removeListener.mockImplementation((listener) => {
    storageListeners.delete(listener);
  });
}

async function loadContentEntrypoint(fetcher: typeof fetch): Promise<void> {
  vi.stubGlobal('defineContentScript', (value: typeof definition) => {
    definition = value;
    return value;
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('browser', browserMock);
  vi.resetModules();
  await import('../entrypoints/content');
}

afterEach(() => {
  act(() => {
    for (const invalidate of [...pendingInvalidations]) invalidate();
  });
  wxtBoundary.options = undefined;
  vi.doUnmock('../lib/github-client');
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetBrowserMock();
});

it('renders the real content entrypoint and never mutates the native counter', async () => {
  currentPullRequestRow();
  const nativeCounter = document.querySelector<HTMLAnchorElement>('a[aria-label="2 comments"]')!;
  const nativeAttributes = {
    ariaHidden: nativeCounter.getAttribute('aria-hidden'),
    hidden: nativeCounter.hidden,
    style: nativeCounter.getAttribute('style'),
    tabindex: nativeCounter.getAttribute('tabindex'),
  };
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
  const context = createFakeContext();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  browserMock.storage.local.get.mockRejectedValueOnce(new Error('storage read'));

  await loadContentEntrypoint(fetcher);

  await definition.main(context.value);

  expect(definition.matches).toEqual(['https://github.com/*/*/pulls*']);
  expect(wxtBoundary.options?.css).toBe(CARD_STYLES);
  expect(wxtBoundary.options).not.toHaveProperty('cssInjectionMode');

  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('0 unresolved · −353/+524 · 18 files · Copilot 1');
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Unable to read extension enabled preference; defaulting to enabled.',
  );
  expect(nativeCounter).toBeVisible();
  expect({
    ariaHidden: nativeCounter.getAttribute('aria-hidden'),
    hidden: nativeCounter.hidden,
    style: nativeCounter.getAttribute('style'),
    tabindex: nativeCounter.getAttribute('tabindex'),
  }).toEqual(nativeAttributes);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([...fixtures.keys()]));
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ credentials: 'same-origin', method: 'GET', redirect: 'follow' });
  }

  context.listeners.get('wxt:locationchange')!(Object.assign(new Event('wxt:locationchange'), {
    newUrl: new URL('https://github.com/octo/demo/pulls?q=reviewed'),
  }));
  expect(context.frames).toHaveLength(1);
  await act(async () => {
    window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
    context.frames.shift()!(0);
  });

  act(context.invalidate);
  expect(document.querySelector('github-pr-overview')).toBeNull();
  expect({
    ariaHidden: nativeCounter.getAttribute('aria-hidden'),
    hidden: nativeCounter.hidden,
    style: nativeCounter.getAttribute('style'),
    tabindex: nativeCounter.getAttribute('tabindex'),
  }).toEqual(nativeAttributes);
});

it('starts dormant when the stored preference is disabled', async () => {
  currentPullRequestRow();
  storedEnabled = false;
  const context = createFakeContext();
  const fetcher = vi.fn();

  await loadContentEntrypoint(fetcher as unknown as typeof fetch);
  await definition.main(context.value);

  expect(document.querySelector('github-pr-overview')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
});

it('applies storage toggles immediately without navigating or leaking its listener', async () => {
  currentPullRequestRow();
  const context = createFakeContext();
  const fixtures = new Map([
    ['https://github.com/octo/demo/pull/42', currentConversationHtml],
    ['https://github.com/octo/demo/pull/42/files', currentFilesHtml],
    ['https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42', currentTimelineFragmentHtml],
  ]);
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const fixture = fixtures.get(url);
    if (!fixture) throw new Error(`Unexpected fixture request: ${url}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return response(fixture, url);
  });

  await loadContentEntrypoint(fetcher);
  await definition.main(context.value);
  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('0 unresolved · −353/+524 · 18 files · Copilot 1');
  });
  const href = window.location.href;
  const firstCycleSignals = fetcher.mock.calls.map(([, init]) => init?.signal as AbortSignal);

  act(() => {
    for (const listener of storageListeners) {
      listener({ enabled: { oldValue: true, newValue: false } }, 'local');
    }
  });
  await waitFor(() => {
    expect(document.querySelector('github-pr-overview')).toBeNull();
  });
  expect(firstCycleSignals).not.toHaveLength(0);
  expect(firstCycleSignals.every((signal) => signal.aborted)).toBe(true);

  act(() => {
    for (const listener of storageListeners) {
      listener({ enabled: { oldValue: false, newValue: true } }, 'local');
    }
  });
  await waitFor(() => {
    expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
  });
  expect(window.location.href).toBe(href);

  act(context.invalidate);
  expect(browserMock.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  expect(storageListeners).toHaveLength(0);
});

it('keeps the latest storage event when the initial read resolves later', async () => {
  currentPullRequestRow();
  const context = createFakeContext();
  let resolveRead!: (value: { enabled: unknown }) => void;
  browserMock.storage.local.get.mockReturnValueOnce(new Promise((resolve) => {
    resolveRead = resolve;
  }));

  await loadContentEntrypoint(vi.fn() as unknown as typeof fetch);
  const main = definition.main(context.value);
  await vi.waitFor(() => {
    expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });
  for (const listener of storageListeners) {
    listener({ enabled: { newValue: false } }, 'local');
  }
  resolveRead({ enabled: true });

  await main;
  expect(document.querySelector('github-pr-overview')).toBeNull();
});

it('does not start and removes its storage listener when invalidated during the initial read', async () => {
  currentPullRequestRow();
  const context = createFakeContext();
  let resolveRead!: (value: { enabled: unknown }) => void;
  browserMock.storage.local.get.mockReturnValueOnce(new Promise((resolve) => {
    resolveRead = resolve;
  }));
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));

  await loadContentEntrypoint(fetcher as typeof fetch);
  const main = definition.main(context.value);
  await vi.waitFor(() => {
    expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });
  context.invalidate();
  resolveRead({ enabled: true });

  await main;
  expect(browserMock.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  expect(storageListeners).toHaveLength(0);
  expect(document.querySelector('github-pr-overview')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
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
  const context = createFakeContext();

  await loadContentEntrypoint(fetcher as typeof fetch);
  await definition.main(context.value);

  await waitFor(() => {
    expect(fetcher).toHaveBeenCalledWith('https://github.com/octo/demo/pull/42/files', expect.anything());
    expect(fetcher).toHaveBeenCalledWith('https://github.com/octo/demo/pull/42', expect.anything());
  });

  await act(async () => {
    files.resolve(response(currentFilesHtml, 'https://github.com/octo/demo/pull/42/files'));
  });

  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('Loading unresolved… · −353/+524 · 18 files · Loading agents…');
  });

  await act(async () => {
    conversation.resolve(response(currentConversationHtml, 'https://github.com/octo/demo/pull/42'));
  });
  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('0 unresolved · −353/+524 · 18 files · Copilot 1');
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
  const context = createFakeContext();

  await loadContentEntrypoint(vi.fn() as unknown as typeof fetch);
  await definition.main(context.value);

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
