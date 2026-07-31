import { describe, expect, it } from 'vitest';

import type {
  AgentParticipation,
  PullRequestIdentity,
  PullRequestSummary,
  SectionState,
} from './domain';

describe('domain data contracts', () => {
  it('shares a pull-request identity contract', () => {
    const identity: PullRequestIdentity = {
      number: 42,
      owner: 'octo',
      repository: '.github',
    };

    expect(identity.repository).toBe('.github');
  });

  it('supports each approved SectionState and PR summary shape', () => {
    const loading: SectionState<string> = { status: 'loading' };
    const ready: SectionState<string> = { status: 'ready', data: 'ready' };
    const partial: SectionState<string> = {
      status: 'partial',
      data: 'partial',
      reason: 'GitHub returned incomplete data.',
    };
    const failed: SectionState<string> = {
      status: 'error',
      message: 'GitHub request failed.',
    };
    const agents: readonly AgentParticipation[] = [];

    const summary: PullRequestSummary = {
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

    expect([loading, ready, partial, failed]).toHaveLength(4);
    expect(summary).not.toHaveProperty('totalComments');
  });
});

if (false) {
  // @ts-expect-error Ready states require data.
  const missingReadyData: SectionState<string> = { status: 'ready' };
  const participation: AgentParticipation = {
    agentId: 'gemini',
    responseCount: 0,
    requestSources: [],
    state: 'requested',
  };
  // @ts-expect-error Consumers cannot mutate request-source provenance.
  participation.requestSources.push('eyes-reaction');

  void missingReadyData;
}
