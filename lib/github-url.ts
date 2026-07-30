import type { PullRequestIdentity } from './domain';

export const GITHUB_ORIGIN = 'https://github.com';

export function trustedGitHubUrl(
  candidate: string | null | undefined,
): URL | undefined {
  if (!candidate) return undefined;
  const authority = candidate.trim().match(/^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/)?.[1];
  const hostAndPort = authority?.split('@').at(-1);
  const rawPath = candidate.slice(0, candidate.search(/[?#]/) === -1 ? candidate.length : candidate.search(/[?#]/));
  if (
    candidate.trimStart().startsWith('//') ||
    hostAndPort?.includes(':') ||
    /(?:^|\/)\.\.?(?=\/|$)/.test(rawPath) ||
    /\\|%(?:2f|5c|2e)/i.test(rawPath)
  ) return undefined;

  let url: URL;
  try {
    url = new URL(candidate, GITHUB_ORIGIN);
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

const validOwner = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

const validRepository = (value: string) =>
  /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(value);

export function isValidPullRequestIdentity(
  identity: PullRequestIdentity,
): boolean {
  return validOwner(identity.owner) &&
    validRepository(identity.repository) &&
    Number.isSafeInteger(identity.number) && identity.number > 0;
}

export function pullRequestPath(identity: PullRequestIdentity): string {
  return `/${identity.owner}/${identity.repository}/pull/${identity.number}`;
}
