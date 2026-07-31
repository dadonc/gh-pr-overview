import { describe, expect, it, vi } from 'vitest';

import type { PullRequestLoadOptions, PullRequestRemoteSummary } from './github-client';
import { startContentRuntime } from './content-runtime';

function setupPage(url = '/octo/demo/pulls') {
  document.head.innerHTML = '<meta name="user-login" content="viewer">';
  document.body.innerHTML = '<div id="issue_42" class="js-issue-row"><a href="/octo/demo/pull/42">A PR</a><span class="opened-by"><a data-hovercard-type="user">author</a></span><a aria-label="2 comments" href="/octo/demo/pull/42#comments">2</a></div>';
  window.history.replaceState({}, '', url);
}

function locationChange(url: string) {
  return Object.assign(new Event('wxt:locationchange'), { newUrl: new URL(url, document.location.href) });
}

function startRuntime(initiallyEnabled = true) {
  const listeners = new Map<string, EventListener>();
  const frames: FrameRequestCallback[] = [];
  let invalidate!: () => void;
  const signals: AbortSignal[] = [];
  const removes: ReturnType<typeof vi.fn>[] = [];
  const client = {
    loadPullRequest: vi.fn((_identity, options?: PullRequestLoadOptions): Promise<PullRequestRemoteSummary> => {
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => {});
    }),
  };
  const mount = vi.fn(() => {
    const remove = vi.fn();
    removes.push(remove);
    return { isConnected: () => true, remove, update: vi.fn() };
  });
  const controller = startContentRuntime({
    ctx: {
      addEventListener(_target, type, listener) { listeners.set(type, listener as EventListener); },
      onInvalidated(listener) { invalidate = listener; return () => {}; },
      requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    },
    client,
    document,
    initiallyEnabled,
    uiFactory: { mount },
  });
  return { client, controller, frames, invalidate, listeners, mount, removes, signals };
}

describe('content runtime', () => {
  it('starts dormant and activates without a reload', async () => {
    setupPage();
    const runtime = startRuntime(false);

    expect(runtime.mount).not.toHaveBeenCalled();
    expect(runtime.client.loadPullRequest).not.toHaveBeenCalled();

    runtime.controller.setEnabled(true);
    await Promise.resolve();

    expect(runtime.mount).toHaveBeenCalledTimes(1);
    expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(1);
  });

  it('disables immediately and creates one fresh reconciler when re-enabled', async () => {
    setupPage();
    const runtime = startRuntime();
    await Promise.resolve();

    runtime.controller.setEnabled(false);

    expect(runtime.signals[0]!.aborted).toBe(true);
    expect(runtime.removes[0]).toHaveBeenCalledTimes(1);

    runtime.controller.setEnabled(false);
    runtime.controller.setEnabled(true);
    runtime.controller.setEnabled(true);
    await Promise.resolve();

    expect(runtime.mount).toHaveBeenCalledTimes(2);
    expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(2);
  });

  it('ignores navigation while disabled and enables against the current route', async () => {
    setupPage();
    const runtime = startRuntime(false);

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/pulls?q=reviewed'));
    window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
    expect(runtime.frames).toHaveLength(0);
    expect(runtime.mount).not.toHaveBeenCalled();

    runtime.controller.setEnabled(true);
    await Promise.resolve();
    expect(runtime.mount).toHaveBeenCalledTimes(1);
  });

  it('makes activation and queued frames inert after invalidation', async () => {
    setupPage();
    const runtime = startRuntime();
    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/pulls?q=reviewed'));
    await Promise.resolve();

    runtime.invalidate();
    runtime.controller.setEnabled(true);
    window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
    runtime.frames.shift()!(0);

    expect(runtime.mount).toHaveBeenCalledTimes(1);
    expect(runtime.removes[0]).toHaveBeenCalledTimes(1);
  });

  it('waits for a location event URL to become committed before tearing down rows', async () => {
    setupPage();
    const runtime = startRuntime();
    await Promise.resolve();

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/issues'));

    expect(runtime.frames).toHaveLength(1);
    expect(runtime.signals[0]!.aborted).toBe(false);
    expect(runtime.removes[0]).not.toHaveBeenCalled();
    expect(runtime.mount).toHaveBeenCalledTimes(1);

    runtime.frames.shift()!(0);
    expect(runtime.signals[0]!.aborted).toBe(false);
    expect(runtime.removes[0]).not.toHaveBeenCalled();
    expect(runtime.mount).toHaveBeenCalledTimes(1);

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/issues'));
    window.history.replaceState({}, '', '/octo/demo/issues');
    runtime.frames.shift()!(0);

    expect(runtime.signals[0]!.aborted).toBe(true);
    expect(runtime.removes[0]).toHaveBeenCalledTimes(1);
    expect(runtime.mount).toHaveBeenCalledTimes(1);
  });

  it('coalesces location events and keeps a same-pulls query navigation mounted', async () => {
    setupPage();
    const runtime = startRuntime();
    await Promise.resolve();

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/issues'));
    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/pulls?q=reviewed'));
    expect(runtime.frames).toHaveLength(1);

    window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
    runtime.frames.shift()!(0);

    expect(runtime.signals[0]!.aborted).toBe(false);
    expect(runtime.removes[0]).not.toHaveBeenCalled();
    expect(runtime.mount).toHaveBeenCalledTimes(1);
    expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(1);
  });

  it('uses the latest coalesced location event when it commits to a non-pulls route', async () => {
    setupPage();
    const runtime = startRuntime();
    await Promise.resolve();

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/pulls?q=reviewed'));
    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/issues'));
    expect(runtime.frames).toHaveLength(1);

    window.history.replaceState({}, '', '/octo/demo/issues');
    runtime.frames.shift()!(0);

    expect(runtime.signals[0]!.aborted).toBe(true);
    expect(runtime.removes[0]).toHaveBeenCalledTimes(1);
    expect(runtime.mount).toHaveBeenCalledTimes(1);
    expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a stale committed location after a newer coalesced event', async () => {
    setupPage();
    const runtime = startRuntime();
    await Promise.resolve();

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/issues'));
    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/pulls?q=reviewed'));
    expect(runtime.frames).toHaveLength(1);

    window.history.replaceState({}, '', '/octo/demo/issues');
    runtime.frames.shift()!(0);

    expect(runtime.signals[0]!.aborted).toBe(false);
    expect(runtime.removes[0]).not.toHaveBeenCalled();
    expect(runtime.mount).toHaveBeenCalledTimes(1);
    expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(1);
  });

  it('makes a queued location frame inert after invalidation cleanup', async () => {
    setupPage();
    const runtime = startRuntime();
    await Promise.resolve();

    runtime.listeners.get('wxt:locationchange')!(locationChange('/octo/demo/pulls?q=reviewed'));
    window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
    runtime.invalidate();
    runtime.frames.shift()!(0);

    document.body.insertAdjacentHTML('beforeend', '<div id="issue_43" class="js-issue-row"><a href="/octo/demo/pull/43">Another PR</a><span class="opened-by"><a data-hovercard-type="user">author</a></span><a aria-label="1 comment" href="/octo/demo/pull/43#comments">1</a></div>');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.signals[0]!.aborted).toBe(true);
    expect(runtime.removes[0]).toHaveBeenCalledTimes(1);
    expect(runtime.mount).toHaveBeenCalledTimes(1);
    expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(1);
  });
});
