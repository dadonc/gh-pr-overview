import type { Page, Route } from '@playwright/test';

import { expect, test } from './extension-fixture';

const conversationUrl = 'https://github.com/octo/demo/pull/42';
const filesUrl = `${conversationUrl}/files`;

function conversationHtml(unresolved: number, codexResponses: number, partial = false): string {
  const threads = Array.from({ length: unresolved }, (_, index) => `
    <div class="js-resolvable-timeline-thread-container" data-resolved="false">
      <input name="pull_request_review_thread_id" value="PRRT_${index}">
    </div>`).join('');
  const reviews = Array.from({ length: codexResponses }, (_, index) => `
    <article id="pullrequestreview-${index}">
      <header><a data-hovercard-url="/apps/openai-code-agent/hovercard">Codex</a></header>
    </article>`).join('');
  const hidden = partial
    ? `<review-thread-collapsible
        class="js-resolvable-timeline-thread-container"
        data-deferred-content-url="/octo/demo/pull/42/threads/hidden?rendering_on_files_tab=false"
        data-hidden-comment-ids="hidden-comment"
        data-resolved="true"
      ></review-thread-collapsible>`
    : '';
  return `<!doctype html><html><body><div id="discussion_bucket"></div>${threads}${reviews}${hidden}</body></html>`;
}

function filesHtml(additions: number, deletions: number, files: number): string {
  return `<!doctype html><html><body>
    <span id="files_tab_counter" title="${files}">${files}</span>
    <span id="diffstat">
      <span class="color-fg-success">+${additions}</span>
      <span class="color-fg-danger">−${deletions}</span>
    </span>
  </body></html>`;
}

function visibleCardLine(card: HTMLElement): string {
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
  return [...clone.children]
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

interface RemoteGeneration {
  additions: number;
  codexResponses: number;
  deletions: number;
  files: number;
  partial?: boolean;
  unresolved: number;
}

async function routeRemotePullRequest(
  page: Page,
  generation: () => RemoteGeneration,
  requests: string[],
): Promise<void> {
  await page.route('https://github.com/**', async (route: Route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() !== 'GET' || url !== conversationUrl && url !== filesUrl) {
      await route.fallback();
      return;
    }
    requests.push(url);
    const current = generation();
    const body = url === conversationUrl
      ? conversationHtml(current.unresolved, current.codexResponses, current.partial)
      : filesHtml(current.additions, current.deletions, current.files);
    await route.fulfill({ body, contentType: 'text/html; charset=utf-8' });
  });
}

test('shows lower bounds for hidden conversation data and replaces them after Retry', async ({ extension }) => {
  const requests: string[] = [];
  let current: RemoteGeneration = {
    additions: 10,
    codexResponses: 1,
    deletions: 2,
    files: 2,
    partial: true,
    unresolved: 0,
  };
  await routeRemotePullRequest(extension.page, () => current, requests);
  await extension.page.goto(extension.urls.prList);

  const row = extension.page.locator('#issue_42');
  const card = row.locator('github-pr-overview .pr-overview-card');
  const nativeCounter = row.locator('a[aria-label="2 comments"]');
  await expect.poll(() => card.evaluate(visibleCardLine))
    .toBe('≥0 unresolved · −2/+10 · 2 files · Codex ≥1 · Retry');
  await expect(card.getByRole('button', { name: 'Retry pull request overview' })).toBeEnabled();
  await expect(nativeCounter).toHaveText('2');

  current = {
    additions: 20,
    codexResponses: 2,
    deletions: 5,
    files: 3,
    unresolved: 2,
  };
  await card.getByRole('button', { name: 'Retry pull request overview' }).click();

  await expect.poll(() => card.evaluate(visibleCardLine))
    .toBe('2 unresolved · −5/+20 · 3 files · Codex 2');
  await expect(nativeCounter).toHaveText('2');
  expect(requests.filter((url) => url === conversationUrl)).toHaveLength(2);
  expect(requests.filter((url) => url === filesUrl)).toHaveLength(2);
  await extension.expectNoFailures();
});

test('revalidates a mounted card when the native comment count changes', async ({ extension }) => {
  const requests: string[] = [];
  let current: RemoteGeneration = {
    additions: 10,
    codexResponses: 1,
    deletions: 2,
    files: 2,
    unresolved: 1,
  };
  await routeRemotePullRequest(extension.page, () => current, requests);
  await extension.page.goto(extension.urls.prList);

  const row = extension.page.locator('#issue_42');
  const host = row.locator('github-pr-overview');
  const card = host.locator('.pr-overview-card');
  await expect.poll(() => card.evaluate(visibleCardLine))
    .toBe('1 unresolved · −2/+10 · 2 files · Codex 1');
  await host.evaluate((element) => {
    (window as Window & { __originalOverviewHost?: Element }).__originalOverviewHost = element;
  });

  current = {
    additions: 30,
    codexResponses: 2,
    deletions: 7,
    files: 4,
    unresolved: 4,
  };
  await row.locator('a[aria-label="2 comments"]').evaluate((counter) => {
    counter.setAttribute('aria-label', '3 comments');
    counter.textContent = '3';
  });

  await expect.poll(() => card.evaluate(visibleCardLine))
    .toBe('4 unresolved · −7/+30 · 4 files · Codex 2');
  expect(await host.evaluate((element) =>
    (window as Window & { __originalOverviewHost?: Element }).__originalOverviewHost === element,
  )).toBe(true);
  await expect(row.locator('a[aria-label="3 comments"]')).toHaveText('3');
  expect(requests.filter((url) => url === conversationUrl)).toHaveLength(2);
  await extension.expectNoFailures();
});

test('refreshes stale data on focus, skips fresh focus, and stops after disable', async ({ extension }) => {
  const devtools = await extension.page.context().newCDPSession(extension.page);
  const executionContexts: Array<{ id: number; name: string; origin: string; type?: string }> = [];
  devtools.on('Runtime.executionContextCreated', ({ context }) => {
    executionContexts.push({
      id: context.id,
      name: context.name,
      origin: context.origin,
      type: context.auxData?.type as string | undefined,
    });
  });
  await devtools.send('Runtime.enable');
  const requests: string[] = [];
  let current: RemoteGeneration = {
    additions: 10,
    codexResponses: 1,
    deletions: 2,
    files: 2,
    unresolved: 1,
  };
  await routeRemotePullRequest(extension.page, () => current, requests);
  await extension.page.goto(extension.urls.prList);

  const card = extension.page.locator('#issue_42 github-pr-overview .pr-overview-card');
  await expect.poll(() => card.evaluate(visibleCardLine))
    .toBe('1 unresolved · −2/+10 · 2 files · Codex 1');
  await extension.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requests.filter((url) => url === conversationUrl).length).toBe(1);

  current = {
    additions: 40,
    codexResponses: 3,
    deletions: 8,
    files: 5,
    unresolved: 5,
  };
  const contentContext = executionContexts.find((context) =>
    context.type === 'isolated' &&
    context.name !== '__playwright_utility_world__' &&
    !context.name.startsWith('__playwright'),
  );
  if (!contentContext) throw new Error(`Extension execution context was not found: ${JSON.stringify(executionContexts)}`);
  const futureNow = Date.now() + 61_000;
  await devtools.send('Runtime.evaluate', {
    contextId: contentContext.id,
    expression: `Date.now = () => ${futureNow}`,
  });
  await extension.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => card.evaluate(visibleCardLine))
    .toBe('5 unresolved · −8/+40 · 5 files · Codex 3');
  expect(requests.filter((url) => url === conversationUrl)).toHaveLength(2);

  await extension.setEnabled(false);
  await expect(card).toHaveCount(0);
  await devtools.send('Runtime.evaluate', {
    contextId: contentContext.id,
    expression: `Date.now = () => ${futureNow + 61_000}`,
  });
  await extension.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await extension.page.waitForTimeout(100);
  expect(requests.filter((url) => url === conversationUrl)).toHaveLength(2);
  await extension.expectNoFailures();
  await devtools.detach();
});
