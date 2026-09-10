import type { PullRequestIdentity } from './domain';
import { trustedGitHubUrl } from './github-url';

export type NativeCommentCount =
  | { count: number; href: string; status: 'ready' }
  | { status: 'zero' }
  | { reason: string; status: 'error' };

export interface PullRequestRowExtraction {
  authorLogin?: string;
  identity: PullRequestIdentity;
  nativeComments: NativeCommentCount;
  viewerLogin?: string;
}

// GitHub serves both the legacy list and the React ListView during its rollout.
// Share this selector with mounting and lifecycle checks so they agree on ownership.
export const PULL_REQUEST_ROW_SELECTOR =
  '[id^="issue_"].js-issue-row, [data-listview-component="items-list"] > li';

const pullRequestTitleSelector =
  '.Link--primary, [data-testid="issue-pr-title-link"], [data-testid="pull-request-title-link"], [data-testid="issue-title-link"], [data-testid="listitem-title-link"]';

function canonicalPullIdentity(href: string | null): PullRequestIdentity | undefined {
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
  identity: PullRequestIdentity;
}> {
  return [...row.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap((anchor) => {
    const identity = canonicalPullIdentity(anchor.getAttribute('href'));
    return identity ? [{ anchor, identity }] : [];
  });
}

export function findPullRequestIdentity(row: Element): PullRequestIdentity | undefined {
  const candidates = canonicalPullCandidates(row);
  const semanticCandidates = candidates.filter(({ anchor }) => anchor.matches(pullRequestTitleSelector));
  if (semanticCandidates.length > 0) {
    const semanticIdentities = new Set(semanticCandidates.map(({ identity }) =>
      `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`,
    ));
    return semanticIdentities.size === 1 ? semanticCandidates[0]?.identity : undefined;
  }
  const identities = new Set(candidates.map(({ identity }) =>
    `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`,
  ));
  return identities.size === 1 ? candidates[0]?.identity : undefined;
}

export function findPullRequestTitle(row: Element): {
  anchor: HTMLAnchorElement;
  identity: PullRequestIdentity;
} | undefined {
  const candidates = canonicalPullCandidates(row);
  const semanticCandidates = candidates.filter(({ anchor }) => anchor.matches(pullRequestTitleSelector));
  if (semanticCandidates.length > 0) {
    const semanticIdentities = new Set(semanticCandidates.map(({ identity }) =>
      `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`,
    ));
    return semanticIdentities.size === 1 ? semanticCandidates[0] : undefined;
  }
  const identities = new Set(candidates.map(({ identity }) =>
    `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.number}`,
  ));
  if (identities.size !== 1) return undefined;
  const structurallyPossibleTitles = candidates.filter(({ anchor }) => !hasCommentCounterStructure(anchor));
  return structurallyPossibleTitles.length === 1 ? structurallyPossibleTitles[0] : undefined;
}

interface NativeCommentCounterResolution {
  counter?: HTMLAnchorElement;
  isAmbiguous: boolean;
}

function resolveNativeCommentCounter(row: Element, suppliedTitle?: HTMLAnchorElement): NativeCommentCounterResolution {
  const title = suppliedTitle ?? findPullRequestTitle(row)?.anchor;
  const candidates = [...row.querySelectorAll<HTMLAnchorElement>('a')].filter(
    (anchor) => anchor !== title && !anchor.closest('github-pr-overview'),
  );
  const plausibleCounters = candidates.filter(isCommentCounterCandidate);
  if (title) return plausibleCounters.length === 1
    ? { counter: plausibleCounters[0], isAmbiguous: false }
    : { isAmbiguous: plausibleCounters.length > 1 };
  const strongCounters = plausibleCounters.filter(hasStrongCommentCounterPlacement);
  if (strongCounters.length === 1) return { counter: strongCounters[0], isAmbiguous: false };
  return { isAmbiguous: plausibleCounters.length > 0 || canonicalPullCandidates(row).length > 1 };
}

export function findNativeCommentCounter(row: Element, title?: HTMLAnchorElement): HTMLAnchorElement | undefined {
  return resolveNativeCommentCounter(row, title).counter;
}

function validatedNativeCounterHref(href: string | null, identity: PullRequestIdentity): string | undefined {
  const url = trustedGitHubUrl(href);
  if (!href || !url) return undefined;
  const conversationPath = `/${identity.owner}/${identity.repository}/pull/${identity.number}`;
  const isAllowed = url.pathname.toLowerCase() === conversationPath.toLowerCase() &&
    !url.search &&
    (!url.hash || /^#(?:comments|discussion_bucket|issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|discussion-diff-\d+)$/i.test(url.hash));
  return isAllowed ? href : undefined;
}

function reactNativeCommentCount(row: HTMLElement, title: HTMLAnchorElement | undefined): NativeCommentCount | undefined {
  if (!row.matches('[data-listview-component="items-list"] > li')) return undefined;
  const counters = [...row.querySelectorAll('svg.octicon-comment')]
    .filter((icon) => !icon.closest('a, github-pr-overview'))
    .map((icon) => icon.parentElement!);
  if (counters.length === 0) return undefined;
  const count = counters.length === 1
    ? nativeCommentCountFromLabel(`${counters[0]!.textContent?.trim()} comments`)
    : undefined;
  const href = title?.getAttribute('href');
  return count !== undefined && href
    ? { count, href, status: 'ready' }
    : { reason: 'GitHub comment counter is malformed.', status: 'error' };
}

export function extractPullRequestRow(
  row: HTMLElement,
  viewerLogin?: string,
): PullRequestRowExtraction | undefined {
  const identity = findPullRequestIdentity(row);
  if (!identity) return undefined;
  const pullLink = findPullRequestTitle(row)?.anchor;
  const counterResolution = resolveNativeCommentCounter(row, pullLink);
  const recognizedCounter = counterResolution.counter;
  const recognizedHref = recognizedCounter?.getAttribute('href');
  const recognizedCount = nativeCommentCountFromLabel(recognizedCounter?.getAttribute('aria-label') ?? null);
  const counterHref = validatedNativeCounterHref(recognizedHref ?? null, identity);
  const nativeComments: NativeCommentCount = recognizedCount !== undefined && counterHref
    ? { count: recognizedCount, href: counterHref, status: 'ready' }
    : recognizedCounter
      ? { reason: 'GitHub comment counter is malformed.', status: 'error' }
      : counterResolution.isAmbiguous
        ? { reason: 'GitHub comment counter is malformed.', status: 'error' }
        : reactNativeCommentCount(row, pullLink) ?? { status: 'zero' };
  return {
    authorLogin: row.querySelector('.opened-by a[data-hovercard-type="user"], a[data-testid="author-filter-link"]')?.textContent?.trim() || undefined,
    identity,
    nativeComments,
    viewerLogin,
  };
}

export function extractPullRequestRows(document: Document): PullRequestRowExtraction[] {
  const viewerLogin =
    document.querySelector('meta[name="user-login"]')
      ?.getAttribute('content')
      ?.trim() || undefined;

  return [...document.querySelectorAll<HTMLElement>(
    PULL_REQUEST_ROW_SELECTOR,
  )].flatMap((row) => {
    const extraction = extractPullRequestRow(row, viewerLogin);
    return extraction ? [extraction] : [];
  });
}
