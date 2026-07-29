import { describe, expect, it } from 'vitest';

import {
  aggregateAgentParticipation,
  classifyReviewThreads,
  normalizeAgentLogin,
} from './domain';

describe('classifyReviewThreads', () => {
  it('keeps each unique thread in exactly one bucket', () => {
    const counts = classifyReviewThreads([
      { id: 'active', isResolved: false, isOutdated: false },
      { id: 'resolved', isResolved: true, isOutdated: false },
      { id: 'outdated', isResolved: false, isOutdated: true },
      { id: 'both', isResolved: true, isOutdated: true },
    ]);

    expect(counts).toEqual({
      unresolved: 1,
      resolvedOrOutdated: 3,
      total: 4,
    });
  });

  it('deduplicates by id and treats any resolved or outdated copy as non-active', () => {
    const counts = classifyReviewThreads([
      { id: 'thread-1', isResolved: false, isOutdated: false },
      { id: 'thread-1', isResolved: true, isOutdated: false },
      { id: 'thread-2', isResolved: false, isOutdated: false },
    ]);

    expect(counts).toEqual({
      unresolved: 1,
      resolvedOrOutdated: 1,
      total: 2,
    });
  });

  it.each([
    {
      threads: [
        { id: 'thread-1', isResolved: false, isOutdated: false },
        { id: 'thread-1', isResolved: false, isOutdated: true },
      ],
    },
    {
      threads: [
        { id: 'thread-1', isResolved: false, isOutdated: true },
        { id: 'thread-1', isResolved: false, isOutdated: false },
      ],
    },
  ])('keeps an outdated duplicate out of the unresolved bucket in either order', ({ threads }) => {
    expect(classifyReviewThreads(threads)).toEqual({
      unresolved: 0,
      resolvedOrOutdated: 1,
      total: 1,
    });
  });
});

describe('normalizeAgentLogin', () => {
  it.each([
    ['gemini-code-assist', 'gemini'],
    ['gemini-cli', 'gemini'],
    ['chatgpt-codex-connector', 'codex'],
    ['openai-code-agent', 'codex'],
    ['claude', 'claude'],
    ['anthropic-code-agent', 'claude'],
    ['cubic-dev-ai', 'cubic'],
    ['coderabbitai', 'coderabbit'],
    ['devin-ai-integration', 'devin'],
    ['copilot-pull-request-reviewer', 'copilot'],
  ])('maps %s to the central %s registry entry', (login, agent) => {
    expect(normalizeAgentLogin(login)).toBe(agent);
  });

  it('normalizes whitespace, app hrefs, hovercard identifiers, and bot suffixes', () => {
    expect(normalizeAgentLogin('  /apps/Gemini-CLI  ')).toBe('gemini');
    expect(normalizeAgentLogin('/users/openai-code-agent[bot]/hovercard')).toBe('codex');
    expect(normalizeAgentLogin('chatgpt-codex-connector[bot]')).toBe('codex');
    expect(normalizeAgentLogin('unknown-review-bot')).toBeUndefined();
    expect(normalizeAgentLogin(undefined)).toBeUndefined();
  });
});

describe('aggregateAgentParticipation', () => {
  it('counts each stable response artifact once, including inline replies', () => {
    const participation = aggregateAgentParticipation({
      comments: [{ id: 'comment-1', actorLogin: 'gemini-cli' }],
      reviews: [{ id: 'review-1', actorLogin: 'openai-code-agent' }],
      inlineComments: [{ id: 'inline-1', actorLogin: 'claude' }],
      threadReplies: [
        { id: 'reply-1', actorLogin: 'cubic-dev-ai' },
        { id: 'comment-1', actorLogin: 'gemini-cli' },
      ],
    });

    expect(participation).toEqual([
      { agentId: 'claude', responseCount: 1, requestSources: [], state: 'responded' },
      { agentId: 'codex', responseCount: 1, requestSources: [], state: 'responded' },
      { agentId: 'cubic', responseCount: 1, requestSources: [], state: 'responded' },
      { agentId: 'gemini', responseCount: 1, requestSources: [], state: 'responded' },
    ]);
  });

  it('does not let an ignored duplicate suppress a recognized response', () => {
    const participation = aggregateAgentParticipation({
      comments: [{ id: 'comment-1' }],
      reviews: [{ id: 'comment-1', actorLogin: 'gemini-cli' }],
    });

    expect(participation).toEqual([
      { agentId: 'gemini', responseCount: 1, requestSources: [], state: 'responded' },
    ]);
  });

  it('reports a response over a request while preserving request provenance', () => {
    const participation = aggregateAgentParticipation({
      reviewRequests: [
        { id: 'request-1', requestedLogin: 'coderabbitai' },
        { id: 'request-1', requestedLogin: 'coderabbitai' },
      ],
      reviewEvents: [
        { id: 'event-1', actorLogin: 'devin-ai-integration', action: 'started-reviewing' },
      ],
      reactions: [
        { id: 'reaction-1', actorLogin: 'copilot-pull-request-reviewer', content: 'eyes' },
        { id: 'reaction-1', actorLogin: 'copilot-pull-request-reviewer', content: 'eyes' },
      ],
      comments: [{ id: 'comment-1', actorLogin: 'coderabbitai' }],
    });

    expect(participation).toEqual([
      { agentId: 'coderabbit', responseCount: 1, requestSources: ['formal-review-request'], state: 'responded' },
      { agentId: 'copilot', responseCount: 0, requestSources: ['eyes-reaction'], state: 'requested' },
      { agentId: 'devin', responseCount: 0, requestSources: ['started-reviewing'], state: 'requested' },
    ]);
  });

  it('keeps request and event provenance when their ids collide with a response', () => {
    const participation = aggregateAgentParticipation({
      comments: [{ id: 'shared-id', actorLogin: 'gemini-cli' }],
      reviewRequests: [{ id: 'shared-id', requestedLogin: 'gemini-cli' }],
      reviewEvents: [{ id: 'shared-id', actorLogin: 'gemini-cli', action: 'started-reviewing' }],
    });

    expect(participation).toEqual([
      {
        agentId: 'gemini',
        responseCount: 1,
        requestSources: ['formal-review-request', 'started-reviewing'],
        state: 'responded',
      },
    ]);
  });

  it('preserves all request provenance after a later response', () => {
    const participation = aggregateAgentParticipation({
      reviewRequests: [{ id: 'request-1', requestedLogin: 'coderabbitai' }],
      reviewEvents: [
        { id: 'event-1', actorLogin: 'coderabbitai', action: 'started-reviewing' },
      ],
      reactions: [{ id: 'reaction-1', actorLogin: 'coderabbitai', content: 'eyes' }],
      comments: [{ id: 'comment-1', actorLogin: 'coderabbitai' }],
    });

    expect(participation).toEqual([
      {
        agentId: 'coderabbit',
        responseCount: 1,
        requestSources: ['formal-review-request', 'started-reviewing', 'eyes-reaction'],
        state: 'responded',
      },
    ]);
  });

  it('ignores unknown bots, actorless artifacts, non-eyes reactions, and reactions as responses', () => {
    const participation = aggregateAgentParticipation({
      comments: [
        { id: 'unknown-comment', actorLogin: 'unlisted-bot' },
        { id: 'actorless-comment' },
      ],
      reactions: [
        { id: 'actorless-eyes', content: 'eyes' },
        { id: 'thumbs-up', actorLogin: 'gemini-cli', content: '+1' },
        { id: 'eyes-only', actorLogin: 'gemini-cli', content: 'EYES' },
      ],
    });

    expect(participation).toEqual([
      { agentId: 'gemini', responseCount: 0, requestSources: ['eyes-reaction'], state: 'requested' },
    ]);
  });
});
