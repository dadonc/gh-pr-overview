import { describe, expect, it } from 'vitest';

import type {
  AgentParticipation,
  PullRequestSummary,
  SectionState,
  TotalComments,
} from './domain';

describe('domain data contracts', () => {
  it('supports each approved SectionState and PR summary shape', () => {
    const loading: SectionState<TotalComments> = { status: 'loading' };
    const ready: SectionState<TotalComments> = {
      status: 'ready',
      data: { count: 8, href: '#comments' },
    };
    const partial: SectionState<TotalComments> = {
      status: 'partial',
      data: { count: 8, href: '#comments' },
      reason: 'GitHub did not return every comment page.',
    };
    const failed: SectionState<TotalComments> = {
      status: 'error',
      message: 'GitHub request failed.',
    };
    const agents: readonly AgentParticipation[] = [];

    const summary: PullRequestSummary = {
      totalComments: ready,
      reviewThreads: {
        status: 'partial',
        data: { unresolved: 2, resolvedOrOutdated: 3, total: 5 },
        reason: 'Thread pagination is incomplete.',
      },
      diff: {
        status: 'ready',
        data: { filesChanged: 3, additions: 16, deletions: 4 },
      },
      agents: { status: 'ready', data: agents },
      authoredByViewer: true,
    };

    expect([loading, partial, failed]).toHaveLength(3);
    expect(summary.totalComments).toEqual(ready);
  });
});

if (false) {
  // @ts-expect-error Ready states require data.
  const missingReadyData: SectionState<TotalComments> = { status: 'ready' };
  // @ts-expect-error TotalComments href is a required string.
  const wrongCommentHref: TotalComments = { count: 1, href: 1 };
  const participation: AgentParticipation = {
    agentId: 'gemini',
    responseCount: 0,
    requestSources: [],
    state: 'requested',
  };
  // @ts-expect-error Consumers cannot mutate request-source provenance.
  participation.requestSources.push('eyes-reaction');

  void missingReadyData;
  void wrongCommentHref;
}
