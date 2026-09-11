import { describe, expect, it, vi } from 'vitest';

import { createGitHubClient, isAllowedPullRequestUrl, type PullRequestRemoteUpdate } from './github-client';

const identity = { owner: 'octo', repository: 'demo', number: 42 };
const base = 'https://github.com/octo/demo/pull/42';
const mergeUrl = `${base}/page_data/merge_box?merge_method=MERGE&bypass_requirements=false`;
const conversation = '<react-app app-name="pull-requests"><div id="discussion_bucket"></div></react-app>';

function mergeData(conflicts: unknown, result = 'FAILED', state = 'OPEN') {
  return {
    pullRequest: { state },
    mergeRequirements: { conditions: [{ type: 'PULL_REQUEST_MERGE_CONFLICT_STATE', result, conflicts }] },
  };
}

function response(body: string, url: string, contentType = 'text/html', status = 200): Response {
  return { url, ok: status === 200, status, headers: new Headers({ 'content-type': contentType }), text: async () => body } as Response;
}

describe('pull request merge conflicts', () => {
  it('loads conflicting filenames and clears the count after a fresh merge-status response', async () => {
    let files = ['src/app.ts', 'README.md', 'src/app.ts'];
    const updates: PullRequestRemoteUpdate[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === mergeUrl) return response(JSON.stringify(mergeData(files)), url, 'application/json');
      return response(url === base ? conversation : '<div></div>', url);
    });
    const client = createGitHubClient({ fetch: fetcher });

    expect((await client.loadPullRequest(identity, { onUpdate: update => updates.push(update) })).conflicts).toBe(2);
    expect(updates).toContainEqual({ kind: 'conflicts', conflicts: 2 });
    const request = fetcher.mock.calls.find(([input]) => String(input) === mergeUrl)?.[1];
    expect(request).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error' });
    expect(new Headers(request?.headers).get('GitHub-Verified-Fetch')).toBe('true');

    files = [];
    expect((await client.loadPullRequest(identity, { bypassCache: true })).conflicts).toBe(0);
  });

  it.each([
    mergeData([], 'PASSED'),
    mergeData(['README.md'], 'PASSED'),
    mergeData(['README.md'], 'FAILED', 'MERGED'),
    mergeData(['README.md'], 'FAILED', 'CLOSED'),
  ])('does not report conflicts for a clean or closed pull request', async data => {
    const client = createGitHubClient({ fetch: async input => {
      const url = String(input);
      return url === mergeUrl ? response(JSON.stringify(data), url, 'application/json') : response(conversation, url);
    } });
    expect((await client.loadPullRequest(identity)).conflicts).toBe(0);
  });

  it.each([
    ['malformed data', JSON.stringify(mergeData(['README.md', null])), 'application/json', mergeUrl, 200],
    ['missing condition', '{}', 'application/json', mergeUrl, 200],
    ['invalid JSON', '{', 'application/json', mergeUrl, 200],
    ['HTML login response', '<html>Sign in</html>', 'text/html', mergeUrl, 200],
    ['redirected response', JSON.stringify(mergeData(['README.md'])), 'application/json', `${base}/other`, 200],
    ['request failure', '', 'application/json', mergeUrl, 500],
  ])('keeps the rest of the overview usable with %s', async (_label, body, type, finalUrl, status) => {
    const client = createGitHubClient({ fetch: async input => {
      const url = String(input);
      return url === mergeUrl ? response(body as string, finalUrl as string, type as string, status as number) : response(conversation, url);
    } });
    const summary = await client.loadPullRequest(identity);
    expect(summary.conflicts).toBeUndefined();
    expect(summary.reviewThreads.status).toBe('ready');
    expect(summary.agents.status).toBe('ready');
  });

  it('allows only the same PR’s read-only merge-status URL with fixed parameters', () => {
    expect(isAllowedPullRequestUrl(mergeUrl, identity, 'merge-status')).toBe(true);
    for (const url of [
      mergeUrl.replace('/42/', '/43/'),
      mergeUrl.replace('github.com', 'example.com'),
      mergeUrl.replace('false', 'true'),
      `${mergeUrl}&extra=1`,
      `${mergeUrl}#fragment`,
    ]) expect(isAllowedPullRequestUrl(url, identity, 'merge-status')).toBe(false);
  });
});
