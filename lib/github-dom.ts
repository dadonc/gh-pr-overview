import type { DiffSummary, ReviewThread } from './domain';
import { normalizeAgentAccountLogin, normalizeAgentLogin } from './domain';

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

const GITHUB_ORIGIN = 'https://github.com';
const threadRootSelector =
  '.js-resolvable-timeline-thread-container, review-thread-collapsible';

function documentsFrom(input: Document | readonly Document[]): readonly Document[] {
  return 'querySelector' in input ? [input] : input;
}

function trustedGitHubUrl(href: string | null): URL | undefined {
  if (!href) return undefined;
  const authority = href.trim().match(/^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/)?.[1];
  const hostAndPort = authority?.split('@').at(-1);
  const rawPath = href.slice(0, href.search(/[?#]/) === -1 ? href.length : href.search(/[?#]/));
  if (
    href.trimStart().startsWith('//') ||
    hostAndPort?.includes(':') ||
    /(?:^|\/)\.\.?(?=\/|$)/.test(rawPath) ||
    /\\|%(?:2f|5c|2e)/i.test(rawPath)
  ) return undefined;

  let url: URL;
  try {
    url = new URL(href, GITHUB_ORIGIN);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== GITHUB_ORIGIN ||
    url.port ||
    url.username ||
    url.password
  ) return undefined;
  return url;
}

function canonicalPullIdentity(href: string | null): PullRequestRowExtraction['identity'] | undefined {
  const url = trustedGitHubUrl(href);
  if (!url || url.search || url.hash) return undefined;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (!match) return undefined;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return { number, owner: match[1]!, repository: match[2]! };
}

function hasStrongCommentCounterPlacement(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute('href') ?? '';
  const role = anchor.getAttribute('role') ?? '';
  return (
    /#(?:comments?|issuecomment-)/i.test(href) ||
    /(?:^|\s)(?:comments?-link|comments?-count)(?:\s|$)/i.test(anchor.className) ||
    /comment/i.test(role) ||
    Boolean(
      anchor.closest('.comment-area, [data-comment-count], .js-comments-count, .js-comment-count') ||
        anchor.querySelector('svg[aria-label*="comment" i], [data-comment-count]'),
    )
  );
}

function hasCommentCounterStructure(anchor: HTMLAnchorElement): boolean {
  return hasStrongCommentCounterPlacement(anchor) ||
    /\bcomments?\b/i.test(anchor.getAttribute('aria-label') ?? '');
}

function isCommentCounterCandidate(anchor: HTMLAnchorElement): boolean {
  return hasCommentCounterStructure(anchor) ||
    /^\s*[\d,]+\s+comments?\s*$/i.test(anchor.textContent ?? '');
}

function nativeCommentCountFromLabel(label: string | null): number | undefined {
  const count = label?.match(
    /^\s*(\d{1,3}(?:,\d{3})+|\d+)\s+comments?\s*$/i,
  )?.[1];
  if (!count) return undefined;
  const parsed = Number(count.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function canonicalPullCandidates(row: Element): Array<{
  anchor: HTMLAnchorElement;
  identity: PullRequestRowExtraction['identity'];
}> {
  return [...row.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap((anchor) => {
    const identity = canonicalPullIdentity(anchor.getAttribute('href'));
    return identity ? [{ anchor, identity }] : [];
  });
}

export function findPullRequestIdentity(
  row: Element,
): PullRequestRowExtraction['identity'] | undefined {
  const candidates = canonicalPullCandidates(row);
  const identities = new Set(candidates.map(({ identity }) =>
    `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`,
  ));
  return identities.size === 1 ? candidates[0]?.identity : undefined;
}

export function findPullRequestTitle(row: Element): {
  anchor: HTMLAnchorElement;
  identity: PullRequestRowExtraction['identity'];
} | undefined {
  if (!findPullRequestIdentity(row)) return undefined;
  const candidates = canonicalPullCandidates(row);
  return candidates.find(({ anchor }) =>
    anchor.matches(
      '.Link--primary, [data-testid="issue-pr-title-link"], [data-testid="pull-request-title-link"], [data-testid="issue-title-link"]',
    ),
  ) ?? (() => {
    const structurallyPossibleTitles = candidates.filter(
      ({ anchor }) => !hasCommentCounterStructure(anchor),
    );
    return structurallyPossibleTitles.length === 1
      ? structurallyPossibleTitles[0]
      : undefined;
  })();
}

interface NativeCommentCounterResolution {
  counter?: HTMLAnchorElement;
  isAmbiguous: boolean;
}

function resolveNativeCommentCounter(
  row: Element,
  suppliedTitle?: HTMLAnchorElement,
): NativeCommentCounterResolution {
  const title = suppliedTitle ?? findPullRequestTitle(row)?.anchor;
  const candidates = [...row.querySelectorAll<HTMLAnchorElement>('a')].filter(
    (anchor) => anchor !== title && !anchor.closest('github-pr-overview'),
  );
  const plausibleCounters = candidates.filter(isCommentCounterCandidate);

  if (title) {
    return plausibleCounters.length === 1
      ? { counter: plausibleCounters[0], isAmbiguous: false }
      : { isAmbiguous: plausibleCounters.length > 1 };
  }

  const strongCounters = plausibleCounters.filter(hasStrongCommentCounterPlacement);
  if (strongCounters.length === 1) {
    return { counter: strongCounters[0], isAmbiguous: false };
  }
  return {
    isAmbiguous: plausibleCounters.length > 0 ||
      canonicalPullCandidates(row).length > 1,
  };
}

export function findNativeCommentCounter(
  row: Element,
  title?: HTMLAnchorElement,
): HTMLAnchorElement | undefined {
  return resolveNativeCommentCounter(row, title).counter;
}

function validatedNativeCounterHref(
  href: string | null,
  identity: PullRequestRowExtraction['identity'],
): string | undefined {
  const url = trustedGitHubUrl(href);
  if (!href || !url) return undefined;
  const conversationPath = `/${identity.owner}/${identity.repository}/pull/${identity.number}`;
  const isAllowed = url.pathname.toLowerCase() === conversationPath.toLowerCase() &&
    !url.search &&
    (!url.hash || /^#(?:comments|discussion_bucket|issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|discussion-diff-\d+)$/i.test(url.hash));
  return isAllowed ? href : undefined;
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

const actorSelectors = [
  'a[data-hovercard-type="user"]',
  'a[data-login]',
  'a[data-actor-login]',
  'a[data-hovercard-url]',
  'a[href^="/users/"]',
  'a[href^="/apps/"]',
] as const;

function recognizedLogin(element: Element, includeText = true): string | undefined {
  const candidates = [
    element.getAttribute('data-login'),
    element.getAttribute('data-actor-login'),
    element.getAttribute('data-review-requested-login'),
    element.getAttribute('data-hovercard-url')?.match(/\/(?:apps|users)\/([^/?#]+)/i)?.[1],
    element.getAttribute('href')?.match(/\/(?:apps|users)\/([^/?#]+)/i)?.[1],
    ...(includeText ? [element.textContent?.trim()] : []),
  ];
  return candidates.find(
    (candidate): candidate is string => Boolean(candidate) && Boolean(normalizeAgentLogin(candidate)),
  );
}

function actorLogins(element: Element, includeNestedActors = false): string[] {
  const logins: string[] = [];
  const seenAccounts = new Set<string>();
  const add = (login: string | undefined) => {
    const accountLogin = normalizeAgentAccountLogin(login);
    if (login && accountLogin && !seenAccounts.has(accountLogin)) {
      seenAccounts.add(accountLogin);
      logins.push(login);
    }
  };
  const ownLogin = recognizedLogin(element, false);
  add(ownLogin);
  const selector = actorSelectors.join(', ');
  const candidates = includeNestedActors
    ? [...element.querySelectorAll(selector)]
    : [...element.children].flatMap((child) => {
        if (child.matches(selector)) return [child];
        return child.matches('header, [class*="header" i]')
          ? [...child.querySelectorAll(selector)]
          : [];
      });
  for (const candidate of candidates) {
    add(recognizedLogin(candidate));
  }
  return logins;
}

function actorLogin(element: Element, includeNestedActors = false): string | undefined {
  return actorLogins(element, includeNestedActors)[0];
}

function typedResponseId(element: Element): string | undefined {
  return /^(?:issuecomment-|pullrequestreview-|discussion_r|discussion-diff-)/.test(element.id)
    ? element.id
    : undefined;
}

function stableId(element: Element): string | undefined {
  return (element.getAttribute('data-gid') ?? element.id) || undefined;
}

function booleanAttribute(element: Element, name: string): boolean | undefined {
  const value = element.getAttribute(name)?.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
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

interface ThreadCandidate {
  identities: readonly string[];
  outdated: ParsedThreadState;
  resolved: ParsedThreadState;
}

interface AliasedCandidate {
  identities: readonly string[];
}

function groupAliasedCandidates<T extends AliasedCandidate>(
  candidates: readonly T[],
): T[][] {
  const parent = new Map<string, string>();
  const find = (identity: string): string => {
    const current = parent.get(identity) ?? identity;
    if (current === identity) return identity;
    const root = find(current);
    parent.set(identity, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const candidate of candidates) {
    const [first, ...rest] = candidate.identities;
    if (!first) continue;
    parent.set(first, parent.get(first) ?? first);
    for (const identity of rest) {
      parent.set(identity, parent.get(identity) ?? identity);
      union(first, identity);
    }
  }

  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const first = candidate.identities[0];
    if (!first) continue;
    const group = groups.get(find(first)) ?? [];
    group.push(candidate);
    groups.set(find(first), group);
  }
  return [...groups.values()] as T[][];
}

function mergeThreadCandidates(candidates: readonly ThreadCandidate[]): ReviewThread[] {
  return groupAliasedCandidates(candidates).flatMap((group) => {
    const isOutdated = group.some((candidate) =>
      candidate.outdated.isReadable && candidate.outdated.value,
    );
    const isResolved = group.some((candidate) =>
      candidate.resolved.isReadable && candidate.resolved.value,
    );
    const isActive = group.every((candidate) =>
      candidate.outdated.isReadable && !candidate.outdated.value &&
      candidate.resolved.isReadable && !candidate.resolved.value,
    );
    if (!isOutdated && !isResolved && !isActive) return [];

    const identities = [...new Set(group.flatMap((candidate) => candidate.identities))];
    const id = identities.sort((left, right) => {
      const leftDiscussion = left.startsWith('discussion_');
      const rightDiscussion = right.startsWith('discussion_');
      return Number(leftDiscussion) - Number(rightDiscussion) || left.localeCompare(right);
    })[0]!;
    return [{
      id,
      isOutdated,
      isResolved,
    }];
  });
}

interface ParsedThreadState {
  isReadable: boolean;
  value: boolean;
}

function structuredBooleanState(
  root: Element,
  key: 'isOutdated' | 'isResolved',
): ParsedThreadState | undefined {
  for (const attribute of [...root.attributes]) {
    if (!/(?:state|hydrate|payload|data)$/i.test(attribute.name) ||
      !new RegExp(`["']${key}["']`, 'i').test(attribute.value)) {
      continue;
    }
    const match = attribute.value.match(new RegExp(`["']${key}["']\\s*:\\s*(true|false)`, 'i'));
    return { isReadable: Boolean(match), value: match?.[1]?.toLowerCase() === 'true' };
  }
  return undefined;
}

function resolvedState(root: Element): ParsedThreadState {
  if (root.hasAttribute('data-resolved')) {
    const value = booleanAttribute(root, 'data-resolved');
    return { isReadable: value !== undefined, value: value ?? false };
  }
  return structuredBooleanState(root, 'isResolved') ?? { isReadable: false, value: false };
}

function outdatedState(root: Element): ParsedThreadState {
  if (root.hasAttribute('data-outdated')) {
    const value = booleanAttribute(root, 'data-outdated');
    return { isReadable: value !== undefined, value: value ?? false };
  }
  if ([...root.querySelectorAll('[title]')].some((element) => element.getAttribute('title') === 'Label: Outdated')) {
    return { isReadable: true, value: true };
  }
  return structuredBooleanState(root, 'isOutdated') ?? { isReadable: true, value: false };
}

type ResponseKind = 'comment' | 'inline' | 'review' | 'thread-reply';

interface ResponseCandidate extends AliasedCandidate {
  actorLogin: string;
  kind: ResponseKind;
}

function responseIdentities(element: Element): string[] {
  const identities: string[] = [];
  const add = (identity: string | null | undefined) => {
    if (identity && !identities.includes(identity)) identities.push(identity);
  };
  add(typedResponseId(element));
  add(element.getAttribute('data-gid'));
  if (identities.length === 0) add(element.id);
  return identities;
}

function responseIdentityRank(identity: string): number {
  if (identity.startsWith('issuecomment-')) return 0;
  if (identity.startsWith('pullrequestreview-')) return 1;
  if (identity.startsWith('discussion_r')) return 2;
  if (identity.startsWith('discussion-diff-')) return 3;
  return 4;
}

function mergeResponseCandidates(candidates: readonly ResponseCandidate[]): {
  comments: ResponseArtifactExtraction[];
  inlineComments: ResponseArtifactExtraction[];
  reviews: ResponseArtifactExtraction[];
  threadReplies: ResponseArtifactExtraction[];
} {
  const result = {
    comments: [] as ResponseArtifactExtraction[],
    inlineComments: [] as ResponseArtifactExtraction[],
    reviews: [] as ResponseArtifactExtraction[],
    threadReplies: [] as ResponseArtifactExtraction[],
  };
  const targets: Record<ResponseKind, ResponseArtifactExtraction[]> = {
    comment: result.comments,
    inline: result.inlineComments,
    review: result.reviews,
    'thread-reply': result.threadReplies,
  };

  const reviewCandidates = candidates.filter((candidate) => candidate.kind === 'review');
  const commentCandidates = candidates.filter((candidate) => candidate.kind !== 'review');
  for (const namespace of [reviewCandidates, commentCandidates]) {
    for (const group of groupAliasedCandidates(namespace)) {
      const id = [...new Set(group.flatMap((candidate) => candidate.identities))]
        .sort((left, right) =>
          responseIdentityRank(left) - responseIdentityRank(right) || left.localeCompare(right),
        )[0];
      if (!id) continue;
      const seenKinds = new Set<ResponseKind>();
      for (const candidate of group) {
        if (seenKinds.has(candidate.kind)) continue;
        seenKinds.add(candidate.kind);
        targets[candidate.kind].push({ actorLogin: candidate.actorLogin, id });
      }
    }
  }
  return result;
}

export function extractPullRequestRows(document: Document): PullRequestRowExtraction[] {
  const viewerLogin = document.querySelector('meta[name="user-login"]')?.getAttribute('content')?.trim() || undefined;

  return [...document.querySelectorAll<HTMLElement>('[id^="issue_"].js-issue-row')].flatMap((row) => {
    const identity = findPullRequestIdentity(row);
    if (!identity) return [];
    const pullLink = findPullRequestTitle(row)?.anchor;

    const counterResolution = resolveNativeCommentCounter(row, pullLink);
    const recognizedCounter = counterResolution.counter;
    const recognizedHref = recognizedCounter?.getAttribute('href');
    const recognizedCount = nativeCommentCountFromLabel(
      recognizedCounter?.getAttribute('aria-label') ?? null,
    );
    const counterHref = validatedNativeCounterHref(recognizedHref ?? null, identity);
    const nativeComments: NativeCommentCount = recognizedCount !== undefined && counterHref
      ? {
          count: recognizedCount,
          href: counterHref,
          status: 'ready',
        }
      : recognizedCounter
        ? { reason: 'GitHub comment counter is malformed.', status: 'error' }
        : counterResolution.isAmbiguous
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
  const threadCandidates: ThreadCandidate[] = [];
  const responseCandidates: ResponseCandidate[] = [];
  const reviewRequests: FormalReviewRequestExtraction[] = [];
  const reviewEvents: ReviewEventExtraction[] = [];
  const reactions: ReactionExtraction[] = [];
  const seen = new Map<string, Set<string>>();
  const add = <T extends { id: string }>(
    kind: string,
    target: T[],
    artifact: T,
    identity = artifact.id,
  ) => {
    const identities = seen.get(kind) ?? new Set<string>();
    seen.set(kind, identities);
    if (!identities.has(identity)) {
      identities.add(identity);
      target.push(artifact);
    }
  };
  const addResponse = (kind: ResponseKind, element: Element) => {
    const identities = responseIdentities(element);
    const login = actorLogin(element);
    if (identities.length > 0 && login) {
      responseCandidates.push({ actorLogin: login, identities, kind });
    }
  };
  const nextTimelineFragments: string[] = [];
  const seenFragments = new Set<string>();
  const incompleteReasons = new Set<string>();

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
      const resolved = resolvedState(root);
      const outdated = outdatedState(root);
      if (identities.length === 0) {
        incompleteReasons.add('A resolvable review thread had no stable identity.');
      } else {
        threadCandidates.push({ identities, outdated, resolved });
        if (!resolved.isReadable || !outdated.isReadable) {
          incompleteReasons.add('A resolvable review thread had unreadable resolution or outdated state.');
        }
      }

      for (const element of root.querySelectorAll<HTMLElement>('[id^="discussion_r"], [id^="discussion-diff-"]')) {
        addResponse('inline', element);
      }
      for (const element of root.querySelectorAll<HTMLElement>('[id^="issuecomment-"]')) {
        addResponse('thread-reply', element);
      }
    }

    for (const element of document.querySelectorAll<HTMLElement>('[id^="issuecomment-"]')) {
      if (element.closest(threadRootSelector)) continue;
      addResponse('comment', element);
    }
    for (const element of document.querySelectorAll<HTMLElement>('[id^="pullrequestreview-"]')) {
      addResponse('review', element);
    }

    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-review-request-action], [data-review-requested-login], .TimelineItem[id], .TimelineItem[data-gid]',
    )) {
      const actionValue = element.getAttribute('data-review-request-action')?.toLowerCase();
      const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const action = actionValue === 'removed'
        ? 'removed'
        : actionValue === 'requested'
          ? 'requested'
          : /\brequested a review from\b/i.test(text)
            ? 'requested'
            : /\bremoved review request (?:for|from)\b/i.test(text)
              ? 'removed'
              : undefined;
      const id = stableId(element);
      const requestedLogin = textLogin(element) ?? actorLogin(element);
      if (action && id && requestedLogin) add('review-request', reviewRequests, { action, id, requestedLogin });
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-review-event="started-reviewing"], .TimelineItem[id], .TimelineItem[data-gid]')) {
      const started = element.getAttribute('data-review-event') === 'started-reviewing' ||
        /\bstarted reviewing\b/i.test(element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      if (!started) continue;
      const id = stableId(element);
      const login = actorLogin(element);
      if (id && login) add('review-event', reviewEvents, { action: 'started-reviewing', actorLogin: login, id });
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-reaction-content="eyes"]')) {
      const id = stableId(element) ?? element.getAttribute('data-reaction-id') ?? undefined;
      if (!id) continue;
      for (const login of actorLogins(element, true)) {
        const accountLogin = normalizeAgentAccountLogin(login);
        if (accountLogin) {
          add(
            'reaction',
            reactions,
            { actorLogin: login, content: 'eyes', id },
            `${id}\0${accountLogin}`,
          );
        }
      }
    }
  }

  const currentRequests = new Map<string, Omit<FormalReviewRequestExtraction, 'action'>>();
  for (const request of reviewRequests) {
    const accountLogin = normalizeAgentAccountLogin(request.requestedLogin);
    if (!accountLogin) continue;
    if (request.action === 'removed') currentRequests.delete(accountLogin);
    else currentRequests.set(accountLogin, { id: request.id, requestedLogin: request.requestedLogin });
  }
  const responses = mergeResponseCandidates(responseCandidates);

  return {
    artifacts: {
      comments: responses.comments,
      currentReviewRequests: [...currentRequests.values()],
      inlineComments: responses.inlineComments,
      reactions,
      reviewEvents,
      reviewRequests,
      reviews: responses.reviews,
      threadReplies: responses.threadReplies,
    },
    completeness: incompleteReasons.size > 0
      ? { isComplete: false, reasons: [...incompleteReasons] }
      : { isComplete: true, reasons: [] },
    nextTimelineFragments,
    threads: mergeThreadCandidates(threadCandidates),
  };
}

function parseMetric(text: string, label: string): number | undefined {
  const match = text.match(new RegExp(`([\\d,]+)\\s+${label}`, 'i'));
  return match ? Number(match[1]!.replaceAll(',', '')) : undefined;
}

export function extractDiffSummary(document: Document): DiffExtraction {
  for (const region of document.querySelectorAll<HTMLElement>('.diffstat, [data-diffstat], [data-testid="diffstat"]')) {
    const semanticText = [region, ...region.querySelectorAll<HTMLElement>('[aria-label], [title]')]
      .map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.textContent ?? ''}`)
      .join(' ');
    const filesChanged = parseMetric(semanticText, 'files? changed');
    const additions = parseMetric(semanticText, 'additions?');
    const deletions = parseMetric(semanticText, 'deletions?');
    if (filesChanged !== undefined && additions !== undefined && deletions !== undefined) {
      return { completeness: { isComplete: true, reasons: [] }, data: { additions, deletions, filesChanged } };
    }
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
  const hasRenderedEvidence = files.size > 0 || countLines('.blob-code-addition') > 0 || countLines('.blob-code-deletion') > 0;
  return {
    completeness: partial
      ? { isComplete: false, reasons: ['One or more diff files are collapsed, truncated, or not loaded.'] }
      : hasRenderedEvidence
        ? { isComplete: true, reasons: [] }
        : { isComplete: false, reasons: ['GitHub did not expose recognizable diff evidence.'] },
    data: {
      additions: countLines('.blob-code-addition'),
      deletions: countLines('.blob-code-deletion'),
      filesChanged: files.size,
    },
  };
}
