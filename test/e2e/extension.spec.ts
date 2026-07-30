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

function readVisibleCardLine(card: HTMLElement): string {
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
  return [...clone.children]
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

test('boots the unpacked extension with a rendered, isolated shadow card', async ({ extension }) => {
  await extension.recordNativeCounterAtHostConnection();
  await extension.page.goto(extension.urls.prList);
  await extension.installHostilePageCss();

  const row = extension.page.locator('#issue_42');
  const host = row.locator('github-pr-overview');
  const card = host.locator('.pr-overview-card');
  const nativeCounter = row.locator('a[aria-label="2 comments"]');

  await expect(extension.page.locator('[id^="issue_"].js-issue-row')).toHaveCount(1);
  await expect(host).toHaveCount(1);
  await expect.poll(() => card.evaluate(readVisibleCardLine))
    .toBe('2 comments · 0 unresolved · −353/+524 18 files · Copilot 1');
  await expect(nativeCounter).toBeHidden();

  const typography = await card.evaluate((element) => {
    const weight = (selector: string) =>
      getComputedStyle(element.querySelector<HTMLElement>(selector)!).fontWeight;
    return {
      agent: weight('.agent'),
      comments: weight('.comments'),
      diff: weight('.diff'),
      separator: weight('.separator'),
      unresolved: weight('[aria-label="0 unresolved review threads"]'),
    };
  });
  expect(typography).toEqual({
    agent: '400',
    comments: '400',
    diff: '400',
    separator: '400',
    unresolved: '400',
  });

  const verticalSpread = await card.evaluate((element) => {
    const tops = [...element.querySelectorAll<HTMLElement>(
      ':scope > .comments, :scope > .separator, :scope > .unresolved, :scope > .diff, :scope > .agent',
    )].map((node) => node.getBoundingClientRect().top);
    return Math.max(...tops) - Math.min(...tops);
  });
  expect(verticalSpread).toBeLessThanOrEqual(1);

  const bounds = await row.evaluate((element) => {
    const renderedCard = element.querySelector('github-pr-overview')
      ?.shadowRoot
      ?.querySelector<HTMLElement>('.pr-overview-card');
    if (!renderedCard?.parentElement) throw new Error('Rendered card is missing.');
    const rowBounds = element.getBoundingClientRect();
    const cardBounds = renderedCard.getBoundingClientRect();
    const containerBounds = renderedCard.parentElement.getBoundingClientRect();
    return {
      cardLeft: cardBounds.left,
      cardRight: cardBounds.right,
      cardWidth: cardBounds.width,
      containerRight: containerBounds.right,
      containerWidth: containerBounds.width,
      rowLeft: rowBounds.left,
      rowRight: rowBounds.right,
    };
  });
  expect(bounds.cardLeft).toBeGreaterThanOrEqual(bounds.rowLeft);
  expect(bounds.cardRight).toBeLessThanOrEqual(bounds.rowRight);
  expect(bounds.cardWidth).toBeLessThan(bounds.containerWidth);
  expect(bounds.cardRight).toBeCloseTo(bounds.containerRight, 1);
  await expect(host).toHaveCSS('display', 'block');
  await expect(host).toHaveCSS('max-width', '100%');

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

test('keeps the strict line inside the row and scrolls it internally at narrow widths', async ({ extension }) => {
  await extension.page.setViewportSize({ width: 240, height: 720 });
  await extension.page.goto(extension.urls.prList);

  const row = extension.page.locator('#issue_42');
  const card = row.locator('github-pr-overview').locator('.pr-overview-card');
  await expect.poll(() => card.evaluate(readVisibleCardLine))
    .toBe('2 comments · 0 unresolved · −353/+524 18 files · Copilot 1');

  const layout = await card.evaluate((element) => {
    const visibleChildren = [...element.querySelectorAll<HTMLElement>(
      ':scope > .comments, :scope > .separator, :scope > .unresolved, :scope > .diff, :scope > .agent',
    )];
    const tops = visibleChildren.map((node) => node.getBoundingClientRect().top);
    const shadowRoot = element.getRootNode();
    const row = shadowRoot instanceof ShadowRoot
      ? shadowRoot.host.closest<HTMLElement>('#issue_42')
      : null;
    if (!row) throw new Error('Pull request row is missing.');
    const rowBounds = row.getBoundingClientRect();
    const cardBounds = element.getBoundingClientRect();
    element.scrollLeft = element.scrollWidth;
    return {
      cardLeft: cardBounds.left,
      cardRight: cardBounds.right,
      clientWidth: element.clientWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      rowLeft: rowBounds.left,
      rowRight: rowBounds.right,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      verticalSpread: Math.max(...tops) - Math.min(...tops),
    };
  });

  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
  expect(layout.scrollLeft).toBeGreaterThan(0);
  expect(layout.verticalSpread).toBeLessThanOrEqual(1);
  expect(layout.cardLeft).toBeGreaterThanOrEqual(layout.rowLeft);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.rowRight);
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);

  await extension.expectNoFailures();
});

test('reconciles inserted rows and restores native UI across pushState remounts', async ({ extension }) => {
  await extension.recordNativeCounterAtHostConnection();
  await extension.page.goto(extension.urls.prList);

  const row = extension.page.locator('#issue_42');
  const host = row.locator('github-pr-overview');
  const nativeCounter = row.locator('a[aria-label="2 comments"]');
  await expect(host).toHaveCount(1);
  await expect.poll(() => host.locator('.pr-overview-card').evaluate(readVisibleCardLine))
    .toBe('2 comments · 0 unresolved · −353/+524 18 files · Copilot 1');
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
  await expect.poll(() => inserted.locator('.pr-overview-card').evaluate(readVisibleCardLine))
    .toBe('2 comments · 0 unresolved · −353/+524 18 files · Copilot 1');
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
  await expect.poll(() => remountedHost.locator('.pr-overview-card').evaluate(readVisibleCardLine))
    .toBe('7 comments · 0 unresolved · −353/+524 18 files · Copilot 1');
  await expect(remountedHost).toHaveCount(1);
  await expect(extension.page.locator('github-pr-overview')).toHaveCount(1);

  await extension.expectNoFailures();
});
