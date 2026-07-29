import { describe, expect, it, vi } from 'vitest';

import type { PullRequestRemoteSummary } from './github-client';
import { startContentRuntime } from './content-runtime';

function setupPage() {
  document.head.innerHTML = '<meta name="user-login" content="viewer">';
  document.body.innerHTML = '<div id="issue_42" class="js-issue-row"><a href="/octo/demo/pull/42">A PR</a><span class="opened-by"><a data-hovercard-type="user">author</a></span><a aria-label="2 comments" href="/octo/demo/pull/42#comments">2</a></div>';
  window.history.replaceState({}, '', '/octo/demo/pulls');
}

describe('content runtime', () => {
  it('reconciles initially, tears down on Turbo route changes, and honors context invalidation', async () => {
    setupPage();
    const listeners = new Map<string, EventListener>();
    let invalidate!: () => void;
    const controller = new AbortController();
    const client = { loadPullRequest: vi.fn((_identity, signal?: AbortSignal): Promise<PullRequestRemoteSummary> => { signal?.addEventListener('abort', () => controller.abort()); return new Promise(() => {}); }) };
    const remove = vi.fn();
    startContentRuntime({
      ctx: { addEventListener(_target, type, listener) { listeners.set(String(type), listener as EventListener); }, onInvalidated(listener) { invalidate = listener; return () => {}; } },
      client,
      document,
      uiFactory: { mount() { return { remove, update: vi.fn() }; } },
    });

    expect(client.loadPullRequest).toHaveBeenCalledOnce();
    await Promise.resolve();
    window.history.replaceState({}, '', '/octo/demo/issues');
    listeners.get('wxt:locationchange')!(new Event('wxt:locationchange'));
    expect(controller.signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    invalidate();
    expect(remove).toHaveBeenCalledOnce();
  });
});
