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

afterEach(() => {
  wxtBoundary.options = undefined;
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

  vi.stubGlobal('defineContentScript', (value: typeof definition) => {
    definition = value;
    return value;
  });
  vi.stubGlobal('fetch', fetcher);
  await import('../entrypoints/content');

  await definition.main(context);

  expect(definition.matches).toEqual(['https://github.com/*/*/pulls*']);
  expect(wxtBoundary.options?.css).toBe(CARD_STYLES);
  expect(wxtBoundary.options).not.toHaveProperty('cssInjectionMode');

  await waitFor(() => {
    expect(renderedOverviewLine()).toBe('2 comments · 0 unresolved · −353/+524 18 files · Copilot 1');
  });
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([...fixtures.keys()]));
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ credentials: 'same-origin', method: 'GET', redirect: 'error' });
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
