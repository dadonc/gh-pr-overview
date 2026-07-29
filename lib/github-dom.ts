import type { DiffSummary, ReviewThread } from './domain';
import { normalizeAgentLogin } from './domain';

export interface ExtractionCompleteness {
  isComplete: boolean;
  reasons: readonly string[];
}

export type NativeCommentCount =
  | { count: number; href: string; status: 'ready' }
  | { status: 'zero' }
  | { reason: string; status: 'error' };

export interface PullRequestRowExtraction {
  authorLogin?: string;
  identity: { number: number; owner: string; repository: string };
  nativeComments: NativeCommentCount;
  viewerLogin?: string;
}

export interface ResponseArtifactExtraction {
  actorLogin: string;
  id: string;
}

export interface FormalReviewRequestExtraction {
  action: 'removed' | 'requested';
  id: string;
  requestedLogin: string;
}

export interface ReviewEventExtraction extends ResponseArtifactExtraction {
  action: 'started-reviewing';
}

export interface ReactionExtraction extends ResponseArtifactExtraction {
  content: 'eyes';
}

export interface TimelineArtifactsExtraction {
  comments: readonly ResponseArtifactExtraction[];
  currentReviewRequests: readonly Omit<FormalReviewRequestExtraction, 'action'>[];
  inlineComments: readonly ResponseArtifactExtraction[];
  reactions: readonly ReactionExtraction[];
  reviewEvents: readonly ReviewEventExtraction[];
  reviewRequests: readonly FormalReviewRequestExtraction[];
  reviews: readonly ResponseArtifactExtraction[];
  threadReplies: readonly ResponseArtifactExtraction[];
}

export interface TimelineExtraction {
  artifacts: TimelineArtifactsExtraction;
  completeness: ExtractionCompleteness;
  nextTimelineFragments: readonly string[];
  threads: readonly ReviewThread[];
}

export interface DiffExtraction {
  completeness: ExtractionCompleteness;
  data: DiffSummary;
}

const threadRootSelector =
  '.js-resolvable-timeline-thread-container[data-resolved], review-thread-collapsible[data-resolved]';

function documentsFrom(input: Document | readonly Document[]): readonly Document[] {
  return 'querySelector' in input ? [input] : input;
}

function canonicalPullIdentity(href: string | null): PullRequestRowExtraction['identity'] | undefined {
  if (!href) return undefined;
  const path = new URL(href, 'https://github.com').pathname;
  const match = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (!match) return undefined;
  return { number: Number(match[3]), owner: match[1]!, repository: match[2]! };
}

function textLogin(element: Element | null): string | undefined {
  if (!element) return undefined;
  const attributeLogin =
    element.getAttribute('data-login') ??
    element.getAttribute('data-actor-login') ??
    element.getAttribute('data-review-requested-login');
  const candidate = attributeLogin ?? element.textContent?.trim();
  return candidate && normalizeAgentLogin(candidate) ? candidate : undefined;
}

function actorLogin(element: Element): string | undefined {
  const direct = textLogin(element);
  if (direct) return direct;

  const actor = element.querySelector(
    ':scope > a[data-hovercard-type="user"], :scope > a[data-login], :scope > a[data-actor-login], :scope > a[href^="/users/"], :scope > a[href^="/apps/"]',
  );
  const visibleLogin = textLogin(actor);
  if (visibleLogin) return visibleLogin;
  const hrefLogin = actor?.getAttribute('href')?.match(/\/(?:apps|users)\/([^/?#]+)/i)?.[1];
  return hrefLogin && normalizeAgentLogin(hrefLogin) ? hrefLogin : undefined;
}

function stableId(element: Element): string | undefined {
  return (element.getAttribute('data-gid') ?? element.id) || undefined;
}

function booleanAttribute(element: Element, name: string): boolean {
  return element.getAttribute(name)?.toLowerCase() === 'true';
}

function threadIdentities(root: Element): string[] {
  const identities: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && !identities.includes(value)) identities.push(value);
  };
  const hidden = root.querySelector<HTMLInputElement>('input[name="pull_request_review_thread_id"]');
  add(hidden?.value);
  add(root.getAttribute('data-review-thread-id'));
  add(root.getAttribute('data-pull-request-review-thread-id'));
  add(root.getAttribute('data-gid'));
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    add(anchor.getAttribute('href')?.match(/#(discussion_(?:r|diff-)[^?#/]+)/)?.[1]);
  }
  add(root.querySelector<HTMLElement>('[id^="discussion_r"], [id^="discussion-diff-"]')?.id);
  return identities;
}

function isOutdated(root: Element): boolean {
  if (booleanAttribute(root, 'data-outdated')) return true;
  if ([...root.querySelectorAll('[title]')].some((element) => element.getAttribute('title') === 'Label: Outdated')) {
    return true;
  }
  return [...root.attributes].some(
    (attribute) =>
      /(?:state|hydrate|payload|data)$/i.test(attribute.name) &&
      /["']isOutdated["']\s*:\s*true/i.test(attribute.value),
  );
}

function addUnique<T extends { id: string }>(items: T[], seen: Set<string>, item: T): void {
  if (!seen.has(item.id)) {
    seen.add(item.id);
    items.push(item);
  }
}

export function extractPullRequestRows(document: Document): PullRequestRowExtraction[] {
  const viewerLogin = document.querySelector('meta[name="user-login"]')?.getAttribute('content')?.trim() || undefined;

  return [...document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')].flatMap((row) => {
    const pullLink = [...row.querySelectorAll<HTMLAnchorElement>('a[href]')].find((anchor) =>
      canonicalPullIdentity(anchor.getAttribute('href')),
    );
    const identity = canonicalPullIdentity(pullLink?.getAttribute('href') ?? null);
    if (!identity) return [];

    const counterAnchors = [...row.querySelectorAll<HTMLAnchorElement>('a[aria-label]')].filter((anchor) =>
      /\bcomments?\b/i.test(anchor.getAttribute('aria-label') ?? ''),
    );
    const recognizedCounter = counterAnchors.find((anchor) =>
      /^\s*[\d,]+\s+comments?\s*$/i.test(anchor.getAttribute('aria-label') ?? ''),
    );
    const nativeComments: NativeCommentCount = recognizedCounter
      ? {
          count: Number((recognizedCounter.getAttribute('aria-label') ?? '').match(/[\d,]+/)![0].replaceAll(',', '')),
          href: recognizedCounter.getAttribute('href') ?? '',
          status: 'ready',
        }
      : counterAnchors.length > 0
        ? { reason: 'GitHub comment counter is malformed.', status: 'error' }
        : { status: 'zero' };

    return [{
      authorLogin: row.querySelector('.opened-by a[data-hovercard-type="user"]')?.textContent?.trim() || undefined,
      identity,
      nativeComments,
      viewerLogin,
    }];
  });
}

export function extractTimeline(input: Document | readonly Document[]): TimelineExtraction {
  const threads = new Map<string, ReviewThread>();
  const threadAliases = new Map<string, string>();
  const comments: ResponseArtifactExtraction[] = [];
  const reviews: ResponseArtifactExtraction[] = [];
  const inlineComments: ResponseArtifactExtraction[] = [];
  const threadReplies: ResponseArtifactExtraction[] = [];
  const reviewRequests: FormalReviewRequestExtraction[] = [];
  const reviewEvents: ReviewEventExtraction[] = [];
  const reactions: ReactionExtraction[] = [];
  const seen = new Map<string, Set<string>>();
  const add = <T extends { id: string }>(kind: string, target: T[], artifact: T) => {
    const identities = seen.get(kind) ?? new Set<string>();
    seen.set(kind, identities);
    addUnique(target, identities, artifact);
  };
  const nextTimelineFragments: string[] = [];
  const seenFragments = new Set<string>();

  for (const document of documentsFrom(input)) {
    for (const loader of document.querySelectorAll<HTMLElement>(
      '#js-timeline-progressive-loader[data-timeline-item-src]',
    )) {
      const fragment = loader.getAttribute('data-timeline-item-src');
      if (fragment && !seenFragments.has(fragment)) {
        seenFragments.add(fragment);
        nextTimelineFragments.push(fragment);
      }
    }

    for (const root of document.querySelectorAll<HTMLElement>(threadRootSelector)) {
      const identities = threadIdentities(root);
      const id = identities.map((identity) => threadAliases.get(identity)).find(Boolean) ?? identities[0];
      if (id) {
        const existing = threads.get(id);
        threads.set(id, {
          id,
          isOutdated: Boolean(existing?.isOutdated || isOutdated(root)),
          isResolved: Boolean(existing?.isResolved || booleanAttribute(root, 'data-resolved')),
        });
        for (const identity of identities) threadAliases.set(identity, id);
      }

      for (const element of root.querySelectorAll<HTMLElement>('[id^="discussion_r"], [id^="discussion-diff-"]')) {
        const artifactId = stableId(element);
        const login = actorLogin(element);
        if (artifactId && login) add('inline', inlineComments, { actorLogin: login, id: artifactId });
      }
      for (const element of root.querySelectorAll<HTMLElement>('[id^="issuecomment-"]')) {
        const artifactId = stableId(element);
        const login = actorLogin(element);
        if (artifactId && login) add('thread-reply', threadReplies, { actorLogin: login, id: artifactId });
      }
    }

    for (const element of document.querySelectorAll<HTMLElement>('[id^="issuecomment-"]')) {
      if (element.closest(threadRootSelector)) continue;
      const id = stableId(element);
      const login = actorLogin(element);
      if (id && login) add('comment', comments, { actorLogin: login, id });
    }
    for (const element of document.querySelectorAll<HTMLElement>('[id^="pullrequestreview-"]')) {
      const id = stableId(element);
      const login = actorLogin(element);
      if (id && login) add('review', reviews, { actorLogin: login, id });
    }

    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-review-request-action], [data-review-requested-login]',
    )) {
      const actionValue = element.getAttribute('data-review-request-action')?.toLowerCase();
      const action = actionValue === 'removed' ? 'removed' : actionValue === 'requested' ? 'requested' : undefined;
      const id = stableId(element);
      const requestedLogin = textLogin(element);
      if (action && id && requestedLogin) add('review-request', reviewRequests, { action, id, requestedLogin });
    }
    for (const element of document.querySelectorAll<HTMLElement>('.TimelineItem[id], .TimelineItem[data-gid]')) {
      if (element.hasAttribute('data-review-request-action') || element.hasAttribute('data-review-requested-login')) {
        continue;
      }
      const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const action = /\brequested a review from\b/i.test(text)
        ? 'requested'
        : /\bremoved review request (?:for|from)\b/i.test(text)
          ? 'removed'
          : undefined;
      const id = stableId(element);
      const requestedLogin = actorLogin(element);
      if (action && id && requestedLogin) add('review-request', reviewRequests, { action, id, requestedLogin });
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-review-event="started-reviewing"]')) {
      const id = stableId(element);
      const login = actorLogin(element);
      if (id && login) add('review-event', reviewEvents, { action: 'started-reviewing', actorLogin: login, id });
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-reaction-content="eyes"]')) {
      const id = stableId(element) ?? element.getAttribute('data-reaction-id') ?? undefined;
      const login = actorLogin(element);
      if (id && login) add('reaction', reactions, { actorLogin: login, content: 'eyes', id });
    }
  }

  const currentRequests = new Map<string, Omit<FormalReviewRequestExtraction, 'action'>>();
  for (const request of reviewRequests) {
    const agent = normalizeAgentLogin(request.requestedLogin);
    if (!agent) continue;
    if (request.action === 'removed') currentRequests.delete(agent);
    else currentRequests.set(agent, { id: request.id, requestedLogin: request.requestedLogin });
  }

  return {
    artifacts: {
      comments,
      currentReviewRequests: [...currentRequests.values()],
      inlineComments,
      reactions,
      reviewEvents,
      reviewRequests,
      reviews,
      threadReplies,
    },
    completeness: { isComplete: true, reasons: [] },
    nextTimelineFragments,
    threads: [...threads.values()],
  };
}

function parseMetric(text: string, label: string): number | undefined {
  const match = text.match(new RegExp(`([\\d,]+)\\s+${label}`, 'i'));
  return match ? Number(match[1]!.replaceAll(',', '')) : undefined;
}

export function extractDiffSummary(document: Document): DiffExtraction {
  const semanticText = [...document.querySelectorAll<HTMLElement>('[aria-label], [title], .diffstat, [data-diffstat]')]
    .map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.textContent ?? ''}`)
    .join(' ');
  const filesChanged = parseMetric(semanticText, 'files? changed');
  const additions = parseMetric(semanticText, 'additions?');
  const deletions = parseMetric(semanticText, 'deletions?');
  if (filesChanged !== undefined && additions !== undefined && deletions !== undefined) {
    return { completeness: { isComplete: true, reasons: [] }, data: { additions, deletions, filesChanged } };
  }

  const files = new Set<string>();
  for (const [index, file] of [...document.querySelectorAll<HTMLElement>('.file.js-file, .js-file')].entries()) {
    files.add(file.querySelector('a[title]')?.getAttribute('title') ?? `rendered-file-${index}`);
  }
  const countLines = (selector: string) => {
    const lines = new Set<string>();
    for (const [index, line] of [...document.querySelectorAll<HTMLElement>(selector)].entries()) {
      const file = line.closest('.file.js-file, .js-file')?.querySelector('a[title]')?.getAttribute('title') ?? 'unknown-file';
      lines.add(`${file}:${line.getAttribute('data-line-number') ?? index}`);
    }
    return lines.size;
  };
  const partial = Boolean(
    document.querySelector(
      '[data-file-type="collapsed"], [data-file-type="suppressed"], [data-file-type="truncated"], .js-diff-load, .js-diff-load-container, include-fragment[data-fragment-url], [data-diff-truncated]',
    ),
  );
  return {
    completeness: partial
      ? { isComplete: false, reasons: ['One or more diff files are collapsed, truncated, or not loaded.'] }
      : { isComplete: true, reasons: [] },
    data: {
      additions: countLines('.blob-code-addition'),
      deletions: countLines('.blob-code-deletion'),
      filesChanged: files.size,
    },
  };
}
