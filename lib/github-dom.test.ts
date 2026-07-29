import { describe, expect, it } from 'vitest';

import diffAggregateHtml from '../test/fixtures/github/diff-aggregate.html?raw';
import diffRenderedPartialHtml from '../test/fixtures/github/diff-rendered-partial.html?raw';
import prListHtml from '../test/fixtures/github/pr-list.html?raw';
import timelineHtml from '../test/fixtures/github/timeline.html?raw';
import {
  extractDiffSummary,
  extractPullRequestRows,
  extractTimeline,
} from './github-dom';
import { classifyReviewThreads } from './domain';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('extractPullRequestRows', () => {
  it('uses canonical pull links and native counters without reconstructing comments', () => {
    const rows = extractPullRequestRows(parse(prListHtml));

    expect(rows[0]).toEqual({
      authorLogin: 'octo-author',
      identity: { number: 42, owner: 'octo', repository: 'demo' },
      nativeComments: {
        count: 1234,
        href: '/octo/demo/pull/42#issuecomment-1234',
        status: 'ready',
      },
      viewerLogin: 'octo-viewer',
    });
  });

  it('recognizes an omitted native counter as zero but makes malformed counter markup explicit', () => {
    const rows = extractPullRequestRows(parse(prListHtml));

    expect(rows[1]?.nativeComments).toEqual({ status: 'zero' });
    expect(rows[2]?.nativeComments).toEqual({
      reason: 'GitHub comment counter is malformed.',
      status: 'error',
    });
  });

  it('keeps native comment totals independent from the number of extracted review threads', () => {
    const rows = extractPullRequestRows(parse(prListHtml));
    const timeline = extractTimeline(parse(timelineHtml));

    expect(rows[3]?.nativeComments).toEqual({
      count: 23,
      href: '/octo/demo/pull/45#issuecomment-23',
      status: 'ready',
    });
    expect(timeline.threads).toHaveLength(8);
    expect(classifyReviewThreads(timeline.threads)).toEqual({
      resolvedOrOutdated: 5,
      total: 8,
      unresolved: 3,
    });
  });

  it('preserves zero/nonzero comment and zero/nonzero thread combinations without fabricating either count', () => {
    const rows = extractPullRequestRows(parse(prListHtml));
    const noThreads = extractTimeline(parse('<body><article id="issuecomment-1"></article></body>'));

    expect(rows[1]?.nativeComments).toEqual({ status: 'zero' });
    expect(noThreads.threads).toEqual([]);
    expect(rows[0]?.nativeComments).toMatchObject({ count: 1234, status: 'ready' });
    expect(noThreads.threads).toEqual([]);
    expect(rows[1]?.nativeComments).toEqual({ status: 'zero' });
    expect(extractTimeline(parse(timelineHtml)).threads).not.toEqual([]);
  });

  it('keeps a missing viewer explicit instead of inferring an author match', () => {
    const document = parse(prListHtml);
    document.querySelector('meta[name="user-login"]')?.remove();

    expect(extractPullRequestRows(document)[0]?.viewerLogin).toBeUndefined();
  });
});

describe('extractTimeline', () => {
  it('deduplicates semantic and legacy resolvable threads and merges non-active flags', () => {
    const result = extractTimeline([parse(timelineHtml), parse(timelineHtml)]);

    expect(result.threads).toEqual([
      { id: 'PRRT_active', isOutdated: false, isResolved: false },
      { id: 'PRRT_resolved', isOutdated: true, isResolved: true },
      { id: 'discussion-diff-103', isOutdated: true, isResolved: false },
      { id: 'PRRT_only_resolved', isOutdated: false, isResolved: true },
      { id: 'PRRT_only_outdated', isOutdated: true, isResolved: false },
      { id: 'PRRT_both', isOutdated: true, isResolved: true },
      { id: 'PRRT_second_active', isOutdated: false, isResolved: false },
      { id: 'PRRT_third_active', isOutdated: false, isResolved: false },
    ]);
    expect(result.completeness).toEqual({ isComplete: true, reasons: [] });
    expect(result.nextTimelineFragments).toEqual(['/octo/demo/pull/42/timeline?after=cursor']);
  });

  it('uses a canonical discussion permalink as an alias for a thread ID found in another document', () => {
    const firstDocument = parse(timelineHtml);
    const permalinkOnlyCopy = parse(timelineHtml);
    permalinkOnlyCopy
      .querySelector('#review-thread-or-comment-id-102-copy input[name="pull_request_review_thread_id"]')
      ?.remove();

    const result = extractTimeline([firstDocument, permalinkOnlyCopy]);

    expect(result.threads).toHaveLength(8);
    expect(result.threads.find((thread) => thread.id === 'PRRT_resolved')).toMatchObject({
      isOutdated: true,
      isResolved: true,
    });
    expect(result.threads.find((thread) => thread.id === 'discussion_r102')).toBeUndefined();
  });

  it('extracts only recognized AI response artifacts once by type and stable identity', () => {
    const { artifacts } = extractTimeline(parse(timelineHtml));

    expect(artifacts.comments).toEqual([
      { actorLogin: 'gemini-code-assist', id: 'issuecomment-901' },
      { actorLogin: 'gemini-cli', id: 'issuecomment-903' },
    ]);
    expect(artifacts.reviews).toEqual([{ actorLogin: 'devin-ai-integration', id: 'pullrequestreview-501' }]);
    expect(artifacts.inlineComments).toEqual([
      { actorLogin: 'claude', id: 'discussion_r101' },
      { actorLogin: 'gemini-cli', id: 'discussion_r102' },
      { actorLogin: 'openai-code-agent', id: 'discussion-diff-103' },
    ]);
    expect(artifacts.threadReplies).toEqual([{ actorLogin: 'cubic-dev-ai', id: 'issuecomment-101' }]);
  });

  it('retains formal request removal history, started-reviewing events, and actor-level eyes only', () => {
    const { artifacts } = extractTimeline(parse(timelineHtml));

    expect(artifacts.reviewRequests).toEqual([
      { action: 'requested', id: 'request-1', requestedLogin: 'coderabbitai' },
      { action: 'removed', id: 'request-2', requestedLogin: 'coderabbitai' },
      { action: 'requested', id: 'request-3', requestedLogin: 'coderabbitai' },
    ]);
    expect(artifacts.currentReviewRequests).toEqual([
      { id: 'request-3', requestedLogin: 'coderabbitai' },
    ]);
    expect(artifacts.reviewEvents).toEqual([
      { action: 'started-reviewing', actorLogin: 'copilot-pull-request-reviewer', id: 'event-started' },
    ]);
    expect(artifacts.reactions).toEqual([{ actorLogin: 'claude', content: 'eyes', id: 'reaction-1' }]);
  });

  it('does not retain a formal reviewer whose final structured event removes the request', () => {
    const document = parse(timelineHtml);
    document.querySelector('#event-rerequested')?.remove();

    expect(extractTimeline(document).artifacts.currentReviewRequests).toEqual([]);
  });

  it('uses only a narrowly scoped timeline-event text fallback for legacy review-request markup', () => {
    const document = parse(`
      <div class="TimelineItem" id="event-text-request">requested a review from
        <a data-hovercard-type="user" href="/coderabbitai">coderabbitai</a>
      </div>
      <div class="TimelineItem" id="event-text-remove">removed review request for
        <a data-hovercard-type="user" href="/coderabbitai">coderabbitai</a>
      </div>
    `);

    expect(extractTimeline(document).artifacts.reviewRequests).toEqual([
      { action: 'requested', id: 'event-text-request', requestedLogin: 'coderabbitai' },
      { action: 'removed', id: 'event-text-remove', requestedLogin: 'coderabbitai' },
    ]);
    expect(extractTimeline(document).artifacts.currentReviewRequests).toEqual([]);
  });
});

describe('extractDiffSummary', () => {
  it('prefers exact semantic diffstat totals', () => {
    expect(extractDiffSummary(parse(diffAggregateHtml))).toEqual({
      completeness: { isComplete: true, reasons: [] },
      data: { additions: 1204, deletions: 56, filesChanged: 3 },
    });
  });

  it('counts rendered paths and lines as a lower bound when GitHub marks the diff partial', () => {
    expect(extractDiffSummary(parse(diffRenderedPartialHtml))).toEqual({
      completeness: {
        isComplete: false,
        reasons: ['One or more diff files are collapsed, truncated, or not loaded.'],
      },
      data: { additions: 2, deletions: 1, filesChanged: 2 },
    });
  });
});
