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
const REQUEST_TIMEOUT_MS = 15_000;

export type { PullRequestIdentity } from './domain';
export { isValidPullRequestIdentity } from './github-url';

/** Remote data only. Native comment totals stay on their live PR-list row. */
export interface PullRequestRemoteSummary {
  agents: SectionState<readonly AgentParticipation[]>;
  diff: SectionState<DiffSummary>;
  reviewThreads: SectionState<ReviewThreadCounts>;
}

export type PullRequestRemoteUpdate =
  | { kind: 'diff'; diff: PullRequestRemoteSummary['diff'] }
  | {
      kind: 'timeline';
      agents: PullRequestRemoteSummary['agents'];
      reviewThreads: PullRequestRemoteSummary['reviewThreads'];
    }
  | { kind: 'complete'; summary: PullRequestRemoteSummary };

export interface PullRequestLoadOptions {
  bypassCache?: boolean;
  onUpdate?: (update: PullRequestRemoteUpdate) => void;
  signal?: AbortSignal;
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

interface DiffLoadOutcome {
  diff: PullRequestRemoteSummary['diff'];
  retryableFailure: boolean;
}

interface TimelineLoadOutcome {
  agents: PullRequestRemoteSummary['agents'];
  retryableFailure: boolean;
  reviewThreads: PullRequestRemoteSummary['reviewThreads'];
}

interface NormalizedTimelineFragment {
  dedupeKey: string;
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
  const paginationPath = `${pullRequestPath(identity)}/timeline_more_items`;
  const isLegacy = url.pathname.toLowerCase() === legacyPath.toLowerCase();
  const isPagination = url.pathname.toLowerCase() === paginationPath.toLowerCase();
  if (!isLegacy && !isPagination) return undefined;

  const parameters = url.searchParams;
  if (isPagination) {
    const cursors = parameters.getAll('after_cursor');
    const beforeCursors = parameters.getAll('before_cursor');
    if (
      parameters.size !== 1 + beforeCursors.length ||
      cursors.length !== 1 ||
      !cursors[0] ||
      beforeCursors.length > 1 ||
      (beforeCursors.length === 1 && !beforeCursors[0])
    ) return undefined;
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

function sectionFromCompleteness<T>(data: T, isComplete: boolean, reasons: readonly string[], retryable = false): SectionState<T> {
  return isComplete
    ? { data, status: 'ready' }
    : { data, reason: reasons.join(' '), status: 'partial', ...(retryable ? { retryable: true } : {}) };
}

function isAuthenticationDocument(document: Document): boolean {
  const title = document.title.trim();
  const sessionForm = document.querySelector('form[action="/session"], form[action^="/session?"]');
  if (sessionForm && /^sign in to github(?:\s*[·-]\s*github)?$/i.test(title)) return true;
  return Boolean(document.querySelector(
    '[data-test-selector="sso-warning"], .js-sso-warning, [data-testid="sso-warning"], .flash-error[data-sso-warning]',
  ));
}

function fragmentRequestHeaders(document: Document): Headers {
  const headers = new Headers({ Accept: 'text/html', 'X-Requested-With': 'XMLHttpRequest' });
  const fetchNonce = document.head?.querySelector<HTMLMetaElement>('meta[name="fetch-nonce"]')?.content.trim();
  const clientVersion = document.head?.querySelector<HTMLMetaElement>('meta[name="release"]')?.content.trim();
  if (fetchNonce) headers.set('X-Fetch-Nonce', fetchNonce);
  if (clientVersion) headers.set('X-GitHub-Client-Version', clientVersion);
  return headers;
}

export function createGitHubClient(options: GitHubClientOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? Date.now;
  const parseDocument = options.parseDocument ?? ((html: string) => new DOMParser().parseFromString(html, 'text/html'));
  const limiter = options.limiter ?? sharedLimiter;
  const cache = new Map<string, CachedSummary>();

  const publish = (loadOptions: PullRequestLoadOptions | undefined, update: PullRequestRemoteUpdate) => {
    if (loadOptions?.signal?.aborted || !loadOptions?.onUpdate) return;
    try {
      loadOptions.onUpdate(update);
    } catch {
      // Updates are best-effort observers; loading and caching remain authoritative.
    }
  };

  const fetchDocument = async (
    target: string,
    identity: PullRequestIdentity,
    kind: PullRequestUrlKind,
    signal: AbortSignal | undefined,
    headers?: HeadersInit,
  ): Promise<Document> => {
    if (!isAllowedPullRequestUrl(target, identity, kind)) throw new Error('GitHub URL was not allowed.');
    if (signal?.aborted) throw abortError();
    return limiter.run(signal, async () => {
      const requestController = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectCancellation: ((reason: Error) => void) | undefined;
      const cancelRequest = () => {
        requestController.abort();
        rejectCancellation?.(abortError());
      };
      signal?.addEventListener('abort', cancelRequest, { once: true });
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
        timer = setTimeout(() => {
          timedOut = true;
          requestController.abort();
          reject(new Error('GitHub request timed out.'));
        }, REQUEST_TIMEOUT_MS);
      });
      const request: RequestInit = {
        credentials: 'same-origin',
        method: 'GET',
        redirect: kind === 'fragment' ? 'error' : 'follow',
        signal: requestController.signal,
      };
      if (headers) request.headers = headers;
      const networkRequest = async () => {
        const response = await fetcher(target, request);
        const finalUrl = response.url || target;
        if (kind === 'fragment' && response.url !== target) throw new Error('GitHub redirected to an untrusted URL.');
        if (!isAllowedPullRequestUrl(finalUrl, identity, kind)) throw new Error('GitHub redirected to an untrusted URL.');
        if (response.status === 401 || response.status === 403) throw new Error('GitHub access was denied.');
        if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!/^text\/html(?:;|$)/i.test(contentType)) throw new Error('GitHub did not return HTML.');
        const document = parseDocument(await response.text());
        if (isAuthenticationDocument(document)) throw new Error('GitHub access was denied.');
        return document;
      };
      try {
        return await Promise.race([networkRequest(), deadline]);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new Error('GitHub request timed out.');
        throw error;
      } finally {
        requestController.abort();
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', cancelRequest);
      }
    });
  };

  const loadUncached = async (identity: PullRequestIdentity, loadOptions?: PullRequestLoadOptions): Promise<LoadOutcome> => {
    const signal = loadOptions?.signal;
    const conversationTarget = canonicalUrl(identity, 'conversation');
    const filesTarget = canonicalUrl(identity, 'files');
    const settle = async (
      target: string,
      kind: PullRequestUrlKind,
      headers?: HeadersInit,
    ): Promise<FetchResult> => {
      try {
        return { document: await fetchDocument(target, identity, kind, signal, headers), ok: true };
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw error;
        return { error: asError(error), ok: false };
      }
    };

    const diffPromise = settle(filesTarget, 'files').then((files): DiffLoadOutcome => {
      const diff: PullRequestRemoteSummary['diff'] = !files.ok
        ? { message: files.error.message, status: 'error' }
        : (() => {
            const extracted = extractDiffSummary(files.document);
            return sectionFromCompleteness(extracted.data, extracted.completeness.isComplete, extracted.completeness.reasons);
          })();
      publish(loadOptions, { diff, kind: 'diff' });
      return { diff, retryableFailure: !files.ok };
    });

    const timelinePromise = settle(conversationTarget, 'conversation').then(async (conversation): Promise<TimelineLoadOutcome> => {
      if (!conversation.ok) {
        const message = conversation.error.message;
        const outcome: TimelineLoadOutcome = {
          agents: { message, status: 'error' },
          retryableFailure: true,
          reviewThreads: { message, status: 'error' },
        };
        publish(loadOptions, { agents: outcome.agents, kind: 'timeline', reviewThreads: outcome.reviewThreads });
        return outcome;
      }

      const timelineDocuments: Document[] = [conversation.document];
      const fragmentHeaders = fragmentRequestHeaders(conversation.document);
      const fragmentReasons = new Set<string>();
      const addFragmentReason = (reason: string) => fragmentReasons.add(reason);
      let retryableFailure = false;
      if (!hasRecognizableTimelineEvidence(conversation.document)) addFragmentReason('GitHub did not expose recognizable timeline evidence.');

      const queuedFragments: NormalizedTimelineFragment[] = [];
      const addFragment = (candidate: string) => {
        const fragment = normalizeTimelineFragment(candidate, identity);
        if (!fragment) {
          addFragmentReason('GitHub exposed an invalid timeline fragment.');
          return;
        }
        queuedFragments.push(fragment);
      };
      for (const fragment of extractTimeline(conversation.document, identity).nextTimelineFragments) {
        addFragment(fragment);
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
        const results = await Promise.all(batch.map(({ href }) => settle(href, 'fragment', fragmentHeaders)));
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
      const outcome: TimelineLoadOutcome = {
        agents: sectionFromCompleteness(agentData, agentReasons.size === 0, [...agentReasons], retryableFailure),
        retryableFailure,
        reviewThreads: sectionFromCompleteness(threadData, threadReasons.size === 0, [...threadReasons], retryableFailure),
      };
      publish(loadOptions, { agents: outcome.agents, kind: 'timeline', reviewThreads: outcome.reviewThreads });
      return outcome;
    });

    const [diff, timeline] = await Promise.all([diffPromise, timelinePromise]);
    return {
      retryableFailure: diff.retryableFailure || timeline.retryableFailure,
      summary: {
        agents: timeline.agents,
        diff: diff.diff,
        reviewThreads: timeline.reviewThreads,
      },
    };
  };

  async function loadPullRequest(
    identity: PullRequestIdentity,
    loadOptions?: PullRequestLoadOptions,
  ): Promise<PullRequestRemoteSummary> {
    const signal = loadOptions?.signal;
    if (signal?.aborted) throw abortError();
    if (!isValidPullRequestIdentity(identity)) {
      const message = 'Pull request identity is invalid.';
      const summary: PullRequestRemoteSummary = {
        agents: { message, status: 'error' },
        diff: { message, status: 'error' },
        reviewThreads: { message, status: 'error' },
      };
      publish(loadOptions, { kind: 'complete', summary });
      return summary;
    }
    const key = cacheKey(identity);
    if (loadOptions?.bypassCache) cache.delete(key);
    const cached = cache.get(key);
    if (!loadOptions?.bypassCache && cached && cached.expiresAt > clock()) {
      publish(loadOptions, { kind: 'complete', summary: cached.summary });
      return cached.summary;
    }
    if (cached) cache.delete(key);

    const loaded = await loadUncached(identity, loadOptions);
    if (!loaded.retryableFailure && !signal?.aborted) cache.set(key, { expiresAt: clock() + CACHE_TTL_MS, summary: loaded.summary });
    return loaded.summary;
  }

  return { loadPullRequest };
}
