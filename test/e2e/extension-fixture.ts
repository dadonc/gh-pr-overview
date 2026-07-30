import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, expect, test as base, type Page } from '@playwright/test';

const fixtureDirectory = path.resolve('test/fixtures/github/current');
const QUIET_WINDOW_MS = 50;
const STABLE_QUIET_ROUNDS = 3;
const QUIESCENCE_TIMEOUT_MS = 2_000;

export const urls = {
  prList: 'https://github.com/octo/demo/pulls',
  conversation: 'https://github.com/octo/demo/pull/42',
  files: 'https://github.com/octo/demo/pull/42/files',
  timeline: 'https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42',
} as const;

interface Diagnostics {
  consoleErrors: string[];
  contentScriptCssRequests: string[];
  pageErrors: string[];
  requestFailures: string[];
  unexpectedRequests: string[];
}

interface NativeCounterSnapshot {
  ariaHidden: string | null;
  display: string;
  hidden: boolean;
  style: string | null;
  tabindex: string | null;
  visibility: string;
}

interface ExtensionHarness {
  currentRowHtml: string;
  expectNoFailures(): Promise<void>;
  installHostilePageCss(): Promise<void>;
  nativeCounterSnapshotsAtHostConnection(): Promise<NativeCounterSnapshot[]>;
  page: Page;
  recordNativeCounterAtHostConnection(): Promise<void>;
  urls: typeof urls;
}

function currentRow(html: string): string {
  const start = html.indexOf('<div id="issue_42"');
  const nextRow = html.indexOf('<div id="issue_43"');
  if (start === -1 || nextRow === -1) throw new Error('The current PR-list fixture no longer contains its focused rows.');
  return html.slice(start, nextRow).trim();
}

async function readFixtures() {
  const [prList, conversation, files, timeline] = await Promise.all([
    readFile(path.join(fixtureDirectory, 'pr-list.html'), 'utf8'),
    readFile(path.join(fixtureDirectory, 'conversation.html'), 'utf8'),
    readFile(path.join(fixtureDirectory, 'files.html'), 'utf8'),
    readFile(path.join(fixtureDirectory, 'timeline-fragment.html'), 'utf8'),
  ]);
  return { conversation, files, prList, timeline };
}

function messageForConsole(type: string, text: string): string {
  return `${type}: ${text}`;
}

export const test = base.extend<{ extension: ExtensionHarness }>({
  extension: async ({}, use) => {
    const fixtures = await readFixtures();
    const responses = new Map<string, string>([
      [urls.prList, fixtures.prList],
      [urls.conversation, fixtures.conversation],
      [urls.files, fixtures.files],
      [urls.timeline, fixtures.timeline],
    ]);
    const diagnostics: Diagnostics = {
      consoleErrors: [],
      contentScriptCssRequests: [],
      pageErrors: [],
      requestFailures: [],
      unexpectedRequests: [],
    };
    const pendingRoutes = new Map<symbol, string>();
    let activity = 0;
    const noteActivity = () => { activity += 1; };
    const extensionPath = path.resolve('.output/chrome-mv3');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
      bypassCSP: false,
    });

    try {
      await context.route('https://github.com/**', async (route) => {
        const request = route.request();
        const routeKey = `${request.method()} ${request.url()}`;
        const routeId = Symbol(routeKey);
        pendingRoutes.set(routeId, routeKey);
        noteActivity();
        try {
          const body = responses.get(request.url());
          if (request.method() !== 'GET' || body === undefined) {
            diagnostics.unexpectedRequests.push(`${request.method()} ${request.url()}`);
            noteActivity();
            await route.abort('blockedbyclient');
            return;
          }
          await route.fulfill({
            body,
            contentType: 'text/html; charset=utf-8',
            headers: request.url() === urls.prList
              ? { 'Content-Security-Policy': "default-src 'none'; style-src 'none'; img-src 'none'" }
              : undefined,
          });
        } finally {
          pendingRoutes.delete(routeId);
          noteActivity();
        }
      });
      context.on('request', (request) => {
        if (new URL(request.url()).pathname.endsWith('/content-scripts/content.css')) {
          diagnostics.contentScriptCssRequests.push(request.url());
          noteActivity();
        }
      });

      const page = await context.newPage();
      page.on('pageerror', (error) => {
        diagnostics.pageErrors.push(error.message);
        noteActivity();
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          diagnostics.consoleErrors.push(messageForConsole(message.type(), message.text()));
          noteActivity();
        }
      });
      page.on('requestfailed', (request) => {
        diagnostics.requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`.trim());
        noteActivity();
      });
      await page.addInitScript(() => {
        const removeUnservedFixtureRows = () => document.querySelector('#issue_43')?.remove();
        new MutationObserver(removeUnservedFixtureRows).observe(document, { childList: true, subtree: true });
        removeUnservedFixtureRows();
      });

      await use({
        currentRowHtml: currentRow(fixtures.prList),
        async expectNoFailures() {
          await Promise.race([
            page.waitForLoadState('networkidle'),
            new Promise<never>((_resolve, reject) => setTimeout(
              () => reject(new Error('Timed out waiting for browser network idle.')),
              QUIESCENCE_TIMEOUT_MS,
            )),
          ]);
          const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
          let stableRounds = 0;
          while (stableRounds < STABLE_QUIET_ROUNDS && Date.now() < deadline) {
            const observedActivity = activity;
            await new Promise<void>((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
            if (pendingRoutes.size === 0 && activity === observedActivity) stableRounds += 1;
            else stableRounds = 0;
          }
          if (stableRounds !== STABLE_QUIET_ROUNDS) {
            throw new Error(`Browser diagnostics did not reach quiescence; pending routes: ${[...pendingRoutes.values()].join(', ') || 'none'}.`);
          }
          expect(diagnostics.pageErrors, `page errors: ${diagnostics.pageErrors.join('\n')}`).toEqual([]);
          expect(diagnostics.consoleErrors, `console errors: ${diagnostics.consoleErrors.join('\n')}`).toEqual([]);
          expect(diagnostics.requestFailures, `request failures: ${diagnostics.requestFailures.join('\n')}`).toEqual([]);
          expect(diagnostics.unexpectedRequests, `unexpected requests: ${diagnostics.unexpectedRequests.join('\n')}`).toEqual([]);
          expect(diagnostics.contentScriptCssRequests, `content stylesheet requests: ${diagnostics.contentScriptCssRequests.join('\n')}`).toEqual([]);
        },
        async installHostilePageCss() {
          const session = await context.newCDPSession(page);
          try {
            await session.send('DOM.enable');
            await session.send('CSS.enable');
            const frameTree = await session.send('Page.getFrameTree');
            const sheet = await session.send('CSS.createStyleSheet', { frameId: frameTree.frameTree.frame.id });
            await session.send('CSS.setStyleSheetText', {
              styleSheetId: sheet.styleSheetId,
              text: 'a { color: rgb(255, 0, 0) !important; font-size: 40px !important; }',
            });
          } finally {
            await session.detach();
          }
        },
        async nativeCounterSnapshotsAtHostConnection() {
          return page.evaluate(() =>
            (window as Window & { __prOverviewCounterSnapshots?: NativeCounterSnapshot[] }).__prOverviewCounterSnapshots ?? [],
          );
        },
        page,
        async recordNativeCounterAtHostConnection() {
          await page.addInitScript(() => {
            const trackedWindow = window as Window & { __prOverviewCounterSnapshots?: NativeCounterSnapshot[] };
            trackedWindow.__prOverviewCounterSnapshots = [];
            customElements.define('github-pr-overview', class extends HTMLElement {
              connectedCallback() {
                const counter = this.closest('#issue_42')?.querySelector<HTMLAnchorElement>('a[aria-label="2 comments"]');
                if (!counter) return;
                const styles = getComputedStyle(counter);
                trackedWindow.__prOverviewCounterSnapshots!.push({
                  ariaHidden: counter.getAttribute('aria-hidden'),
                  display: styles.display,
                  hidden: counter.hidden,
                  style: counter.getAttribute('style'),
                  tabindex: counter.getAttribute('tabindex'),
                  visibility: styles.visibility,
                });
              }
            });
          });
        },
        urls,
      });
    } finally {
      await context.close();
    }
  },
});

export { expect };
