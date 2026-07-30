import {
  aggregateAgentParticipation,
  classifyReviewThreads,
  type AgentParticipation,
  type DiffSummary,
  type ReviewThreadCounts,
  type SectionState,
} from './domain';
import type { PullRequestIdentity } from './domain';
import {
  extractDiffSummary,
  extractTimeline,
  hasRecognizableTimelineEvidence,
} from './github-dom';
import {
  GITHUB_ORIGIN,
  isValidPullRequestIdentity,
  pullRequestPath,
  trustedGitHubUrl,
} from './github-url';

const CACHE_TTL_MS = 60_000;
const MAX_TIMELINE_FRAGMENTS = 20;

export type { PullRequestIdentity } from './domain';
export { isValidPullRequestIdentity } from './github-url';

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

interface LoadOutcome {
  retryableFailure: boolean;
  summary: PullRequestRemoteSummary;
}

interface NormalizedTimelineFragment {
  dedupeKey: string;
  focusedPullRequestId: string | undefined;
  href: string;
}

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

function canonicalUrl(identity: PullRequestIdentity, kind: 'conversation' | 'files'): string {
  const suffix = kind === 'files' ? '/files' : '';
  return `${GITHUB_ORIGIN}${pullRequestPath(identity)}${suffix}`;
}

function normalizeTimelineFragment(
  candidate: string,
  identity: PullRequestIdentity,
): NormalizedTimelineFragment | undefined {
  const url = trustedGitHubUrl(candidate, { rejectRawFragmentDelimiter: true });
  if (!url || url.hash) return undefined;

  const legacyPath = `${pullRequestPath(identity)}/timeline`;
  const focusedPath = `/${identity.owner}/${identity.repository}/timeline_focused_item`;
  const isLegacy = url.pathname.toLowerCase() === legacyPath.toLowerCase();
  const isFocused = url.pathname.toLowerCase() === focusedPath.toLowerCase();
  if (!isLegacy && !isFocused) return undefined;

  const parameters = url.searchParams;
  let focusedPullRequestId: string | undefined;
  if (isFocused) {
    const ids = parameters.getAll('id');
    const cursors = parameters.getAll('after_cursor');
    if (
      parameters.size !== 2 ||
      ids.length !== 1 ||
      cursors.length !== 1 ||
      !cursors[0] ||
      !/^PR_[A-Za-z0-9_-]+$/.test(ids[0] ?? '')
    ) return undefined;
    focusedPullRequestId = ids[0];
  } else {
    const after = parameters.getAll('after');
    const afterCursor = parameters.getAll('after_cursor');
    if (
      parameters.size !== 1 ||
      (after.length === 1 && Boolean(after[0])) === (afterCursor.length === 1 && Boolean(afterCursor[0]))
    ) return undefined;
  }

  return {
    dedupeKey: `${url.origin}${url.pathname.toLowerCase()}${url.search}`,
    focusedPullRequestId,
    href: url.href,
  };
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
  const url = trustedGitHubUrl(candidate);
  if (!url) return false;

  const base = pullRequestPath(identity);
  const sameConversationPath = url.pathname.toLowerCase() === base.toLowerCase();
  if (kind === 'conversation') return sameConversationPath && !url.search && !url.hash;
  if (kind === 'files') {
    const path = url.pathname.toLowerCase();
    return (
      path === `${base}/files`.toLowerCase()
      || path === `${base}/changes`.toLowerCase()
    ) && !url.search && !url.hash;
  }

  return Boolean(normalizeTimelineFragment(candidate, identity));
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

function isAuthenticationDocument(document: Document): boolean {
  const title = document.title.trim();
  const sessionForm = document.querySelector('form[action="/session"], form[action^="/session?"]');
  if (sessionForm && /^sign in to github(?:\s*[·-]\s*github)?$/i.test(title)) return true;
  return Boolean(document.querySelector(
    '[data-test-selector="sso-warning"], .js-sso-warning, [data-testid="sso-warning"], .flash-error[data-sso-warning]',
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
        redirect: 'follow',
        signal,
      });
      const finalUrl = response.url || target;
      if (!isAllowedPullRequestUrl(finalUrl, identity, kind)) throw new Error('GitHub redirected to an untrusted URL.');
      if (response.status === 401 || response.status === 403) throw new Error('GitHub access was denied.');
      if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^text\/html(?:;|$)/i.test(contentType)) throw new Error('GitHub did not return HTML.');
      const document = parseDocument(await response.text());
      if (isAuthenticationDocument(document)) throw new Error('GitHub access was denied.');
      return document;
    });
  };

  const loadUncached = async (identity: PullRequestIdentity, signal?: AbortSignal): Promise<LoadOutcome> => {
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
        retryableFailure: true,
        summary: {
          agents: { message, status: 'error' },
          diff,
          reviewThreads: { message, status: 'error' },
        },
      };
    }

    const timelineDocuments: Document[] = [conversation.document];
    const fragmentReasons = new Set<string>();
    const addFragmentReason = (reason: string) => fragmentReasons.add(reason);
    let retryableFailure = !files.ok;
    if (!hasRecognizableTimelineEvidence(conversation.document)) addFragmentReason('GitHub did not expose recognizable timeline evidence.');

    let pinnedFocusedPullRequestId: string | undefined;
    const queuedFragments: NormalizedTimelineFragment[] = [];
    const addFragment = (candidate: string, isConversationLoader = false) => {
      const fragment = normalizeTimelineFragment(candidate, identity);
      if (!fragment) {
        addFragmentReason('GitHub exposed an invalid timeline fragment.');
        return;
      }
      if (fragment.focusedPullRequestId) {
        if (isConversationLoader && pinnedFocusedPullRequestId === undefined) {
          pinnedFocusedPullRequestId = fragment.focusedPullRequestId;
        } else if (pinnedFocusedPullRequestId !== fragment.focusedPullRequestId) {
          addFragmentReason('GitHub exposed an invalid timeline fragment.');
          return;
        }
      }
      queuedFragments.push(fragment);
    };
    for (const fragment of extractTimeline(conversation.document, identity).nextTimelineFragments) {
      addFragment(fragment, true);
    }
    const seenFragments = new Set<string>();
    let followed = 0;
    while (queuedFragments.length > 0) {
      if (followed >= MAX_TIMELINE_FRAGMENTS) {
        addFragmentReason('GitHub exposed more than 20 timeline fragments.');
        break;
      }
      const batch: NormalizedTimelineFragment[] = [];
      while (queuedFragments.length > 0 && batch.length + followed < MAX_TIMELINE_FRAGMENTS && batch.length < 4) {
        const fragment = queuedFragments.shift()!;
        if (seenFragments.has(fragment.dedupeKey)) continue;
        seenFragments.add(fragment.dedupeKey);
        batch.push(fragment);
      }
      if (batch.length === 0) continue;
      followed += batch.length;
      const results = await Promise.all(batch.map(({ href }) => settle(href, 'fragment')));
      for (const result of results) {
        if (!result.ok) {
          retryableFailure = true;
          addFragmentReason(`A timeline fragment could not be loaded: ${result.error.message}`);
          continue;
        }
        timelineDocuments.push(result.document);
        if (!hasRecognizableTimelineEvidence(result.document)) addFragmentReason('A timeline fragment had no recognizable review data.');
        for (const fragment of extractTimeline(result.document, identity).nextTimelineFragments) {
          addFragment(fragment);
        }
      }
    }

    const timeline = extractTimeline(timelineDocuments, identity);
    const agentReasons = new Set([
      ...fragmentReasons,
      ...timeline.completeness.agents.reasons,
    ]);
    const threadReasons = new Set([
      ...fragmentReasons,
      ...timeline.completeness.reviewThreads.reasons,
    ]);
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
      retryableFailure,
      summary: {
        agents: sectionFromCompleteness(agentData, agentReasons.size === 0, [...agentReasons]),
        diff,
        reviewThreads: sectionFromCompleteness(threadData, threadReasons.size === 0, [...threadReasons]),
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
      if (!loaded.retryableFailure && !signal?.aborted) cache.set(key, { expiresAt: clock() + CACHE_TTL_MS, summary: loaded.summary });
      return loaded.summary;
    },
  };
}
