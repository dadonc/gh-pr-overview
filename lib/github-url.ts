import type { PullRequestIdentity } from './domain';

export const GITHUB_ORIGIN = 'https://github.com';

interface TrustedGitHubUrlOptions {
  rejectRawFragmentDelimiter?: boolean;
}

export function trustedGitHubUrl(
  candidate: string | null | undefined,
  options: TrustedGitHubUrlOptions = {},
): URL | undefined {
  if (!candidate) return undefined;
  const raw = candidate.trim();
  const authority = raw.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/)?.[1];
  const hostAndPort = authority?.split('@').at(-1);
  const rawPath = raw.slice(0, raw.search(/[?#]/) === -1 ? raw.length : raw.search(/[?#]/));
  if (
    raw.startsWith('//') ||
    authority?.includes('@') ||
    hostAndPort?.includes(':') ||
    options.rejectRawFragmentDelimiter && raw.includes('#') ||
    /(?:^|\/)\.\.?(?=\/|$)/.test(rawPath) ||
    /\\|%(?:2f|5c|2e)/i.test(rawPath)
  ) return undefined;

  let url: URL;
  try {
    url = new URL(raw, GITHUB_ORIGIN);
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
