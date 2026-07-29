import {
  aggregateAgentParticipation,
  classifyReviewThreads,
  type AgentParticipation,
  type DiffSummary,
  type ReviewThreadCounts,
  type SectionState,
} from './domain';
import { extractDiffSummary, extractTimeline } from './github-dom';

const GITHUB_ORIGIN = 'https://github.com';
const CACHE_TTL_MS = 60_000;
const MAX_TIMELINE_FRAGMENTS = 20;

export interface PullRequestIdentity {
  number: number;
  owner: string;
  repository: string;
}

/** Remote data only. Native comment totals stay on their live PR-list row. */
export interface PullRequestRemoteSummary {
  agents: SectionState<readonly AgentParticipation[]>;
  diff: SectionState<DiffSummary>;
  reviewThreads: SectionState<ReviewThreadCounts>;
}

export type PullRequestUrlKind = 'conversation' | 'files' | 'fragment';

export interface FetchLimiter {
  run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T>;
}

export interface GitHubClientOptions {
  clock?: () => number;
  fetch?: typeof fetch;
  limiter?: FetchLimiter;
  parseDocument?: (html: string) => Document;
}

interface CachedSummary {
  expiresAt: number;
  summary: PullRequestRemoteSummary;
}

interface FetchFailure {
  error: Error;
  ok: false;
}

interface FetchSuccess {
  document: Document;
  ok: true;
}

type FetchResult = FetchFailure | FetchSuccess;

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError' ||
    error instanceof Error && error.name === 'AbortError';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function isValidPullRequestIdentity(identity: PullRequestIdentity): boolean {
  return validSegment(identity.owner) &&
    validSegment(identity.repository) &&
    Number.isSafeInteger(identity.number) && identity.number > 0;
}

function canonicalUrl(identity: PullRequestIdentity, kind: 'conversation' | 'files'): string {
  const suffix = kind === 'files' ? '/files' : '';
  return `${GITHUB_ORIGIN}/${identity.owner}/${identity.repository}/pull/${identity.number}${suffix}`;
}

/**
 * Validates every navigation target before it crosses the fetch boundary.
 * Timeline fragments are intentionally the only non-page target allowed.
 */
export function isAllowedPullRequestUrl(
  candidate: string,
  identity: PullRequestIdentity,
  kind: PullRequestUrlKind,
): boolean {
  if (!isValidPullRequestIdentity(identity)) return false;
  // WHATWG URL normalizes backslashes and dot segments. Reject their raw or
  // encoded spellings so validation never approves a different path than the
  // one GitHub ultimately receives.
  if (/\\|%(?:2f|5c|2e)/i.test(candidate)) return false;

  let url: URL;
  try {
    url = new URL(candidate, GITHUB_ORIGIN);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== GITHUB_ORIGIN ||
    url.port ||
    url.username ||
    url.password
  ) return false;

  const base = `/${identity.owner}/${identity.repository}/pull/${identity.number}`;
  const sameConversationPath = url.pathname.toLowerCase() === base.toLowerCase();
  if (kind === 'conversation') return sameConversationPath && !url.search && !url.hash;
  if (kind === 'files') return url.pathname.toLowerCase() === `${base}/files`.toLowerCase() && !url.search && !url.hash;

  return url.pathname.toLowerCase() === `${base}/timeline`.toLowerCase() && !url.hash;
}

export function createFetchLimiter(maximum = 4): FetchLimiter {
  if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError('Fetch limiter maximum must be at least one.');

  let active = 0;
  const queue: Array<() => void> = [];
  const drain = () => {
    while (active < maximum && queue.length > 0) queue.shift()!();
  };

  return {
    run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener('abort', cancel);
          if (signal?.aborted) {
            reject(abortError());
            drain();
            return;
          }
          active += 1;
          work().then(resolve, reject).finally(() => {
            active -= 1;
            drain();
          });
        };
        const cancel = () => {
          const index = queue.indexOf(start);
          if (index !== -1) queue.splice(index, 1);
          signal?.removeEventListener('abort', cancel);
          reject(abortError());
        };
        queue.push(start);
        signal?.addEventListener('abort', cancel, { once: true });
        drain();
      });
    },
  };
}

const sharedLimiter = createFetchLimiter(4);

function cacheKey(identity: PullRequestIdentity): string {
  return `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`;
}

function sectionFromCompleteness<T>(data: T, isComplete: boolean, reasons: readonly string[]): SectionState<T> {
  return isComplete
    ? { data, status: 'ready' }
    : { data, reason: reasons.join(' '), status: 'partial' };
}

function hasTimelineEvidence(document: Document): boolean {
  return Boolean(document.querySelector(
    '#discussion_bucket, .js-discussion, [data-testid="issue-viewer-issue-container"], .js-resolvable-timeline-thread-container, review-thread-collapsible, [id^="issuecomment-"], [id^="pullrequestreview-"], [data-review-request-action], [data-review-event], [data-reaction-content="eyes"], #js-timeline-progressive-loader',
  ));
}

export function createGitHubClient(options: GitHubClientOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? Date.now;
  const parseDocument = options.parseDocument ?? ((html: string) => new DOMParser().parseFromString(html, 'text/html'));
  const limiter = options.limiter ?? sharedLimiter;
  const cache = new Map<string, CachedSummary>();

  const fetchDocument = async (
    target: string,
    identity: PullRequestIdentity,
    kind: PullRequestUrlKind,
    signal: AbortSignal | undefined,
  ): Promise<Document> => {
    if (!isAllowedPullRequestUrl(target, identity, kind)) throw new Error('GitHub URL was not allowed.');
    if (signal?.aborted) throw abortError();
    return limiter.run(signal, async () => {
      const response = await fetcher(target, {
        credentials: 'same-origin',
        method: 'GET',
        redirect: 'error',
        signal,
      });
      const finalUrl = response.url || target;
      if (!isAllowedPullRequestUrl(finalUrl, identity, kind)) throw new Error('GitHub redirected to an untrusted URL.');
      if (response.status === 401 || response.status === 403) throw new Error('GitHub access was denied.');
      if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^text\/html(?:;|$)/i.test(contentType)) throw new Error('GitHub did not return HTML.');
      const document = parseDocument(await response.text());
      const bodyText = document.body.textContent ?? '';
      if (
        /\b(?:access denied|sign in to github|single sign-on|sso authorization)\b/i.test(bodyText) ||
        document.querySelector('form[action*="/session"], a[href^="/login"], [data-test-selector="sso-warning"]')
      ) throw new Error('GitHub access was denied.');
      return document;
    });
  };

  const loadUncached = async (identity: PullRequestIdentity, signal?: AbortSignal): Promise<{ cacheable: boolean; summary: PullRequestRemoteSummary }> => {
    const conversationTarget = canonicalUrl(identity, 'conversation');
    const filesTarget = canonicalUrl(identity, 'files');
    const settle = async (target: string, kind: PullRequestUrlKind): Promise<FetchResult> => {
      try {
        return { document: await fetchDocument(target, identity, kind, signal), ok: true };
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw error;
        return { error: asError(error), ok: false };
      }
    };

    const [conversation, files] = await Promise.all([
      settle(conversationTarget, 'conversation'),
      settle(filesTarget, 'files'),
    ]);

    const diff = !files.ok
      ? { message: files.error.message, status: 'error' as const }
      : (() => {
          const extracted = extractDiffSummary(files.document);
          return sectionFromCompleteness(extracted.data, extracted.completeness.isComplete, extracted.completeness.reasons);
        })();

    if (!conversation.ok) {
      const message = conversation.error.message;
      return {
        cacheable: false,
        summary: {
          agents: { message, status: 'error' },
          diff,
          reviewThreads: { message, status: 'error' },
        },
      };
    }

    const timelineDocuments: Document[] = [conversation.document];
    const incompleteReasons: string[] = [];
    let fetchFailed = !files.ok;
    if (!hasTimelineEvidence(conversation.document)) incompleteReasons.push('GitHub did not expose recognizable timeline evidence.');
    if (!files.ok) incompleteReasons.push('The files page could not be loaded for inline review data.');

    const queuedFragments = [...extractTimeline(conversation.document).nextTimelineFragments];
    const seenFragments = new Set<string>();
    let followed = 0;
    while (queuedFragments.length > 0) {
      if (followed >= MAX_TIMELINE_FRAGMENTS) {
        incompleteReasons.push('GitHub exposed more than 20 timeline fragments.');
        break;
      }
      const batch: string[] = [];
      while (queuedFragments.length > 0 && batch.length + followed < MAX_TIMELINE_FRAGMENTS && batch.length < 4) {
        const candidate = queuedFragments.shift()!;
        if (!isAllowedPullRequestUrl(candidate, identity, 'fragment')) {
          incompleteReasons.push('GitHub exposed an invalid timeline fragment.');
          continue;
        }
        const normalized = new URL(candidate, GITHUB_ORIGIN).href;
        if (seenFragments.has(normalized)) continue;
        seenFragments.add(normalized);
        batch.push(normalized);
      }
      if (batch.length === 0) continue;
      followed += batch.length;
      const results = await Promise.all(batch.map((target) => settle(target, 'fragment')));
      for (const result of results) {
        if (!result.ok) {
          fetchFailed = true;
          incompleteReasons.push(`A timeline fragment could not be loaded: ${result.error.message}`);
          continue;
        }
        timelineDocuments.push(result.document);
        if (!hasTimelineEvidence(result.document)) incompleteReasons.push('A timeline fragment had no recognizable review data.');
        queuedFragments.push(...extractTimeline(result.document).nextTimelineFragments);
      }
    }

    if (files.ok) timelineDocuments.push(files.document);
    const timeline = extractTimeline(timelineDocuments);
    if (!timeline.completeness.isComplete) incompleteReasons.push(...timeline.completeness.reasons);
    const timelineComplete = incompleteReasons.length === 0;
    const threadData = classifyReviewThreads(timeline.threads);
    const agentData = aggregateAgentParticipation({
      comments: timeline.artifacts.comments,
      inlineComments: timeline.artifacts.inlineComments,
      reactions: timeline.artifacts.reactions,
      reviewEvents: timeline.artifacts.reviewEvents,
      reviewRequests: timeline.artifacts.currentReviewRequests,
      reviews: timeline.artifacts.reviews,
      threadReplies: timeline.artifacts.threadReplies,
    });

    return {
      cacheable: !fetchFailed,
      summary: {
        agents: sectionFromCompleteness(agentData, timelineComplete, incompleteReasons),
        diff,
        reviewThreads: sectionFromCompleteness(threadData, timelineComplete, incompleteReasons),
      },
    };
  };

  return {
    async loadPullRequest(identity: PullRequestIdentity, signal?: AbortSignal): Promise<PullRequestRemoteSummary> {
      if (signal?.aborted) throw abortError();
      if (!isValidPullRequestIdentity(identity)) {
        const message = 'Pull request identity is invalid.';
        return {
          agents: { message, status: 'error' },
          diff: { message, status: 'error' },
          reviewThreads: { message, status: 'error' },
        };
      }
      const key = cacheKey(identity);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > clock()) return cached.summary;
      if (cached) cache.delete(key);

      const loaded = await loadUncached(identity, signal);
      if (loaded.cacheable) cache.set(key, { expiresAt: clock() + CACHE_TTL_MS, summary: loaded.summary });
      return loaded.summary;
    },
  };
}
