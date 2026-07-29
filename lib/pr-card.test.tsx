import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
    expect(screen.getByText('8+ review threads · 2 unresolved · 6 resolved+outdated')).toHaveAttribute('title', 'More content is loading.');
    expect(screen.getByText('12+ files · +340+ −81+')).toHaveAttribute('title', 'Collapsed files.');
    expect(screen.getByLabelText('Loading AI agents')).toBeVisible();
  });

  it('uses registry labels with response precedence, provenance, and tab hrefs', () => {
    render(<PullRequestCard summary={ready} conversationHref="/octo/demo/pull/42" filesHref="/octo/demo/pull/42/files" />);

    expect(screen.getByText('Codex Responded · 3')).toHaveAttribute('title', 'Responded after a formal review request.');
    expect(screen.getByText('Claude Requested')).toHaveAttribute('title', 'Requested — detected from 👀 reaction.');
    expect(screen.getByRole('link', { name: /8 review threads/ })).toHaveAttribute('href', '/octo/demo/pull/42');
    expect(screen.getByRole('link', { name: /12 files/ })).toHaveAttribute('href', '/octo/demo/pull/42/files');
  });

  it('announces authored-by-viewer accessibly and ships isolated theme, focus, and reduced-motion styling', () => {
    render(<PullRequestCard summary={ready} conversationHref="/o/r/pull/1" filesHref="/o/r/pull/1/files" />);

    expect(screen.getByText('Authored by you', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByTestId('pr-card')).toHaveClass('authored');
    expect(CARD_STYLES).toContain('--fgColor-accent');
    expect(CARD_STYLES).toContain(':focus-visible');
    expect(CARD_STYLES).toContain('prefers-reduced-motion: reduce');
  });
});
