import type { PullRequestIdentity, ReviewThread } from './domain';
import {
  AI_AGENT_REGISTRY,
  normalizeAgentAccountLogin,
  normalizeAgentLogin,
} from './domain';
import {
  isValidPullRequestIdentity,
  pullRequestPath,
  trustedGitHubUrl,
} from './github-url';

export interface ExtractionCompleteness {
  isComplete: boolean;
  reasons: readonly string[];
}
export interface ResponseArtifactExtraction { actorLogin: string; id: string; }
export interface FormalReviewRequestExtraction { action: 'removed' | 'requested'; id: string; requestedLogin: string; }
export interface ReviewEventExtraction extends ResponseArtifactExtraction { action: 'started-reviewing'; }
export interface ReactionExtraction extends ResponseArtifactExtraction { content: 'eyes'; }
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
  completeness: {
    agents: ExtractionCompleteness;
    reviewThreads: ExtractionCompleteness;
  };
  nextTimelineFragments: readonly string[];
  threads: readonly ReviewThread[];
}

const threadRootSelector = '.js-resolvable-timeline-thread-container, review-thread-collapsible';
// The progressive loader's data-timeline-item-src is an anchor lookup, not pagination.
const timelineLoaderSelector = 'form.js-ajax-pagination[method="get" i][action]:not(.js-review-hidden-comment-ids)';
const inlineResponseSelector = '[id^="discussion_r"], [id^="discussion-diff-"]';
const reviewRequestSelector = '[data-review-request-action], [data-review-requested-login], .TimelineItem[id^="event-"]';
const reviewEventSelector = '[data-review-event="started-reviewing"], .TimelineItem[id^="event-"]';
const recognizableTimelineEvidenceSelector = [
  '#discussion_bucket',
  '.js-discussion',
  '[data-testid="issue-viewer-issue-container"]',
  threadRootSelector,
  '[id^="issuecomment-"]',
  '[id^="pullrequestreview-"]',
  inlineResponseSelector,
  '[data-reaction-content="eyes"]',
  timelineLoaderSelector,
].join(', ');

function documentsFrom(input: Document | readonly Document[]): readonly Document[] { return 'querySelector' in input ? [input] : input; }
function textLogin(element: Element | null): string | undefined {
  if (!element) return undefined;
  const candidate = element.getAttribute('data-login') ?? element.getAttribute('data-actor-login') ?? element.getAttribute('data-review-requested-login') ?? element.textContent?.trim();
  return candidate && normalizeAgentLogin(candidate) ? candidate : undefined;
}
const actorSelectors = ['a[data-hovercard-type="user"]', 'a[data-login]', 'a[data-actor-login]', 'a[data-hovercard-url]', 'a[href^="/users/"]', 'a[href^="/apps/"]'] as const;
function recognizedLogin(element: Element, includeText = true): string | undefined {
  const candidates = [element.getAttribute('data-login'), element.getAttribute('data-actor-login'), element.getAttribute('data-review-requested-login'), element.getAttribute('data-hovercard-url')?.match(/\/(?:apps|users)\/([^/?#]+)/i)?.[1], element.getAttribute('href')?.match(/\/(?:apps|users)\/([^/?#]+)/i)?.[1], ...(includeText ? [element.textContent?.trim()] : [])];
  return candidates.find((candidate): candidate is string => Boolean(candidate) && Boolean(normalizeAgentLogin(candidate)));
}
function actorLogins(element: Element, includeNestedActors = false): string[] {
  const logins: string[] = []; const seenAccounts = new Set<string>();
  const add = (login: string | undefined) => { const accountLogin = normalizeAgentAccountLogin(login); if (login && accountLogin && !seenAccounts.has(accountLogin)) { seenAccounts.add(accountLogin); logins.push(login); } };
  add(recognizedLogin(element, false));
  const selector = actorSelectors.join(', ');
  const candidates = includeNestedActors ? [...element.querySelectorAll(selector)] : [...element.children].flatMap((child) => child.matches(selector) ? [child] : child.matches('header, [class*="header" i]') ? [...child.querySelectorAll(selector)] : []);
  for (const candidate of candidates) add(recognizedLogin(candidate));
  return logins;
}
function actorLogin(element: Element, includeNestedActors = false): string | undefined { return actorLogins(element, includeNestedActors)[0]; }
function typedResponseId(element: Element): string | undefined { return /^(?:issuecomment-|pullrequestreview-|discussion_r|discussion-diff-)/.test(element.id) ? element.id : undefined; }
function stableId(element: Element): string | undefined { return (element.getAttribute('data-gid') ?? element.id) || undefined; }
function booleanAttribute(element: Element, name: string): boolean | undefined { const value = element.getAttribute(name)?.toLowerCase(); return value === 'true' ? true : value === 'false' ? false : undefined; }
function deferredThreadIdentity(
  root: Element,
  identity: PullRequestIdentity,
): string | undefined {
  if (!isValidPullRequestIdentity(identity)) return undefined;

  const url = trustedGitHubUrl(root.getAttribute('data-deferred-content-url'), {
    rejectRawFragmentDelimiter: true,
  });
  if (!url) return undefined;

  const path = pullRequestPath(identity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = url.pathname.match(new RegExp(`^${path}/threads/([1-9]\\d*)$`, 'i'));
  return match ? `thread-${match[1]}` : undefined;
}

function threadIdentities(root: Element, identity: PullRequestIdentity): string[] {
  const identities: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && !identities.includes(value)) identities.push(value);
  };

  add(root.querySelector<HTMLInputElement>('input[name="pull_request_review_thread_id"]')?.value);
  add(root.getAttribute('data-review-thread-id'));
  add(root.getAttribute('data-pull-request-review-thread-id'));
  add(root.getAttribute('data-gid'));
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    add(anchor.getAttribute('href')?.match(/#(discussion_(?:r|diff-)[^?#/]+)/)?.[1]);
  }
  add(root.querySelector<HTMLElement>('[id^="discussion_r"], [id^="discussion-diff-"]')?.id);
  add(deferredThreadIdentity(root, identity));
  return identities;
}
interface ParsedThreadState { isReadable: boolean; value: boolean; }
interface ThreadCandidate { identities: readonly string[]; outdated: ParsedThreadState; resolved: ParsedThreadState; }
interface AliasedCandidate { identities: readonly string[]; }
function groupAliasedCandidates<T extends AliasedCandidate>(candidates: readonly T[]): T[][] {
  const parent = new Map<string, string>();
  const find = (identity: string): string => { const current = parent.get(identity) ?? identity; if (current === identity) return identity; const root = find(current); parent.set(identity, root); return root; };
  const union = (left: string, right: string) => { const leftRoot = find(left); const rightRoot = find(right); if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot); };
  for (const candidate of candidates) { const [first, ...rest] = candidate.identities; if (!first) continue; parent.set(first, parent.get(first) ?? first); for (const identity of rest) { parent.set(identity, parent.get(identity) ?? identity); union(first, identity); } }
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) { const first = candidate.identities[0]; if (!first) continue; const group = groups.get(find(first)) ?? []; group.push(candidate); groups.set(find(first), group); }
  return [...groups.values()] as T[][];
}
function mergeThreadCandidates(candidates: readonly ThreadCandidate[]): ReviewThread[] {
  return groupAliasedCandidates(candidates).flatMap((group) => {
    const isOutdated = group.some((candidate) => candidate.outdated.isReadable && candidate.outdated.value);
    const isResolved = group.some((candidate) => candidate.resolved.isReadable && candidate.resolved.value);
    const isActive = group.every((candidate) => candidate.outdated.isReadable && !candidate.outdated.value && candidate.resolved.isReadable && !candidate.resolved.value);
    if (!isOutdated && !isResolved && !isActive) return [];
    const id = [...new Set(group.flatMap((candidate) => candidate.identities))].sort((left, right) => Number(left.startsWith('discussion_')) - Number(right.startsWith('discussion_')) || left.localeCompare(right))[0]!;
    return [{ id, isOutdated, isResolved }];
  });
}
function structuredBooleanState(root: Element, key: 'isOutdated' | 'isResolved'): ParsedThreadState | undefined {
  for (const attribute of [...root.attributes]) { if (!/(?:state|hydrate|payload|data)$/i.test(attribute.name) || !new RegExp(`["']${key}["']`, 'i').test(attribute.value)) continue; const match = attribute.value.match(new RegExp(`["']${key}["']\\s*:\\s*(true|false)`, 'i')); return { isReadable: Boolean(match), value: match?.[1]?.toLowerCase() === 'true' }; }
  return undefined;
}
function resolvedState(root: Element): ParsedThreadState { if (root.hasAttribute('data-resolved')) { const value = booleanAttribute(root, 'data-resolved'); return { isReadable: value !== undefined, value: value ?? false }; } return structuredBooleanState(root, 'isResolved') ?? { isReadable: false, value: false }; }
function outdatedState(root: Element): ParsedThreadState { if (root.hasAttribute('data-outdated')) { const value = booleanAttribute(root, 'data-outdated'); return { isReadable: value !== undefined, value: value ?? false }; } if ([...root.querySelectorAll('[title]')].some((element) => element.getAttribute('title') === 'Label: Outdated')) return { isReadable: true, value: true }; return structuredBooleanState(root, 'isOutdated') ?? { isReadable: true, value: false }; }
type ResponseKind = 'comment' | 'inline' | 'review' | 'thread-reply';
interface ResponseCandidate extends AliasedCandidate { actorLogin: string; kind: ResponseKind; }
function responseIdentities(element: Element): string[] { const identities: string[] = []; const add = (identity: string | null | undefined) => { if (identity && !identities.includes(identity)) identities.push(identity); }; add(typedResponseId(element)); add(element.getAttribute('data-gid')); if (identities.length === 0) add(element.id); return identities; }
function responseIdentityRank(identity: string): number { if (identity.startsWith('issuecomment-')) return 0; if (identity.startsWith('pullrequestreview-')) return 1; if (identity.startsWith('discussion_r')) return 2; if (identity.startsWith('discussion-diff-')) return 3; return 4; }
function mergeResponseCandidates(candidates: readonly ResponseCandidate[]): { comments: ResponseArtifactExtraction[]; inlineComments: ResponseArtifactExtraction[]; reviews: ResponseArtifactExtraction[]; threadReplies: ResponseArtifactExtraction[]; } {
  const result = { comments: [] as ResponseArtifactExtraction[], inlineComments: [] as ResponseArtifactExtraction[], reviews: [] as ResponseArtifactExtraction[], threadReplies: [] as ResponseArtifactExtraction[] };
  const targets: Record<ResponseKind, ResponseArtifactExtraction[]> = { comment: result.comments, inline: result.inlineComments, review: result.reviews, 'thread-reply': result.threadReplies };
  const reviewCandidates = candidates.filter((candidate) => candidate.kind === 'review'); const commentCandidates = candidates.filter((candidate) => candidate.kind !== 'review');
  for (const namespace of [reviewCandidates, commentCandidates]) for (const group of groupAliasedCandidates(namespace)) { const id = [...new Set(group.flatMap((candidate) => candidate.identities))].sort((left, right) => responseIdentityRank(left) - responseIdentityRank(right) || left.localeCompare(right))[0]; if (!id) continue; const seenKinds = new Set<ResponseKind>(); for (const candidate of group) { if (seenKinds.has(candidate.kind)) continue; seenKinds.add(candidate.kind); targets[candidate.kind].push({ actorLogin: candidate.actorLogin, id }); } }
  return result;
}
function loginForAgentLabel(value: string | null | undefined): string | undefined {
  const label = value?.trim().toLowerCase();
  return AI_AGENT_REGISTRY.find(
    (agent) => agent.label.toLowerCase() === label,
  )?.logins[0];
}
function eventAgentLogin(element: Element): string | undefined {
  for (const anchor of element.querySelectorAll('a')) {
    const login = recognizedLogin(anchor);
    if (login) return login;
  }
  return loginForAgentLabel(element.querySelector('strong')?.textContent);
}
function reviewRequestFrom(element: Element): FormalReviewRequestExtraction | undefined {
  const actionValue = element.getAttribute('data-review-request-action')?.toLowerCase();
  const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const usesStructuredAction = actionValue === 'removed' || actionValue === 'requested';
  const action = actionValue === 'removed'
    ? 'removed'
    : actionValue === 'requested'
      ? 'requested'
      : /\b(?:requested a review from|AI review requested)\b/i.test(text)
        ? 'requested'
        : /\bremoved review request (?:for|from)\b/i.test(text)
          ? 'removed'
          : undefined;
  const id = stableId(element);
  const requestedLogin = usesStructuredAction
    ? textLogin(element) ?? eventAgentLogin(element)
    : eventAgentLogin(element) ?? textLogin(element);
  return action && id && requestedLogin
    ? { action, id, requestedLogin }
    : undefined;
}
function reviewEventFrom(element: Element): ReviewEventExtraction | undefined {
  const usesStructuredEvent = element.getAttribute('data-review-event') === 'started-reviewing';
  const started = usesStructuredEvent || /\bstarted reviewing\b/i.test(element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  if (!started) return undefined;
  const id = stableId(element);
  const login = usesStructuredEvent
    ? actorLogin(element) ?? eventAgentLogin(element)
    : eventAgentLogin(element) ?? actorLogin(element);
  return id && login ? { action: 'started-reviewing', actorLogin: login, id } : undefined;
}
export function hasRecognizableTimelineEvidence(document: Document): boolean {
  return Boolean(document.querySelector(recognizableTimelineEvidenceSelector)) ||
    [...document.querySelectorAll(reviewRequestSelector)].some((element) => Boolean(reviewRequestFrom(element))) ||
    [...document.querySelectorAll(reviewEventSelector)].some((element) => Boolean(reviewEventFrom(element)));
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function automatedCommentLogin(
  element: Element,
  agentReasons: Set<string>,
): string | undefined {
  const scripts = element.querySelectorAll(
    'react-partial script[type="application/json"][data-target="react-partial.embeddedData"]',
  );
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      agentReasons.add('An automated review comment payload could not be read.');
      continue;
    }
    if (!isObject(parsed) || !isObject(parsed.props) || !isObject(parsed.props.comment)) {
      continue;
    }
    const { author, automatedComment } = parsed.props.comment;
    if (!isObject(author) || !isObject(automatedComment)) continue;
    if (author.login === 'Copilot' && automatedComment.source === 'copilot') {
      return 'copilot-pull-request-reviewer';
    }
  }
  return undefined;
}
function hasHiddenDeferredBody(root: Element): boolean {
  return root.hasAttribute('data-hidden-comment-ids') ||
    root.querySelector('include-fragment, [data-deferred-content]') !== null;
}
export function extractTimeline(
  input: Document | readonly Document[],
  identity: PullRequestIdentity,
): TimelineExtraction {
  const threadCandidates: ThreadCandidate[] = [];
  const responseCandidates: ResponseCandidate[] = [];
  const reviewRequests: FormalReviewRequestExtraction[] = [];
  const reviewEvents: ReviewEventExtraction[] = [];
  const reactions: ReactionExtraction[] = [];
  const seen = new Map<string, Set<string>>();
  const add = <T extends { id: string }>(kind: string, target: T[], artifact: T, identity = artifact.id) => { const identities = seen.get(kind) ?? new Set<string>(); seen.set(kind, identities); if (!identities.has(identity)) { identities.add(identity); target.push(artifact); } };
  const agentReasons = new Set<string>(); const reviewThreadReasons = new Set<string>();
  const addResponse = (kind: ResponseKind, element: Element) => {
    const identities = responseIdentities(element);
    const login = actorLogin(element) ?? automatedCommentLogin(element, agentReasons);
    if (identities.length > 0 && login) responseCandidates.push({ actorLogin: login, identities, kind });
  };
  const nextTimelineFragments: string[] = []; const seenFragments = new Set<string>();
  for (const document of documentsFrom(input)) {
    if (document.querySelector('form.js-review-hidden-comment-ids')) {
      const reason = 'GitHub has additional review conversations that are not loaded.';
      reviewThreadReasons.add(reason);
      agentReasons.add(reason);
    }
    for (const loader of document.querySelectorAll<HTMLElement>(timelineLoaderSelector)) { const fragment = loader.getAttribute('action'); if (fragment && !seenFragments.has(fragment)) { seenFragments.add(fragment); nextTimelineFragments.push(fragment); } }
    for (const root of document.querySelectorAll<HTMLElement>(threadRootSelector)) {
      const identities = threadIdentities(root, identity);
      const resolved = resolvedState(root);
      const outdated = outdatedState(root);
      if (identities.length === 0) {
        reviewThreadReasons.add('A resolvable review thread had no stable identity.');
      } else {
        threadCandidates.push({ identities, outdated, resolved });
        if (!resolved.isReadable || !outdated.isReadable) {
          reviewThreadReasons.add('A resolvable review thread had unreadable resolution or outdated state.');
        }
      }
      if (root.hasAttribute('data-deferred-content-url') && hasHiddenDeferredBody(root)) {
        agentReasons.add('A deferred review thread may hide AI response details.');
      }
      for (const element of root.querySelectorAll<HTMLElement>(inlineResponseSelector)) {
        addResponse('inline', element);
      }
      for (const element of root.querySelectorAll<HTMLElement>('[id^="issuecomment-"]')) {
        addResponse('thread-reply', element);
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>('[id^="issuecomment-"]')) { if (!element.closest(threadRootSelector)) addResponse('comment', element); }
    for (const element of document.querySelectorAll<HTMLElement>('[id^="pullrequestreview-"]')) addResponse('review', element);
    for (const element of document.querySelectorAll<HTMLElement>(inlineResponseSelector)) {
      if (!element.closest(threadRootSelector)) addResponse('inline', element);
    }
    for (const element of document.querySelectorAll<HTMLElement>(reviewRequestSelector)) {
      const request = reviewRequestFrom(element);
      if (request) {
        add('review-request', reviewRequests, request);
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>(reviewEventSelector)) {
      const event = reviewEventFrom(element);
      if (event) {
        add('review-event', reviewEvents, event);
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-reaction-content="eyes"]')) { const id = stableId(element) ?? element.getAttribute('data-reaction-id') ?? undefined; if (!id) continue; for (const login of actorLogins(element, true)) { const accountLogin = normalizeAgentAccountLogin(login); if (accountLogin) add('reaction', reactions, { actorLogin: login, content: 'eyes', id }, `${id}\0${accountLogin}`); } }
  }
  const currentRequests = new Map<string, Omit<FormalReviewRequestExtraction, 'action'>>();
  for (const request of reviewRequests) { const accountLogin = normalizeAgentAccountLogin(request.requestedLogin); if (!accountLogin) continue; if (request.action === 'removed') currentRequests.delete(accountLogin); else currentRequests.set(accountLogin, { id: request.id, requestedLogin: request.requestedLogin }); }
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
    completeness: {
      agents: agentReasons.size > 0 ? { isComplete: false, reasons: [...agentReasons] } : { isComplete: true, reasons: [] },
      reviewThreads: reviewThreadReasons.size > 0 ? { isComplete: false, reasons: [...reviewThreadReasons] } : { isComplete: true, reasons: [] },
    },
    nextTimelineFragments,
    threads: mergeThreadCandidates(threadCandidates),
  };
}
