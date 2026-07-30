import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PullRequestSummary } from './domain';
import { PullRequestCard, CARD_STYLES } from './pr-card';

const ready: PullRequestSummary = {
  agents: { data: [
    { agentId: 'codex', responseCount: 3, requestSources: ['formal-review-request'], state: 'responded' },
    { agentId: 'claude', responseCount: 0, requestSources: ['eyes-reaction'], state: 'requested' },
  ], status: 'ready' },
  authoredByViewer: true,
  diff: { data: { additions: 340, deletions: 81, filesChanged: 12 }, status: 'ready' },
  reviewThreads: { data: { resolvedOrOutdated: 6, total: 8, unresolved: 2 }, status: 'ready' },
  totalComments: { data: { count: 23, href: '/octo/demo/pull/42#issuecomment-23' }, status: 'ready' },
};

function visibleCardText(card = screen.getByTestId('pr-card')): string {
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
  return [...clone.children]
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

describe('PullRequestCard', () => {
  it('renders the approved single-line token order with distinct links and explicit separators', () => {
    render(<PullRequestCard summary={ready} conversationHref="/octo/demo/pull/42" filesHref="/octo/demo/pull/42/files" />);

    expect(visibleCardText()).toBe('23 comments · 2 unresolved · −81/+340 · 12 files · Codex 3 · Claude 0');

    const comments = screen.getByRole('link', { name: '23 comments' });
    const unresolved = screen.getByRole('link', { name: '2 unresolved review threads' });
    const diff = screen.getByRole('link', { name: '81 deletions, 340 additions, 12 files changed' });
    expect(comments).toHaveAttribute('href', '/octo/demo/pull/42#issuecomment-23');
    expect(unresolved).toHaveAttribute('href', '/octo/demo/pull/42');
    expect(diff).toHaveAttribute('href', '/octo/demo/pull/42/files');
    expect(unresolved).toHaveClass('unresolved');
    expect(comments).not.toHaveClass('unresolved');
    expect(diff).not.toHaveClass('unresolved');
    expect(screen.getByText('−81')).toHaveClass('deletions');
    expect(screen.getByText('+340')).toHaveClass('additions');
    expect(screen.getByText('Codex 3')).not.toHaveClass('unresolved');

    const separators = screen.getAllByText('·', { selector: '.separator' });
    expect(separators).toHaveLength(4);
    for (const separator of separators) expect(separator).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('·', { selector: '.diff-separator' })).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders exact zero totals and requested-only agents without fabrication', () => {
    render(<PullRequestCard summary={{
      ...ready,
      authoredByViewer: false,
      agents: { data: [
        { agentId: 'gemini', responseCount: 0, requestSources: ['formal-review-request'], state: 'requested' },
      ], status: 'ready' },
      reviewThreads: { data: { total: 0, unresolved: 0, resolvedOrOutdated: 0 }, status: 'ready' },
      totalComments: { data: { count: 0, href: '/o/r/pull/1' }, status: 'ready' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(visibleCardText()).toBe('0 comments · 0 unresolved · −81/+340 · 12 files · Gemini 0');
    expect(screen.getByRole('link', { name: '0 unresolved review threads' })).not.toHaveClass('unresolved');
  });

  it('renders a ready empty agent section as definitive', () => {
    render(<PullRequestCard
      summary={{ ...ready, agents: { data: [], status: 'ready' } }}
      conversationHref="/o/r/pull/1"
      filesHref="/o/r/pull/1/files"
    />);

    expect(visibleCardText()).toBe('23 comments · 2 unresolved · −81/+340 · 12 files · No AI agents');
  });

  it('keeps loading, partial, and error states in their fixed line positions', () => {
    render(<PullRequestCard summary={{
      ...ready,
      totalComments: { message: 'GitHub counter is malformed.', status: 'error' },
      reviewThreads: { data: { total: 8, unresolved: 2, resolvedOrOutdated: 6 }, reason: 'More content is loading.', status: 'partial' },
      diff: { data: { additions: 340, deletions: 81, filesChanged: 12 }, reason: 'Collapsed files.', status: 'partial' },
      agents: { status: 'loading' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(visibleCardText()).toBe('— comments · 2 unresolved · −81+/+340+ · 12+ files · Loading agents…');
    expect(screen.getByText('— comments')).toHaveAttribute('title', 'GitHub counter is malformed.');
    expect(screen.getByRole('link', { name: 'At least 2 unresolved review threads' })).toHaveAttribute('title', 'More content is loading.');
    expect(screen.getByRole('link', { name: 'At least 81 deletions, 340 additions, 12 files changed' })).toHaveAttribute('title', 'Collapsed files.');
    expect(screen.getByLabelText('Loading AI agents')).toBeVisible();
  });

  it('uses singular grammar and exposes every error reason to assistive technology', () => {
    const view = render(<PullRequestCard summary={{
      ...ready,
      totalComments: { data: { count: 1, href: '/o/r/pull/1#comments' }, status: 'ready' },
      reviewThreads: { data: { total: 1, unresolved: 1, resolvedOrOutdated: 0 }, status: 'ready' },
      diff: { data: { additions: 1, deletions: 1, filesChanged: 1 }, status: 'ready' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(visibleCardText()).toBe('1 comment · 1 unresolved · −1/+1 · 1 file · Codex 3 · Claude 0');
    expect(screen.getByRole('link', { name: '1 unresolved review thread' })).toBeVisible();
    expect(screen.getByRole('link', { name: '1 deletion, 1 addition, 1 file changed' })).toBeVisible();

    view.rerender(<PullRequestCard summary={{
      ...ready,
      totalComments: { message: 'counter failed', status: 'error' },
      reviewThreads: { message: 'threads failed', status: 'error' },
      diff: { message: 'files failed', status: 'error' },
      agents: { message: 'agents failed', status: 'error' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(visibleCardText()).toBe('— comments · — unresolved · — files · AI agents unavailable');
    expect(screen.getByText('— unresolved')).not.toHaveClass('unresolved');
    for (const reason of ['counter failed', 'threads failed', 'files failed', 'agents failed']) {
      expect(screen.getByText(reason, { selector: '.sr-only' })).toBeInTheDocument();
    }
  });

  it('marks partial metrics as lower bounds and never treats partial empty agents as definitive', () => {
    render(<PullRequestCard summary={{
      ...ready,
      totalComments: { data: { count: 23, href: '/o/r/pull/1#comments' }, reason: 'counter may still change', status: 'partial' },
      reviewThreads: { data: { total: 8, unresolved: 0, resolvedOrOutdated: 6 }, reason: 'timeline is incomplete', status: 'partial' },
      agents: { data: [], reason: 'timeline is incomplete', status: 'partial' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(visibleCardText()).toBe('23+ comments · 0 unresolved · −81/+340 · 12 files · No AI agents detected yet');
    expect(screen.getByText('23+ comments')).toHaveAttribute('aria-describedby');
    const unresolved = screen.getByRole('link', { name: 'At least 0 unresolved review threads' });
    expect(unresolved).toHaveAttribute('aria-describedby');
    expect(unresolved).not.toHaveClass('unresolved');
    expect(unresolved).not.toHaveTextContent('+');
    expect(screen.getByText('No AI agents detected yet')).toHaveAttribute('aria-describedby');
  });

  it('keeps partial agent counts visually terse while preserving the reason accessibly', () => {
    render(<PullRequestCard summary={{
      ...ready,
      agents: { data: [
        { agentId: 'codex', responseCount: 3, requestSources: ['formal-review-request'], state: 'responded' },
      ], reason: 'Some timeline fragments were unavailable.', status: 'partial' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    const agent = screen.getByText('Codex 3');
    expect(agent).toHaveAttribute('aria-describedby');
    expect(agent).toHaveAttribute(
      'title',
      'Responded after a formal review request. At least 3 responses detected. Partial agent data: Some timeline fragments were unavailable.',
    );
    expect(agent).not.toHaveTextContent('+');
    expect(screen.getByText(
      /At least 3 responses detected\. Partial agent data: Some timeline fragments were unavailable\./,
      { selector: '.sr-only' },
    )).toBeInTheDocument();
  });

  it.each([
    [
      'total comments',
      { ...ready, totalComments: { status: 'loading' } },
      'Loading comments… · 2 unresolved · −81/+340 · 12 files · Codex 3 · Claude 0',
    ],
    [
      'review threads',
      { ...ready, reviewThreads: { status: 'loading' } },
      '23 comments · Loading unresolved… · −81/+340 · 12 files · Codex 3 · Claude 0',
    ],
    [
      'changed files',
      { ...ready, diff: { status: 'loading' } },
      '23 comments · 2 unresolved · Loading files… · Codex 3 · Claude 0',
    ],
    [
      'AI agents',
      { ...ready, agents: { status: 'loading' } },
      '23 comments · 2 unresolved · −81/+340 · 12 files · Loading agents…',
    ],
  ] as const satisfies readonly [string, PullRequestSummary, string][])('keeps the exact line while only %s is loading', (sectionName, loading, line) => {
    render(<PullRequestCard summary={loading} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'true');
    expect(visibleCardText()).toBe(line);
    if (sectionName === 'review threads') {
      expect(screen.getByLabelText('Loading unresolved review threads')).not.toHaveClass('unresolved');
    }
  });

  it('updates aria-busy and retains one stable status node as sections load', () => {
    const loading: PullRequestSummary = { ...ready, totalComments: { status: 'loading' } };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);
    const status = screen.getByRole('status');
    const expectStatus = (message: string) => {
      const currentStatus = screen.getByRole('status');
      expect(currentStatus).toBe(status);
      expect(currentStatus).toHaveAttribute('role', 'status');
      expect(currentStatus).toHaveAttribute('aria-live', 'polite');
      expect(currentStatus).toHaveAttribute('aria-atomic', 'true');
      expect(currentStatus.textContent).toBe(message);
      expect(screen.getAllByRole('status')).toHaveLength(1);
    };

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'false');
    expectStatus('Pull request overview updated.');

    view.rerender(<PullRequestCard summary={loading} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'true');
    expectStatus('Loading pull request overview.');

    view.rerender(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'false');
    expectStatus('Pull request overview updated.');
    expect(screen.getByText('23 comments')).toBeVisible();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('Rendered more hooks'));
    consoleError.mockRestore();
  });

  it('uses registry labels with response precedence, provenance, and tab hrefs', () => {
    render(<PullRequestCard summary={ready} conversationHref="/octo/demo/pull/42" filesHref="/octo/demo/pull/42/files" />);

    expect(screen.getByText('Codex 3')).toHaveAttribute('title', 'Responded after a formal review request.');
    expect(screen.getByText('Claude 0')).toHaveAttribute('title', 'Requested — detected from 👀 reaction.');
    expect(screen.getByRole('link', { name: '2 unresolved review threads' })).toHaveAttribute('href', '/octo/demo/pull/42');
    expect(screen.getByRole('link', { name: '81 deletions, 340 additions, 12 files changed' })).toHaveAttribute('href', '/octo/demo/pull/42/files');
  });

  it('does not invent request provenance for responses and retains every request source accessibly', () => {
    render(<PullRequestCard summary={{ ...ready, agents: { data: [
      { agentId: 'codex', responseCount: 3, requestSources: [], state: 'responded' },
      { agentId: 'claude', responseCount: 0, requestSources: ['formal-review-request', 'started-reviewing', 'eyes-reaction'], state: 'requested' },
    ], status: 'ready' } }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByText('Codex 3')).toHaveAttribute('title', 'Responded 3 times.');
    const requested = screen.getByText('Claude 0');
    expect(requested.getAttribute('title')).toContain('formal review request');
    expect(requested.getAttribute('title')).toContain('started reviewing');
    expect(requested.getAttribute('title')).toContain('👀 reaction');
    expect(requested).toHaveAttribute('aria-describedby');
  });

  it('announces authorship and ships isolated no-wrap, overflow, focus, and motion styling', () => {
    render(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByText('Authored by you', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByTestId('pr-card')).toHaveClass('authored');
    expect(screen.getByRole('group', { name: 'Pull request review overview' })).toBeInTheDocument();
    expect(CARD_STYLES).toContain('flex-flow: row nowrap');
    expect(CARD_STYLES).toContain('white-space: nowrap');
    expect(CARD_STYLES).toContain('overflow-x: auto');
    expect(CARD_STYLES).toContain('margin-inline-start: 0');
    expect(CARD_STYLES).not.toContain('margin-inline-start: auto');
    expect(CARD_STYLES).toContain('color: var(--fgColor-danger');
    expect(CARD_STYLES).toContain('color: var(--fgColor-success');
    expect(CARD_STYLES).toContain('--fgColor-accent');
    expect(CARD_STYLES).toContain(':focus-visible');
    expect(CARD_STYLES).toContain('prefers-reduced-motion: reduce');
  });
});
