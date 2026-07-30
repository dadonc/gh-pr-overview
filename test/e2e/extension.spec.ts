import { expect, test } from './extension-fixture';
import { CARD_STYLES } from '../../lib/pr-card';

interface NativeCounterSnapshot {
  ariaHidden: string | null;
  display: string;
  hidden: boolean;
  hiddenAttribute: string | null;
  style: string | null;
  tabindex: string | null;
  visibility: string;
}

function readNativeCounterSnapshot(counter: HTMLAnchorElement): NativeCounterSnapshot {
  const styles = getComputedStyle(counter);
  return {
    ariaHidden: counter.getAttribute('aria-hidden'),
    display: styles.display,
    hidden: counter.hidden,
    hiddenAttribute: counter.getAttribute('hidden'),
    style: counter.getAttribute('style'),
    tabindex: counter.getAttribute('tabindex'),
    visibility: styles.visibility,
  };
}

test('boots the unpacked extension with a rendered, isolated shadow card', async ({ extension }) => {
  await extension.recordNativeCounterAtHostConnection();
  await extension.page.goto(extension.urls.prList);
  await extension.installHostilePageCss();

  const row = extension.page.locator('#issue_42');
  const host = row.locator('github-pr-overview');
  const nativeCounter = row.locator('a[aria-label="2 comments"]');

  await expect(extension.page.locator('[id^="issue_"].js-issue-row')).toHaveCount(1);
  await expect(host).toHaveCount(1);
  await expect(host.locator('.pr-overview-card')).toContainText('2 total comments');
  await expect(host.locator('.pr-overview-card')).toContainText('1 review thread · 0 unresolved · 1 resolved+outdated');
  await expect(host.locator('.pr-overview-card')).toContainText('18 files · +524 −353');
  await expect(host.locator('.pr-overview-card')).toContainText('Copilot Responded');
  await expect(nativeCounter).toBeHidden();

  await expect.poll(() => extension.nativeCounterSnapshotsAtHostConnection()).toEqual([{
    ariaHidden: null,
    display: 'inline',
    hidden: false,
    hiddenAttribute: null,
    style: null,
    tabindex: null,
    visibility: 'visible',
  }]);
  await expect.poll(() => extension.page.evaluate(() =>
    getComputedStyle(document.querySelector<HTMLAnchorElement>('#issue_42 .Link--primary')!).fontSize,
  )).toBe('40px');
  await expect.poll(() => extension.page.evaluate(() =>
    getComputedStyle(document.querySelector<HTMLAnchorElement>('#issue_42 .Link--primary')!).color,
  )).toBe('rgb(255, 0, 0)');
  await expect(host.locator('.metric').first()).not.toHaveCSS('font-size', '40px');
  await expect(host.locator('.metric').first()).not.toHaveCSS('color', 'rgb(255, 0, 0)');
  expect(await host.evaluate((element) => element.shadowRoot?.mode)).toBe('open');
  expect(await host.evaluate((element) =>
    [...element.shadowRoot!.querySelectorAll('style')].map((style) => style.textContent).join('\n'),
  )).toContain(CARD_STYLES.trim());

  await extension.expectNoFailures();
});

test('reconciles inserted rows and restores native UI across pushState remounts', async ({ extension }) => {
  await extension.recordNativeCounterAtHostConnection();
  await extension.page.goto(extension.urls.prList);

  const row = extension.page.locator('#issue_42');
  const host = row.locator('github-pr-overview');
  const nativeCounter = row.locator('a[aria-label="2 comments"]');
  await expect(host).toHaveCount(1);
  await expect(host.locator('.pr-overview-card')).toContainText('18 files · +524 −353');
  await expect(nativeCounter).toBeHidden();
  const pristineNativeCounter = await extension.nativeCounterSnapshotsAtHostConnection().then((snapshots) => snapshots[0]!);

  await extension.page.evaluate((rowHtml) => {
    const source = document.createElement('template');
    source.innerHTML = rowHtml;
    const inserted = source.content.firstElementChild!.cloneNode(true) as HTMLElement;
    inserted.id = 'issue_420';
    document.body.append(inserted);
  }, extension.currentRowHtml);
  const inserted = extension.page.locator('#issue_420');
  await expect(inserted.locator('github-pr-overview')).toHaveCount(1);
  await expect(inserted.locator('.pr-overview-card')).toContainText('18 files · +524 −353');
  await expect(extension.page.locator('github-pr-overview')).toHaveCount(2);

  await inserted.evaluate((element) => element.remove());
  await expect(inserted.locator('github-pr-overview')).toHaveCount(0);
  await expect(extension.page.locator('github-pr-overview')).toHaveCount(1);

  await extension.page.evaluate(() => history.pushState({}, '', '/octo/demo/issues'));
  await expect(host).toHaveCount(0);
  await expect(nativeCounter).toBeVisible();
  expect(await nativeCounter.evaluate(readNativeCounterSnapshot)).toEqual(pristineNativeCounter);

  await extension.page.evaluate((rowHtml) => {
    history.pushState({}, '', '/octo/demo/pulls');
    document.body.innerHTML = rowHtml;
    const counter = document.querySelector<HTMLAnchorElement>('#issue_42 a[aria-label="2 comments"]')!;
    counter.setAttribute('aria-label', '7 comments');
    counter.textContent = '7';
  }, extension.currentRowHtml);
  const remountedRow = extension.page.locator('#issue_42');
  const remountedHost = remountedRow.locator('github-pr-overview');
  await expect(remountedHost).toHaveCount(1);
  await expect(remountedHost.locator('.pr-overview-card')).toContainText('7 total comments');
  await expect(remountedHost.locator('.pr-overview-card')).not.toContainText('2 total comments');
  await expect(remountedHost.locator('.pr-overview-card')).toContainText('18 files · +524 −353');
  await expect(remountedHost).toHaveCount(1);
  await expect(extension.page.locator('github-pr-overview')).toHaveCount(1);

  await extension.expectNoFailures();
});
