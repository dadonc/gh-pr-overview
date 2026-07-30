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

describe('PullRequestCard', () => {
  it('keeps the native total independent and most prominent from review-thread metrics', () => {
    render(<PullRequestCard summary={ready} conversationHref="/octo/demo/pull/42" filesHref="/octo/demo/pull/42/files" />);

    expect(screen.getByRole('link', { name: '23 total comments' })).toHaveAttribute('href', '/octo/demo/pull/42#issuecomment-23');
    expect(screen.getByRole('link', { name: /8 review threads/ })).toHaveTextContent('8 review threads · 2 unresolved · 6 resolved+outdated');
    expect(screen.getByText('23 total comments').className).toContain('total');
    expect(screen.getByText(/8 review threads/).className).not.toContain('total');
  });

  it('renders exact zero totals and exact zero threads without fabrication', () => {
    render(<PullRequestCard summary={{ ...ready, authoredByViewer: false, agents: { data: [], status: 'ready' }, reviewThreads: { data: { total: 0, unresolved: 0, resolvedOrOutdated: 0 }, status: 'ready' }, totalComments: { data: { count: 0, href: '/o/r/pull/1' }, status: 'ready' } }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByText('0 total comments')).toBeVisible();
    expect(screen.getByText('0 review threads · 0 unresolved · 0 resolved+outdated')).toBeVisible();
    expect(screen.getByText('No AI agents')).toBeVisible();
  });

  it('renders independently loading, partial, and error section states', () => {
    render(<PullRequestCard summary={{ ...ready,
      totalComments: { message: 'GitHub counter is malformed.', status: 'error' },
      reviewThreads: { data: { total: 8, unresolved: 2, resolvedOrOutdated: 6 }, reason: 'More content is loading.', status: 'partial' },
      diff: { data: { additions: 340, deletions: 81, filesChanged: 12 }, reason: 'Collapsed files.', status: 'partial' },
      agents: { status: 'loading' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByText('— total comments')).toHaveAttribute('title', 'GitHub counter is malformed.');
    expect(screen.getByText('8+ review threads · 2+ unresolved · 6+ resolved+outdated')).toHaveAttribute('title', 'More content is loading.');
    expect(screen.getByText('12+ files · +340+ −81+')).toHaveAttribute('title', 'Collapsed files.');
    expect(screen.getByLabelText('Loading AI agents')).toBeVisible();
  });

  it('uses singular grammar and exposes every error reason to assistive technology', () => {
    render(<PullRequestCard summary={{ ...ready,
      totalComments: { data: { count: 1, href: '/o/r/pull/1#comments' }, status: 'ready' },
      reviewThreads: { data: { total: 1, unresolved: 1, resolvedOrOutdated: 0 }, status: 'ready' },
      diff: { data: { additions: 1, deletions: 1, filesChanged: 1 }, status: 'ready' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);
    expect(screen.getByText('1 total comment')).toBeVisible();
    expect(screen.getByText('1 review thread · 1 unresolved · 0 resolved+outdated')).toBeVisible();
    expect(screen.getByText('1 file · +1 −1')).toBeVisible();

    render(<PullRequestCard summary={{ ...ready,
      totalComments: { message: 'counter failed', status: 'error' }, reviewThreads: { message: 'threads failed', status: 'error' },
      diff: { message: 'files failed', status: 'error' }, agents: { message: 'agents failed', status: 'error' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);
    for (const reason of ['counter failed', 'threads failed', 'files failed', 'agents failed']) {
      expect(screen.getAllByText(reason, { selector: '.sr-only' }).length).toBeGreaterThan(0);
    }
  });

  it('marks partial values as lower bounds and never treats partial empty agents as definitive', () => {
    render(<PullRequestCard summary={{ ...ready,
      totalComments: { data: { count: 23, href: '/o/r/pull/1#comments' }, reason: 'counter may still change', status: 'partial' },
      reviewThreads: { data: { total: 8, unresolved: 2, resolvedOrOutdated: 6 }, reason: 'timeline is incomplete', status: 'partial' },
      agents: { data: [], reason: 'timeline is incomplete', status: 'partial' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);
    expect(screen.getByText('23+ total comments')).toHaveAttribute('aria-describedby');
    expect(screen.getByText(/8\+ review threads/)).toHaveAttribute('aria-describedby');
    expect(screen.getByText('No AI agents detected yet')).toHaveAttribute('aria-describedby');
  });

  it('visibly marks responded-agent counts as lower bounds when agent data is partial', () => {
    render(<PullRequestCard summary={{ ...ready,
      agents: { data: [
        { agentId: 'codex', responseCount: 3, requestSources: ['formal-review-request'], state: 'responded' },
      ], reason: 'Some timeline fragments were unavailable.', status: 'partial' },
    }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    const chip = screen.getByText('Codex Responded · 3+');
    expect(chip).toHaveAttribute('aria-describedby');
    expect(chip).toHaveAttribute('title', expect.stringContaining('Some timeline fragments were unavailable.'));
  });

  it.each([
    ['total comments', { ...ready, totalComments: { status: 'loading' } }],
    ['review threads', { ...ready, reviewThreads: { status: 'loading' } }],
    ['changed files', { ...ready, diff: { status: 'loading' } }],
    ['AI agents', { ...ready, agents: { status: 'loading' } }],
  ] as const satisfies readonly [string, PullRequestSummary][])('sets aria-busy while only %s is loading', (_, loading) => {
    render(<PullRequestCard summary={loading} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'true');
  });

  it('updates aria-busy and retains one stable status node as sections load', () => {
    const loading: PullRequestSummary = { ...ready, totalComments: { status: 'loading' } };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);
    const status = screen.getByRole('status');

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'false');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('Pull request overview updated.');
    expect(screen.getAllByRole('status')).toHaveLength(1);

    view.rerender(<PullRequestCard summary={loading} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('status')).toHaveTextContent('Loading pull request overview.');
    expect(screen.getAllByRole('status')).toHaveLength(1);

    view.rerender(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByTestId('pr-card')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('status')).toHaveTextContent('Pull request overview updated.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('23 total comments')).toBeVisible();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('Rendered more hooks'));
    consoleError.mockRestore();
  });

  it('uses registry labels with response precedence, provenance, and tab hrefs', () => {
    render(<PullRequestCard summary={ready} conversationHref="/octo/demo/pull/42" filesHref="/octo/demo/pull/42/files" />);

    expect(screen.getByText('Codex Responded · 3')).toHaveAttribute('title', 'Responded after a formal review request.');
    expect(screen.getByText('Claude Requested')).toHaveAttribute('title', 'Requested — detected from 👀 reaction.');
    expect(screen.getByRole('link', { name: /8 review threads/ })).toHaveAttribute('href', '/octo/demo/pull/42');
    expect(screen.getByRole('link', { name: /12 files/ })).toHaveAttribute('href', '/octo/demo/pull/42/files');
  });

  it('does not invent request provenance for responses and retains every request source accessibly', () => {
    render(<PullRequestCard summary={{ ...ready, agents: { data: [
      { agentId: 'codex', responseCount: 3, requestSources: [], state: 'responded' },
      { agentId: 'claude', responseCount: 0, requestSources: ['formal-review-request', 'started-reviewing', 'eyes-reaction'], state: 'requested' },
    ], status: 'ready' } }} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);
    expect(screen.getByText('Codex Responded · 3')).toHaveAttribute('title', 'Responded 3 times.');
    const requested = screen.getByText('Claude Requested');
    expect(requested.getAttribute('title')).toContain('formal review request');
    expect(requested.getAttribute('title')).toContain('started reviewing');
    expect(requested.getAttribute('title')).toContain('👀 reaction');
    expect(requested).toHaveAttribute('aria-describedby');
  });

  it('announces authored-by-viewer accessibly and ships isolated theme, focus, and reduced-motion styling', () => {
    render(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByText('Authored by you', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByTestId('pr-card')).toHaveClass('authored');
    expect(screen.getByRole('group', { name: 'Pull request review overview' })).toBeInTheDocument();
    expect(CARD_STYLES).toContain('--fgColor-accent');
    expect(CARD_STYLES).toContain(':focus-visible');
    expect(CARD_STYLES).toContain('prefers-reduced-motion: reduce');
  });
});
