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

  it('rejects recognized counters without destinations and comment-like links without aria labels', () => {
    const rows = extractPullRequestRows(parse(`
      <div id="issue_1" class="js-issue-row"><a href="/o/r/pull/1">one</a><a aria-label="2 comments">2</a></div>
      <div id="issue_2" class="js-issue-row"><a href="/o/r/pull/2">two</a><a class="comments-link" href="#comments">comments</a></div>
      <div id="issue_3" class="js-issue-row"><a href="/o/r/pull/3">three</a></div>
    `));

    expect(rows.map((row) => row.nativeComments)).toEqual([
      { reason: 'GitHub comment counter is malformed.', status: 'error' },
      { reason: 'GitHub comment counter is malformed.', status: 'error' },
      { status: 'zero' },
    ]);
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

  it.each([
    ['first-to-last', ['alpha', 'beta', 'bridge']],
    ['last-to-first', ['bridge', 'beta', 'alpha']],
  ])('unions records joined late by a thread alias regardless of document order (%s)', (_name, order) => {
    const documents = {
      alpha: parse('<turbo-frame id="review-thread-or-comment-id-a"><div class="js-resolvable-timeline-thread-container" data-resolved="false"><input name="pull_request_review_thread_id" value="PRRT_alpha"><a href="/o/r/pull/1/files#discussion_r1">link</a></div></turbo-frame>'),
      beta: parse('<turbo-frame id="review-thread-or-comment-id-b"><div class="js-resolvable-timeline-thread-container" data-resolved="true"><input name="pull_request_review_thread_id" value="PRRT_beta"><a href="/o/r/pull/1/files#discussion_r2">link</a></div></turbo-frame>'),
      bridge: parse('<turbo-frame id="review-thread-or-comment-id-c"><div class="js-resolvable-timeline-thread-container" data-resolved="false" data-outdated="true"><input name="pull_request_review_thread_id" value="PRRT_alpha"><a href="/o/r/pull/1/files#discussion_r2">link</a></div></turbo-frame>'),
    };

    const result = extractTimeline(order.map((key) => documents[key as keyof typeof documents]));

    expect(result.threads).toEqual([
      { id: 'PRRT_alpha', isOutdated: true, isResolved: true },
    ]);
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

  it('keeps structured and legacy review requests in document chronology', () => {
    const document = parse(`
      <div id="request-1" data-review-request-action="requested" data-review-requested-login="coderabbitai"></div>
      <div class="TimelineItem" id="request-2">removed review request for <a data-hovercard-type="user">coderabbitai</a></div>
      <div id="request-3" data-review-request-action="requested" data-review-requested-login="coderabbitai"></div>
    `);

    expect(extractTimeline(document).artifacts.reviewRequests).toEqual([
      { action: 'requested', id: 'request-1', requestedLogin: 'coderabbitai' },
      { action: 'removed', id: 'request-2', requestedLogin: 'coderabbitai' },
      { action: 'requested', id: 'request-3', requestedLogin: 'coderabbitai' },
    ]);
    expect(extractTimeline(document).artifacts.currentReviewRequests).toEqual([
      { id: 'request-3', requestedLogin: 'coderabbitai' },
    ]);
  });

  it('recognizes a narrowly scoped started-reviewing timeline event', () => {
    const result = extractTimeline(parse(`
      <div class="TimelineItem" id="event-started">started reviewing <a data-hovercard-type="user" data-hovercard-url="/apps/gemini-cli/hovercard">Gemini</a></div>
    `));

    expect(result.artifacts.reviewEvents).toEqual([
      { action: 'started-reviewing', actorLogin: 'gemini-cli', id: 'event-started' },
    ]);
  });

  it('finds semantic header actors without mistaking nested reactions for comment authors', () => {
    const result = extractTimeline(parse(`
      <article id="issuecomment-100"><div class="timeline-comment-header"><a data-hovercard-url="/users/gemini-cli[bot]/hovercard"><span>Gemini</span></a></div><div data-reaction-content="eyes" data-reaction-id="r1"><span><a data-hovercard-url="/apps/claude/hovercard">Claude</a></span></div></article>
      <article id="pullrequestreview-100"><header><a data-hovercard-url="/apps/openai-code-agent/hovercard">Codex</a></header></article>
      <div class="TimelineItem" id="request-human-first">requested a review from <a data-hovercard-type="user">human-author</a> and <a data-hovercard-url="/apps/coderabbitai/hovercard">CodeRabbit</a></div>
      <span aria-label="4 eyes reactions">4</span>
    `));

    expect(result.artifacts.comments).toEqual([{ actorLogin: 'gemini-cli[bot]', id: 'issuecomment-100' }]);
    expect(result.artifacts.reviews).toEqual([{ actorLogin: 'openai-code-agent', id: 'pullrequestreview-100' }]);
    expect(result.artifacts.reactions).toEqual([{ actorLogin: 'claude', content: 'eyes', id: 'r1' }]);
    expect(result.artifacts.reviewRequests).toEqual([
      { action: 'requested', id: 'request-human-first', requestedLogin: 'coderabbitai' },
    ]);
  });

  it('uses typed DOM ids as response identities when a copy also has data-gid', () => {
    const result = extractTimeline(parse(`
      <article id="issuecomment-200" data-gid="gid://IssueComment/200"><header><a data-hovercard-url="/apps/gemini-cli/hovercard">Gemini</a></header></article>
      <article id="issuecomment-200"><header><a data-hovercard-url="/apps/gemini-cli/hovercard">Gemini</a></header></article>
    `));

    expect(result.artifacts.comments).toEqual([{ actorLogin: 'gemini-cli', id: 'issuecomment-200' }]);
  });

  it('makes a skipped resolvable thread incomplete while retaining next fragment discovery', () => {
    const result = extractTimeline(parse(`
      <div class="js-resolvable-timeline-thread-container" data-resolved="false"><span>no identifier</span></div>
      <div id="js-timeline-progressive-loader" data-timeline-item-src="/o/r/pull/1/timeline?after=next"></div>
    `));

    expect(result.threads).toEqual([]);
    expect(result.completeness).toEqual({
      isComplete: false,
      reasons: ['A resolvable review thread had no stable identity.'],
    });
    expect(result.nextTimelineFragments).toEqual(['/o/r/pull/1/timeline?after=next']);
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

  it('does not combine unrelated page labels into exact diff totals', () => {
    const result = extractDiffSummary(parse(`
      <aside aria-label="99 files changed"></aside><aside aria-label="500 additions"></aside><aside aria-label="8 deletions"></aside>
      <div class="js-file file"><a title="src/a.ts">src/a.ts</a><span class="blob-code-addition" data-line-number="1">+a</span></div>
    `));

    expect(result).toEqual({
      completeness: { isComplete: true, reasons: [] },
      data: { additions: 1, deletions: 0, filesChanged: 1 },
    });
  });

  it('keeps missing or inaccessible diff evidence incomplete instead of exact zeroes', () => {
    const result = extractDiffSummary(parse('<div class="flash-error">Access denied</div>'));

    expect(result).toEqual({
      completeness: { isComplete: false, reasons: ['GitHub did not expose recognizable diff evidence.'] },
      data: { additions: 0, deletions: 0, filesChanged: 0 },
    });
  });
});
